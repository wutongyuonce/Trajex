`session-detail.ts` 不是直接组装 Vue 的“卡片”；它先把 record 流投影为一套稳定的详情数据模型。`session-timeline-items.mjs` 再基于这套模型，把一条已组装消息拆成最终要渲染的时间线块。

```
原始 records / SQLite 各表行
        ↓
session-detail.ts：事实关联 + 消息序列归并
        ↓
{ messages: AssembledMessage[], workflows, summaries }
        ↓
session-timeline-items.mjs：一条消息 → 1 或 2 个 timeline item
        ↓
SessionTimelineRow.vue：按 item.kind 选用具体 UI
```

## `session-detail.ts` 组装出的块

它的主输出不是泛型 `Record[]`，而是：

- `messages`：按时间排序的 `AssembledMessage[]`，是详情主时间线的内容来源
- `workflows`：完整 workflow 列表，供页面或关联工具调用使用
- `summaries`：summary 列表，目前不直接变成主时间线行

核心在 [session-detail.ts (line 180)](/Users/a/Desktop/WorkSpace/ALL/我的Github项目/Trajex/packages/core/src/session-detail.ts:180) 的 `assembleMessages()`。它把下列记录组装为一个“消息块”：

| 输入 record             | 进入输出的位置                         | 关键规则                                                     |
| ----------------------- | -------------------------------------- | ------------------------------------------------------------ |
| `message`               | 一个基础 `AssembledMessage`            | 保留 `uuid`、角色、文本、时间、`content_type` 等             |
| `tool_call`             | 附到对应消息的 `message.tool_calls[]`  | 用 `message_uuid` 关联                                       |
| `tool_result`           | 附到对应工具的 `tool_calls[i].result`  | 用 `tool_use_id` 关联；不作为单独消息显示                    |
| `workflow`              | 附到 `Workflow` 工具调用的 `.workflow` | 用 workflow 的 `parent_tool_use_id` 关联                     |
| `workflow_agent`        | 收进对应 `workflow.agents[]`           | 按 `run_id` 归属，并合并同 agent 的补充状态                  |
| `summary`               | `snapshot.summaries[]`                 | 与主消息流分离                                               |
| `message-turn-duration` | 补到对应 message                       | 用消息 `uuid` 关联                                           |
| `subagent`              | 当前只收集，不直接生成主时间线卡片     | workflow agent 的点击目标来自 workflow 数据；子会话由详情页单独打开 |

这里有一个重要边界：`session-detail.ts` 只认识 canonical record 字段和关联 ID，不判断 Claude / Codex / Pi / Kimi。因此它是 Provider 无关的“语义归并层”。

## 消息归并的设计细节

### 1. 结果不会单独占一行

`tool_result` 在读取时会被跳过为独立消息，再挂回对应工具调用：

```
assistant message
  └─ tool_calls
      └─ { id, name, input_json, result }
```

这避免详情页出现“调用工具一行、输出又一行”的断裂感；折叠工具时，输入和输出始终在同一块内。

### 2. 连续 thinking 会被合并

连续的 assistant `content_type === 'thinking'` 会以双换行拼成一段：

```
thinking A + thinking B + thinking C
              ↓
一个 thinking 文本块
```

如果其后紧跟普通 assistant 消息或工具调用，这段 thinking 不会另占时间线位置，而是写到后一个消息的 `_thinking` 字段。于是 UI 可在回复/工具上方显示可折叠的 Thinking 区域。

如果 thinking 后面没有可附着的 assistant 消息，才会保留为独立的 `content_type: 'thinking'` 消息。

### 3. 连续工具调用被并到一条 assistant 消息

当 assistant 消息的 `content_type === 'tool_use'` 时，后续连续的 tool-use 会合并进同一条 `tool_calls[]`；中间的 tool result 不会打断合并。

普通 assistant 文本后面若接连续 tool-use，也会把这些工具调用附到这条文本消息上。

```
assistant 文本 → tool_use A → tool_result A → tool_use B → tool_result B
        ↓
一个 AssembledMessage：
{ text, tool_calls: [A(result), B(result)] }
```

这正是“一个 assistant 回合 + 它执行的工具”的展示单元。

### 4. workflow 进一步成为工具调用的附属语义

当一个工具调用名为 `Workflow`，且有匹配的 workflow record：

```
tool_call(id)
  ← workflow.parent_tool_use_id
      ← workflow_agent.run_id
```

组装结果会是：

```
{
  name: 'Workflow',
  workflow: {
    workflow_name,
    status,
    agents: [{ agent_id, phase, label, state, ... }]
  }
}
```

所以 renderer 不必再查询或猜测多 agent 数据关系。

### 5. 可见性与主线先于 UI 被决定

在 record → detail 的阶段：

- `visibility === 'hidden'` 的 message 不会进入详情；
- 主 session 的详情只取主线 message；
- Pi 的 sidechain 是已进入详情的标记，默认是否显示由 renderer 决定，而不是重新解析原始日志。

## 它和 `session-timeline-items.mjs` 的关系

两者是相邻但职责不同的两层：

| 文件                         | 问题                                                 | 输出                 |
| ---------------------------- | ---------------------------------------------------- | -------------------- |
| `session-detail.ts`          | “哪些记录属于同一条通用消息？”                       | `AssembledMessage[]` |
| `session-timeline-items.mjs` | “这条通用消息在时间线上应占几个、什么类型的 UI 行？” | `TimelineItem[]`     |

例如，`session-detail.ts` 已产出一条：

```
{
  uuid: 'm1',
  type: 'assistant',
  text: '处理完成',
  _thinking: '先分析需求…',
  tool_calls: [
    { name: 'Read', result: {...} },
    { name: 'Edit', result: {...} }
  ]
}
```

`session-timeline-items.mjs` 看到它不是 meta / workflow / 纯 thinking，就生成一个：

```
{ kind: 'message', message: m1 }
```

随后 [SessionTimelineRow.vue (line 186)](/Users/a/Desktop/WorkSpace/ALL/我的Github项目/Trajex/app/src/renderer/src/components/SessionTimelineRow.vue:186) 在这个 `message` 行内依次渲染：

1. assistant 标头和正文；
2. `_thinking` 的折叠块；
3. 两个工具的折叠块。

也就是说，这类常规消息不会因 thinking 或工具被拆成多条虚拟列表行。

但 timeline-items 有两个刻意拆行的例外：

### workflow：拆成 workflow 卡片和其余工具行

如果一条 assistant 消息含带 `workflow` 数据的 `Workflow` 工具调用：

```
[
  { kind: 'workflow', message, workflowCall },
  { kind: 'workflow-tools', message, toolCalls: 其余工具 }
]
```

这样 workflow 能拥有独立的 agent 卡片、phase 分组、跳转交互；同一消息内的普通工具仍以另一行保留，避免被 workflow 卡片吞掉。

### 独立 thinking：成为专门的 thinking 行

只有无法附着到后续 assistant 消息的纯 thinking，才变为：

```
{ kind: 'thinking', message }
```

之后由 `SessionTimelineRow.vue` 渲染为独立可折叠 Thinking 行。

### meta：成为专门的 system 行

当 `message.is_meta === 1`：

```
{ kind: 'meta', message }
```

它用紧凑的 System 折叠 UI，而不是 user/assistant 气泡。

所以，`session-detail.ts` 的“块”是稳定的**数据级会话块**；`session-timeline-items.mjs` 的 `meta / workflow / workflow-tools / thinking / message` 才是稳定的**UI 级时间线块**。后者刻意很薄，只依据前者已经完成的关联结果做展示切分，不重复工具、thinking、workflow 的组装逻辑。