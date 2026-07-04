import fs from "node:fs";
import path from "node:path";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import picomatch from "picomatch";
import type { ChatCompletionTool } from "./llm.js";
import { confirm, confirmWrite, workerEvent } from "./ui.js";
import { createTwoFilesPatch } from "diff";

const execAsync = promisify(exec);

const MAX_FILE_CHARS = 60_000;
const MAX_OUTPUT_CHARS = 8_000;
const COMMAND_TIMEOUT_MS = 120_000;
const MAX_GREP_RESULTS = 100;
const MAX_GLOB_RESULTS = 200;
const MAX_WALK_DEPTH = 12;
const IGNORED_DIRS = new Set(["node_modules", ".git", "dist", ".crew"]);

/** 把模型给的路径限制在工作目录内，防止越权读写 */
function safePath(cwd: string, p: string): string {
  const resolved = path.resolve(cwd, p);
  if (resolved !== cwd && !resolved.startsWith(cwd + path.sep)) {
    throw new Error(`路径越出工作目录: ${p}`);
  }
  return resolved;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + `\n...[截断，共 ${text.length} 字符]`;
}

function makeDiff(path: string, oldContent: string, newContent: string): string {
  if (oldContent === newContent) return "（无变化）";
  return createTwoFilesPatch(path, path, oldContent, newContent, "旧版本", "新版本");
}

function rejectionMessage(reason?: string): string {
  return reason
    ? `用户拒绝了这次修改：${reason}`
    : "用户拒绝了这次修改";
}

function isBinaryFile(filePath: string): boolean {
  try {
    const fd = fs.openSync(filePath, "r");
    const buf = Buffer.alloc(512);
    const bytes = fs.readSync(fd, buf, 0, 512, 0);
    fs.closeSync(fd);
    for (let i = 0; i < bytes; i++) {
      if (buf[i] === 0) return true;
    }
    return false;
  } catch {
    return true;
  }
}

function* walkFiles(
  dir: string,
  relativeRoot: string,
  depth = 0,
): Generator<string> {
  if (depth > MAX_WALK_DEPTH) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name)) continue;
      yield* walkFiles(path.join(dir, entry.name), relativeRoot, depth + 1);
    } else if (entry.isFile()) {
      yield path.relative(relativeRoot, path.join(dir, entry.name));
    }
  }
}

function searchFiles(
  cwd: string,
  rootRel: string,
  pattern: RegExp,
  globMatcher: picomatch.Matcher | null,
): string[] {
  const root = path.join(cwd, rootRel);
  const results: string[] = [];
  for (const rel of walkFiles(root, cwd)) {
    if (globMatcher && !globMatcher(rel)) continue;
    const full = path.join(cwd, rel);
    if (isBinaryFile(full)) continue;
    const content = fs.readFileSync(full, "utf8");
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (pattern.test(lines[i])) {
        results.push(`${rel}:${i + 1}: ${lines[i].trimEnd()}`);
        if (results.length >= MAX_GREP_RESULTS) {
          results.push(`...[结果超过 ${MAX_GREP_RESULTS} 条，请收窄 pattern]`);
          return results;
        }
      }
    }
  }
  return results;
}

function globFiles(cwd: string, pattern: string): string[] {
  const isMatch = picomatch(pattern);
  const results: string[] = [];
  for (const rel of walkFiles(cwd, cwd)) {
    if (isMatch(rel)) {
      results.push(rel);
      if (results.length >= MAX_GLOB_RESULTS) {
        results.push(`...[结果超过 ${MAX_GLOB_RESULTS} 条，请收窄 pattern]`);
        return results;
      }
    }
  }
  return results;
}

export const WORKER_TOOLS: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "read_file",
      description: "读取一个文本文件的内容",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "相对于工作目录的文件路径" },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "写入文件（覆盖已有内容），父目录不存在会自动创建",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "相对于工作目录的文件路径" },
          content: { type: "string", description: "完整的文件内容" },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "edit_file",
      description:
        "对文件做精确的字符串替换。old_string 必须在文件中恰好出现一次",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "相对于工作目录的文件路径" },
          old_string: { type: "string", description: "要被替换的原文" },
          new_string: { type: "string", description: "替换后的新文本" },
        },
        required: ["path", "old_string", "new_string"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_dir",
      description: "列出目录内容，目录名以 / 结尾",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "相对于工作目录的目录路径，默认为工作目录本身",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_command",
      description:
        "在工作目录下执行 shell 命令（如运行测试、安装依赖），返回 stdout/stderr。超时 120 秒",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "要执行的 shell 命令" },
        },
        required: ["command"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "grep",
      description:
        "按正则表达式搜索文件内容，返回 路径:行号:行内容。探索代码时优先用 grep/glob 定位相关文件，其次才逐个 read_file",
      parameters: {
        type: "object",
        properties: {
          pattern: {
            type: "string",
            description: "JavaScript 正则表达式字符串（如 \"function foo\"）",
          },
          path: {
            type: "string",
            description: "相对于工作目录的搜索起点，默认为工作目录本身",
          },
          glob: {
            type: "string",
            description: "文件名过滤模式（可选），如 *.ts",
          },
        },
        required: ["pattern"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "glob",
      description:
        "按模式匹配文件路径，如 **/*.ts。探索代码时优先用 grep/glob 定位相关文件，其次才逐个 read_file",
      parameters: {
        type: "object",
        properties: {
          pattern: {
            type: "string",
            description: "glob 模式，如 **/*.ts、src/**/*.test.ts",
          },
        },
        required: ["pattern"],
      },
    },
  },
];

export interface ToolContext {
  cwd: string;
  workerName: string;
  autoApprove: boolean;
  signal?: AbortSignal;
}

/** 执行一个工具调用，返回给模型的结果字符串。出错时返回错误描述而不是抛出 */
export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<string> {
  try {
    switch (name) {
      case "read_file": {
        const p = safePath(ctx.cwd, String(args.path));
        workerEvent(ctx.workerName, `读取 ${args.path}`);
        return truncate(fs.readFileSync(p, "utf8"), MAX_FILE_CHARS);
      }
      case "write_file": {
        const p = safePath(ctx.cwd, String(args.path));
        const content = String(args.content);
        const oldContent = fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "";
        if (!ctx.autoApprove) {
          const diff = makeDiff(String(args.path), oldContent, content);
          const { ok, reason } = await confirmWrite(diff);
          if (!ok) return rejectionMessage(reason);
        }
        workerEvent(ctx.workerName, `写入 ${args.path}`);
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, content, "utf8");
        return `已写入 ${args.path}`;
      }
      case "edit_file": {
        const p = safePath(ctx.cwd, String(args.path));
        const oldStr = String(args.old_string);
        const newStr = String(args.new_string);
        const content = fs.readFileSync(p, "utf8");
        const count = content.split(oldStr).length - 1;
        if (count === 0) return `错误: old_string 在文件中不存在`;
        if (count > 1)
          return `错误: old_string 出现了 ${count} 次，请提供更长的唯一上下文`;
        const newContent = content.replace(oldStr, newStr);
        if (!ctx.autoApprove) {
          const diff = makeDiff(String(args.path), content, newContent);
          const { ok, reason } = await confirmWrite(diff);
          if (!ok) return rejectionMessage(reason);
        }
        workerEvent(ctx.workerName, `编辑 ${args.path}`);
        fs.writeFileSync(p, newContent, "utf8");
        return `已编辑 ${args.path}`;
      }
      case "list_dir": {
        const p = safePath(ctx.cwd, String(args.path ?? "."));
        const entries = fs.readdirSync(p, { withFileTypes: true });
        return (
          entries
            .map((e) => (e.isDirectory() ? e.name + "/" : e.name))
            .join("\n") || "(空目录)"
        );
      }
      case "run_command": {
        const command = String(args.command);
        if (!ctx.autoApprove) {
          const ok = await confirm(`[${ctx.workerName}] 要执行命令: ${command}`);
          if (!ok) return "用户拒绝了这条命令，请换一种方式或跳过";
        }
        workerEvent(ctx.workerName, `执行 $ ${command}`);
        try {
          const { stdout, stderr } = await execAsync(command, {
            cwd: ctx.cwd,
            timeout: COMMAND_TIMEOUT_MS,
            maxBuffer: 10 * 1024 * 1024,
            signal: ctx.signal,
          });
          const out = [stdout, stderr && `[stderr]\n${stderr}`]
            .filter(Boolean)
            .join("\n");
          return truncate(out || "(无输出，退出码 0)", MAX_OUTPUT_CHARS);
        } catch (e: any) {
          const out = [e.stdout, e.stderr, `[退出码 ${e.code ?? "?"}]`]
            .filter(Boolean)
            .join("\n");
          return truncate(out, MAX_OUTPUT_CHARS);
        }
      }
      case "grep": {
        const rootRel = String(args.path ?? ".");
        const p = safePath(ctx.cwd, rootRel);
        const patternStr = String(args.pattern);
        const globStr = args.glob ? String(args.glob) : undefined;
        workerEvent(ctx.workerName, `grep ${patternStr} in ${rootRel}`);
        let regex: RegExp;
        try {
          regex = new RegExp(patternStr);
        } catch {
          return "错误: pattern 不是合法的正则表达式";
        }
        let matcher: picomatch.Matcher | null = null;
        if (globStr) {
          try {
            matcher = picomatch(globStr);
          } catch {
            return "错误: glob 不是合法的模式";
          }
        }
        const lines = searchFiles(ctx.cwd, rootRel, regex, matcher);
        return lines.join("\n") || "(无匹配)";
      }
      case "glob": {
        const pattern = String(args.pattern);
        workerEvent(ctx.workerName, `glob ${pattern}`);
        try {
          picomatch.makeRe(pattern);
        } catch {
          return "错误: pattern 不是合法的 glob 模式";
        }
        const files = globFiles(ctx.cwd, pattern);
        return files.join("\n") || "(无匹配)";
      }
      default:
        return `错误: 未知工具 ${name}`;
    }
  } catch (e: any) {
    return `错误: ${e.message}`;
  }
}
