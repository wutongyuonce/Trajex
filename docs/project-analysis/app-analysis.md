> **chokidar** 是 Node.js 生态里最常用的**跨平台文件监听库** 。
>
> 原理：在系统原生事件之上做一层"归一化"
>
> 1、底层依赖 OS 的原生通知机制（事件驱动，非轮询）
>
> - Linux → inotify
> - macOS → FSEvents
> - Windows → ReadDirectoryChangesW
>
> 这些是内核级机制：文件一变化内核就回调，不需要程序定时去扫目录。
>
> 2、为什么不用 Node 自带的 fs.watch ？ fs.watch 虽然也接同一套底层机制，但 API 很"糙"。

### 12.2 app daemon 数据流

```text
Electron ready
  -> startBackgroundResources
  -> createWorkerBuildIndex
  -> startIndexerService
  -> chokidar watch providerRegistry.watchRoots(...)
  -> scheduleBuild debounce/stability
  -> worker buildIndex({ changedPaths })
  -> createProviderIndexPlan
  -> provider.parse + persist
  -> finalize markers
  -> notifyIndexUpdated / notifySessionUpdated
  -> renderer fetch patch
  -> apply patch
  -> timeline update
```





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





## 六、Electron App 架构

Electron app 可以理解成两部分：

```
Electron app = UI 浏览器 + 本地索引 daemon
```

UI 部分负责展示：

- Sessions
- Session Detail
- Memory
- Activity
- Settings

daemon 部分负责实时维护 SQLite：

```
写 heartbeat
用 chokidar 监听 provider roots
文件变化时 scheduleBuild
debounce + 等文件写稳定
调用 worker buildIndex
写 SQLite
通知 renderer 更新
定时继续写 heartbeat
```

### Worker 与 daemon

索引任务可能很重：扫描文件、解析 JSONL、写 SQLite、重建 FTS。为了不阻塞 Electron main process，app 把索引任务放到 worker thread。

`indexer-worker-client.ts` 是主进程和 worker 的通信桥：

```
main process -> postMessage({ id, args })
worker -> buildIndex(args)
worker -> postMessage({ id, result })
```

它用自增 id 和 pending map 把每次 build 请求包装成 Promise。

### Heartbeat 与 chokidar

heartbeat 是 app daemon 写进 `index_state` 的特殊 marker：

```
jsonl_path = __app_heartbeat__
mtime = Date.now()
```

作用是告诉 CLI：app 还活着，正在负责写索引。CLI 看到最近 60 秒内有 heartbeat，就不主动写 SQLite，避免和 app 抢写。

chokidar 用来监听 provider roots：

```
~/.codex/sessions
~/.codex/session_index.jsonl
~/.claude/projects
~/.claude/history.jsonl
```

文件新增、修改、删除会触发 `scheduleBuild`。Trajex 不会立刻 build，而是 debounce 并等待文件写稳定，避免读到半截 JSONL 或频繁写库。

## app：Electron 桌面端实现

app 的主线是：

```text
main process
  -> open/migrate SQLite
  -> start indexer service + worker
  -> expose IPC
preload
  -> window.trajex API
renderer
  -> Vue state/data/session timeline
```

### 11.1 main process

文件：`app/src/main/index.ts`

主进程负责：

- 创建窗口。
- 定位默认 provider roots。
- 管理 SQLite 连接。
- 启动/停止索引后台资源。
- 注册 IPC handlers。
- 处理 settings、memory archive/restore。

关键函数：

- `detectClaudeDir()`
  - macOS/Linux 直接 `~/.claude`。
  - Windows 尝试 WSL 路径。

- `getRuntimePaths(persisted)`
  - 基于 settings 解析 provider roots。
  - 创建 provider registry。
  - 返回 `dbPath`、`projectsDir`、`claudeDir`、`codexDir` 等。

- `migrateLegacyDbIfNeeded(...)`
  - 如果 `~/.trajex/trajex.sqlite` 不存在，但旧位置有 DB，则迁移。

- `openDb(...)`
  - 打开 better-sqlite3。
  - 设置 busy_timeout。
  - 在写锁保护下迁移 schema。

- `startBackgroundResources(...)`
  - 创建 indexer worker。
  - 打开 DB。
  - 启动 indexer service。
  - 启动 Trajex watcher。

- `notifyIndexUpdated(result)`
  - 给所有 renderer 窗口发送：
    - `trajex:index-updated`
    - 对每个 affected session 发送 `trajex:session-updated`

- `sourceWhereClause(opts)`
  - 给 source filter 生成 SQL 条件。
  - 默认是 Claude，`source: all` 时不过滤。

### 11.2 app indexer

文件：`app/src/main/indexer.ts`

app 里的 buildIndex 和 CLI 共享 provider/persist，但因为 Electron 使用 `better-sqlite3`，并且需要 daemon 语义，所以它有自己的外层。

主要能力：

- `openIndexDb(...)`
  - 创建 DB 目录。
  - 打开 better-sqlite3。
  - 配置连接。
  - 安装 schema。

- `writeHeartbeat(...)`
  - 写 `__app_heartbeat__` marker。
  - CLI passive pull 看到新鲜 heartbeat 会跳过写操作。

- `buildIndex(...)`
  - 获取 writer lease。
  - 打开 DB。
  - 创建 provider registry。
  - 调 `createProviderIndexPlan`。
  - force 时清空派生表。
  - 调 `indexProviderPlan`。
  - finalize：
    - refresh project paths。
    - 确保 FTS。
    - 写 `__last_build__`。
    - 写 `__app_last_successful_build__`。
    - 写 `__indexer_owner_app__`。
    - 写 provider markers。
    - 写 `__last_source_mtime__`。
  - 返回 affectedSessionIds，让 renderer 增量刷新。

app indexer 与 CLI indexer 的区别：

- app 是 daemon mode，会持续监听。
- app 使用 better-sqlite3。
- app 支持 changedPaths，只重索引变化文件。
- app build 失败遇到 writer busy 时返回 `deferred`，service 会稍后重试。

### 11.3 indexer service

文件：`app/src/main/indexer-service.ts`

这是文件监听和调度层，不懂 provider 解析。

关键参数：

- `debounceMs = 2000`
- `stabilityMs = 500`
- `heartbeatMs = 30000`
- `watchRetryMs = 5000`
- `deferredRetryMs = 250`

关键状态：

- `running`
  - 当前是否有 build 在跑。

- `pending`
  - build 期间又来了变化，结束后再跑一次。

- `changedPaths`
  - 去重后的变化文件集合。

- `idlePromise`
  - 测试和停止服务时等待当前 build 完成。

关键函数：

- `scheduleBuild(reason, changedPath)`
  - 收集变化路径。
  - debounce。
  - 等文件写稳定后调用 `runBuildNow`。

- `runBuildNow(reason, paths)`
  - 如果正在运行，标记 pending。
  - 调注入的 `buildIndex({ reason, changedPaths })`。
  - 如果结果 `deferred`，说明写锁或 DB busy，稍后重试。
  - 成功后写 heartbeat。

- `start()`
  - 立即写 heartbeat。
  - 可选 startup build。
  - 启动 chokidar watcher。
  - 定时 heartbeat。

- `stop()`
  - 清理 timers、watcher、heartbeat。

### 11.4 indexer worker

文件：

- `app/src/main/indexer-worker.ts`
- `app/src/main/indexer-worker-client.ts`

目的：把耗时索引构建放到 worker thread，避免阻塞 Electron 主进程。

`createWorkerBuildIndex()` 做：

- lazy 创建 worker。
- 用递增 id 匹配 request/response。
- pending map 保存 resolve/reject。
- worker error/exit 时 reject 所有 pending。
- `stop()` 终止 worker。

worker 文件很薄：

- 监听 message。
- 调 app indexer 的 `buildIndex(args)`。
- postMessage result 或 error。

### 11.5 preload IPC API

文件：`app/src/preload/index.ts`

preload 用 `contextBridge.exposeInMainWorld('trajex', ...)` 暴露 API。

renderer 不直接访问 Electron IPC，而是调用：

- `getSessions`
- `getSessionMessages`
- `getSessionToolCalls`
- `getSessionToolResults`
- `getSessionPatch`
- `getSubagentMessages`
- `getMessageFullText`
- `getMemories`
- `archiveMemory`
- `restoreMemory`
- `getProjects`
- `getStats`
- `getUsageStats`
- `onIndexUpdated`
- `onSessionUpdated`
- `getSettings`
- `setSetting`
- `rebuildIndex`

这层是安全边界：renderer 只能使用白名单 API。

### 11.6 main IPC 查询

文件：`app/src/main/index.ts`

session detail 相关查询：

- `querySessionMessages(sessionId)`
  - 只取 `agent_id IS NULL` 的主线消息。

- `querySessionToolCalls(sessionId)`
  - 取 session 的 tool calls。

- `querySessionToolResults(sessionId)`
  - 取 session 的 tool results。

- `querySessionSubagents(sessionId)`
  - 取 subagents。

- `querySessionWorkflows(sessionId)`
  - 取 workflows，并为每个 workflow 补 agents。

- `querySessionSummaries(sessionId)`
  - 取 summaries。

- `querySessionSnapshot(sessionId)`
  - 组装上述 rows。

- `querySessionDisplaySnapshot(sessionId)`
  - 调 `assembleSessionDetail(snapshot)`，得到 renderer 直接可用的 messages/workflows/summaries。

- `db:getSessionPatch`
  - 根据 renderer 传来的 cursor 计算 session patch。
  - 返回 changes/removed/hashes/positions 和 session metadata。

全文相关：

- `db:getMessageFullText`
  - 根据 message source 调 registry.raw。
  - Codex 会走 `rawCodex`。

### 11.7 renderer data layer

文件：`app/src/renderer/src/data.js`

定位：把 `window.trajex` IPC 调用转换成 Vue state 可用的数据。

关键函数：

- `fetchInitialData()`
  - 并行加载 memories、sessions、stats、projects。

- `commitInitialData(...)`
  - 写入全局 `state`。
  - 保留已加载 session messages。

- `loadSessionDetail(sessionId)`
  - 并行取 messages/toolCalls/toolResults/subagents/workflows/summaries。
  - 调 `assembleSessionDetail`。
  - 缓存 snapshot cursor。
  - 写入 session store。

- `fetchSessionDetailPatch(sessionId)`
  - 如果有缓存 cursor，调用 IPC `getSessionPatch`。

- `materializeSessionDetailPatch(...)`
  - 用 shared patch 算法把 patch 应用到本地 snapshot。
  - 生成 `messagePatch` metadata，告诉 UI 是否 tail-only。

- `loadSubagentDetail(agentId)`
  - 加载 subagent messages 和 tools。

- `loadFullText(uuid)`
  - 调 main 的 `getMessageFullText`，从原始日志取未截断正文。

### 11.8 session patch

文件：`app/src/shared/session-patch.mjs`

这套 patch 是 app 实时刷新体验的基础。

核心表：

```js
messages -> uuid
toolCalls -> id
toolResults -> tool_use_id
subagents -> agent_id
workflows -> run_id
summaries -> id
```

核心函数：

- `rowId(table, row)`
  - 获取表内主键。

- `rowHash(row)`
  - 对整行 JSON 序列化后做 hash。

- `rowFingerprint(row, position)`
  - 把 position 和 rowHash 组合。
  - 不仅检测内容变化，也检测位置变化。

- `createSessionPatchCursor(snapshot)`
  - 为当前 snapshot 生成 `{ table: { id: fingerprint } }`。

- `createSessionPatch(snapshot, cursor)`
  - 对比当前 snapshot 和旧 cursor。
  - 生成：
    - `changes`
    - `removed`
    - `hashes`
    - `positions`

- `applySessionPatch(snapshot, cursor, patch)`
  - 如果是 append-only，直接尾部追加。
  - 否则删除旧行、插入变更行并按 positions 放回。

这让长 session 的实时刷新不需要每次重载全部 timeline。

### 11.9 SessionDetail renderer

文件：`app/src/renderer/src/views/SessionDetail.vue`

这是 session 阅读体验的核心页面。

它负责：

- 加载 session snapshot。
- 监听 `onSessionUpdated` 做 live reload。
- 使用 patch 增量更新。
- 使用虚拟列表渲染长 timeline。
- 恢复阅读位置。
- 展开/收起 message、tool、thinking。
- 懒加载全文。
- 处理 focus query。
- 处理字体缩放。

重要模块：

- `session-live.mjs`
  - 全局 dirty 标记。

- `session-live-reload.mjs`
  - reload coordinator。
  - 用户滚动时延迟应用刷新，避免阅读位置跳动。

- `session-timeline-viewport.mjs`
  - 虚拟列表和滚动位置捕获/恢复。

- `session-reader-state.mjs`
  - 缓存阅读状态。

- `session-disclosures.mjs`
  - 管理展开状态。

- `session-timeline-items.mjs`
  - 把 messages 转成 timeline item。

这个页面体现了 app 的核心工程取舍：数据库和 provider 层提供证据，assembly 层提供可读结构，renderer 层负责长文阅读和实时更新的人机体验。

## 13. 如何二开

### 13.1 新增一个 provider

目标：比如适配 Pi、OpenCode 或另一个 Agent。

推荐步骤：

1. 新建 `packages/core/src/providers/<name>.ts`。
2. 实现 adapter：
   - `name`
   - `descriptor`
   - `indexVersionMarker`
   - `watchRoots(configuredRoot)`
   - `discover(ctx)`
   - `parse(unit, cursor)`
   - `raw(input)`
3. 把 provider 原始事件翻译成现有 `TranscriptRecord`。
4. 在 `packages/core/src/providers/builtins.ts` 注册。
5. 加 provider parse golden tests。
6. 加 app provider settings/source catalog 测试。

注意：

- 不要在 adapter 中写 DB。
- 不要在 persist 中写 provider-specific 分支，除非真的扩展 canonical record。
- provider 自己决定 cursor 语义。
- provider 自己处理去重、撤回、隐藏上下文、child thread 归属。

### 13.2 修改 Codex 适配

常见需求：

- Codex 新增事件类型。
- Codex token usage 字段变化。
- Codex child thread metadata 变化。
- Codex 工具调用 payload 变化。
- 需要展示新的 content type。

改动位置：

- 新事件转 message/tool/subagent：
  - `packages/core/src/providers/codex.ts` 的第二遍 parse loop。

- 新文本提取规则：
  - `codexEventText`
  - `codexMessagePayloadText`

- 新 tool input/output 格式：
  - `codexToolInput`
  - `codexToolOutput`

- parent thread 识别：
  - `codexParentThreadId`

- guardian/auto-review 识别：
  - `codexIsGuardianThread`
  - `readCodexGuardianThreadInfo`

- 原始行回查：
  - `rawCodex`

测试建议：

- 用最小 JSONL fixture 覆盖新增事件。
- 断言 parse 输出的 `TranscriptRecord`。
- 如果影响 DB 写入，补 persist/indexer 测试。
- 如果影响 app 展示，补 session detail assembly 测试。

### 13.3 扩展 schema

只有当现有 `TranscriptRecord` 无法表达新事实时才扩 schema。

步骤：

1. 改 `schema.sql`。
2. 改 `schema-migrations.ts`。
3. 改 `providers/types.ts` 的 record 类型。
4. 改 `persist.ts` 的 SQL 和 switch。
5. 改 `session-detail.ts` / app shared assembly。
6. 改 query helper 或 app IPC。
7. 加迁移测试、persist 测试、query/app 测试。

### 13.4 扩展 query API

如果只是给 Agent 新增查询便利函数：

1. 在 `packages/core/src/query.ts` 的 `createQueryApi` 里加 helper。
2. 确保只读。
3. 使用 `buildWhere`/`normalizeOpts` 这类现有模式。
4. 给 helper 加测试。
5. 更新 skill 文档或 API reference。

不要把 helper 设计成外部工具集合。Trajex 的交互方式是 Agent 写 JS，一次性调用本地 sandbox。

### 13.5 改 app session 展示

改动位置：

- 数据结构：
  - `app/src/shared/session-detail-assembly.mjs`
  - `packages/core/src/session-detail.ts`

- IPC 查询：
  - `app/src/main/index.ts`

- renderer 数据：
  - `app/src/renderer/src/data.js`

- timeline 展示：
  - `app/src/renderer/src/views/SessionDetail.vue`
  - `app/src/renderer/src/components/SessionTimelineRow.vue`
  - `app/src/renderer/src/tool-renderer.js`

- 实时刷新：
  - `app/src/shared/session-patch.mjs`
  - `app/src/renderer/src/session-live-reload.mjs`

如果新增字段只是展示层需要，优先在 assembly 里挂到 assembled message/tool call 上，而不是让 renderer 自己 join 多张表。
