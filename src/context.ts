import type { ChatCompletionMessageParam } from "./llm.js";

const TOOL_CONTENT_PLACEHOLDER =
  "[工具结果已省略以节省上下文：原 {chars} 字符]";
const MIN_TOOL_CONTENT_LENGTH = 500;
const ALWAYS_KEEP_LAST_N = 4;

function messageChars(m: ChatCompletionMessageParam): number {
  if (typeof m.content === "string") return m.content.length;
  if (Array.isArray(m.content)) {
    return m.content.reduce((sum, part) => sum + JSON.stringify(part).length, 0);
  }
  return 0;
}

function totalChars(messages: ChatCompletionMessageParam[]): number {
  return messages.reduce((sum, m) => sum + messageChars(m), 0);
}

export interface PruneResult {
  messages: ChatCompletionMessageParam[];
  pruned: boolean;
}

/**
 * 上下文裁剪：超限时把最老的 tool 结果替换为占位字符串，只改 content 不删消息。
 * system prompt 和最近 4 条消息永不触碰，保证 tool_call/tool result 配对完整。
 */
export function pruneHistory(
  messages: ChatCompletionMessageParam[],
  limit: number,
): PruneResult {
  if (messages.length <= 1 || totalChars(messages) <= limit) {
    return { messages, pruned: false };
  }

  const pruned = messages.map((m) => ({ ...m }));
  let changed = false;

  while (totalChars(pruned) > limit) {
    let found = false;
    // 从老到新扫描，跳过 system（索引 0）和最后 4 条
    for (let i = 1; i < pruned.length - ALWAYS_KEEP_LAST_N; i++) {
      const m = pruned[i];
      if (m.role !== "tool" || typeof m.content !== "string") continue;
      if (m.content.length <= MIN_TOOL_CONTENT_LENGTH) continue;
      const chars = m.content.length;
      m.content = TOOL_CONTENT_PLACEHOLDER.replace("{chars}", String(chars));
      changed = true;
      found = true;
      if (totalChars(pruned) <= limit) break;
    }
    if (!found) break; // 没有可裁剪的了
  }

  return { messages: pruned, pruned: changed };
}
