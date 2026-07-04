import OpenAI from "openai";
import {
  APIConnectionError,
  APIConnectionTimeoutError,
  type APIError,
} from "openai/error";
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
  ChatCompletionMessage,
} from "openai/resources/chat/completions";
import {
  CrewConfig,
  ModelConfig,
  ProviderConfig,
  resolveProvider,
} from "./config.js";
import { resolveApiKey } from "./credentials.js";
import { recordUsage } from "./usage.js";
import { info } from "./ui.js";

const clients = new Map<string, OpenAI>();

function getClient(providerName: string, config: CrewConfig): OpenAI {
  let client = clients.get(providerName);
  if (!client) {
    const p = resolveProvider(providerName, config);
    const apiKey = resolveApiKey(providerName, p);
    if (!apiKey) {
      throw new Error(
        `缺少 provider "${providerName}" 的 API key，用 /login ${providerName} 配置，或 export ${p.apiKeyEnv}=...`,
      );
    }
    client = new OpenAI({ baseURL: p.baseURL, apiKey, maxRetries: 0 });
    clients.set(providerName, client);
  }
  return client;
}

/** /login 换 key 后调用，丢弃缓存的旧客户端 */
export function resetClients() {
  clients.clear();
}

/**
 * 用 GET /models 探测 key 是否有效。
 * 认证失败（401/403）判为无效；网络类错误放行并附警告——不因为断网卡死引导流程。
 */
export async function validateApiKey(
  pc: ProviderConfig,
  key: string,
): Promise<{ ok: boolean; warning?: string }> {
  const client = new OpenAI({
    baseURL: pc.baseURL,
    apiKey: key,
    timeout: 10_000,
    maxRetries: 0,
  });
  try {
    await client.models.list();
    return { ok: true };
  } catch (e: any) {
    if (e?.status === 401 || e?.status === 403) {
      return { ok: false };
    }
    return {
      ok: true,
      warning: `无法完全验证（${e?.message ?? e}），已先保存；若调用报错请用 /login 重新配置`,
    };
  }
}

function isRetryableError(e: unknown): boolean {
  if (e instanceof APIConnectionError || e instanceof APIConnectionTimeoutError)
    return true;
  const status = (e as APIError | undefined)?.status;
  if (status === 429) return true;
  if (typeof status === "number" && status >= 500) return true;
  return false;
}

function retryDelayMs(e: unknown, attempt: number): number {
  // 429 优先读响应头的 retry-after（秒）
  const headers = (e as APIError | undefined)?.headers;
  const retryAfter =
    headers?.["retry-after"] ?? headers?.["Retry-After"] ?? undefined;
  if (typeof retryAfter === "string" || typeof retryAfter === "number") {
    const seconds = Number(retryAfter);
    if (!Number.isNaN(seconds) && seconds > 0) return seconds * 1000;
  }
  // 指数退避：1s -> 2s -> 4s -> 8s
  return 1000 * 2 ** attempt;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 调一次对话补全，带工具定义；返回 assistant message（可能含 tool_calls） */
export async function chat(
  model: ModelConfig,
  config: CrewConfig,
  messages: ChatCompletionMessageParam[],
  tools: ChatCompletionTool[],
  signal?: AbortSignal,
): Promise<ChatCompletionMessage> {
  const client = getClient(model.provider, config);
  const maxRetries = 4;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const res = await client.chat.completions.create(
        {
          model: model.model,
          messages,
          tools: tools.length > 0 ? tools : undefined,
          max_tokens: 8192,
        },
        { signal },
      );
      if (res.usage) recordUsage(model, res.usage);
      const choice = res.choices[0];
      if (!choice) throw new Error(`模型 ${model.model} 返回了空响应`);
      return choice.message;
    } catch (e: any) {
      if (attempt === maxRetries || !isRetryableError(e)) throw e;
      const delay = retryDelayMs(e, attempt);
      const reason = e.status === 429 ? "限流" : "服务端错误或网络超时";
      info(`${reason}（${e.status ?? "连接"}），${delay / 1000} 秒后第 ${attempt + 1} 次重试...`);
      await sleep(delay);
    }
  }

  throw new Error("重试次数耗尽，不应到达这里");
}

export interface ChatResult {
  message: ChatCompletionMessage;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

interface AggregatedToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

/**
 * 流式对话补全。文本增量通过 onText 回调即时输出；tool_calls 增量会在内部
 * 聚合成完整的 ChatCompletionMessage 后返回。最后一条 chunk 的 usage 会一并返回。
 *
 * 与重试策略结合：首 chunk 到达前发生的可重试错误会按指数退避重试；首 chunk
 * 到达后再失败直接抛出，避免重复输出。
 */
export async function chatStream(
  model: ModelConfig,
  config: CrewConfig,
  messages: ChatCompletionMessageParam[],
  tools: ChatCompletionTool[],
  onText: (text: string) => void,
  signal?: AbortSignal,
): Promise<ChatResult> {
  const client = getClient(model.provider, config);
  const maxRetries = 4;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let firstChunkReceived = false;
    try {
      const stream = await client.chat.completions.create(
        {
          model: model.model,
          messages,
          tools: tools.length > 0 ? tools : undefined,
          max_tokens: 8192,
          stream: true,
          stream_options: { include_usage: true },
        },
        { signal },
      );

      let content = "";
      const toolCalls: AggregatedToolCall[] = [];
      let usage: ChatResult["usage"];

      for await (const chunk of stream) {
        firstChunkReceived = true;
        const delta = chunk.choices[0]?.delta;
        if (!delta) {
          // usage-only chunk（最后一个）
          if (chunk.usage) {
            usage = {
              prompt_tokens: chunk.usage.prompt_tokens,
              completion_tokens: chunk.usage.completion_tokens,
              total_tokens: chunk.usage.total_tokens,
            };
          }
          continue;
        }

        if (delta.content) {
          content += delta.content;
          onText(delta.content);
        }

        if (delta.tool_calls) {
          for (const part of delta.tool_calls) {
            const idx = part.index ?? 0;
            if (!toolCalls[idx]) {
              toolCalls[idx] = {
                id: part.id ?? "",
                type: "function",
                function: { name: "", arguments: "" },
              };
            }
            if (part.function?.name) {
              toolCalls[idx].function.name += part.function.name;
            }
            if (part.function?.arguments) {
              toolCalls[idx].function.arguments += part.function.arguments;
            }
            if (part.id && !toolCalls[idx].id) {
              toolCalls[idx].id = part.id;
            }
          }
        }

        if (chunk.usage) {
          usage = {
            prompt_tokens: chunk.usage.prompt_tokens,
            completion_tokens: chunk.usage.completion_tokens,
            total_tokens: chunk.usage.total_tokens,
          };
        }
      }

      const message: ChatCompletionMessage = {
        role: "assistant",
        content: content || null,
        tool_calls:
          toolCalls.length > 0
            ? toolCalls.filter((tc) => tc.id).map((tc) => ({
                id: tc.id,
                type: tc.type,
                function: tc.function,
              }))
            : undefined,
        refusal: null,
      };

      if (usage) recordUsage(model, usage);
      return { message, usage };
    } catch (e: any) {
      // 首 chunk 到达后不再重试，避免重复输出
      const canRetry = !firstChunkReceived && isRetryableError(e);
      if (attempt === maxRetries || !canRetry) throw e;
      const delay = retryDelayMs(e, attempt);
      const reason = e.status === 429 ? "限流" : "服务端错误或网络超时";
      info(`${reason}（${e.status ?? "连接"}），${delay / 1000} 秒后第 ${attempt + 1} 次重试...`);
      await sleep(delay);
    }
  }

  throw new Error("流式重试次数耗尽，不应到达这里");
}

export type { ChatCompletionMessageParam, ChatCompletionTool };
