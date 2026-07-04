# crew — 多模型协作 coding 工具

一个交互式 CLI：**指挥模型**接收你的需求，分解任务后派给多个**工作模型**执行。工作模型可以读写文件、执行命令（跑测试、装依赖），完成后向指挥模型汇报，指挥模型验收并向你总结。

```
你 ──> 指挥模型 (orchestrator)
          │  dispatch_task（可并行派多个）
          ├──> worker "coder"    ── read/write/edit 文件、run_command
          └──> worker "reviewer" ── 审查代码、找 bug
```

## 快速开始

```bash
npm install
npm start
```

首次运行会自动引导你配置 API key：展示申请地址 → 粘贴 key（输入不回显）→ 在线验证 → 保存到 `~/.crew/credentials.json`（权限 600，仅本机）。之后再启动就直接进入对话。

也可以用环境变量（优先级高于保存的 key）：

```bash
export DEEPSEEK_API_KEY=sk-...
npm start
```

进入交互界面后直接说需求，例如：`帮我写一个 Express 的 TODO API，带单元测试，写完让 reviewer 审一遍`。

## 支持的模型厂商（内置）

都走 OpenAI 兼容接口：

| provider | API key 环境变量 | 常用模型 |
|---|---|---|
| `deepseek` | `DEEPSEEK_API_KEY` | `deepseek-chat`, `deepseek-reasoner` |
| `qwen` | `DASHSCOPE_API_KEY` | `qwen-max`, `qwen-plus`, `qwen-coder-plus` |
| `kimi` | `MOONSHOT_API_KEY` | `kimi-k2-turbo-preview`, `moonshot-v1-32k` |

## 配置

在**工作目录**放一个 `crew.config.json`（可选，缺省全用 DeepSeek）：

```json
{
  "orchestrator": { "provider": "deepseek", "model": "deepseek-chat" },
  "workers": {
    "coder": {
      "provider": "qwen",
      "model": "qwen-coder-plus",
      "description": "写代码、改代码、跑测试的主力执行者"
    },
    "reviewer": {
      "provider": "kimi",
      "model": "kimi-k2-turbo-preview",
      "description": "审查代码质量、找 bug、提改进建议"
    }
  },
  "providers": {
    "my-proxy": {
      "baseURL": "https://my-gateway.example.com/v1",
      "apiKeyEnv": "MY_PROXY_KEY"
    }
  },
  "autoApprove": false
}
```

- `workers` 可以随意增删；`description` 会展示给指挥模型，直接影响它怎么分工
- `providers` 用于接入任何 OpenAI 兼容的自建网关 / 其他厂商
- `autoApprove: true`（或启动时加 `--yes`）后，worker 执行 shell 命令不再逐条向你确认

## 命令

| 命令 | 作用 |
|---|---|
| `/models` | 查看当前模型配置 |
| `/login [provider]` | 重新配置某个厂商的 API key |
| `/clear` | 清空对话历史 |
| `/exit` | 退出 |

## 开发

架构说明、agent loop / 工具 / 提示词的开发规则见 [DEVELOPMENT.md（开发守则）](./DEVELOPMENT.md)。

## 安全说明

- 所有文件读写被限制在启动时的工作目录内（路径穿越会被拒绝）
- shell 命令默认逐条向你确认；`--yes` 会放开，请只在信任的目录里用
- 单条命令超时 120 秒，输出超长自动截断
