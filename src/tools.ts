import fs from "node:fs";
import path from "node:path";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { ChatCompletionTool } from "./llm.js";
import { confirm, workerEvent } from "./ui.js";

const execAsync = promisify(exec);

const MAX_FILE_CHARS = 60_000;
const MAX_OUTPUT_CHARS = 8_000;
const COMMAND_TIMEOUT_MS = 120_000;

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
];

export interface ToolContext {
  cwd: string;
  workerName: string;
  autoApprove: boolean;
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
        workerEvent(ctx.workerName, `写入 ${args.path}`);
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, String(args.content), "utf8");
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
        workerEvent(ctx.workerName, `编辑 ${args.path}`);
        fs.writeFileSync(p, content.replace(oldStr, newStr), "utf8");
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
      default:
        return `错误: 未知工具 ${name}`;
    }
  } catch (e: any) {
    return `错误: ${e.message}`;
  }
}
