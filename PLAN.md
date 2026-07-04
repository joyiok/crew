# crew 实施计划

这是 [ROADMAP.md](./ROADMAP.md) 中 P0/P1 任务的**详细实施方案**：每个任务写清目标、涉及文件、实现步骤、验收清单，拿到就能开工。动手前先读 [DEVELOPMENT.md（开发守则）](./DEVELOPMENT.md)。

## 认领方式

不用 issue。认领 = 提一个只改下面状态表的 PR（填上你的 ID，状态改"进行中"）；完成 = 功能 PR 里顺手把状态改"已完成"。

## 任务状态表

| 任务 | 优先级 | 状态 | 认领人 |
|---|---|---|---|
| T1 API 错误重试与退避 | P0 | 已完成 | — |
| T2 流式输出 | P0 | 已完成 | — |
| T3 Ctrl+C 中断当前任务 | P0 | 已完成 | — |
| T4 token 用量与成本统计 | P0 | 已完成 | — |
| T5 上下文管理 | P0 | 已完成 | — |
| T6 worker 工具补齐 grep/glob | P0 | 已完成 | — |
| T7 核心逻辑测试 + CI | P0 | 已完成 | — |
| T8 会话持久化 | P1 | 已完成 | — |
| T9 写操作 diff 预览 | P1 | 已完成 | — |
| T10 crew init 向导 | P1 | 已完成 | — |
| T11 worker 失败兜底 | P1 | 已完成 | — |
| T12 npm 发布 | P1 | 已完成 | — |

## 建议顺序与依赖

```
T1 重试 ──> T2 流式 ──> T4 用量统计（依赖流式的 usage 块）
                └─────> T3 中断（都在改 loop，避免并行冲突）
T5 上下文管理 ─┐
T6 grep/glob  ─┼── 相互独立，可随时并行认领
T7 测试+CI    ─┘（工具层测试可立刻写；loop 层测试建议等 T1-T3 合入后补）
```

---

## T1. API 错误重试与退避

**目标**：一次 429 / 5xx / 网络超时不再打断整轮任务。

**涉及文件**：`src/llm.ts`、`src/ui.ts`（复用 `info`）

**实现步骤**：
1. 客户端创建时显式 `maxRetries: 0`（重试自己管，SDK 内建重试没有提示钩子）
2. 在 `chat()` 里包一层 `withRetry`：捕获 `e.status === 429 || e.status >= 500` 及连接超时类错误（openai SDK 的 `APIConnectionError` / `APIConnectionTimeoutError`）
3. 指数退避：1s → 2s → 4s → 8s，最多 4 次；429 优先读响应头 `retry-after` 的秒数
4. 每次重试前打印：`限流/服务端错误（429），3 秒后第 2 次重试...`
5. 4xx（400 参数错、401 认证失败）**不重试**，直接抛给上层——这类错误重试无意义

**验收清单**：
- [ ] 单测：mock 先抛 429 再成功，`chat()` 最终返回成功结果且只重试了一次
- [ ] 单测：mock 400，立刻抛出、零重试
- [ ] 重试时终端有可见提示

**注意**：重试发生在单次 `chat()` 内部，loop 层（orchestrator/worker）不感知，不需要改动。

---

## T2. 流式输出

**目标**：指挥的回复和 worker 的报告边生成边打印，消除长时间静默。

**涉及文件**：`src/llm.ts`、`src/orchestrator.ts`、`src/worker.ts`、`src/ui.ts`

**实现步骤**：
1. `llm.ts` 新增 `chatStream(model, config, messages, tools, onText)`：`stream: true` + `stream_options: { include_usage: true }`
2. 逐 chunk 处理 delta：
   - `delta.content` → 即时调 `onText(text)` 打印
   - `delta.tool_calls` 是**分片增量**：按 `index` 聚合，`id`/`function.name` 在首片，`function.arguments` 逐片拼接字符串
   - 最后一个 chunk 带 `usage`（供 T4 使用），收集后组装出完整的 `ChatCompletionMessage` 返回
3. loop 改造：orchestrator 的最终回复、worker 的文本输出走流式打印；**工具调用仍然攒完整之后才执行**（不做半截执行）
4. `ui.ts` 加流式打印辅助（前缀只在行首打一次，后续增量直接 write）

**验收清单**：
- [ ] 问一个不派工的问题，回答逐字出现
- [ ] 派工任务全程没有 30 秒以上的无输出静默
- [ ] DeepSeek / Qwen / Kimi 三家各跑通一次（流式 tool_calls 的分片行为有差异，务必分别验证）
- [ ] 流式回复的完整文本与历史里保存的 message 一致

**注意**：与 T1 的重试结合——流已经开始吐字后再失败，不能盲目重试（会重复输出）。简单处理：首 chunk 到达前的失败可重试，之后的失败直接报错。

---

## T3. Ctrl+C 中断当前任务

**目标**：任务执行中 Ctrl+C 取消当前任务回到 REPL；空闲时连按两次才退出。

**涉及文件**：`src/index.ts`、`src/orchestrator.ts`、`src/worker.ts`、`src/llm.ts`、`src/tools.ts`

**实现步骤**：
1. `index.ts` 维护"空闲/忙碌"状态：进入 `orchestrator.handle()` 前置忙碌，返回后置空闲
2. 每轮任务创建一个 `AbortController`；SIGINT 时忙碌则 `abort()`，空闲则提示"再按一次 Ctrl+C 退出"（2 秒窗口）
3. `signal` 一路传下去：`chat()` 把它作为请求选项传给 openai SDK（第二参数 `{ signal }`）；`run_command` 的 `exec` 也接收它
4. loop 层处理中断：每次 `chat()` 调用前检查 `signal.aborted`；**如果中断发生在 tool_calls 已返回但结果未回填时，必须给每个未完成的 call 回填 `"任务被用户中断"` 再退出循环**（守则第 3 条：配对不能破坏）
5. 中断后向指挥历史 push 一条 `{ role: "user", content: "[上一个任务被用户中断]" }`，让后续对话有上下文

**验收清单**：
- [ ] 派工进行中按 Ctrl+C，1 秒内回到 `你>` 提示符
- [ ] 中断后继续输入新指令，对话正常（不会因 tool 配对残缺被 API 拒绝）
- [ ] 空闲时单次 Ctrl+C 不退出，两次退出
- [ ] readline 的 SIGINT 行为要显式接管（`rl.on("SIGINT", ...)`），否则默认会直接关闭输入流

---

## T4. token 用量与成本统计

**目标**：每轮任务结束能看到各模型花了多少 tokens（配了价格则显示金额）。

**涉及文件**：新建 `src/usage.ts`；`src/llm.ts`、`src/index.ts`、`src/config.ts`

**实现步骤**：
1. `usage.ts`：`UsageTracker`，按 `provider/model` 累计 `{ promptTokens, completionTokens, calls }`；模块级单例即可
2. `chat()` / `chatStream()` 拿到响应的 `usage` 后上报 tracker（流式的 usage 在最后一个 chunk，依赖 T2 的 `include_usage`）
3. `crew.config.json` 可选加价格表：`"prices": { "deepseek-chat": { "input": 2, "output": 8 } }`（元/百万 tokens）；没配价格就只显示 tokens
4. 每轮 `handle()` 结束后打印一行本轮增量摘要；新增 `/usage` 命令显示会话累计明细
5. 同步更新 README 的配置示例和命令表

**验收清单**：
- [ ] 跑一轮派工任务后，能看到指挥和各 worker 分别的 tokens
- [ ] 配了价格时显示估算金额，没配时不报错
- [ ] `/usage` 输出会话累计

---

## T5. 上下文管理

**目标**：长会话 / 读大量文件的任务不再撑爆上下文窗口。

**涉及文件**：新建 `src/context.ts`；`src/orchestrator.ts`、`src/worker.ts`、`src/config.ts`

**实现步骤**：
1. 先不引入 tokenizer，按字符数估算（阈值默认 300,000 字符，进 `crew.config.json` 的 `contextCharLimit`）
2. `context.ts` 提供 `pruneHistory(messages, limit)`：超限时从**最老**的 `role: "tool"` 消息开始，把超过 500 字符的内容替换为 `[工具结果已省略以节省上下文：原 N 字符]`，直到降到阈值内
3. 只替换 content，**不删除消息本身**——保住 tool_call/tool result 的配对和消息序（守则第 3 条）；`system` 和最近 4 轮消息永不触碰
4. orchestrator 和 worker 的 loop 里，每次 `chat()` 前调用
5. 触发裁剪时用 `ui.info` 提示一次（每轮最多提示一次，避免刷屏）

**验收清单**：
- [ ] 构造读多个大文件的任务（可以造几个 50KB 的测试文件），全程不触发上下文超限
- [ ] 单测：裁剪后消息数量不变、tool 配对完整、system 原样
- [ ] 裁剪只发生在超限时，普通短会话零影响

**注意**："总结压缩"是 P2 的事，这里只做占位替换，别做复杂了。

---

## T6. worker 工具补齐：grep / glob

**目标**：worker 在稍大的项目里能一步定位代码，不再逐个 read_file 摸索。

**涉及文件**：`src/tools.ts`、`src/worker.ts`（提示词）；可加一个小依赖 `picomatch`

**实现步骤**：
1. `grep` 工具：参数 `{ pattern（正则）, path?（起点目录）, glob?（文件名过滤，如 *.ts） }`。纯 Node 递归遍历（跳过 `node_modules` / `.git` / `dist` / 二进制文件），逐行匹配，输出 `路径:行号: 行内容`，上限 100 条（超限提示收窄 pattern）
2. `glob` 工具：参数 `{ pattern }`（支持 `**/*.ts` 形式），用 `picomatch` 匹配相对路径，返回文件列表，上限 200 条
3. 两个工具都走 `safePath` 边界；schema 的 description 写清楚"探索代码时优先用 grep/glob，其次才逐个 read_file"
4. worker 提示词"工作循环"第 1 步同步改为：`用 glob/grep 定位相关文件，再 read_file 细读`
5. 遍历深度限制（如 12 层）防符号链接环

**验收清单**：
- [ ] 在 20+ 文件项目里让 worker 找某个函数的定义，一次 grep 命中
- [ ] 结果超限时返回的提示能引导模型收窄搜索
- [ ] 单测：ignore 目录生效、safePath 生效、上限截断

---

## T7. 核心逻辑测试 + CI

**目标**：改 loop / 工具有回归保障，PR 有自动检查。

**涉及文件**：新建 `test/`、`.github/workflows/ci.yml`；`package.json`

**实现步骤**：
1. 引入 `vitest`（devDependency），`npm test` 跑 `vitest run`
2. 工具层测试（`test/tools.test.ts`，可立即写）：
   - `safePath`：`../../etc/passwd`、绝对路径逃逸、符号链接指向目录外 → 全部拒绝
   - `edit_file`：old_string 出现 0 次 / 1 次 / N 次的三种行为
   - 截断：超长文件和超长命令输出
3. loop 层测试（`test/loop.test.ts`，建议 T1–T3 合入后写）：`vi.mock` 掉 `llm.js` 的 `chat`，验证——每个 tool_call 都有配对回填、迭代上限触发时返回明确的未完成报告、同轮多 call 并行执行、参数 JSON 非法时回填错误不 crash
4. CI（GitHub Actions）：Node 22，`npm ci` → `npm run typecheck` → `npm test`，对 push 和 PR 触发
5. 测试里所有文件操作用 `fs.mkdtempSync(os.tmpdir())` 临时目录，跑完清理

**验收清单**：
- [ ] `npm test` 本地通过
- [ ] 仓库主页显示 CI 通过徽章（README 加 badge）
- [ ] 故意破坏 safePath 时有测试挂掉

---

## P1 任务（做完 P0 再动）

**T8 会话持久化**：`Orchestrator` 暴露历史的序列化/恢复；存 `~/.crew/sessions/<工作目录hash>.json`；启动参数 `--resume` 恢复最近会话。注意恢复后 system prompt 用当前版本重建（配置可能变了），只恢复对话部分。

**T9 写操作 diff 预览**：`write_file` / `edit_file` 执行前生成 unified diff（新文件显示全文添加），走 `confirm` 队列请求批准；`autoApprove` 跳过。被拒时给 worker 回填"用户拒绝了这次修改：<可选原因>"。diff 生成可用 `diff` npm 包。

**T10 `crew init` 向导**：子命令进入交互流程——选指挥模型 → 逐个添加 worker（名字/厂商/模型/description）→ 写出 `crew.config.json`。厂商列表从 `BUILTIN_PROVIDERS` + 已有自定义合并。

**T11 worker 失败兜底**：worker 到迭代上限时，把**已改动的文件列表**（从工具调用记录收集）附在报告里给指挥；worker 配置可选 `fallbackModel`，异常（非用户中断）时自动换模型整任务重试一次，重试也失败才报告失败。

**T12 npm 发布**：确认 `npm run build` 产物 + bin 可执行（`dist/index.js` 首行 shebang）；`files` 字段只包 `dist`；语义化版本 + `CHANGELOG.md`；GitHub Actions 在打 tag 时自动 `npm publish`。

---

## MVP 完成判定

T1–T7 全部"已完成"后，按 ROADMAP 的验收场景做一次完整演练：在一个 ~20 文件的真实项目里执行"加功能 + 补测试 + reviewer 审查"，确认流式可见、可中断续聊、能看到花费、遇到限流自动恢复。演练通过即打 `v0.2.0` tag，宣告 MVP。
