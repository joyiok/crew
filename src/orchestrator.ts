import { CrewConfig } from "./config.js";
import { pruneHistory } from "./context.js";
import {
  ChatCompletionMessageParam,
  ChatCompletionTool,
  chatStream,
} from "./llm.js";
import { executeTool } from "./tools.js";
import {
  diffUsage,
  renderUsageLine,
  snapshotUsage,
  UsageEntry,
} from "./usage.js";
import { runWorker } from "./worker.js";
import { createOrchestratorStreamWriter, info, orchestratorSays } from "./ui.js";

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
  return `你是编程团队的总指挥（orchestrator）。你负责理解用户意图、拆解任务、调度 worker、验收结果；你自己不直接写代码——所有代码改动必须经由 worker 完成。

## 环境
工作目录: ${cwd}

## 你的团队
${roster}

## 决策准则
- 答疑、解释概念、讨论方案：直接回答，不派工
- 需要动代码的任务：先用 list_dir / read_file 快速摸底（只看少量必要的文件，重活留给 worker），再拆解派工
- 用户要求含糊、影响方案取舍时，先向用户澄清再开工
- 大任务拆成边界清晰的子任务，一个子任务对应一次 dispatch_task

## 派工规范
- worker 是全新会话，看不到这里的任何对话。任务描述必须自包含：背景是什么、涉及哪些文件路径、具体要做什么、怎样算完成（验收标准）
- 互不依赖的子任务在同一轮并行发出多个 dispatch_task；有先后依赖的分轮串行派发
- 按团队名册里各 worker 的特长分工：实现类任务派给写码的，质量检查派给审查的

## 验收
- worker 的报告不要照单全收：关键改动用 read_file 抽查，或派审查类 worker 复核
- 发现问题就带着具体反馈重新派工，直到达标或确认无法完成

## 与用户沟通
- 用中文
- 汇报以结论开头：做成了什么、谁做的、验证结果如何；细节放在后面
- 如实转述失败和遗留问题，不粉饰`;
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
  async handle(
    userInput: string,
    signal?: AbortSignal,
  ): Promise<{ reply: string; streamed: boolean; usageDelta: Map<string, UsageEntry> }> {
    this.messages.push({ role: "user", content: userInput });
    const tools = orchestratorTools(this.config);
    const usageBefore = snapshotUsage();
    let prunedNotified = false;
    let interrupted = false;

    for (let i = 0; i < MAX_ITERATIONS; i++) {
      if (signal?.aborted) {
        interrupted = true;
        break;
      }

      const { messages, pruned } = pruneHistory(
        this.messages,
        this.config.contextCharLimit,
      );
      if (pruned && !prunedNotified) {
        info("上下文已裁剪：旧的 tool 结果被替换为占位符以节省 tokens");
        prunedNotified = true;
      }
      this.messages = messages;

      const onText = createOrchestratorStreamWriter();
      const { message: msg } = await chatStream(
        this.config.orchestrator,
        this.config,
        this.messages,
        tools,
        onText,
        signal,
      );
      this.messages.push(msg);

      const toolCalls = msg.tool_calls ?? [];
      if (toolCalls.length === 0) {
        process.stdout.write("\n");
        return {
          reply: msg.content ?? "(指挥模型没有返回内容)",
          streamed: true,
          usageDelta: diffUsage(usageBefore, snapshotUsage()),
        };
      }

      // 伴随工具调用的思路说明已经在流式输出里打印过了
      const results = await Promise.all(
        toolCalls.map(async (tc) => {
          let args: Record<string, unknown> = {};
          try {
            args = JSON.parse(tc.function.arguments || "{}");
          } catch {
            return { id: tc.id, result: "错误: 工具参数不是合法 JSON" };
          }

          if (signal?.aborted) {
            return { id: tc.id, result: "任务被用户中断" };
          }

          try {
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
                signal,
              );
              return { id: tc.id, result: `[${workerName} 的报告]\n${report}` };
            }

            // 指挥自己的轻量工具（read_file / list_dir），只读不写
            const result = await executeTool(tc.function.name, args, {
              cwd: this.cwd,
              workerName: "指挥",
              autoApprove: true,
              signal,
            });
            return { id: tc.id, result };
          } catch (e: any) {
            if (e.name === "AbortError" || signal?.aborted) {
              return { id: tc.id, result: "任务被用户中断" };
            }
            return { id: tc.id, result: `错误: ${e.message}` };
          }
        }),
      );

      for (const r of results) {
        this.messages.push({ role: "tool", tool_call_id: r.id, content: r.result });
      }
    }

    if (interrupted) {
      this.messages.push({
        role: "user",
        content: "[上一个任务被用户中断]",
      });
      return {
        reply: "任务已中断。可以继续输入新指令。",
        streamed: false,
        usageDelta: diffUsage(usageBefore, snapshotUsage()),
      };
    }

    info(`指挥循环达到最大迭代次数 (${MAX_ITERATIONS})`);
    return {
      reply: "本轮指挥循环超出迭代上限，已停止。可以继续对话让我接着处理。",
      streamed: false,
      usageDelta: diffUsage(usageBefore, snapshotUsage()),
    };
  }

  /** 清空对话历史（保留 system prompt） */
  reset() {
    this.messages = this.messages.slice(0, 1);
  }

  /** 序列化会话（不含 system prompt，恢复时会用当前配置重建） */
  serialize(): ChatCompletionMessageParam[] {
    return this.messages.slice(1);
  }

  /** 恢复会话：保留当前 system prompt，替换对话部分 */
  restore(conversation: ChatCompletionMessageParam[]): void {
    this.messages = [
      { role: "system", content: systemPrompt(this.config, this.cwd) },
      ...conversation,
    ];
  }
}
