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

export function banner(text: string) {
  console.log(`${COLORS.bold}${COLORS.magenta}${text}${COLORS.reset}`);
}

export function orchestratorSays(text: string) {
  console.log(`${COLORS.magenta}${COLORS.bold}[指挥]${COLORS.reset} ${text}`);
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
