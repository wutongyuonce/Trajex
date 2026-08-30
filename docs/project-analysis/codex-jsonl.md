# Codex Rollout JSONL / 线程格式

> 非官方、观测性文档。OpenAI 没有把 rollout JSONL 当作稳定公开 schema；顶层 `type` 与 `payload` 内的字段都可能随版本变化。本文以本机观察到的 **Codex Desktop（`cli_version` 0.146–0.147 alpha）与 CLI（`codex_cli_rs` 0.94–0.130）** 输出，以及 Trajex 当前 `providers/codex.ts` 的实际消费行为为准。

## 1. 范围与基本规则

Codex 把一个线程（thread）保存为一个 **rollout JSONL 文件**：一行一个自包含 JSON 对象，追加式写入。与 Claude 不同，Codex 没有"子代理独立文件"——子代理是**另一个 rollout 文件**（一个线程一个文件），靠 `session_meta.payload` 里的父线程字段表达父子关系。

```text
~/.codex/
├── sessions/
│   └── 2026/07/24/
│       └── rollout-2026-07-24T02-19-46-019f9034-7bc7-….jsonl   # 一个线程 = 一个文件
├── archived_sessions/                                          # v0.136+ 归档目录
│   └── rollout-2026-07-30T00-31-25-….jsonl
└── session_index.jsonl                                         # 线程名索引，不是 transcript
```

- 文件名：`rollout-<UTC时间戳>-<uuid片段>.jsonl`，天然可排序。
- 日期目录按 `YYYY/MM/DD` 分层；Trajex 的 `discoverCodexJsonlFiles()` 递归枚举 `sessions/` 和可选 `archived_sessions/` 下的全部 `*.jsonl`，并监听这两个目录及 `session_index.jsonl`。
- `session_index.jsonl` 每行是 `{"id":"<thread-id>","thread_name":"…","updated_at":"…"}`，提供标题与最后更新时间；它不是 transcript。Trajex 用它给 session 提供 `title` 和 `ended_at`。
- 可用环境变量 `CODEX_SESSIONS_DIR` 覆盖默认位置（Trajex 的默认根目录是 `~/.codex`）。

## 2. JSONL 的公共形状

每个 rollout 对象是**两级类型**：顶层 `type` 决定行类别，`payload` 承载数据；`event_msg` / `response_item` 还各自有 `payload.type` 细分类别。顶层 `timestamp` 是 ISO 8601 字符串。

对本机 166 个 rollout 文件的 43932 行统计，顶层 `type` 分布：

| 顶层 `type` | 份数 | 含义 |
| --- | --- | --- |
| `response_item` | 20691 | API 原始响应条目（消息、推理、工具调用/结果） |
| `event_msg` | 19994 | 客户端可见事件流（消息、token、耗时等） |
| `session_meta` | 1093 | 线程元数据（通常首行） |
| `turn_context` | 1784 | 每轮模型/沙箱快照 |
| `world_state` | 325 | 环境状态快照 |
| `compacted` | 34 | 压缩历史（含 `replacement_history`） |
| `inter_agent_communication_metadata` | 11 | 多 agent 通信标记（`payload: {"trigger_turn": true}`） |

> 字段不是每行都有，解析器必须按可选字段处理。未知顶层 `type` 或 `payload.type` 不应被当作错误。

## 3. `session_meta`：线程元数据

典型首行（本机真实数据，CLI 正常根线程）：

```json
{
  "timestamp": "2026-03-16T16:39:14.432Z",
  "type": "session_meta",
  "payload": {
    "id": "019cf784-14f5-7850-944e-4b3c97c662ef",
    "timestamp": "2026-03-16T16:39:14.421Z",
    "cwd": "/Users/a",
    "originator": "codex_cli_rs",
    "cli_version": "0.94.0",
    "source": "cli",
    "model_provider": "custom",
    "base_instructions": { "text": "You are GPT-5.2 running in the Codex CLI…" }
  }
}
```

本机 1093 个 `session_meta` 中观察到的 `payload` 字段：

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| `id` | string | 线程 ID（Trajex 的 `session_id = codex:<id>`） |
| `session_id` | string | Desktop 新增；对子线程等于父线程 ID，注意与 `id` 区分 |
| `timestamp` | string | 线程创建时间 |
| `cwd` | string | 工作目录，Trajex 据此推 `sessions.project_path` |
| `originator` | string | 客户端标识：`codex_cli_rs`、`Codex Desktop`、`codex_vscode`、`codex-tui`、`codex_sdk_ts` 均已见 |
| `cli_version` | string | 版本（如 `0.146.0-alpha.3.1`），写入 `sessions.version` |
| `source` | string \| object | **类型可变**：根线程是字符串（`"cli"` / `"vscode"` / `"cli_tui"` 等）；子线程是对象（见 §3.1） |
| `thread_source` | string | `"user"`（根线程）或 `"subagent"`（子线程） |
| `model_provider` | string | `"openai"` / `"custom"` 等 |
| `base_instructions` | object | `{ text }`，系统提示词 |
| `dynamic_tools` | array | 动态启用的工具 |
| `history_mode` | string | 历史模式 |
| `context_window` | number | 上下文窗口大小 |
| `memory_mode` | string | 记忆模式 |
| `multi_agent_version` | string | 多 agent 版本 |
| `git` | object | `{ branch, commit_hash }`；`branch` 写入 `sessions.git_branch` |
| `parent_thread_id` | string | Desktop 新增顶层字段；子线程指向父线程 |
| `forked_from_id` | string | fork 场景的父线程 ID |
| `agent_nickname` | string | 子代理昵称（如 `Socrates`） |
| `agent_path` | string | 子代理路径（如 `/root/pi_provider_review`） |

### 3.1 子线程 / 父线程判定

`source` 为对象时表示子线程。真实文件见两种形状：

```json
// 子代理派生（thread_spawn）
{
  "session_id": "019fdb89-…",
  "id": "019fdba6-…",
  "forked_from_id": "019fdb89-…",
  "parent_thread_id": "019fdb89-…",
  "source": { "subagent": {
    "thread_spawn": {
      "parent_thread_id": "019fdb89-…",
      "depth": 1,
      "agent_nickname": "Socrates",
      "agent_path": null
    }
  }},
  "thread_source": "subagent",
  "agent_nickname": "Socrates"
}
```

```json
// Guardian / auto-review
"source": { "subagent": { "other": "guardian" } }
```

| 优先级 | 路径 | 场景 |
| --- | --- | --- |
| ① | `source.subagent.thread_spawn.parent_thread_id` | 子代理派生（真实文件已见：`depth`、`agent_nickname` 伴随出现） |
| ② | `forked_from_id` | fork 派生 |
| ③ | `source.subagent.parent_thread_id` | 兜底（旧版遗留） |
| ④ | 顶层 `parent_thread_id` | Desktop 顶层字段 |
| ⑤ | `thread_source === "subagent"` | 子线程信号 |

### 3.2 Guardian / auto-review 线程

guardian 是子线程的特殊变体，标记在 `source.subagent.other`，见上例。本机真实 guardian 的 `base_instructions` 表明它"judging one planned coding-agent action"。Trajex 的 `codexIsGuardianThread()` 用于识别它。

## 4. `turn_context`：每轮上下文

每轮对话开始时写入一条快照，Trajex 用它更新 `currentModel` / `currentCwd`：

```json
{
  "timestamp": "2026-03-16T16:39:16.803Z",
  "type": "turn_context",
  "payload": {
    "cwd": "/Users/a",
    "approval_policy": "untrusted",
    "sandbox_policy": { "type": "workspace-write", "network_access": false },
    "model": "gpt-5.2",
    "personality": "friendly",
    "collaboration_mode": { "mode": "code", "settings": { "model": "gpt-5.2", "reasoning_effort": "high" } },
    "effort": "high",
    "summary": "auto",
    "turn_id": "019cf786-…",
    "current_date": "2026-07-27",
    "timezone": "Asia/Shanghai",
    "realtime_active": false,
    "permission_profile": {},
    "workspace_roots": []
  }
}
```

本机观察到的 `payload` 键：`cwd`、`model`、`approval_policy`、`sandbox_policy`、`personality`、`collaboration_mode`、`effort`、`summary`、`user_instructions`、`truncation_policy`、`turn_id`、`current_date`、`timezone`、`realtime_active`、`developer_instructions`、`permission_profile`、`file_system_sandbox_policy`、`workspace_roots`、`multi_agent_version`、`approvals_reviewer`、`comp_hash`、`multi_agent_mode`。

## 5. `event_msg`：客户端可见事件流

`payload.type` 细分事件。本机 19994 条统计与 Trajex 消费行为：

| `payload.type` | 份数 | 关键字段 | Trajex 行为 |
| --- | --- | --- | --- |
| `token_count` | 6510 | `info.last_token_usage` / `info.total_token_usage` | 更新会话 token 总和，并回填上一条 assistant 文本消息的 input/output tokens |
| `agent_message` | 3193 | `message`、`phase` | 产生 assistant 消息 |
| `agent_reasoning` | 2367 | `text` | 产生 assistant 消息，`content_type = "thinking"` |
| `user_message` | 1733 | `message` / `text_elements` / `images` | 产生 user 消息；文本优先 `message` 字符串，其次拼接 `text_elements` |
| `task_started` | 1737 | `turn_id`、`model_context_window` | 忽略 |
| `task_complete` | 1667 | `turn_id`、`last_agent_message`、`duration_ms` | 给上一条 assistant 文本消息产生 `message-turn-duration` |
| `thread_settings_applied` | 1573 | `thread_settings.model`（如 `codex-auto-review`） | 忽略 |
| `patch_apply_end` | 848 | `call_id`、`stdout`、`success` | 忽略 |
| `turn_aborted` | 64 | `turn_id`、`reason` | 忽略 |
| `thread_rolled_back` | 80 | — | 忽略 |
| `web_search_end` | 57 | `call_id`、`query` | 忽略 |
| `context_compacted` | 34 | — | 产生一条固定内容 `"已 compact"` 的 summary（压缩标记） |
| `mcp_tool_call_end` | 116 | `call_id`、`invocation` | 忽略 |
| `image_generation_end` | 7 | `call_id`、`status` | 忽略 |
| `sub_agent_activity` | 7 | `agent_thread_id`、`kind` | 忽略 |
| `error` | 1 | `message` | 忽略 |

```json
{"timestamp":"2026-07-23T18:22:02.187Z","type":"event_msg","payload":{
  "type":"user_message","client_id":"…","message":"写一份项目解析…","images":[],"text_elements":[]}}

{"timestamp":"2026-07-23T18:22:10.188Z","type":"event_msg","payload":{
  "type":"agent_message","message":"我会先把项目结构和核心入口摸清楚…","phase":"commentary"}}

{"timestamp":"2026-07-23T18:22:10.379Z","type":"event_msg","payload":{
  "type":"token_count","info":{
    "total_token_usage":{"input_tokens":18983,"output_tokens":338,"cached_input_tokens":0},
    "last_token_usage":{"input_tokens":18983,"output_tokens":338,"cached_input_tokens":0},
    "model_context_window":258400}}}

{"timestamp":"2026-05-06T00:20:12.641Z","type":"event_msg","payload":{
  "type":"error","message":"unexpected status 503 …","codex_error_info":"other"}}
```

注意：**token 计数在 `info.last_token_usage` / `info.total_token_usage` 里**，不在顶层 `payload.input_tokens` 下；二者通常相同。`info` 也可能为 `null`（空轮）。`codexEventText()` 会先剥离 `<image>…</image>` 图片标记再取文本。

## 6. `response_item`：API 原始响应条目

`payload.type` 细分。本机 20691 条统计与 Trajex 消费行为：

| `payload.type` | 份数 | Trajex 行为 |
| --- | --- | --- |
| `reasoning` | 5816 | 忽略（内容在 `encrypted_content` 中，可能加密） |
| `message`（`role !== "developer"`） | 5778 | 与 event_msg 去重后产生 user/assistant 消息（见 §8） |
| `custom_tool_call` | 4150 | 产生 tool_use 消息 + `tool_call`（入参取 `payload.input`，`apply_patch`、`exec` 等） |
| `custom_tool_call_output` | 4150 | 产生 `tool_result` 和 `content_type: 'tool_result'` 的 user message |
| `function_call` | 388 | 产生 tool_use 消息 + `tool_call`（`name` 取 `payload.name`，入参取 `payload.arguments`，如 `exec_command`） |
| `function_call_output` | 388 | 同 `custom_tool_call_output` |
| `web_search_call` | 6 | 产生 tool_call（入参仅 `{ action }`） |
| `tool_search_call` | 2 | 同上；入参取 `payload.arguments` |
| `tool_search_output` | 2 | 同 output 处理 |
| `agent_message` | 11 | 多 agent 消息（`author` / `recipient`），忽略 |
| 其他 | — | 忽略 |

工具调用与结果通过 `call_id` 关联：`tool_call.id = codex:<threadId>:<call_id>`，`tool_result.tool_use_id` 指向同一值。`output` 可能是字符串（`function_call_output`）或 block 数组（`custom_tool_call_output`）。结果 message 只保留最多 1,000 字符的首尾预览，`tool_results.content` 保留最多 10,000 字符的首尾内容。

```json
{"timestamp":"2026-07-23T18:22:10.192Z","type":"response_item","payload":{
  "type":"function_call","id":"fc_…","name":"exec_command",
  "arguments":"{\"cmd\":\"pwd\",\"workdir\":\"/Users/a/Desktop/obelisk\",…}",
  "call_id":"call_XSJjvS2o1MGUR9vLPf06RqDd"}}

{"timestamp":"2026-07-23T18:22:10.326Z","type":"response_item","payload":{
  "type":"function_call_output","id":"fco_…","call_id":"call_XSJjvS2o1MGUR9vLPf06RqDd",
  "output":"Chunk ID: 071531\n…"}}

{"timestamp":"2026-07-27T11:02:17.340Z","type":"response_item","payload":{
  "type":"custom_tool_call","id":"ctc_…","status":"completed",
  "call_id":"call_tQMqD9rrSIW22G0jiGD8pdE1","name":"apply_patch",
  "input":"*** Begin Patch\n…"}}
```

与 Claude 的关键差异：Codex 所有工具的 `tool_calls.file_path` 恒为 `null`（Claude 只对 `Read`/`Edit`/`Write`/`NotebookEdit` 提取标准化 `file_path`）。

## 7. 消息正文结构

`response_item.message` 的 `payload.content` 是 block 数组；用户用 `input_text`、助手用 `output_text`：

```json
{"content":[{"type":"input_text","text":"Hello"}]}
```

- `codexMessagePayloadText()` 拼 `block.text`；被 `<image>` + `input_image` + `</image>` 三段包裹的图片占位会被整段跳过。
- 被 `<environment_context>` / `<codex_internal_context>` 包裹的 user 消息判定为 `hidden`（`is_meta = 1`）。
- 符合 skill instruction 结构的文本会标为 `content_type = "skill_instructions"`。
- 混合块不会产生 `unknown` 归类——Codex 每条消息的正文是单一文本投影，`content_type` 只在 `text` / `thinking`（agent_reasoning）/ `tool_use`（工具调用消息，`text` 为 null）之间选择。

## 8. event_msg ↔ response_item 去重

```
模型/运行时产生原始响应
        │
        ├── response_item：协议层原始记录
        │     ├── message
        │     ├── reasoning
        │     ├── function_call
        │     └── function_call_output
        │
        └── event_msg：Codex 面向 UI/事件订阅者的事件流
              ├── user_message
              ├── agent_message
              ├── agent_reasoning
              ├── token_count
              └── task_complete
response_item
  = API/模型层的事实记录
  = 工具调用和结果的主要来源

event_msg
  = Codex runtime/UI 层事件
  = 文本消息、token、耗时、工具状态通知
```

同一内容在文件里有两份镜像：`event_msg`（客户端可见事件）与 `response_item`（API 原始响应），配对行相距 ±1 行但**顺序不定**。Trajex 的 `parse` 先整文件读入，第一遍收集所有可见 `event_msg` 的 `(role, text)` 键（`codexVisibleMessageKey`），第二遍遇到 `response_item.message` 时，若 `(role, text)` 已存在则丢弃——**event_msg 优先，response_item 兜底**。

## 9. Trajex 的处理

### 9.1 发现（discover）

- 读取 `session_index.jsonl`，构建 `Map<rawId, {title, updatedAt}>`；每行解析为 `{id, thread_name, updated_at}`。
- 递归枚举 `sessions/` 和 `archived_sessions/` 下全部 `*.jsonl`。有 `changedPaths` 时只检查 watcher 指出的路径；否则用存储 cursor 与文件 mtime 跳过未变更文件。
- 对每个候选文件读首行 `session_meta`；**有父 ID 的 rollout 一律不索引**（`discoverAt` 直接跳过，与 Claude 把子代理转录也索引的做法不同）。
- 产出 `IndexUnit`：`sessionId = codex:<rawId>`，携带 `indexedTitle` / `indexedUpdatedAt`。
- 发现阶段同时读取已索引的 session 路径清单。只有当 `sessions/` 本身可读，且旧路径从当前清单中明确消失时，才产出带 `retractSessionIds` 的 tombstone unit；如果根目录暂时不存在或不可读，则不产出 tombstone，保留上一次快照。

### 9.2 全量重放（parse）

这正是 Codex 是"全量重放"适配器的原因：去重需要整文件（双向）知识，无法像 Claude 那样按行增量续读。每次根 thread 的 parse 都重发全部记录并带 `countMode: 'total'`，且在记录流开头发出 `delete-session`，由 persist 先清理该 session 的旧派生投影，再写入当前完整结果。`delete-session` 是全量重建协议，不再是 guardian/auto-review 的特殊撤回协议。若全量读取遇到已换行结束的损坏 JSONL 记录，解析器消费该行并继续处理后续记录；未换行的文件尾可能仍在写入，因此 cursor 停在它之前，下次 replay 会从头重建。

处理顺序（`providers/codex.ts`）：

1. 整文件读入内存，`outCursor = mtime:lineNum`；找不到 `session_meta` 或命中 child/guardian 则直接返回。
2. `session_id = codex:<threadId>`；`project` 由 `meta.cwd` 推导；`lineUuid(n) = codex:<threadId>:<n>`。
3. 第一遍：收集所有可见 `event_msg`（`user_message` / `agent_message`）的 `(role, text)` 键。
4. 第二遍逐行：
   - `session_meta` / `turn_context`：更新 `currentCwd` / `currentModel` / `git_branch` / `version`。
   - `event_msg.context_compacted` → summary `"已 compact"`；`task_complete` → 上一条 assistant 文本消息的 `message-turn-duration`；`token_count` → 会话 token 总和 + 回填上一条 assistant 文本消息 token；`thread_name_updated` → 会话标题。
   - `response_item.message`（`role !== 'developer'`）→ 去重未命中时产生消息。
   - `response_item` 的 `payload.type` 为 `function_call`、`custom_tool_call`、`tool_search_call` 或带 `call_id` 的 `web_search_call` 时，先产生一条 `content_type: 'tool_use'` 的 assistant 消息（`text` 为 null），再写 `tool_call`；`name` 取 `payload.name || payload.tool`，入参从 `payload.arguments` / `payload.input` / 搜索 action 提取后序列化进 `input_json`，`file_path` 恒为 null。`event_msg` 中的 `patch_apply_end`、`mcp_tool_call_end`、`web_search_end` 等只是生命周期通知，当前不作为独立 `tool_call` 来源。
   - `response_item` 的 `payload.type` 为 `function_call_output`、`custom_tool_call_output` 或 `tool_search_output` 时，产生 `content_type: 'tool_result'` 的 user 消息 + `tool_result`，通过 `payload.call_id` 关联对应调用。
5. 结尾产出 `session` record：`started_at` 取最早时间戳，`ended_at` 优先 `session_index.updated_at`，`title` 优先 `session_index.thread_name`，`countMode: 'total'`。

### 9.3 会话聚合

- `session_id = codex:<payload.id>`；`project` 由 `payload.cwd` 推导；
- `started_at` 取最早时间戳，`ended_at` 优先用 `session_index.jsonl` 的 `updated_at`（否则取最新时间戳）；
- `title` 优先 `session_index.thread_name`，`event_msg.thread_name_updated` 可覆盖；
- `git_branch`、`version`（cli_version）来自 `session_meta`；
- `countMode: 'total'`；`message_count` 为本次重放的可见消息数。
- 子线程不产生 `session` record，也不挂到 `subagents` 表。

### 9.4 raw 回源

`codex:<threadId>:<lineNum>` 格式的合成 uuid 可还原：优先用 `sessions.jsonl_path`，否则递归搜索以 `<threadId>.jsonl` 结尾的文件，按行号取回原始 JSON，并额外投影 `messageText`（event_msg 取 `message` / `text`，response_item.message 取拼接文本）。
