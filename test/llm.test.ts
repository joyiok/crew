import { describe, it, expect, vi, beforeEach } from "vitest";
import OpenAI from "openai";
import { chat, chatStream, resetClients } from "../src/llm.js";
import type { CrewConfig } from "../src/config.js";

vi.mock("openai", () => {
  return {
    default: vi.fn(),
  };
});

const config: CrewConfig = {
  orchestrator: { provider: "deepseek", model: "deepseek-chat" },
  workers: {},
  providers: {
    deepseek: { baseURL: "https://api.deepseek.com/v1", apiKeyEnv: "DEEPSEEK_API_KEY" },
  },
  autoApprove: false,
};

function fakeChoice(content: string) {
  return {
    choices: [{ message: { role: "assistant", content } }],
  };
}

function fakeError(status: number, headers?: Record<string, string>) {
  const e: any = new Error(`HTTP ${status}`);
  e.status = status;
  e.headers = headers ?? {};
  return e;
}

describe("chat retry", () => {
  beforeEach(() => {
    resetClients();
    vi.clearAllMocks();
    vi.stubEnv("DEEPSEEK_API_KEY", "fake-key");
  });

  it("先抛 429 再成功时只重试一次并返回结果", async () => {
    const create = vi
      .fn()
      .mockRejectedValueOnce(fakeError(429))
      .mockResolvedValueOnce(fakeChoice("ok"));
    vi.mocked(OpenAI).mockImplementation(
      () =>
        ({
          chat: { completions: { create } },
        }) as unknown as OpenAI,
    );

    const result = await chat(
      config.orchestrator,
      config,
      [{ role: "user", content: "hi" }],
      [],
    );

    expect(result.content).toBe("ok");
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("400 错误立刻抛出，零重试", async () => {
    const create = vi.fn().mockRejectedValue(fakeError(400));
    vi.mocked(OpenAI).mockImplementation(
      () =>
        ({
          chat: { completions: { create } },
        }) as unknown as OpenAI,
    );

    await expect(
      chat(config.orchestrator, config, [{ role: "user", content: "hi" }], []),
    ).rejects.toThrow("HTTP 400");
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("429 优先使用 retry-after 头", async () => {
    const create = vi
      .fn()
      .mockRejectedValueOnce(fakeError(429, { "retry-after": "2" }))
      .mockResolvedValueOnce(fakeChoice("ok"));
    vi.mocked(OpenAI).mockImplementation(
      () =>
        ({
          chat: { completions: { create } },
        }) as unknown as OpenAI,
    );

    const start = Date.now();
    await chat(config.orchestrator, config, [{ role: "user", content: "hi" }], []);
    const elapsed = Date.now() - start;

    expect(create).toHaveBeenCalledTimes(2);
    expect(elapsed).toBeGreaterThanOrEqual(1800);
  });
});

describe("chatStream", () => {
  beforeEach(() => {
    resetClients();
    vi.clearAllMocks();
    vi.stubEnv("DEEPSEEK_API_KEY", "fake-key");
  });

  function asyncStream(chunks: any[]) {
    return {
      [Symbol.asyncIterator]: async function* () {
        for (const c of chunks) yield c;
      },
    };
  }

  it("逐 chunk 输出文本并聚合完整消息", async () => {
    const chunks = [
      { choices: [{ delta: { content: "Hello" } }] },
      { choices: [{ delta: { content: " world" } }] },
      { choices: [{ delta: {} }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } },
    ];
    const create = vi.fn().mockResolvedValue(asyncStream(chunks));
    vi.mocked(OpenAI).mockImplementation(
      () =>
        ({
          chat: { completions: { create } },
        }) as unknown as OpenAI,
    );

    const emitted: string[] = [];
    const result = await chatStream(
      config.orchestrator,
      config,
      [{ role: "user", content: "hi" }],
      [],
      (t) => emitted.push(t),
    );

    expect(emitted).toEqual(["Hello", " world"]);
    expect(result.message.content).toBe("Hello world");
    expect(result.usage).toEqual({ prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 });
  });

  it("聚合分片 tool_calls", async () => {
    const chunks = [
      { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "read_file" } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"path": "' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'a.txt"}' } }] } }] },
    ];
    const create = vi.fn().mockResolvedValue(asyncStream(chunks));
    vi.mocked(OpenAI).mockImplementation(
      () =>
        ({
          chat: { completions: { create } },
        }) as unknown as OpenAI,
    );

    const result = await chatStream(
      config.orchestrator,
      config,
      [{ role: "user", content: "hi" }],
      [],
      () => {},
    );

    expect(result.message.tool_calls).toHaveLength(1);
    expect(result.message.tool_calls?.[0].function.name).toBe("read_file");
    expect(result.message.tool_calls?.[0].function.arguments).toBe('{"path": "a.txt"}');
  });
});
