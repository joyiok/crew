import { CrewConfig, ModelConfig } from "./config.js";

export interface UsageEntry {
  promptTokens: number;
  completionTokens: number;
  calls: number;
}

export interface ModelPrice {
  input: number; // 元/百万 tokens
  output: number;
}

const tracker = new Map<string, UsageEntry>();

function key(model: ModelConfig): string {
  return `${model.provider}/${model.model}`;
}

/** 上报一次调用的 token 用量 */
export function recordUsage(
  model: ModelConfig,
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number },
): void {
  const k = key(model);
  const entry = tracker.get(k) ?? {
    promptTokens: 0,
    completionTokens: 0,
    calls: 0,
  };
  entry.promptTokens += usage.prompt_tokens;
  entry.completionTokens += usage.completion_tokens;
  entry.calls += 1;
  tracker.set(k, entry);
}

/** 获取累计用量（按 provider/model） */
export function getUsage(): Map<string, UsageEntry> {
  return new Map(tracker);
}

/** 清空用量统计 */
export function resetUsage(): void {
  tracker.clear();
}

/** 生成当前用量的不可变快照 */
export function snapshotUsage(): Map<string, UsageEntry> {
  const copy = new Map<string, UsageEntry>();
  for (const [k, v] of tracker) {
    copy.set(k, { ...v });
  }
  return copy;
}

/** 计算 after - before 的增量用量 */
export function diffUsage(
  before: Map<string, UsageEntry>,
  after: Map<string, UsageEntry>,
): Map<string, UsageEntry> {
  const delta = new Map<string, UsageEntry>();
  for (const [k, afterEntry] of after) {
    const beforeEntry = before.get(k);
    delta.set(k, {
      promptTokens: afterEntry.promptTokens - (beforeEntry?.promptTokens ?? 0),
      completionTokens:
        afterEntry.completionTokens - (beforeEntry?.completionTokens ?? 0),
      calls: afterEntry.calls - (beforeEntry?.calls ?? 0),
    });
  }
  return delta;
}

function priceOf(
  config: CrewConfig,
  model: ModelConfig,
): ModelPrice | undefined {
  return config.prices?.[model.model];
}

function formatYuan(n: number): string {
  if (n < 0.01) return `${(n * 1000).toFixed(2)} 厘`;
  if (n < 1) return `${(n * 100).toFixed(2)} 分`;
  return `¥${n.toFixed(4)}`;
}

function entryCost(entry: UsageEntry, price?: ModelPrice): number | undefined {
  if (!price) return undefined;
  const inputCost = (entry.promptTokens / 1_000_000) * price.input;
  const outputCost = (entry.completionTokens / 1_000_000) * price.output;
  return inputCost + outputCost;
}

/** 渲染一行用量摘要 */
export function renderUsageLine(
  config: CrewConfig,
  model: ModelConfig,
  entry: UsageEntry,
): string {
  const cost = entryCost(entry, priceOf(config, model));
  const costText = cost !== undefined ? ` / 估算 ${formatYuan(cost)}` : "";
  return `${key(model)}: prompt ${entry.promptTokens} / completion ${entry.completionTokens} (共 ${entry.calls} 次调用)${costText}`;
}

/** 渲染会话累计用量表 */
export function renderUsageReport(config: CrewConfig): string {
  const entries = getUsage();
  if (entries.size === 0) return "暂无 token 用量记录";
  const lines = ["会话累计用量："];
  for (const [k, entry] of entries) {
    const [provider, model] = k.split("/");
    const cost = entryCost(entry, priceOf(config, { provider, model }));
    const costText = cost !== undefined ? ` / 估算 ${formatYuan(cost)}` : "";
    lines.push(
      `  ${k}: prompt ${entry.promptTokens} / completion ${entry.completionTokens} (共 ${entry.calls} 次调用)${costText}`,
    );
  }
  return lines.join("\n");
}
