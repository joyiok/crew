import { CrewConfig, WorkerConfig } from "./config.js";
import { pruneHistory } from "./context.js";
import { ChatCompletionMessageParam, chatStream } from "./llm.js";
import { WORKER_TOOLS, executeTool } from "./tools.js";
import {
  createWorkerStreamWriter,
  info,
  workerEvent,
  workerSays,
} from "./ui.js";

const MAX_ITERATIONS = 40;

function systemPrompt(name: string, cwd: string): string {
  return `你是编程团队中的执行 agent「${name}」，接受指挥模型派发的任务。你的职责是把手头这一个任务做完、做对、可验证。

## 环境
- 工作目录: ${cwd}，所有文件路径相对于它
- 你只能看到本条任务描述，看不到指挥与用户的对话。任务里给的背景就是你的全部上下文；信息不足时优先用工具探索，而不是靠猜

## 工作循环
1. 探索：先用 glob/grep 定位相关文件，再用 read_file 细读；不要凭空假设项目结构或代码风格
2. 动手：小步修改。改已有文件用 edit_file 做精确替换；新建或整体重写才用 write_file
3. 验证：能验证的必须验证——用 run_command 跑测试、编译或执行脚本；没有现成测试就做一次最小化的手动验证
4. 报告：确认完成后停止调用工具，输出最终报告

## 纪律
- 只做任务要求的事：不顺手重构、不加没要求的功能、不"优化"无关代码
- 遵循项目已有的代码风格和约定，而不是你自己的偏好
- 命令可能被用户拒绝：被拒后换一种方式或在报告中说明，不要原样重试同一条命令
- 如实报告：验证失败就说失败并附上关键输出；禁止把未验证的工作说成已完成

## 最终报告格式
- 结论：做了什么（一两句）
- 改动文件：逐个列出
- 验证：怎么验证的、结果如何
- 遗留：需要指挥注意的问题（没有就写"无"）`;
}

function changedFilesFromResult(name: string, result: string): string[] {
  const files: string[] = [];
  const writeMatch = result.match(/^已写入 (.+)$/m);
  const editMatch = result.match(/^已编辑 (.+)$/m);
  if (writeMatch) files.push(writeMatch[1]);
  if (editMatch) files.push(editMatch[1]);
  return files;
}

async function runWorkerOnce(
  name: string,
  worker: WorkerConfig,
  task: string,
  config: CrewConfig,
  cwd: string,
  signal?: AbortSignal,
): Promise<{ report: string; changedFiles: string[] }> {
  workerEvent(name, `领到任务 (${worker.provider}/${worker.model})`);

  let messages: ChatCompletionMessageParam[] = [
    { role: "system", content: systemPrompt(name, cwd) },
    { role: "user", content: task },
  ];

  const changedFiles = new Set<string>();
  let prunedNotified = false;

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    if (signal?.aborted) {
      throw new Error("任务被用户中断");
    }

    const prune = pruneHistory(messages, config.contextCharLimit);
    if (prune.pruned && !prunedNotified) {
      info("上下文已裁剪：旧的 tool 结果被替换为占位符以节省 tokens");
      prunedNotified = true;
    }
    messages = prune.messages;

    const onText = createWorkerStreamWriter(name);
    const { message: msg } = await chatStream(
      worker,
      config,
      messages,
      WORKER_TOOLS,
      onText,
      signal,
    );
    messages.push(msg);

    const toolCalls = msg.tool_calls ?? [];
    if (toolCalls.length === 0) {
      const report = msg.content ?? "(worker 没有返回内容)";
      process.stdout.write("\n");
      workerSays(name, "任务完成");
      return { report, changedFiles: Array.from(changedFiles) };
    }

    // 同一轮的多个工具调用并行执行
    const results = await Promise.all(
      toolCalls.map(async (tc) => {
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(tc.function.arguments || "{}");
        } catch {
          return { id: tc.id, result: "错误: 工具参数不是合法 JSON" };
        }
        const result = await executeTool(tc.function.name, args, {
          cwd,
          workerName: name,
          autoApprove: config.autoApprove,
          signal,
        });
        for (const f of changedFilesFromResult(tc.function.name, result)) {
          changedFiles.add(f);
        }
        return { id: tc.id, result };
      }),
    );

    for (const r of results) {
      messages.push({ role: "tool", tool_call_id: r.id, content: r.result });
    }
  }

  const fileList =
    changedFiles.size > 0
      ? `\n已改动文件：\n${Array.from(changedFiles).map((f) => `- ${f}`).join("\n")}`
      : "";
  return {
    report: `worker "${name}" 达到最大迭代次数 (${MAX_ITERATIONS})，任务可能未完成。${fileList}`,
    changedFiles: Array.from(changedFiles),
  };
}

/**
 * 运行一个 worker agent 直到任务完成，返回它的最终报告。
 * 每次任务是独立会话——上下文由指挥模型在任务描述里给足。
 * 配置了 fallbackModel 时，非用户中断异常会自动重试一次。
 */
export async function runWorker(
  name: string,
  worker: WorkerConfig,
  task: string,
  config: CrewConfig,
  cwd: string,
  signal?: AbortSignal,
): Promise<string> {
  try {
    const { report } = await runWorkerOnce(name, worker, task, config, cwd, signal);
    return report;
  } catch (e: any) {
    if (e.message === "任务被用户中断" || signal?.aborted) throw e;
    if (!worker.fallbackModel) {
      return `worker "${name}" 执行失败：${e.message}`;
    }
    info(`worker "${name}" 异常，用兜底模型 ${worker.fallbackModel} 重试一次`);
    const fallbackWorker: WorkerConfig = {
      ...worker,
      model: worker.fallbackModel,
    };
    try {
      const { report } = await runWorkerOnce(
        name,
        fallbackWorker,
        task,
        config,
        cwd,
        signal,
      );
      return `[用兜底模型 ${worker.fallbackModel} 重试]\n${report}`;
    } catch (retryErr: any) {
      return `worker "${name}" 重试后仍然失败：${retryErr.message}`;
    }
  }
}
