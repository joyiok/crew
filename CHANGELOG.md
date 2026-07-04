# Changelog

## 0.2.0

### Added
- API 错误重试与指数退避（429 / 5xx / 网络超时），优先读取 `retry-after` 响应头。
- 流式输出：指挥与 worker 的文本回复边生成边打印，tool_calls 增量聚合后执行。
- Ctrl+C 中断当前任务并回到 REPL；空闲时连按两次才退出。
- Token 用量与成本统计，支持 `/usage` 命令与可选价格表。
- 上下文管理：接近字符阈值时裁剪最老的 tool 结果，保留消息配对。
- Worker 工具补齐：`grep` / `glob` 用于代码探索。
- 核心逻辑测试（vitest）与 GitHub Actions CI。
- 会话持久化：`--resume` 恢复上次会话，退出自动保存。
- 写操作 diff 预览：`write_file` / `edit_file` 执行前展示 unified diff。
- `crew init` 交互式初始化向导。
- Worker 失败兜底：迭代上限附带改动文件列表；配置 `fallbackModel` 异常时自动重试一次。
