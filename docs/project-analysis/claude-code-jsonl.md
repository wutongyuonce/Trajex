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

## 2.1 Trajex 的发现与解析边界

Trajex 对主 transcript 使用 `mtime:lines:size:ctime:inode` cursor：行数用来跳过已成功消费的前缀，size、ctime 和 inode 用来补足单靠 mtime 无法区分的同毫秒追加和原路径文件替换。旧数据库中的 `mtime:lines` cursor 仍可读取。若 cursor 的行数超过当前文件长度（例如文件被重写或截断），解析器会回到文件开头重新建立投影。cursor 之后遇到损坏 JSONL 时，已换行结束的完整坏记录会被消费并跳过，后续合法消息继续解析；未换行的文件尾可能仍在写入，因此不推进 cursor，等待下次文件变化后重试。

删除清理以 `projects/` 为来源根边界：如果它不存在或根层枚举失败，discover 不生成 tombstone，普通 build 保留 Claude 的上一次快照；一旦根层枚举成功，本次清单就有权威性，缺失或不可读的项目、subagent、workflow 子目录按空子树处理。已索引的主 transcript 路径从权威清单中消失时，discover 生成 tombstone unit，由共享 persist 撤回该 session 的可重建派生投影。普通子代理和 workflow 文件仍按各自 unit 解析；当前 session 删除清理的主键来自 `sessions.jsonl_path`。

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

Trajex 用 `tool_use.id` / `tool_result.tool_use_id` 关联两者。`StructuredOutput` 也属于普通 `tool_use`：其 `input` 是结构化结果，后续 `tool_result` 是运行时确认。纯 `tool_result` message 的 `text` 只保留最多 1,000 字符的首尾预览，`tool_results.content` 保留最多 10,000 字符的首尾内容；它们不是永久、无损的原始存档。

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

Trajex 的 Workflow 关联分两阶段完成：

1. 解析 `workflows/<run-id>.json`，读取 `runId`，并回扫对应的主 transcript。
2. 在主 transcript 中先收集名为 `Workflow` 的 assistant `tool_use`，再检查对应 user `tool_result`。只有 `tool_result.content` 包含该唯一 `runId` 时，才使用 `tool_result.tool_use_id` 写入 `workflows.parent_tool_use_id`。因此 Workflow 最终挂在 `tool_use` 上，`tool_result` 只是中间凭证；workflow 名称不参与关联，避免同名 workflow 串线。

一次索引中，workflow JSON 和主 transcript 是两个独立 unit，文件到达顺序也可能不同。如果 workflow JSON 先入库，而主 transcript 的 `tool_result` 尚未写入，第一次解析会诚实地留下 `parent_tool_use_id = null`。每次索引 finalize 时，Trajex 会在所有 unit 写入完成后执行一次幂等补偿：从 `workflows.run_id` 匹配同 session 的 `tool_results.content`，并且只接受对应 `tool_calls.name = 'Workflow'` 的结果，再把 `tool_results.tool_use_id` 回填到 `workflows.parent_tool_use_id`。找不到唯一 run ID 的记录继续保持 `null`，不猜测、不按名称兜底。
