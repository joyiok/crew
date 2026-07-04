import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { executeTool, WORKER_TOOLS } from "../src/tools.js";
import * as ui from "../src/ui.js";

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "crew-tools-test-"));
}

function ctx(cwd: string, autoApprove = false) {
  return { cwd, workerName: "coder", autoApprove };
}

describe("safePath", () => {
  let d: string;
  beforeEach(() => {
    d = tmpDir();
  });
  afterEach(() => {
    fs.rmSync(d, { recursive: true, force: true });
  });

  it("拒绝路径穿越", async () => {
    const result = await executeTool("read_file", { path: "../../etc/passwd" }, ctx(d));
    expect(result).toContain("路径越出工作目录");
  });

  it("拒绝绝对路径逃逸", async () => {
    const result = await executeTool("read_file", { path: "/etc/passwd" }, ctx(d));
    expect(result).toContain("路径越出工作目录");
  });
});

describe("edit_file", () => {
  let d: string;
  beforeEach(() => {
    d = tmpDir();
    fs.writeFileSync(path.join(d, "a.txt"), "hello world\nfoo bar\n");
  });
  afterEach(() => {
    fs.rmSync(d, { recursive: true, force: true });
  });

  it("old_string 不存在时返回错误", async () => {
    const result = await executeTool(
      "edit_file",
      { path: "a.txt", old_string: "not-found", new_string: "x" },
      ctx(d, true),
    );
    expect(result).toContain("old_string 在文件中不存在");
  });

  it("old_string 出现多次时返回错误", async () => {
    const result = await executeTool(
      "edit_file",
      { path: "a.txt", old_string: "o", new_string: "x" },
      ctx(d, true),
    );
    expect(result).toContain("出现了");
  });

  it("唯一时正确替换", async () => {
    const result = await executeTool(
      "edit_file",
      { path: "a.txt", old_string: "world", new_string: "crew" },
      ctx(d, true),
    );
    expect(result).toContain("已编辑");
    expect(fs.readFileSync(path.join(d, "a.txt"), "utf8")).toBe("hello crew\nfoo bar\n");
  });

  it("用户拒绝时返回拒绝信息", async () => {
    vi.spyOn(ui, "confirmWrite").mockResolvedValue({ ok: false, reason: "不需要" });
    const result = await executeTool(
      "edit_file",
      { path: "a.txt", old_string: "world", new_string: "crew" },
      ctx(d, false),
    );
    expect(result).toContain("用户拒绝了这次修改");
    expect(result).toContain("不需要");
    expect(fs.readFileSync(path.join(d, "a.txt"), "utf8")).toBe("hello world\nfoo bar\n");
    vi.restoreAllMocks();
  });
});

describe("grep", () => {
  let d: string;
  beforeEach(() => {
    d = tmpDir();
    fs.mkdirSync(path.join(d, "src"), { recursive: true });
    fs.writeFileSync(path.join(d, "src/a.ts"), "export function foo() { return 1; }\n");
    fs.writeFileSync(path.join(d, "src/b.ts"), "export const foo = 2;\n");
    fs.mkdirSync(path.join(d, "node_modules"), { recursive: true });
    fs.writeFileSync(path.join(d, "node_modules/x.ts"), "function foo() {}\n");
  });
  afterEach(() => {
    fs.rmSync(d, { recursive: true, force: true });
  });

  it("命中多个文件并跳过 node_modules", async () => {
    const result = await executeTool("grep", { pattern: "foo" }, ctx(d));
    expect(result).toContain("src/a.ts:1:");
    expect(result).toContain("src/b.ts:1:");
    expect(result).not.toContain("node_modules");
  });

  it("glob 过滤生效", async () => {
    const result = await executeTool("grep", { pattern: "foo", glob: "src/*.ts" }, ctx(d));
    expect(result).toContain("src/a.ts");
    expect(result).toContain("src/b.ts");
  });
});

describe("glob", () => {
  let d: string;
  beforeEach(() => {
    d = tmpDir();
    fs.mkdirSync(path.join(d, "src"), { recursive: true });
    fs.writeFileSync(path.join(d, "src/a.ts"), "x");
    fs.writeFileSync(path.join(d, "src/b.ts"), "x");
    fs.writeFileSync(path.join(d, "readme.md"), "x");
    fs.mkdirSync(path.join(d, "node_modules"), { recursive: true });
    fs.writeFileSync(path.join(d, "node_modules/x.ts"), "x");
  });
  afterEach(() => {
    fs.rmSync(d, { recursive: true, force: true });
  });

  it("返回匹配文件并跳过 node_modules", async () => {
    const result = await executeTool("glob", { pattern: "**/*.ts" }, ctx(d));
    expect(result).toContain("src/a.ts");
    expect(result).toContain("src/b.ts");
    expect(result).not.toContain("node_modules");
    expect(result).not.toContain("readme.md");
  });
});

describe("WORKER_TOOLS schema", () => {
  it("包含 grep 和 glob", () => {
    const names = WORKER_TOOLS.map((t) => t.function.name);
    expect(names).toContain("grep");
    expect(names).toContain("glob");
  });
});
