import fs from "node:fs";
import path from "node:path";

/** 一个模型端点的定义：接哪个厂商、用哪个模型 */
export interface ModelConfig {
  provider: string;
  model: string;
}

/** 自定义厂商（config 里可扩展，不限于内置的三家） */
export interface ProviderConfig {
  baseURL: string;
  apiKeyEnv: string;
}

export interface WorkerConfig extends ModelConfig {
  /** 给指挥模型看的能力描述，影响任务怎么分派 */
  description: string;
}

export interface CrewConfig {
  orchestrator: ModelConfig;
  workers: Record<string, WorkerConfig>;
  providers: Record<string, ProviderConfig>;
  /** true 时执行 shell 命令不再逐条向用户确认 */
  autoApprove: boolean;
}

/** 内置的 OpenAI 兼容厂商 */
export const BUILTIN_PROVIDERS: Record<string, ProviderConfig> = {
  deepseek: {
    baseURL: "https://api.deepseek.com/v1",
    apiKeyEnv: "DEEPSEEK_API_KEY",
  },
  qwen: {
    baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    apiKeyEnv: "DASHSCOPE_API_KEY",
  },
  kimi: {
    baseURL: "https://api.moonshot.cn/v1",
    apiKeyEnv: "MOONSHOT_API_KEY",
  },
};

const DEFAULT_CONFIG: CrewConfig = {
  orchestrator: { provider: "deepseek", model: "deepseek-chat" },
  workers: {
    coder: {
      provider: "deepseek",
      model: "deepseek-chat",
      description: "写代码、改代码、跑测试的主力执行者",
    },
    reviewer: {
      provider: "deepseek",
      model: "deepseek-chat",
      description: "审查代码质量、找 bug、提改进建议",
    },
  },
  providers: {},
  autoApprove: false,
};

export const CONFIG_FILE = "crew.config.json";

/** 从当前目录加载 crew.config.json，缺失字段用默认值补齐 */
export function loadConfig(cwd: string): CrewConfig {
  const file = path.join(cwd, CONFIG_FILE);
  if (!fs.existsSync(file)) return DEFAULT_CONFIG;
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  return {
    orchestrator: raw.orchestrator ?? DEFAULT_CONFIG.orchestrator,
    workers: raw.workers ?? DEFAULT_CONFIG.workers,
    providers: raw.providers ?? {},
    autoApprove: raw.autoApprove ?? false,
  };
}

export function resolveProvider(
  name: string,
  config: CrewConfig,
): ProviderConfig {
  const p = config.providers[name] ?? BUILTIN_PROVIDERS[name];
  if (!p) {
    throw new Error(
      `未知的 provider "${name}"，内置支持: ${Object.keys(BUILTIN_PROVIDERS).join(", ")}，或在 ${CONFIG_FILE} 的 providers 里自定义`,
    );
  }
  return p;
}
