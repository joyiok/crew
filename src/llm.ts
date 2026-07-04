import OpenAI from "openai";
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
    client = new OpenAI({ baseURL: p.baseURL, apiKey });
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

/** 调一次对话补全，带工具定义；返回 assistant message（可能含 tool_calls） */
export async function chat(
  model: ModelConfig,
  config: CrewConfig,
  messages: ChatCompletionMessageParam[],
  tools: ChatCompletionTool[],
): Promise<ChatCompletionMessage> {
  const client = getClient(model.provider, config);
  const res = await client.chat.completions.create({
    model: model.model,
    messages,
    tools: tools.length > 0 ? tools : undefined,
    max_tokens: 8192,
  });
  const choice = res.choices[0];
  if (!choice) throw new Error(`模型 ${model.model} 返回了空响应`);
  return choice.message;
}

export type { ChatCompletionMessageParam, ChatCompletionTool };
