import { describe, it, expect } from "vitest";
import { pruneHistory } from "../src/context.js";
import type { ChatCompletionMessageParam } from "../src/llm.js";

function msg(role: ChatCompletionMessageParam["role"], content: string): ChatCompletionMessageParam {
  return { role, content } as ChatCompletionMessageParam;
}

describe("pruneHistory", () => {
  it("未超限时原样返回", () => {
    const messages = [msg("system", "sys"), msg("user", "hi")];
    const result = pruneHistory(messages, 1000);
    expect(result.pruned).toBe(false);
    expect(result.messages).toEqual(messages);
  });

  it("只裁剪最老的 tool 消息", () => {
    const oldTool = msg("tool", "A".repeat(1000));
    (oldTool as any).tool_call_id = "tc1";
    const newTool = msg("tool", "B".repeat(1000));
    (newTool as any).tool_call_id = "tc2";
    const messages: ChatCompletionMessageParam[] = [
      msg("system", "sys"),
      oldTool,
      msg("user", "hi"),
      msg("assistant", "ok"),
      newTool,
      msg("user", "bye"),
    ];
    const result = pruneHistory(messages, 1500);
    expect(result.pruned).toBe(true);
    expect(result.messages.length).toBe(6);
    expect((result.messages[1] as any).content).toContain("已省略");
    expect((result.messages[4] as any).content).toBe("B".repeat(1000));
  });

  it("不删除消息，保留 tool 配对", () => {
    const tool = msg("tool", "A".repeat(1000));
    (tool as any).tool_call_id = "tc1";
    const messages: ChatCompletionMessageParam[] = [
      msg("system", "sys"),
      msg("assistant", "call"),
      tool,
      msg("user", "hi"),
    ];
    const result = pruneHistory(messages, 100);
    expect(result.messages.length).toBe(4);
    expect(result.messages[2].role).toBe("tool");
    expect((result.messages[2] as any).tool_call_id).toBe("tc1");
  });

  it("system 和最近 4 条消息不被触碰", () => {
    const tool1 = msg("tool", "A".repeat(1000));
    (tool1 as any).tool_call_id = "tc1";
    const recentTool = msg("tool", "B".repeat(1000));
    (recentTool as any).tool_call_id = "tc2";
    const messages: ChatCompletionMessageParam[] = [
      msg("system", "S".repeat(2000)),
      tool1,
      msg("user", "a"),
      msg("assistant", "b"),
      msg("user", "c"),
      recentTool,
      msg("user", "d"),
    ];
    const result = pruneHistory(messages, 500);
    expect(result.pruned).toBe(true);
    expect((result.messages[0] as any).content).toBe("S".repeat(2000));
    expect((result.messages[5] as any).content).toBe("B".repeat(1000));
  });
});
