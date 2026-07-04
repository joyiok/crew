import readline from "node:readline";

const COLORS = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  yellow: "\x1b[33m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  blue: "\x1b[34m",
};

const WORKER_COLORS = [COLORS.cyan, COLORS.green, COLORS.blue, COLORS.yellow];
const workerColorMap = new Map<string, string>();

function workerColor(name: string): string {
  let c = workerColorMap.get(name);
  if (!c) {
    c = WORKER_COLORS[workerColorMap.size % WORKER_COLORS.length];
    workerColorMap.set(name, c);
  }
  return c;
}

export const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

export function ask(prompt: string): Promise<string> {
  return new Promise((resolve) => rl.question(prompt, resolve));
}

/** 询问敏感输入（API key 等）：输入过程不回显，只在回车时换行 */
export function askSecret(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    const anyRl = rl as unknown as {
      _writeToOutput?: (s: string) => void;
      output: NodeJS.WritableStream;
    };
    process.stdout.write(prompt);
    anyRl._writeToOutput = (s: string) => {
      if (s.includes("\n") || s.includes("\r")) anyRl.output.write("\r\n");
    };
    rl.question("", (answer) => {
      delete anyRl._writeToOutput;
      resolve(answer.trim());
    });
  });
}

// 多个 worker 并行跑时，确认提示要排队逐个出现，避免交错
let confirmQueue: Promise<unknown> = Promise.resolve();

/** 向用户请求确认（y/n），并行调用时自动串行化 */
export function confirm(question: string): Promise<boolean> {
  const result = confirmQueue.then(async () => {
    const answer = await ask(
      `${COLORS.yellow}${question} [y/N]${COLORS.reset} `,
    );
    return answer.trim().toLowerCase() === "y";
  });
  confirmQueue = result.catch(() => {});
  return result;
}

/**
 * 请求用户确认一次写操作，展示 diff。拒绝时可填写原因。
 * 返回 { ok, reason }，reason 仅在拒绝时可能非空。
 */
export async function confirmWrite(diff: string): Promise<{ ok: boolean; reason?: string }> {
  const ok = await confirm(`是否应用以下修改？\n${COLORS.dim}${diff}${COLORS.reset}\n确认`);
  if (ok) return { ok: true };
  const reason = (await ask("拒绝原因（可选，直接回车跳过）: ")).trim();
  return { ok: false, reason: reason || undefined };
}

export function banner(text: string) {
  console.log(`${COLORS.bold}${COLORS.magenta}${text}${COLORS.reset}`);
}

export function orchestratorSays(text: string) {
  console.log(`${COLORS.magenta}${COLORS.bold}[指挥]${COLORS.reset} ${text}`);
}

/**
 * 创建一个流式输出写入器：第一次写入时把 label 打到行首，后续增量直接追加。
 * 调用方需要在流结束时自行换行。
 */
export function createStreamWriter(prefix: string): (text: string) => void {
  let started = false;
  return (text: string) => {
    if (!started) {
      process.stdout.write(prefix);
      started = true;
    }
    process.stdout.write(text);
  };
}

export function createOrchestratorStreamWriter(): (text: string) => void {
  return createStreamWriter(
    `${COLORS.magenta}${COLORS.bold}[指挥]${COLORS.reset} `,
  );
}

export function createWorkerStreamWriter(name: string): (text: string) => void {
  const c = workerColor(name);
  return createStreamWriter(`${c}[${name}]${COLORS.reset} `);
}

export function workerEvent(name: string, event: string) {
  const c = workerColor(name);
  console.log(`${c}[${name}]${COLORS.reset} ${COLORS.dim}${event}${COLORS.reset}`);
}

export function workerSays(name: string, text: string) {
  const c = workerColor(name);
  console.log(`${c}[${name}]${COLORS.reset} ${text}`);
}

export function info(text: string) {
  console.log(`${COLORS.dim}${text}${COLORS.reset}`);
}

export function error(text: string) {
  console.log(`${COLORS.red}✗ ${text}${COLORS.reset}`);
}
