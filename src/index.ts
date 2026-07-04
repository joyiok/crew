#!/usr/bin/env node
import {
  loadConfig,
  resolveProvider,
  CrewConfig,
  ProviderConfig,
  CONFIG_FILE,
} from "./config.js";
import { CRED_FILE, resolveApiKey, saveKey } from "./credentials.js";
import { resetClients, validateApiKey } from "./llm.js";
import { Orchestrator } from "./orchestrator.js";
import {
  ask,
  askSecret,
  banner,
  error,
  info,
  orchestratorSays,
  rl,
} from "./ui.js";

const HELP = `命令:
  /models            查看当前的指挥模型和 worker 配置
  /login [provider]  重新配置某个厂商的 API key（不带参数则逐个配置）
  /clear             清空对话历史
  /help              显示本帮助
  /exit              退出
其余输入会交给指挥模型处理。`;

/** 各厂商的 key 申请页，引导时展示 */
const KEY_URLS: Record<string, string> = {
  deepseek: "https://platform.deepseek.com/api_keys",
  qwen: "https://bailian.console.aliyun.com (阿里云百炼 → API-KEY)",
  kimi: "https://platform.moonshot.cn/console/api-keys",
};

/** 本次会话实际会用到的 provider 集合（指挥 + 所有 worker） */
function neededProviders(config: CrewConfig): string[] {
  return [
    ...new Set([
      config.orchestrator.provider,
      ...Object.values(config.workers).map((w) => w.provider),
    ]),
  ];
}

/** 引导用户为一个 provider 配置 key：提示申请地址 → 隐藏输入 → 在线验证 → 保存 */
async function setupProvider(name: string, pc: ProviderConfig) {
  console.log();
  info(`需要配置 provider "${name}" 的 API key`);
  if (KEY_URLS[name]) info(`  申请地址: ${KEY_URLS[name]}`);
  info(`  （也可以用环境变量 ${pc.apiKeyEnv}，优先级高于保存的 key）`);

  while (true) {
    const key = await askSecret(`请粘贴 ${name} 的 API Key（输入不回显，回车确认）: `);
    if (!key) {
      error("API key 不能为空，请重新输入（Ctrl+C 退出）");
      continue;
    }
    process.stdout.write("正在验证 ... ");
    const result = await validateApiKey(pc, key);
    if (!result.ok) {
      console.log("✗");
      error("认证失败（401），这个 key 无效，请检查后重新输入");
      continue;
    }
    console.log("✓");
    if (result.warning) info(result.warning);
    saveKey(name, key);
    info(`已保存到 ${CRED_FILE}（仅本机，权限 600）`);
    return;
  }
}

/** 启动时确保所有会用到的 provider 都有 key，缺哪个就引导哪个 */
async function ensureCredentials(config: CrewConfig) {
  for (const name of neededProviders(config)) {
    const pc = resolveProvider(name, config);
    if (!resolveApiKey(name, pc)) {
      await setupProvider(name, pc);
    }
  }
}

async function handleLogin(arg: string, config: CrewConfig) {
  const targets = arg ? [arg] : neededProviders(config);
  for (const name of targets) {
    try {
      await setupProvider(name, resolveProvider(name, config));
    } catch (e: any) {
      error(e.message);
      return;
    }
  }
  resetClients(); // 丢掉缓存的旧客户端，让新 key 生效
}

async function main() {
  const cwd = process.cwd();
  const config = loadConfig(cwd);

  if (process.argv.includes("--yes") || process.argv.includes("-y")) {
    config.autoApprove = true;
  }

  // 用户 Ctrl+D 或输入流结束时干净退出
  rl.on("close", () => process.exit(0));

  banner("═══ crew — 多模型协作 coding 工具 ═══");
  info(`工作目录: ${cwd}`);
  info(
    `指挥: ${config.orchestrator.provider}/${config.orchestrator.model} | worker: ${Object.keys(config.workers).join(", ")}`,
  );
  info(
    config.autoApprove
      ? "自动批准模式：执行命令不再逐条确认"
      : "命令执行需要确认（用 --yes 跳过）",
  );
  info(`配置文件: ${CONFIG_FILE}（当前目录，可选）；输入 /help 查看命令\n`);

  try {
    await ensureCredentials(config);
  } catch (e: any) {
    error(e.message);
    process.exit(1);
  }

  const orchestrator = new Orchestrator(config, cwd);

  while (true) {
    const input = (await ask("\x1b[1m你> \x1b[0m")).trim();
    if (!input) continue;

    if (input === "/exit" || input === "/quit") break;
    if (input === "/help") {
      console.log(HELP);
      continue;
    }
    if (input === "/clear") {
      orchestrator.reset();
      info("对话历史已清空");
      continue;
    }
    if (input === "/models") {
      console.log(
        `指挥: ${config.orchestrator.provider}/${config.orchestrator.model}`,
      );
      for (const [name, w] of Object.entries(config.workers)) {
        console.log(
          `worker ${name}: ${w.provider}/${w.model} — ${w.description}`,
        );
      }
      continue;
    }
    if (input === "/login" || input.startsWith("/login ")) {
      await handleLogin(input.slice("/login".length).trim(), config);
      continue;
    }
    if (input.startsWith("/")) {
      error(`未知命令 ${input.split(" ")[0]}`);
      console.log(HELP);
      continue;
    }

    try {
      const reply = await orchestrator.handle(input);
      console.log();
      orchestratorSays(reply);
      console.log();
    } catch (e: any) {
      error(`出错了: ${e.message}`);
    }
  }

  rl.close();
}

main();
