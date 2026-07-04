import { CrewConfig, WorkerConfig } from "./config.js";
import { chat, ChatCompletionMessageParam } from "./llm.js";
import { WORKER_TOOLS, executeTool } from "./tools.js";
import { workerEvent, workerSays } from "./ui.js";

const MAX_ITERATIONS = 40;

function systemPrompt(name: string, cwd: string): string {
  return `你是一个名为 "${name}" 的编程执行 agent，隶属于一个多模型协作团队，接受指挥模型分派的任务。

工作目录: ${cwd}

规则:
- 用工具完成任务：先 list_dir / read_file 了解现状，再动手改
- 改完代码尽量用 run_command 验证（跑测试、编译、语法检查）
- 修改文件优先用 edit_file 做精确替换；新文件或整体重写才用 write_file
- 任务完成后，停止调用工具，输出一份简明报告：做了什么、改了哪些文件、验证结果、遗留问题
- 遇到无法解决的阻塞，如实报告，不要编造结果`;
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
