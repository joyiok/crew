import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadSession, saveSession } from "../src/session.js";
import type { ChatCompletionMessageParam } from "../src/llm.js";

describe("session persistence", () => {
  let cwd = "";

  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), "crew-session-test-"));
  });

  afterEach(() => {
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it("保存并恢复会话", () => {
    const messages: ChatCompletionMessageParam[] = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ];
    saveSession(cwd, messages);
    const loaded = loadSession(cwd);
    expect(loaded).toEqual(messages);
  });

  it("没有会话时返回 undefined", () => {
    expect(loadSession(cwd)).toBeUndefined();
  });
});
