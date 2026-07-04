#!/usr/bin/env node
import { loadConfig, CONFIG_FILE, resolveProvider } from "./config.js";
import { Orchestrator } from "./orchestrator.js";
import { ask, banner, error, info, orchestratorSays, rl } from "./ui.js";

const HELP = `命令:
  /models   查看当前的指挥模型和 worker 配置
  /clear    清空对话历史
  /help     显示本帮助
  /exit     退出
其余输入会交给指挥模型处理。`;

async function main() {
  const cwd = process.cwd();
  const config = loadConfig(cwd);

  if (process.argv.includes("--yes") || process.argv.includes("-y")) {
    config.autoApprove = true;
  }

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
  info(`配置文件: ${CONFIG_FILE}（当前目录，可选）\n${HELP}\n`);

  // 提前检查 API key，避免聊到一半才报错
  try {
    const providers = new Set([
      config.orchestrator.provider,
      ...Object.values(config.workers).map((w) => w.provider),
    ]);
    for (const p of providers) {
      const pc = resolveProvider(p, config);
      if (!process.env[pc.apiKeyEnv]) {
        error(`缺少环境变量 ${pc.apiKeyEnv}（provider "${p}"）`);
        info(`  export ${pc.apiKeyEnv}=sk-...`);
        process.exit(1);
      }
    }
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
        console.log(`worker ${name}: ${w.provider}/${w.model} — ${w.description}`);
      }
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
