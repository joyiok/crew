import { describe, it, expect, beforeEach } from "vitest";
import {
  diffUsage,
  getUsage,
  recordUsage,
  renderUsageLine,
  renderUsageReport,
  resetUsage,
  snapshotUsage,
} from "../src/usage.js";
import type { CrewConfig } from "../src/config.js";

const config: CrewConfig = {
  orchestrator: { provider: "deepseek", model: "deepseek-chat" },
  workers: {},
  providers: {},
  autoApprove: false,
  contextCharLimit: 300_000,
  prices: {
    "deepseek-chat": { input: 2, output: 8 },
  },
};

describe("usage tracker", () => {
  beforeEach(() => resetUsage());

  it("按 provider/model 累计", () => {
    recordUsage(
      { provider: "deepseek", model: "deepseek-chat" },
      { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
    );
    recordUsage(
      { provider: "deepseek", model: "deepseek-chat" },
      { prompt_tokens: 200, completion_tokens: 100, total_tokens: 300 },
    );
    const entry = getUsage().get("deepseek/deepseek-chat")!;
    expect(entry.promptTokens).toBe(300);
    expect(entry.completionTokens).toBe(150);
    expect(entry.calls).toBe(2);
  });

  it("没配价格时只显示 tokens", () => {
    const noPriceConfig = { ...config, prices: undefined };
    recordUsage(
      { provider: "deepseek", model: "deepseek-chat" },
      { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
    );
    const line = renderUsageLine(
      noPriceConfig,
      { provider: "deepseek", model: "deepseek-chat" },
      getUsage().get("deepseek/deepseek-chat")!,
    );
    expect(line).toContain("prompt 100");
    expect(line).not.toContain("¥");
  });

  it("配了价格时显示估算金额", () => {
    recordUsage(
      { provider: "deepseek", model: "deepseek-chat" },
      { prompt_tokens: 1_000_000, completion_tokens: 1_000_000, total_tokens: 2_000_000 },
    );
    const line = renderUsageLine(
      config,
      { provider: "deepseek", model: "deepseek-chat" },
      getUsage().get("deepseek/deepseek-chat")!,
    );
    expect(line).toContain("¥");
  });

  it("snapshot + diff 计算增量", () => {
    const before = snapshotUsage();
    recordUsage(
      { provider: "deepseek", model: "deepseek-chat" },
      { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
    );
    const after = snapshotUsage();
    const delta = diffUsage(before, after);
    expect(delta.get("deepseek/deepseek-chat")?.promptTokens).toBe(100);
  });

  it("renderUsageReport 无记录时返回提示", () => {
    expect(renderUsageReport(config)).toBe("暂无 token 用量记录");
  });
});
