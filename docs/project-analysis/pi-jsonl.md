# Pi v3 Session JSONL

> Pi 官方 v3 session 文件的格式说明，结合 Trajex 当前 `packages/core/src/providers/pi.ts` 的实际消费行为整理。这里只保留索引、查询和 Session Detail 所需要的内容；完整上游定义见 [Pi session-format.md](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/session-format.md)。

## 1. 文件与索引边界

Pi 的一个 `.jsonl` 文件就是一个 session。默认位置是：

```text
~/.pi/agent/sessions/--<project-path>--/<timestamp>_<uuid>.jsonl
```

Trajex 的 Pi provider 接收配置后的最终 session directory，不再追加 `sessions` 子目录；它递归发现其中的 `*.jsonl`，但只接受官方 v3 文件：

```json
{"type":"session","version":3,"id":"session-id","timestamp":"2024-12-03T14:00:00.000Z","cwd":"/project"}
```

第一行是 session header，不属于消息树。其余带 `id` 的 entry 通过 `parentId` 组成树。Pi 可以在同一个文件中保存分支，不会为每个分支新建文件。

Trajex 对 Pi 文件采用全量 replay：active context 依赖 durable `leaf`、分支和 compaction checkpoint，不能只从上次行号继续解析。每次 replay 先删除该 session 的旧投影，再写入完整事实，`session.countMode` 为 `total`。

- 根目录暂时不可枚举时，保留上一次快照。
- 根目录可枚举但某个 session 文件消失时，发出 tombstone，清理该文件的可再生索引数据。
- JSONL 中出现损坏行时，只提交损坏行以前的有效前缀，cursor 停在损坏行之前。

## 2. 树结构

除 header 外，entry 通常具有以下公共字段：

```json
{
  "type":"message",
  "id":"a1b2c3d4",
  "parentId":"上一条-entry-id",
  "timestamp":"2024-12-03T14:00:01.000Z"
}
```

当前上下文由最后一个 durable leaf 决定：

```json
{"type":"leaf","id":"leaf-1","parentId":"a2","targetId":"a2"}
```

解析器从 leaf 指向的 target 沿 `parentId` 回溯到根，再反转为时间顺序。没有 leaf 时，使用文件中最后一个物理 entry 作为当前位置。

示意：

```text
user ── assistant ── user ── assistant ── leaf → 当前上下文
                    └─ branch_summary ── 另一条分支（inactive）
```

当前路径上的消息为 `visible`；仍在文件中但不属于当前 leaf 路径的分支证据为 `inactive`。来源明确要求不展示的 custom message 为 `hidden`。

## 3. 与 Trajex 有关的 entry 类型

### 3.1 普通消息：`message`

```json
{"type":"message","id":"u1","parentId":null,
 "message":{"role":"user","content":"检查项目"}}

{"type":"message","id":"a1","parentId":"u1",
 "message":{"role":"assistant","content":[
   {"type":"thinking","thinking":"先查看目录"},
   {"type":"toolCall","id":"call-1","name":"Read","arguments":{"file_path":"/tmp/a"}}
 ]}}

{"type":"message","id":"r1","parentId":"a1",
 "message":{"role":"toolResult","toolCallId":"call-1","toolName":"Read",
 "content":[{"type":"text","text":"file body"}],"isError":false}}
```

Trajex 当前处理的 message role：

| 原始 role / content | Trajex 投影 |
|---|---|
| `user` 文本 | `message(role='user', content_type='text')` |
| `user` 图片 | `message(role='user', content_type='image')`，只保留 MIME 与 base64 字符数占位符 |
| `assistant` 的 `text` | `message(role='assistant', content_type='text')` |
| `assistant` 的非空 `thinking` | `message(role='assistant', content_type='thinking')` |
| `assistant.errorMessage` | `message(role='assistant', content_type='error')` |
| `assistant` 的 `toolCall` | 空文本的 `message(content_type='tool_use')` + `tool_call` |
| `toolResult` | `message(role='tool', content_type='tool_result')` + `tool_result`；自带 usage 写入 message token 字段 |
| `bashExecution` | `message(role='tool', content_type='bash')` |

同一个 user 或 assistant entry 可能包含多个 content part，Trajex 会按 part 拆成多条消息，用 `:<part-index>` 区分 UUID，并保持 parent chain。图片不将 base64 正文写入索引；空 thinking 不投影，assistant 失败则把 `errorMessage` 连在 content parts 后面，并承接该响应 usage。Pi 的原始 `toolCallId` 在分叉后可能复用，因此不能直接作为数据库主键：每次 tool call 使用对应 tool-use message UUID 派生独立 canonical ID；tool result 沿 entry 的 `parentId` 工具作用域寻找同一分支内最近的原始 ID。compaction 与 branch summary 会清除旧作用域，retained tail 再从保留消息重建；找不到调用的结果仍保留 message 证据，但不生成错误的 `tool_result` 关联。

工具结果的时间线 message 只保存最多 1,000 字符的首尾预览；`tool_results.content` 保存最多 10,000 字符的首尾内容。这样既能在 `thread()` / FTS 中检索，也避免把大工具输出直接塞进消息列表。若 `toolResult` 本身携带嵌套模型 usage，输入按 `input + cacheRead + cacheWrite` 归一化后写入这条 message，让 Activity 统计实际消耗。

### 3.2 Compact：`compaction`

旧格式只保存保留边界：

```json
{"type":"compaction","id":"c1","parentId":"r1",
 "timestamp":"2024-12-03T14:10:00.000Z",
 "summary":"此前讨论了 X、Y、Z。",
 "firstKeptEntryId":"a1",
 "tokensBefore":50000}
```

新格式把 compact 后仍要保留的消息直接嵌进同一条 entry：

```json
{"type":"compaction","id":"c1","parentId":"r1",
 "summary":"此前讨论了 X、Y、Z。",
 "tokensBefore":50000,
 "retainedTail":[
   {"role":"user","content":"最近的问题"},
   {"role":"assistant","content":[{"type":"text","text":"最近的回答"}]}
 ]}
```

对 Trajex 来说：

- `summary` 产生一条独立 `summary(source='compaction')`。
- `retainedTail` 会被合成为消息或 summary，显示在 compact checkpoint 后面；其中每条 branch/compaction summary 都有独立 canonical ID。
- `retainedTail` 是上下文快照，不是新的模型执行；嵌套 message 与 summary 中复制的 usage 不再计入 Activity，避免与物理记录重复。
- `retainedTail` 中的合成消息没有独立物理 JSONL 行；回查会通过 UUID 中的 retained index 取出对应的嵌套消息，不返回整条 compaction，也不暴露其他 retained sibling。
- 有 `retainedTail` 时，compact 之前的 active ancestor 被截断；没有它时，使用 `firstKeptEntryId` 确定保留边界。
- compact 之后的真实物理 `message` 继续沿 `parentId=compaction.id` 写入。

因此 Pi 的实际链路是：

```text
旧消息树
  → compaction.summary
  → compaction.retainedTail（嵌套消息，可选）
  → 后续真实 message
  → leaf
```

### 3.3 分支摘要：`branch_summary`

```json
{"type":"branch_summary","id":"b1","parentId":"a1",
 "timestamp":"2024-12-03T14:15:00.000Z",
 "fromId":"a1","summary":"废弃分支尝试了方案 A。"}
```

Trajex 将 `summary` 投影为 `summary(source='branch_summary')`。如果它不在当前 leaf 路径上，相关消息保留为 `inactive`，便于查看历史分支但不污染默认会话上下文。

### 3.4 扩展消息：`custom_message`

```json
{"type":"custom_message","id":"m1","parentId":"a1",
 "customType":"my-extension","content":"注入给模型的上下文","display":false}
```

这类 entry 会参与 Pi 的上下文构建。Trajex 将其投影为 role `custom` 的消息：`display=false` 时为 `hidden`，否则沿当前分支显示，并标记为 meta/扩展内容。

普通 `custom` entry 是扩展状态持久化，不参与 LLM context；当前 Trajex 不把它当普通 conversation message。`session_info` 只更新 session 标题；`model_change` 和 `thinking_level_change` 只影响 Pi 运行时状态，当前不产出独立消息。

## 4. 当前上下文与历史分支

Pi 的物理文件是完整树，不等于当前 LLM 看到的线性上下文。Trajex 同时保留两层信息：

```text
原始树：所有 message / branch / compaction entry
             │
             └─ leaf + compaction 规则
                   │
                   ├─ visible：当前上下文
                   ├─ inactive：被分支替代但仍保留的证据
                   └─ hidden：来源明确不展示的内容
```

详情页和普通 `thread()` 默认只展示 `visible`。调查被替代的 Pi 分支时，需要显式请求 inactive 记录。

## 5. Trajex 解析流程

`packages/core/src/providers/pi.ts` 的处理顺序如下：

1. 读取整个 JSONL，遇到损坏行停止。
2. 找到 v3 session header，计算 `session_id = pi:<raw-id>:<cwd-hash>`。
3. 建立 `id → entry` 索引，解析 durable leaf 和 active path。
4. 从 active head 反向追溯，遇到最近的 `retainedTail` checkpoint 就停止，更早物理链不再参与当前上下文计算。
5. 在这段有效 path 内应用最后一次 compaction：checkpoint 用 `retainedTail` 替代祖先，legacy compaction 只能从 path 内存在的 `firstKeptEntryId` 开始保留。
6. active checkpoint 的 `retainedTail` 只在 compaction entry 后合成一次，并与后续消息重新连接；被压缩的物理祖先仍以 inactive 证据保留。
7. 遍历保留的物理 entry，产生消息、tool call、tool result 和 summary。
8. 根据 active path 设置 `visible` / `inactive` / `hidden`。
9. 最后产生 `session(countMode='total')`。

Trajex 不从 message 文本猜分支关系，也不把时间顺序当作当前上下文；`parentId` 和 `leaf` 才是 Pi 的结构事实。

进入上述计算前，Provider 会验证 entry ID 唯一、`parentId` 类型、父链无环、leaf target 存在，以及 `retainedTail` 容器和 active retained value 的对象结构。字符串父 ID 不存在时按 Pi 官方 orphan root 结束父链，不报错。JSON 语法损坏仍采用有效前缀；JSON 已能解析但树结构不可信时整份 unit 抛错，由索引事务保留上一次成功投影。

## 6. 与其他 JSONL provider 的关键区别

| | Pi | Codex | Claude |
|---|---|---|---|
| 文件结构 | 一文件一 session，entry 是树 | 一文件一 rollout，追加式事件流 | 一文件一 session，主要按行增量解析 |
| 当前上下文 | `leaf` + `parentId` + compaction | 文件事件顺序 | transcript 顺序 |
| 分支 | 同文件树内保存，inactive 投影 | 通常由独立 thread 表达 | 主要通过 transcript / workflow 关联 |
| compact | 明文 `summary`，可带 `retainedTail` | `compacted` 替换记录 + `context_compacted` 事件 | compact summary 消息 |
| 工具调用 | `message.role=assistant` 的 `toolCall` | `response_item.*_call` | assistant content block |
| 工具结果 | `message.role=toolResult` | `response_item.*_call_output` | user tool-result 消息 |

## 7. 相关实现位置

- Provider 解析：[packages/core/src/providers/pi.ts](/Users/a/Desktop/WorkSpace/ALL/我的Github项目/Trajex/packages/core/src/providers/pi.ts)
- Provider 测试：[tests/pi-parse.test.mjs](/Users/a/Desktop/WorkSpace/ALL/我的Github项目/Trajex/tests/pi-parse.test.mjs)
- Canonical session detail：[packages/core/src/session-detail.ts](/Users/a/Desktop/WorkSpace/ALL/我的Github项目/Trajex/packages/core/src/session-detail.ts)
- Pi v3 compaction ADR：[docs/adr/0006-pi-v3-context-projection-and-visibility.md](/Users/a/Desktop/WorkSpace/ALL/我的Github项目/Trajex/docs/adr/0006-pi-v3-context-projection-and-visibility.md)
