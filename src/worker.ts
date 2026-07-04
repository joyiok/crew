import { CrewConfig, WorkerConfig } from "./config.js";
import { chat, ChatCompletionMessageParam } from "./llm.js";
import { WORKER_TOOLS, executeTool } from "./tools.js";
import { workerEvent, workerSays } from "./ui.js";

const MAX_ITERATIONS = 40;

function systemPrompt(name: string, cwd: string): string {
  return `你是编程团队中的执行 agent「${name}」，接受指挥模型派发的任务。你的职责是把手头这一个任务做完、做对、可验证。

## 环境
- 工作目录: ${cwd}，所有文件路径相对于它
- 你只能看到本条任务描述，看不到指挥与用户的对话。任务里给的背景就是你的全部上下文；信息不足时优先用工具探索，而不是靠猜

## 工作循环
1. 探索：用 list_dir / read_file 弄清现状，不要凭空假设项目结构或代码风格
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

/**
 * 运行一个 worker agent 直到任务完成，返回它的最终报告。
 * 每次任务是独立会话——上下文由指挥模型在任务描述里给足。
 */
export async function runWorker(
  name: string,
  worker: WorkerConfig,
  task: string,
  config: CrewConfig,
  cwd: string,
): Promise<string> {
  workerEvent(name, `领到任务 (${worker.provider}/${worker.model})`);

  const messages: ChatCompletionMessageParam[] = [
    { role: "system", content: systemPrompt(name, cwd) },
    { role: "user", content: task },
  ];

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const msg = await chat(worker, config, messages, WORKER_TOOLS);
    messages.push(msg);

    const toolCalls = msg.tool_calls ?? [];
    if (toolCalls.length === 0) {
      const report = msg.content ?? "(worker 没有返回内容)";
      workerSays(name, "任务完成");
      return report;
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
        });
        return { id: tc.id, result };
      }),
    );

    for (const r of results) {
      messages.push({ role: "tool", tool_call_id: r.id, content: r.result });
    }
  }

  return `worker "${name}" 达到最大迭代次数 (${MAX_ITERATIONS})，任务可能未完成。请检查已完成的部分或拆小任务重试。`;
}
