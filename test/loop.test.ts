import { describe, it, expect, vi, beforeEach } from "vitest";
import { Orchestrator } from "../src/orchestrator.js";
import type { CrewConfig } from "../src/config.js";
import type { ChatCompletionMessage, ChatResult } from "../src/llm.js";

vi.mock("../src/llm.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/llm.js")>();
  return {
    ...actual,
    chatStream: vi.fn(),
  };
});

import { chatStream } from "../src/llm.js";

const config: CrewConfig = {
  orchestrator: { provider: "deepseek", model: "deepseek-chat" },
  workers: {
    coder: {
      provider: "deepseek",
      model: "deepseek-chat",
      description: "写代码",
    },
  },
  providers: {
    deepseek: {
      baseURL: "https://api.deepseek.com/v1",
      apiKeyEnv: "DEEPSEEK_API_KEY",
    },
  },
  autoApprove: false,
  contextCharLimit: 300_000,
};

function assistantMsg(content: string, toolCalls?: ChatCompletionMessage["tool_calls"]): ChatResult {
  return {
    message: {
      role: "assistant",
      content,
      tool_calls: toolCalls,
      refusal: null,
    },
  };
}

function toolCall(id: string, name: string, args: unknown): NonNullable<ChatCompletionMessage["tool_calls"]>[0] {
  return {
    id,
    type: "function",
    function: { name, arguments: JSON.stringify(args) },
  };
}

describe("Orchestrator loop", () => {
  beforeEach(() => {
    vi.stubEnv("DEEPSEEK_API_KEY", "fake-key");
    vi.mocked(chatStream).mockReset();
  });

  it("每个 tool_call 都有配对的 tool result", async () => {
    vi.mocked(chatStream)
      .mockResolvedValueOnce(
        assistantMsg("我去读一下", [toolCall("tc1", "read_file", { path: "a.txt" })]),
      )
      .mockResolvedValueOnce(assistantMsg("读到了"));

    const orch = new Orchestrator(config, "/tmp");
    await orch.handle("读 a.txt");

    const calls = vi.mocked(chatStream).mock.calls;
    expect(calls).toHaveLength(2);
    const secondMessages = calls[1][2] as any[];
    const toolResults = secondMessages.filter((m) => m.role === "tool");
    expect(toolResults).toHaveLength(1);
    expect(toolResults[0].tool_call_id).toBe("tc1");
  });

  it("到达迭代上限返回明确报告", async () => {
    // 每次都返回 tool_call，永远停不下来
    vi.mocked(chatStream).mockResolvedValue(
      assistantMsg("继续", [toolCall("tcN", "list_dir", {})]),
    );

    const orch = new Orchestrator(config, "/tmp");
    const result = await orch.handle("一直循环");

    expect(result.reply).toContain("超出迭代上限");
    expect(vi.mocked(chatStream).mock.calls.length).toBeGreaterThanOrEqual(25);
  });

  it("同一轮多个 tool_call 并行执行", async () => {
    const order: number[] = [];
    vi.mocked(chatStream).mockResolvedValueOnce(
      assistantMsg("并行", [
        toolCall("tc1", "read_file", { path: "a.txt" }),
        toolCall("tc2", "read_file", { path: "b.txt" }),
      ]),
    );
    // We don't care about second call; just verify both results are in first call's follow-up
    vi.mocked(chatStream).mockResolvedValueOnce(assistantMsg("ok"));

    const orch = new Orchestrator(config, "/tmp");
    await orch.handle("读两个文件");

    const secondMessages = vi.mocked(chatStream).mock.calls[1][2] as any[];
    const toolResults = secondMessages.filter((m) => m.role === "tool");
    expect(toolResults).toHaveLength(2);
    expect(toolResults.map((r) => r.tool_call_id).sort()).toEqual(["tc1", "tc2"]);
  });

  it("工具参数 JSON 非法时回填错误不 crash", async () => {
    vi.mocked(chatStream)
      .mockResolvedValueOnce(
        assistantMsg("调用", [
          {
            id: "tc1",
            type: "function",
            function: { name: "read_file", arguments: "not-json" },
          },
        ]),
      )
      .mockResolvedValueOnce(assistantMsg("收到了错误"));

    const orch = new Orchestrator(config, "/tmp");
    await orch.handle("调用");

    const secondMessages = vi.mocked(chatStream).mock.calls[1][2] as any[];
    const toolResult = secondMessages.find((m) => m.role === "tool");
    expect(toolResult?.content).toContain("不是合法 JSON");
  });
});
