# DeepSeek Harness Session JSONL

> DeepSeek Harness（DSH）会话日志格式说明，结合 Trajex `packages/core/src/providers/deepseek.ts` 的实际消费行为整理，只保留索引、查询和 Session Detail 需要的内容。完整上游定义见 [session-persistence-jsonl](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/session/session-persistence-jsonl/README.md) 与 [session-format-v3-to-v4](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/session/session-format-v3-to-v4/README.md)；设计决策见 [ADR-0013](../adr/0013-deepseek-harness-session-trees.md)。

## 1. 文件与索引边界

来源根是 `$DSH_HOME/sessions`，`DSH_HOME` 未设置或为空白时为 `~/.dsh/sessions`。App Settings 可直接指定最终 sessions 目录。

```text
<root>/--<normalized-cwd>--/<encoded-session-id>/
  session.jsonl[.zstd]        # v0
  session.v1.jsonl[.zstd]     # v1 … vN
  session.lock                # 写锁，不是 generation
  *.tmp                       # 迁移临时文件，不是 generation
```

- 每个会话目录可能同时保留多个 generation：DSH 迁移格式时在旁边发布更高版本，旧文件不变。Trajex 只读取支持范围（v0–v4）内的最高 generation；同版本同时存在两种编码时优先 `.zstd`。
- 只有未知更高 generation（例如 `session.v5.*`）或 header 尚不可读的目录不产生新索引，已有快照受保护，不会被 tombstone；它所属的会话树也暂停重放，避免连带删除该成员的旧证据。
- 项目目录名不参与解析；项目与身份都来自 header 的 `cwd`。

## 2. 物理编码

- `compression: 'zstd'`（默认）：若干独立、带校验和的 Zstandard frame 首尾拼接。header 一帧，之后每个持久化批次一帧。Node 的一次性解压只解到第一个帧边界，Trajex 先扫描完整帧范围，再逐帧解码。
- `compression: 'none'`：以换行分隔的 UTF-8 JSONL。
- 撕裂尾部：未以换行结束的原始尾行、EOF 中断的最后一帧都不读取（DSH 会自行修复）。完整帧校验失败视为损坏，本单元失败、下次重试。
- 读取压缩日志需要 Node.js 22.15+；更早的运行时跳过 `.zstd` 并给出一次警告。

## 3. Header

第一行（或第一帧）是不可变 header：

```json
{"type":"session","version":4,"id":"<session-id>","createdAt":1787159057210,"cwd":"/project","isSeeded":false,"delegationDepth":0,"parentSession":"<parent-id>","origin":"subagent"}
```

| 字段 | Trajex 用途 |
|---|---|
| `id` + `cwd` | 身份 `deepseek:<encodeURIComponent(id)>:<sha256("deepseek-cwd-v1\0"+normalize(cwd))>` |
| `version` | 必须与文件名 generation 一致；v0 可省略 |
| `createdAt` | `sessions.started_at`（毫秒时间戳） |
| `parentSession` | 子代理/fork 归属到父会话树 |
| `isSeeded`（v2+）/ `seedLength`（v0/v1） | 继承前缀的边界 |

## 4. 事件

其余每行一个事件：`{"type", "seq", "time", "data", "surfaceOp"?, "sourceEventSeqs"?}`。`time` 是毫秒时间戳，`seq` 是会话内的稠密序号。

| 事件 | 关键字段 | Trajex 投影 |
|---|---|---|
| `user/message` | `data.{id, content[], source.kind}` | user 消息；`source.kind !== 'user'` 为 meta |
| `assistant/message` | `data.{turn, step, message{id, content[reasoning \| text \| tool-call], source.model}, usage}` | thinking / text / `tool_use` 锚点；usage 只记在主消息 |
| `tool/call` | `data.{turn, step, callId, name, arguments(JSON 字符串)}` | `tool_calls` |
| `tool/result` | `data.message.source.callId`，内容见下 | `tool_results` |
| `tool/ptc-dispatch`（v3+）/ `tool/code-dispatch`（v0–v2） | `data.{parentCallId, subCallId, name, arguments, content, isError}` | 挂在外层调用锚点上的子调用与结果 |
| `compaction/summary` | `data.{compactionId, summary}` | `summaries` |
| `session/title` | `data.title` | 会话标题（根会话） |
| `subagent/descriptor` | `data.{agentProvider, agentModel, provider, label}` | `subagents.agent_type` / `description` |
| `request/header` | `data.header.config.model` | 默认模型 |
| `session/end-seed` | `data.inherited: true` | v2+ 继承前缀的结束位置 |

`assistant/attempt`、`system/message`、`turn/*`、`step/*`、`llm/retry*` 以及打包的 chunk 行和内嵌 `stream` 都会被忽略：它们要么是控制面，要么与 step 最终的 `assistant/message` 重复。

### 4.1 工具结果：v3 与 v4

```text
v0–v3: message { role: "user", source: { kind: "tool", callId },
                 content: [{ type: "tool-result", toolCallId, content: [...], isError }] }
v4:    message { role: "tool", toolCallId, source: { kind: "tool", callId },
                 content: [...], isError }
```

两种形态投影出相同的 `tool_results.content`。错误判定：任意版本的 `data.error`，v4 看消息的 `isError`，v0–v3 看包装块的 `isError`。

### 4.2 Compaction 与 `surfaceOp`

`surfaceOp: { op: "replace", startSeq, endSeq }` 表示该事件替换了 `[startSeq, endSeq]` 内的当前上下文。被替换的事件保留为 `inactive`，替换后的检查点消息标为 meta，`compaction/summary` 进入 `summaries`。普通事件的 `surfaceOp` 为 `"append"`。

### 4.3 子代理与 fork

子会话是同级的普通会话目录，只靠 header 的 `parentSession` 关联。Trajex 把根会话与所有可追溯到它的后代合并为一个 session：子会话消息带 `agent_id`，并生成一条 `subagents` 记录；父会话中 `started subagent <id>` 的工具结果会关联到发起调用。seeded 子会话的开头复制了父会话历史，以 `session/end-seed{inherited:true}`（v2+）或 `seedLength`（v0/v1）为界。归属到父树时跳过这段前缀；单独作为根时保留为 `inactive`。

## 5. Trajex 解析流程

1. 枚举两级目录，为每个会话目录选择支持的最高 generation，并读取 header（压缩日志只解码第一帧，按文件快照缓存）。
2. 沿 `parentSession` 在同一项目作用域内分组为会话树；根会话的 artifact 路径就是 unit key 和 `jsonl_path`。
3. 每轮为所有树按成员快照计算签名（成员增删会改变未被 watcher 提示的树），与 cursor 一致且根已按同一路径索引时跳过。
4. 变化时全量重放整棵树：先 `delete-session`，再按成员顺序投影；每个成员读前读后快照必须一致。
5. 根层可读时清单是权威的：消失的会话生成 tombstone；被新树收编的旧根身份在同一事务内由该树撤回。

## 6. 与其他 JSONL provider 的关键区别

| 维度 | DeepSeek Harness | Pi | Codex |
|---|---|---|---|
| 单元 | 根会话树（多文件） | 单文件 | 单文件 |
| 编码 | 多帧 Zstandard 或 JSONL | JSONL | JSONL |
| 版本 | 同目录多 generation，取最高支持版本 | 仅 v3 | 无版本 |
| 子代理 | 并入父会话，带 `agent_id` | 无 | 忽略子 thread |
| 被替换上下文 | `inactive` | `inactive` | 无 |

## 7. 相关实现位置

- `packages/core/src/providers/deepseek.ts`：发现、会话树、投影与 raw 回查。
- `packages/core/src/vendor/dsh-zstd.ts`：多帧 Zstandard 帧扫描与逐帧解码。
- `tests/deepseek-parse.test.mjs`、`tests/deepseek-zstd.test.mjs`、`tests/app-deepseek-indexer.test.mjs`：基于 `tests/fixtures/deepseek/` 的真实格式测试。
