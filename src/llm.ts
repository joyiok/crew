import OpenAI from "openai";
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
  ChatCompletionMessage,
} from "openai/resources/chat/completions";
import { CrewConfig, ModelConfig, resolveProvider } from "./config.js";

const clients = new Map<string, OpenAI>();

function getClient(providerName: string, config: CrewConfig): OpenAI {
  let client = clients.get(providerName);
  if (!client) {
    const p = resolveProvider(providerName, config);
    const apiKey = process.env[p.apiKeyEnv];
    if (!apiKey) {
      throw new Error(
        `缺少环境变量 ${p.apiKeyEnv}（provider "${providerName}" 的 API key）`,
      );
    }
    client = new OpenAI({ baseURL: p.baseURL, apiKey });
    clients.set(providerName, client);
  }
  return client;
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
