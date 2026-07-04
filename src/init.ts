import fs from "node:fs";
import path from "node:path";
import {
  BUILTIN_PROVIDERS,
  CONFIG_FILE,
  CrewConfig,
  ProviderConfig,
} from "./config.js";
import { ask, info, banner, error } from "./ui.js";

interface InitAnswers {
  orchestratorProvider: string;
  orchestratorModel: string;
  workers: Array<{
    name: string;
    provider: string;
    model: string;
    description: string;
  }>;
  customProviders: Record<string, ProviderConfig>;
}

function providerChoices(existingCustom: Record<string, ProviderConfig>): {
  name: string;
  config: ProviderConfig;
}[] {
  const map = new Map<string, ProviderConfig>();
  for (const [name, cfg] of Object.entries(BUILTIN_PROVIDERS)) {
    map.set(name, cfg);
  }
  for (const [name, cfg] of Object.entries(existingCustom)) {
    map.set(name, cfg);
  }
  return Array.from(map.entries()).map(([name, config]) => ({ name, config }));
}

async function askProvider(
  prompt: string,
  choices: { name: string; config: ProviderConfig }[],
): Promise<string> {
  info(`\n${prompt}`);
  choices.forEach((c, i) => {
    info(`  ${i + 1}. ${c.name}`);
  });
  info("  0. 添加新的 OpenAI 兼容厂商");
  const answer = (await ask("选择编号: ")).trim();
  const idx = Number(answer);
  if (answer === "0" || Number.isNaN(idx) || idx < 1 || idx > choices.length) {
    return "__custom__";
  }
  return choices[idx - 1].name;
}

async function askCustomProvider(): Promise<{ name: string; config: ProviderConfig }> {
  const name = (await ask("厂商名称（如 my-proxy）: ")).trim();
  const baseURL = (await ask("baseURL（如 https://api.example.com/v1）: ")).trim();
  const apiKeyEnv = (await ask("API key 环境变量名（如 MY_API_KEY）: ")).trim();
  return { name, config: { baseURL, apiKeyEnv } };
}

async function askModel(defaultModel?: string): Promise<string> {
  const model = (await ask(defaultModel ? `模型（默认 ${defaultModel}）: ` : "模型: ")).trim();
  return model || defaultModel || "";
}

async function askYesNo(prompt: string): Promise<boolean> {
  const answer = (await ask(`${prompt} [y/N] `)).trim().toLowerCase();
  return answer === "y";
}

export async function runInit(cwd: string): Promise<void> {
  banner("═══ crew init — 初始化配置 ═══");

  const existingPath = path.join(cwd, CONFIG_FILE);
  let existingCustom: Record<string, ProviderConfig> = {};
  if (fs.existsSync(existingPath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(existingPath, "utf8"));
      existingCustom = raw.providers ?? {};
      info(`检测到已有 ${CONFIG_FILE}，会合并自定义厂商列表。\n`);
    } catch {
      error(`读取 ${CONFIG_FILE} 失败，会覆盖。`);
    }
  }

  const answers: InitAnswers = {
    orchestratorProvider: "",
    orchestratorModel: "",
    workers: [],
    customProviders: existingCustom,
  };

  let choices = providerChoices(answers.customProviders);

  // 指挥模型
  while (true) {
    const provider = await askProvider("选择指挥模型厂商", choices);
    if (provider === "__custom__") {
      const custom = await askCustomProvider();
      answers.customProviders[custom.name] = custom.config;
      choices = providerChoices(answers.customProviders);
      answers.orchestratorProvider = custom.name;
    } else {
      answers.orchestratorProvider = provider;
    }
    answers.orchestratorModel = await askModel("deepseek-chat");
    if (answers.orchestratorModel) break;
    error("模型不能为空");
  }

  // Worker
  while (true) {
    info("\n添加 worker");
    const name = (await ask("worker 名称（如 coder、reviewer）: ")).trim();
    if (!name) {
      error("名称不能为空");
      continue;
    }
    const provider = await askProvider(`选择 ${name} 的厂商`, choices);
    let workerProvider = provider;
    if (provider === "__custom__") {
      const custom = await askCustomProvider();
      answers.customProviders[custom.name] = custom.config;
      choices = providerChoices(answers.customProviders);
      workerProvider = custom.name;
    }
    const model = await askModel();
    if (!model) {
      error("模型不能为空");
      continue;
    }
    const description = (await ask("能力描述（给指挥模型看的分工说明）: ")).trim();
    answers.workers.push({
      name,
      provider: workerProvider,
      model,
      description: description || `${workerProvider}/${model} worker`,
    });

    if (!(await askYesNo("是否继续添加 worker？"))) break;
  }

  if (answers.workers.length === 0) {
    error("至少需要一个 worker");
    process.exit(1);
  }

  const config: Partial<CrewConfig> = {
    orchestrator: {
      provider: answers.orchestratorProvider,
      model: answers.orchestratorModel,
    },
    workers: answers.workers.reduce((acc, w) => {
      acc[w.name] = {
        provider: w.provider,
        model: w.model,
        description: w.description,
      };
      return acc;
    }, {} as Record<string, { provider: string; model: string; description: string }>),
  };

  if (Object.keys(answers.customProviders).length > 0) {
    config.providers = answers.customProviders;
  }

  fs.writeFileSync(existingPath, JSON.stringify(config, null, 2) + "\n", "utf8");
  info(`\n已写入 ${CONFIG_FILE}`);
}
