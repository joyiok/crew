import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import type { ChatCompletionMessageParam } from "./llm.js";

const SESSION_DIR = path.join(os.homedir(), ".crew", "sessions");

function sessionFile(cwd: string): string {
  const hash = crypto.createHash("sha256").update(cwd).digest("hex").slice(0, 16);
  return path.join(SESSION_DIR, `${hash}.json`);
}

export interface SessionData {
  cwd: string;
  messages: ChatCompletionMessageParam[];
  savedAt: string;
}

export function saveSession(cwd: string, messages: ChatCompletionMessageParam[]): void {
  fs.mkdirSync(SESSION_DIR, { recursive: true });
  const data: SessionData = { cwd, messages, savedAt: new Date().toISOString() };
  fs.writeFileSync(sessionFile(cwd), JSON.stringify(data, null, 2) + "\n", {
    mode: 0o600,
  });
}

export function loadSession(cwd: string): ChatCompletionMessageParam[] | undefined {
  const file = sessionFile(cwd);
  if (!fs.existsSync(file)) return undefined;
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8")) as SessionData;
    return data.messages;
  } catch {
    return undefined;
  }
}

export function listRecentSessions(limit = 5): SessionData[] {
  if (!fs.existsSync(SESSION_DIR)) return [];
  const entries = fs
    .readdirSync(SESSION_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => {
      const full = path.join(SESSION_DIR, f);
      try {
        const data = JSON.parse(fs.readFileSync(full, "utf8")) as SessionData;
        return { ...data, _mtime: fs.statSync(full).mtimeMs };
      } catch {
        return null;
      }
    })
    .filter(Boolean) as (SessionData & { _mtime: number })[];
  entries.sort((a, b) => b._mtime - a._mtime);
  return entries.slice(0, limit).map(({ _mtime, ...data }) => data);
}
