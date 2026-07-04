# crew 开发守则

给 crew 贡献代码（或让 AI 改 crew 的代码）之前，先读这份守则。它定义了核心术语、架构边界和不可破坏的规则。

## 1. 核心概念

| 术语 | 含义 |
|---|---|
| **Harness（骨架）** | 模型之外的一切代码：CLI 入口、agent loop、工具执行、权限确认、凭据管理、输出渲染。模型只产生"下一步意图"（文本或 tool_calls），真正动手的是 harness |
| **Agent Loop** | `发请求 → 模型返回 tool_calls → harness 执行工具 → 结果回填历史 → 再发请求` 的循环，直到模型不再调用工具为止 |
| **Orchestrator（指挥）** | 上层 loop。持有与用户的完整对话历史，工具只有 `dispatch_task` 和只读的 `read_file` / `list_dir`。职责：拆解、派工、验收、汇报 |
| **Worker（执行者）** | 下层 loop。每个任务是独立会话（无共享记忆），拥有全量工具（读写文件、执行命令）。职责：完成单个任务并输出报告 |
| **Tool（工具）** | 模型可调用的函数 = JSON Schema（给模型看的接口文档）+ TypeScript 实现（harness 里真正执行的代码） |
| **Dispatch** | 指挥调用 `dispatch_task`，harness 据此启动一个 worker loop 跑到结束，把 worker 的最终报告作为 tool result 回填给指挥 |

## 2. 架构与模块职责

```
你 ──> Orchestrator loop（指挥模型）
          │ dispatch_task（同一轮可并行多个）
          ├──> Worker loop "coder"    ─ 读写文件 / 执行命令
          └──> Worker loop "reviewer" ─ 审查 / 找 bug
```

| 文件 | 职责 | 不该出现的东西 |
|---|---|---|
| `src/index.ts` | CLI 入口：REPL、slash 命令、首次运行的 key 引导 | agent loop 逻辑 |
| `src/orchestrator.ts` | 指挥层 loop + 指挥提示词 | 直接的文件写入/命令执行 |
| `src/worker.ts` | 执行层 loop + worker 提示词 | 与用户的直接对话 |
| `src/tools.ts` | 工具 schema + 实现（安全边界在这里） | 模型调用 |
| `src/llm.ts` | OpenAI 兼容客户端、chat 封装、key 验证 | 业务逻辑 |
| `src/config.ts` | 配置加载、provider 注册表 | I/O 之外的逻辑 |
| `src/credentials.ts` | key 的保存与解析（`~/.crew/credentials.json`） | key 以外的配置 |
| `src/ui.ts` | 终端输出、确认队列、隐藏输入 | 状态存储 |

**分层铁律：指挥只读不写。** 一切写操作（写文件、执行命令）必须经由 worker 完成，这保证每个改动都有一份 worker 报告可追溯。给指挥加写工具 = 破坏架构，不要做。

## 3. Agent Loop 守则

这些是硬规则，违反任意一条都会产生难排查的运行时问题：

1. **每个 loop 必须有迭代上限**（worker 40 轮 / 指挥 25 轮）。到达上限时向上游明确报告"未完成"，禁止静默停止
2. **每个 tool_call 必须回填恰好一条 `role: "tool"` 消息**，`tool_call_id` 一一对应。工具执行失败时，把错误描述作为 result 内容返回——绝不抛异常打断 loop，也绝不丢弃某个 call 不回填（API 会直接拒绝下一次请求）
3. **assistant 消息必须先原样 push 进历史再执行工具**，顺序不能反
4. **同一轮的多个 tool_calls 并行执行**（`Promise.all`），结果一次性全部回填
5. **工具参数 `JSON.parse` 失败要当作普通工具错误回填**，不 crash
6. **loop 内部不做用户交互**，唯一例外是命令执行确认，且必须走 `ui.confirm` 的串行队列（见第 7 条守则）

## 4. 工具开发守则

- **Schema 的 `description` 是写给模型的接口文档**：说清楚什么时候用、参数怎么填、有什么限制（如"old_string 必须恰好出现一次"）。模型只能看到 schema，看不到实现
- **返回值是写给模型的、可行动的字符串**："错误: old_string 出现了 3 次，请提供更长的唯一上下文" 而不是 "failed"
- **所有路径必须过 `safePath`**（锁死在工作目录内），这是安全边界，新工具不得绕过
- **所有输出必须截断**（文件 60K / 命令输出 8K 字符），防止撑爆上下文
- **危险操作（执行命令、未来的删除类操作）必须走 `confirm`**，并尊重 `autoApprove` 配置
- 新增工具的流程：`tools.ts` 里加 schema + `executeTool` 加分支 → 决定它给 worker、指挥还是两者 → 同步更新相关提示词（见第 5 条）

## 5. 提示词守则

- **System prompt 用固定结构**：角色 → 环境 → 工作循环/决策准则 → 纪律 → 输出格式。改提示词时保持这个骨架
- **Worker 无共享上下文原则**：worker 看不到指挥与用户的对话，所以（a）指挥的提示词必须强调派工描述要自包含；（b）worker 的提示词必须告诉它"任务描述就是全部上下文，缺信息用工具探索"
- **提示词与工具保持同步**：工具改名、换语义、增删，都要检查两份提示词里有没有过时的引用
- **Worker 的 `description` 写成"何时派给它"**而不只是"它是什么"——这段文字会进指挥的 system prompt，直接决定分工质量
- 改动提示词后，至少跑一个真实任务回归（简单任务 + 一个需要派工的任务）

## 6. Provider 与凭据守则

- **只接 OpenAI 兼容接口**。新厂商优先让用户在 `crew.config.json` 的 `providers` 里自定义；确实通用的再进 `BUILTIN_PROVIDERS`
- **Key 解析顺序：环境变量 > `~/.crew/credentials.json`**，环境变量永远优先
- **首次运行缺 key 时进入引导流程**：展示申请地址 → 隐藏输入（不回显）→ `models.list` 在线验证 → 保存（文件权限 600）。网络原因无法验证时先保存并给出警告，不阻塞用户
- **验证只把 401/403 判为无效**；其他错误（超时、断网）放行——引导流程不能因为网络问题死循环
- **key 永远不进仓库**：`crew.config.json` 只存 provider/model 名，不存 key；日志和报错信息里不得输出 key 原文
- 换 key（`/login`）后必须调 `resetClients()`，否则缓存的旧客户端继续用旧 key

## 7. 交互守则（Harness UX）

- **输出前缀**：`[指挥]` 品红加粗；`[worker名]` 按注册顺序自动着色；过程性事件（读文件、执行命令）用暗色，正文用常规色
- **并行时的用户确认必须串行**：多个 worker 同时要求确认时，提示逐个出现（`ui.ts` 里的 confirm 队列），绝不允许两个 y/N 交错打印
- **敏感输入不回显**：API key 用 `askSecret`，只在回车时换行
- **报错要带下一步动作**：告诉用户该 `export` 什么、该跑 `/login` 还是查配置文件，而不是只抛错误原文

## 8. 代码规范

- TypeScript `strict` 模式；ESM（相对 import 必须带 `.js` 后缀）
- 注释写"为什么"和约束，不复述代码在做什么
- 面向用户的文案用中文；代码标识符、类型名用英文
- 任何改动后必跑 `npm run typecheck`；涉及交互流程的改动，手动 `npm start` 冒烟一次（至少走到 REPL 提示符）

## 9. 提交守则

- 提交信息：第一行说结论（改了什么），正文说明动机和影响
- 禁止提交：`node_modules/`、`dist/`、`.env`、任何形式的 API key
