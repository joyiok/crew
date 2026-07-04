import { CrewConfig } from "./config.js";
import {
  chat,
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "./llm.js";
import { executeTool } from "./tools.js";
import { runWorker } from "./worker.js";
import { info, orchestratorSays } from "./ui.js";

const MAX_ITERATIONS = 25;

function orchestratorTools(config: CrewConfig): ChatCompletionTool[] {
  const workerNames = Object.keys(config.workers);
  return [
    {
      type: "function",
      function: {
        name: "dispatch_task",
        description:
          "把一个任务分派给指定的 worker 模型执行，等待并返回它的完成报告。可以在同一轮并行分派多个互不依赖的任务。",
        parameters: {
          type: "object",
          properties: {
            worker: {
              type: "string",
              enum: workerNames,
              description: "worker 名称",
            },
            task: {
              type: "string",
              description:
                "完整的任务描述。worker 看不到你和用户的对话，所以要把背景、涉及的文件路径、具体要求、验收标准都写清楚",
            },
          },
          required: ["worker", "task"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "read_file",
        description: "读取文件内容（用于自己了解现状，重活派给 worker）",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "相对于工作目录的文件路径" },
          },
          required: ["path"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "list_dir",
        description: "列出目录内容，目录名以 / 结尾",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "目录路径，默认工作目录" },
          },
        },
      },
    },
  ];
}

function systemPrompt(config: CrewConfig, cwd: string): string {
  const roster = Object.entries(config.workers)
    .map(
      ([name, w]) => `- ${name} (${w.provider}/${w.model}): ${w.description}`,
    )
    .join("\n");
  return `你是一个编程团队的总指挥。你自己不写代码，而是把任务分解后用 dispatch_task 派给手下的 worker 模型执行。

工作目录: ${cwd}

你的团队:
${roster}

工作方式:
- 简单问题（解释概念、回答提问）直接回答，不必派工
- 编码任务：先用 list_dir / read_file 快速了解项目，再拆解任务派给合适的 worker
- 互不依赖的子任务在同一轮里并行 dispatch_task；有依赖的按顺序派发
- 派任务时把上下文写全——worker 是全新会话，看不到这里的对话
- worker 报告完成后，重要改动可以派 reviewer 审查，或亲自 read_file 抽查
- 全部完成后，向用户总结：做了什么、谁做的、结果如何
- 用中文和用户交流`;
}

export class Orchestrator {
  private messages: ChatCompletionMessageParam[] = [];

  constructor(
    private config: CrewConfig,
    private cwd: string,
  ) {
    this.messages.push({
      role: "system",
      content: systemPrompt(config, cwd),
    });
  }

  /** 处理一轮用户输入：跑指挥循环直到没有工具调用，返回最终回复 */
  async handle(userInput: string): Promise<string> {
    this.messages.push({ role: "user", content: userInput });
    const tools = orchestratorTools(this.config);

    for (let i = 0; i < MAX_ITERATIONS; i++) {
      const msg = await chat(
        this.config.orchestrator,
        this.config,
        this.messages,
        tools,
      );
      this.messages.push(msg);

      const toolCalls = msg.tool_calls ?? [];
      if (toolCalls.length === 0) {
        return msg.content ?? "(指挥模型没有返回内容)";
      }

      // 指挥模型说的话（伴随工具调用的思路说明）也展示给用户
      if (msg.content) orchestratorSays(msg.content);

      const results = await Promise.all(
        toolCalls.map(async (tc) => {
          let args: Record<string, unknown> = {};
          try {
            args = JSON.parse(tc.function.arguments || "{}");
          } catch {
            return { id: tc.id, result: "错误: 工具参数不是合法 JSON" };
          }

          if (tc.function.name === "dispatch_task") {
            const workerName = String(args.worker);
            const worker = this.config.workers[workerName];
            if (!worker) {
              return {
                id: tc.id,
                result: `错误: 没有名为 "${workerName}" 的 worker`,
              };
            }
            orchestratorSays(`派活给 ${workerName}: ${String(args.task).slice(0, 120)}...`);
            const report = await runWorker(
              workerName,
              worker,
              String(args.task),
              this.config,
              this.cwd,
            );
            return { id: tc.id, result: `[${workerName} 的报告]\n${report}` };
          }

          // 指挥自己的轻量工具（read_file / list_dir），只读不写
          const result = await executeTool(tc.function.name, args, {
            cwd: this.cwd,
            workerName: "指挥",
            autoApprove: true,
          });
          return { id: tc.id, result };
        }),
      );

      for (const r of results) {
        this.messages.push({ role: "tool", tool_call_id: r.id, content: r.result });
      }
    }

    info(`指挥循环达到最大迭代次数 (${MAX_ITERATIONS})`);
    return "本轮指挥循环超出迭代上限，已停止。可以继续对话让我接着处理。";
  }

  /** 清空对话历史（保留 system prompt） */
  reset() {
    this.messages = this.messages.slice(0, 1);
  }
}
