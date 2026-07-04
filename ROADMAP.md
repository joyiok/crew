# crew 开发路线图

给想继续开发 crew 的人：这份文档说明现在做到了哪、MVP 长什么样、按什么顺序补齐。动手前先读 [DEVELOPMENT.md（开发守则）](./DEVELOPMENT.md)。

## 现状（v0.1）

**已经能跑的：**

- 两层 agent loop：指挥模型拆解派工（可同轮并行派多个 worker），worker 独立会话干活后汇报
- 工作模型全量工具：读/写/编辑文件（锁定工作目录）、列目录、执行命令（默认逐条确认，`--yes` 放开）
- 三家内置厂商（DeepSeek / Qwen / Kimi，OpenAI 兼容接口），`crew.config.json` 可自定义网关和 worker 编制
- 首次运行的 key 引导（申请地址 → 隐藏输入 → 在线验证 → 保存 `~/.crew/credentials.json`）、`/login` 换 key

**已知缺陷（按疼痛程度排序）：**

| 缺陷 | 后果 |
|---|---|
| 无流式输出 | 指挥模型思考期间界面完全静默，长任务像卡死 |
| 无 API 错误重试 | 一次 429/超时就打断整轮任务，前功尽弃 |
| 对话历史无限增长 | 长会话必然撑爆上下文窗口，且 token 费用线性上涨 |
| 无 token/成本统计 | 用户不知道一轮任务花了多少钱 |
| Ctrl+C 直接退出进程 | 无法中断当前任务回到对话，只能杀掉重来 |
| worker 缺 grep/glob | 稍大的项目里 worker 只能靠 list_dir + 逐个读文件摸索 |
| 零测试 | 改 loop / 工具没有回归保障 |

## MVP 定义

**一句话：能把一个中等编码任务（给已有小项目加功能 + 测试）稳定跑完，全程可观测、可中断、成本可见，常见故障（限流、超时）不会导致前功尽弃。**

具体验收场景：在一个 ~20 文件的真实项目里说"加一个 X 功能并补测试，然后让 reviewer 审一遍"，期间：能实时看到进展（流式）、遇到一次 429 自动恢复、可以 Ctrl+C 中断并换个说法继续、结束时能看到本轮 token 花费。

## 到 MVP 的任务列表

按依赖顺序排列，每个任务独立可交付。改完必过 `npm run typecheck` + 手动冒烟（守则第 8 条）。

### P0 — MVP 必须

**T1. API 错误重试与退避**
- 内容：`llm.ts` 的 `chat()` 对 429/5xx/超时做指数退避重试（openai SDK 自带 `maxRetries`，配置并把重试事件用 `ui.info` 提示出来）；4xx（如 400 参数错）不重试直接报错
- 验收：mock 一个先 429 后成功的响应，loop 不中断；重试时终端有"限流，N 秒后重试"的提示

**T2. 流式输出**
- 内容：`chat()` 增加流式变体（`stream: true` + 增量拼装 tool_calls），指挥的最终回复和 worker 的报告边生成边打印；工具调用仍然攒完整再执行
- 验收：问一个不派工的问题，回答逐字出现；派工任务全程无 30 秒以上的静默
- 提示：OpenAI 兼容接口的流式 tool_calls 是分片增量（`index` + 拼 `arguments`），DeepSeek/Qwen/Kimi 行为略有差异，要各测一遍

**T3. Ctrl+C 中断当前任务**
- 内容：任务执行中 SIGINT 不退出进程，而是取消当前指挥循环（`AbortController` 传入 openai SDK 的 `signal`），把"用户中断了任务"回填历史后回到 REPL；空闲状态下 Ctrl+C 两次才退出
- 验收：派工进行中按 Ctrl+C，1 秒内回到 `你>` 提示符，接着输入新指令能正常续聊

**T4. token 用量与成本统计**
- 内容：`chat()` 收集每次响应的 `usage`，按模型累计；每轮任务结束打印一行摘要（各模型 tokens），新增 `/usage` 命令看会话累计；价格表放 `config.ts`（可选配置，没有价格就只显示 tokens）
- 验收：跑一轮派工任务后，能看到指挥和各 worker 分别消耗的 tokens

**T5. 上下文管理**
- 内容：两层都要。指挥：历史接近阈值（按字符估算即可，先不引入 tokenizer）时，把最老的工具结果替换为"[已省略]"占位；worker：单任务内同理。阈值进 `crew.config.json`
- 验收：构造一个读大量文件的长任务，全程不触发上下文超限错误
- 提示：先做"裁剪"，"总结压缩"放 P2；注意裁剪不能破坏 tool_call/tool result 的配对（守则第 3 条）

**T6. worker 工具补齐：grep / glob**
- 内容：`tools.ts` 新增 `grep`（正则搜文件内容，带文件名/行号，限制结果条数）和 `glob`（按模式找文件）；纯 Node 实现，不依赖系统命令；同步更新 worker 提示词的探索部分
- 验收：worker 在 20+ 文件的项目里能一步定位到目标代码，而不是逐个 read_file

**T7. 核心逻辑测试**
- 内容：引入 `vitest`。工具层：`safePath` 越权、`edit_file` 唯一性、截断；loop 层：mock `chat()` 测 tool result 回填配对、迭代上限、并行分派。CI 用 GitHub Actions 跑 typecheck + test
- 验收：`npm test` 通过；PR 有 CI 检查

### P1 — MVP 后立刻做

**T8. 会话持久化** — 历史存 `~/.crew/sessions/`，`--resume` 恢复上次会话；验收：退出重进能接着聊
**T9. 写操作 diff 预览** — `write_file`/`edit_file` 前展示 diff，交互确认（复用 confirm 队列，`autoApprove` 跳过）；验收：拒绝后 worker 收到"用户拒绝了这次修改"
**T10. `crew init` 向导** — 交互式生成 `crew.config.json`（选指挥模型、增删 worker）；验收：新目录 30 秒配好一套混合厂商编制
**T11. worker 失败兜底** — worker 到迭代上限或异常时，指挥可拿到部分成果；配置 `fallbackModel` 自动换模型重试一次
**T12. npm 发布** — `npm run build` 产物可用（`crew` bin 全局装），版本号 + CHANGELOG，GitHub Actions 发布流程

### P2 — 方向性（做之前先开 issue 讨论）

- **上下文总结压缩**：裁剪升级为"旧对话摘要"，支持超长会话
- **成本感知调度**：先派便宜模型，验收不过再升级贵模型重做
- **计划模式**：复杂任务先让指挥产出计划给用户确认，再按 DAG 执行
- **MCP 支持**：接入 MCP server 作为 worker 的扩展工具
- **更多 provider**：OpenAI / Claude（注意 Anthropic 不是 OpenAI 兼容接口，需要独立适配层）/ Ollama 本地模型
- **多 worker 同屏流式 UI**：并行 worker 的输出分区展示（考虑 ink 或自绘）
- **Web UI**：浏览器里可视化任务树和各模型输出

## 开发流程

1. 挑任务 → 每个任务的详细实施方案（步骤、涉及文件、验收清单）见 [PLAN.md（实施计划）](./PLAN.md)，认领方式也在那里（改状态表，不用 issue）
2. 读 [DEVELOPMENT.md](./DEVELOPMENT.md)，涉及 loop/工具/提示词的改动逐条对照守则
3. 分支开发，`npm run typecheck` + 冒烟 +（T7 之后）`npm test`
4. PR 描述里写：改了什么、怎么验证的、对照了守则哪几条
