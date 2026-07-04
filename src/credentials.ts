import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ProviderConfig } from "./config.js";

const CRED_DIR = path.join(os.homedir(), ".crew");
export const CRED_FILE = path.join(CRED_DIR, "credentials.json");

/** 读取本机保存的 key（~/.crew/credentials.json），文件不存在或损坏时返回空表 */
export function loadSavedKeys(): Record<string, string> {
  try {
    return JSON.parse(fs.readFileSync(CRED_FILE, "utf8"));
  } catch {
    return {};
  }
}

export function saveKey(provider: string, key: string) {
  fs.mkdirSync(CRED_DIR, { recursive: true });
  const keys = loadSavedKeys();
  keys[provider] = key;
  fs.writeFileSync(CRED_FILE, JSON.stringify(keys, null, 2) + "\n", {
    mode: 0o600,
  });
  // writeFile 的 mode 只在新建时生效，已有文件要显式收紧权限
  fs.chmodSync(CRED_FILE, 0o600);
}

/** key 解析顺序：环境变量 > ~/.crew/credentials.json */
export function resolveApiKey(
  providerName: string,
  pc: ProviderConfig,
): string | undefined {
  return process.env[pc.apiKeyEnv] || loadSavedKeys()[providerName];
}
