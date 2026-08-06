# Claude Code 本地 Transcript JSONL / Workflow 格式

> 非官方、观测性文档。Claude Code 没有被 Trajex 依赖的稳定公开 transcript schema；字段、条目类型和目录布局都可能随版本变化。本文以本机观察到的 Claude Code v2.1.220 输出，以及 Trajex 当前 `providers/claude.ts` 的实际消费行为为准。它不是 Anthropic API 或 Agent SDK 的接口说明。

## 1. 范围与基本规则

Claude Code 将一个会话保存为 JSON Lines（JSONL）文件：一行一个独立 JSON 对象。主 transcript、普通子代理 transcript 和 workflow 子代理 transcript 都使用同一类消息行格式；workflow 汇总则是单独的 JSON 文件。

```text
~/.claude/projects/<project-slug>/
├── <session-id>.jsonl                         # 主会话
└── <session-id>/
    ├── subagents/
    │   ├── <agent-id>.jsonl                   # 普通子代理
    │   ├── <agent-id>.meta.json               # 普通子代理元数据
    │   └── workflows/<run-id>/
    │       ├── <agent-id>.jsonl               # workflow 子代理
    │       ├── <agent-id>.meta.json           # workflow 子代理元数据
    │       └── journal.jsonl                  # workflow 运行日志，不是 transcript
    └── workflows/<run-id>.json                # workflow 汇总
```

`journal.jsonl` 记录如 `started`、`result` 的紧凑 workflow 事件。Trajex 当前不持久化它的逐 agent 结果，并在文件发现时跳过它；它不能按普通 agent transcript 解析。

主 JSONL 中通常可见 `sessionId`、子代理行中也可见 `agentId`，但 Trajex 不信任这些字段来决定归属：会话和 agent 归属优先由文件路径建立。

```text
主 <session-id>.jsonl
  → session_id = 文件名（去掉 .jsonl）

subagents/<agent-id>.jsonl
  → session_id = 父目录名；agent_id = 文件名（去掉 .jsonl）

subagents/workflows/<run-id>/<agent-id>.jsonl
  → session_id = 父目录名；agent_id = 文件名；run_id = workflow 目录名
```

## 2. JSONL 的公共形状

字段并非每行都有。以下是消息或系统行中常见的顶层字段：

| 字段 | 类型 | 观察到的含义 |
| --- | --- | --- |
| `type` | string | 条目类别，例如 `user`、`assistant`、`system`、`ai-title`、`attachment`。 |
| `uuid` | string | 条目的稳定 ID；消息、摘要和原文回源主要依赖它。 |
| `parentUuid` | string \| null | 原始事件的父条目 ID；可形成对话/事件链。 |
| `timestamp` | ISO 8601 string | 条目时间；并非每种条目都有。 |
| `sessionId` | string | 来源写入的会话 ID；Trajex 仅保留消息事实，不以它决定归属。 |
| `agentId` | string | 子代理的原始 ID；对子代理文件，Trajex 优先使用文件名中的 agent ID。 |
| `cwd` | string | 消息产生时的工作目录，是 Trajex 推断 `sessions.project_path` 的证据。 |
| `version` | string | Claude Code 版本。 |
| `gitBranch` | string | 当时 Git 分支。 |
| `isMeta` | boolean | 来源显式标记的元消息。 |
| `message` | object | `user` / `assistant` 的消息体。 |

同一文件可能混有不同版本写入的字段；解析器必须按可选字段处理。未知顶层 `type` 不应被当作错误。

## 3. `user` 与 `assistant` 消息

消息的基本形状：

```json
{
  "type": "assistant",
  "uuid": "<message-uuid>",
  "parentUuid": "<previous-uuid>",
  "timestamp": "<ISO-8601>",
  "cwd": "<absolute-path>",
  "message": {
    "role": "assistant",
    "model": "<model-name>",
    "content": "<string> | <content-block[]>",
    "usage": {
      "input_tokens": 0,
      "cache_creation_input_tokens": 0,
      "cache_read_input_tokens": 0,
      "output_tokens": 0
    }
  }
}
```

`message.content` 可以是字符串，也可以是 block 数组。当前 Trajex 关注的 block 为：

| block | 关键字段 | Trajex 行为 |
| --- | --- | --- |
| `text` | `text` | 纳入消息文本。 |
| `thinking` | `thinking`、可选 `signature` | 纳入消息文本，内容类型为 `thinking`。 |
| `tool_use` | `id`、`name`、`input` | 产生一条 `tool_call`；承载它的 assistant 消息也会保留。 |
| `tool_result` | `tool_use_id`、`content`、`is_error` | 产生一条 `tool_result`；通常位于 `user` 消息中。 |

一个 assistant 消息可包含多个 `tool_use`。若数组内同时混有多种 block，Trajex 的 `content_type` 为 `unknown`；单一类型才对应 `text`、`thinking`、`tool_use` 或 `tool_result`。

### 3.1 工具调用与结果

```json
{
  "type": "assistant",
  "message": {
    "role": "assistant",
    "content": [{
      "type": "tool_use",
      "id": "<tool-call-id>",
      "name": "Read",
      "input": { "file_path": "/path/to/file" }
    }]
  }
}
```

```json
{
  "type": "user",
  "message": {
    "role": "user",
    "content": [{
      "type": "tool_result",
      "tool_use_id": "<tool-call-id>",
      "content": "<result>",
      "is_error": false
    }]
  },
  "toolUseResult": { "filePath": "/path/to/file" }
}
```

Trajex 用 `tool_use.id` / `tool_result.tool_use_id` 关联两者。`StructuredOutput` 也属于普通 `tool_use`：其 `input` 是结构化结果，后续 `tool_result` 是运行时确认。`input_json` 和结果文本会受索引长度上限限制；它们不是永久、无损的原始存档。

仅 `Read`、`Edit`、`Write`、`NotebookEdit` 会从 tool input 提取标准化 `file_path`。其他工具仍写入 `tool_calls`，但 `file_path` 为 `null`。

### 3.2 可见性、元消息与 token

Trajex 将 Claude 的 `user` / `assistant` 消息以 `visibility: "visible"` 写入，即使它们被判断为 meta。`is_meta` 在下列情况为 `1`：

- 顶层 `isMeta: true`；
- `message.isMeta: true`；
- 文本匹配命令或系统 envelope，例如 `<command-name>`、`<task-notification>`、`<system-reminder>`、`<local-command>`。

若 meta 消息的正文符合 skill instruction 的结构，`content_type` 会进一步标为 `skill_instructions`。`attributionSkill` 会保存到 `messages.skill`。

Trajex 的 `input_tokens` 是 `input_tokens + cache_creation_input_tokens + cache_read_input_tokens` 中所有存在数值的和；`output_tokens` 直接取来源值。Claude 的 `isSidechain` 不进入 Trajex 的 canonical 或 raw 投影；子代理关系由 `agent_id` 表达。

对于子代理文件，`messages.agent_id` 使用文件名中的 agent ID；对于主文件，通常为 `null`，但若某一行顶层存在 `obj.agentId`，代码会保留该值。

## 4. 非普通消息条目

| 原始条目 | 关键条件 | Trajex 行为 |
| --- | --- | --- |
| `user` compact summary | 顶层或 `message.isCompactSummary === true` | 产生 `summary`，不产生普通 `message`。没有 UUID 时会构造稳定回退 ID。 |
| `system` turn duration | `subtype === "turn_duration"`、有 `parentUuid` 与非零 `durationMs` | 产生 `message-turn-duration`，更新目标消息的 `turn_duration_ms`。 |
| `ai-title` | 有 `aiTitle` | 更新本次主会话聚合的标题；不产生独立 record。 |
| `attachment` | 任意 attachment 载荷 | 当前不产生 record。 |
| 其他 `system` 子类型 | 如 compact、hook、informational 等 | 当前不产生 record。 |
| 其他顶层类型 | 如 queue、file-history、mode、permission 等 | 当前不产生 record。 |

`ai-title`、主会话开始/结束时间、`gitBranch`、`version` 与消息数在主 JSONL 解析结束时聚合为一条 `session` record。子代理 JSONL 不拥有独立 `session` record。

## 5. 普通子代理

普通子代理由 `<agent-id>.jsonl` 加可选的同名 `.meta.json` 组成：

```json
{
  "toolUseId": "<parent-tool-call-id>",
  "agentType": "Explore",
  "description": "<task description>",
  "spawnDepth": 1
}
```

JSONL 与主会话按同一规则产出 message、tool call、tool result、summary 和 turn duration；但它们使用父会话的 `session_id`，并带同一个 `agent_id`。解析器会在读取 JSONL 后读取 `.meta.json`：普通子代理会额外产生 `subagent`，其中 `toolUseId`、`agentType`、`description` 来自 meta，持续时间和 token 总数则由 JSONL 中的 user/assistant 时间与 usage 聚合。

```text
父 Agent 工具调用 tool_calls.id
  → subagents.parent_tool_use_id
  → subagents.agent_id
  → 子代理 messages.agent_id
```

## 6. Workflow

一个 workflow 汇总文件是完整 JSON，不是 JSONL。最小有效条件是存在 `runId`：

```json
{
  "runId": "<run-id>",
  "workflowName": "<name>",
  "taskId": "<task-id>",
  "script": "<workflow source>",
  "result": {},
  "timestamp": "<ISO-8601>",
  "durationMs": 0,
  "totalTokens": 0,
  "status": "completed",
  "workflowProgress": [{
    "type": "workflow_agent",
    "agentId": "<raw-agent-id>",
    "phaseTitle": "<phase>",
    "label": "<prompt>",
    "model": "<model>",
    "state": "done",
    "durationMs": 0,
    "tokens": 0,
    "toolCalls": 0
  }]
}
```

它产生一条 `workflow`，以及每个 `workflow_agent` progress 条目对应的一条 `workflow_agent`。原始 `workflowProgress[].agentId` 不带 `agent-` 前缀；Trajex 规范化为 `agent-<raw-agent-id>`，以匹配 `agent-<raw-agent-id>.jsonl` 与 `.meta.json` 的文件名。

workflow 子代理 JSONL 按普通子代理消息规则解析，但同名 `.meta.json` 只补充 `workflow_agent.agent_type` 和 `description`。workflow JSON 提供该 agent 的阶段、模型、状态、耗时、token 和工具调用数。两路记录按相同 `agent_id` upsert 合并。

Trajex 会回扫主 transcript：先找名为 `Workflow` 的 assistant `tool_use`，再在对应 user `tool_result` 的文本中匹配 `runId` 或 workflow 名称，从而写入 `workflows.parent_tool_use_id`。匹配不到并不阻止 workflow 入库，只会得到 `null`。

## 7. 增量、变更与原文回源

普通 JSONL unit 的 cursor 是 `mtimeMs:linesProcessed`。文件 mtime 变化时，解析器会顺序读取文件、跳过已消费行，只为新增尾部产出 record。主会话首次完整读取的 `session.countMode` 为 `total`；有 cursor 的尾部读取为 `delta`。

监听器传入变更路径时：

- JSONL 变更重解析该 JSONL；
- `.meta.json` 变更强制重解析同名 JSONL，即使 JSONL mtime 未变；
- workflow JSON 变更重解析该 workflow；主 transcript 变更也会使该 session 的 workflow JSON 重跑，以刷新其父工具调用关联。

`rawClaude()` 用已索引 session 的主 transcript 路径定位文件；有 `agent_id` 时，再依据是否关联 `workflow_agents.run_id` 选择普通或 workflow 子代理目录。它以消息 UUID 匹配原始 JSONL 行，并返回原始行和完整 `messageText`；桌面 App 用 `messageText` 展开入库时因长度限制而截断的消息。

## 8. 使用边界

- 这是本地实现格式，不是稳定 API；解析器必须容忍缺字段、未知 block 和未知顶层 type。
- `uuid`、`parentUuid`、`sessionId` 等来源字段不等于数据库外键；Trajex 的归属关系以发现到的文件路径和规范化 ID 为准。
- JSONL 可能包含历史、压缩前内容和不可展示事件；是否展示由上层的 `visibility`、`agent_id`、source 专用规则决定。
- 若要获取完整原文，应通过 provider 的 raw 回源能力，而不是把截断后的 SQLite 文本当作归档。
