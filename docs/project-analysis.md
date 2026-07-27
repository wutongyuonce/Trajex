# Obelisk Core：本地会话索引运行时解析

## 1. 目的、范围与公共表面

本文分析 `packages/cli` 与 `packages/core`，不展开 Electron `app/`。范围内的系统将 Claude Code、Codex、Kimi Code 的原始会话文件转换为统一的可查询索引；它拥有索引协议、SQLite 持久状态、被动刷新、查询和 memory 登记，但把原始格式解释委托给 Provider，把 UI 与 daemon 调度委托给相邻层。

```text
输入：本地 JSONL / state / wire 文件 + 用户查询或 memory 脚本
  → Core：发现、投影、事务提交、FTS、查询/记忆 API
  → 输出：SQLite 事实库、JSON 查询结果、SessionDetailSnapshot、memory 登记结果
```

`@obelisk/core` 的包描述是“供 Obelisk transports 共享的索引与查询核心”；除主入口外，它还发布 db、indexer、providers、query、persist、transaction 和 session-detail 等子入口。`@obelisk-apps/cli` 是 Node 22.13+ 的命令行 transport，`bin` 指向 `dist/cli/src/obelisk.js`。

## 2. 架构地图：系统里有什么

### 分层：按职责与依赖边界

公共门面位于最上方；下方分为写入主线、读取/记忆主线和展示投影。数据库契约与工具层是所有路径的共同基础，Provider 只负责把来源格式投影为统一记录。

```text
公共门面
  packages/cli/src/obelisk.ts             ← CLI 参数、脚本读取、JSON 输出
  packages/core/src/core.ts                ← 4 个高层函数：
                                                buildIndex / searchText
                                                executeQuery / executeAttune
       │
       ├────────────────────────── 写入主线 ──────────────────────────┐
       │                                                               │
       │  四、索引编排与并发层                                         │
       │    indexer.ts                 ← 所有权、计划、提交、finalize  │
       │    provider-indexing.ts       ← Provider 计划与每 unit 执行   │
       │    tx.ts / write-coordinator.ts ← 原子写与有界重试            │
       │    writer-lease.ts            ← 跨进程单 writer 锁            │
       │               │                                               │
       │  三、持久化层                                                 │
       │    persist.ts                 ← TranscriptRecord → SQLite 行  │
       │               │                                               │
       │  二、Provider 适配层                                          │
       │    providers/types.ts         ← TranscriptRecord / Provider 契约
       │    providers/{claude,codex,kimi}.ts ← 原始文件 → 统一记录      │
       │    providers/{registry,builtins}.ts ← 注册、根目录、raw 回源  │
       │               │                                               │
       │  一、数据库契约与工具层                                       │
       │    db.ts / schema.sql / schema-migrations.ts / sqlite-types.ts
       │                              ← DB 生命周期、DDL、迁移、类型面 │
       │    parsing.ts                 ← 文件发现、JSONL、文本、Codex ID
       │                                                               │
       └────────────────────────── 读取与投影 ────────────────────────┘
           五、检索与记忆层
             query.ts               ← Query API、Attune API、只读 SQL、FTS、memory soft delete

           六、展示投影层
             session-detail.ts      ← canonical transcript / SQLite rows → SessionDetailSnapshot
```

对应的调用链是：

```text
obelisk --build
  → core.buildIndex({ force: true })
    → indexer.buildIndex()
      → acquireWriterLease()
      → openDb()
      → createBuiltinProviderRegistry()
      → createProviderIndexPlan()
        → provider.discover()
      → indexProviderPlan()
        → for each unit:
            runRetryableWriteTransaction()
              → persist(db, unit, provider.parse(unit, cursor))
      → refreshSessionProjectPaths()
      → rebuild messages_fts / memories_fts
      → writeProviderIndexMarkers()
      → db.close() + lease.release()
```

Provider 不依赖数据库，`persist.ts` 和 `session-detail.ts` 不应识别特定 Provider 的原始 JSON 字段。

### 文件地图

| 模块 | 角色与关键符号 | 主要调用方 | 关键依赖 |
| --- | --- | --- | --- |
| `core.ts` | `buildIndex`、`searchText`、`executeQuery`、`executeAttune` 的共享门面 | CLI、未来其他 transport | indexer、db、query、writer lease、`node:vm` |
| `indexer.ts` | `buildIndex`、`shouldSkipBuild`、项目路径最终化 | core、app indexer | provider plan、事务、lease |
| `provider-indexing.ts` | 工作计划、按 unit 执行、版本 marker | indexer | registry、persist |
| `providers/types.ts` | `TranscriptRecord`、`IndexUnit`、`ProviderAdapter` | 全部 Provider、persist、detail | 无运行时依赖 |
| `providers/registry.ts` / `builtins.ts` | registry 路由、三种内置 Provider 组装 | indexer、query | Provider factory |
| `providers/claude.ts` | Claude 增量发现/解析/raw | builtins | parsing、fs |
| `providers/codex.ts` | Codex 全量重放、去重、guardian/raw | builtins | parsing、fs |
| `providers/kimi.ts` | Kimi 目录投影、undo/clear/raw | builtins | parsing、fs/path |
| `parsing.ts` | 文件发现、JSONL、文本、项目路径、Codex ID 工具 | db、所有 Provider | fs/path/os |
| `persist.ts` | `TranscriptRecord → SQLite` 唯一共享写入层 | provider plan | `SqliteDb` |
| `db.ts` / `schema.sql` / `schema-migrations.ts` | Node SQLite 生命周期、新库 DDL、旧库补列 | core、indexer | node:sqlite、tx |
| `tx.ts` / `write-coordinator.ts` / `writer-lease.ts` | 原子事务、重试策略、跨进程硬锁 | indexer、attune | SQLite 文件锁 |
| `query.ts` | 只读 Query API 与 Attune memory API | core | SQLite、registry |
| `session-detail.ts` | canonical records 或表行 → 详情快照 | app/调用者 | Provider 协议 |
| `sqlite-types.ts` | `SqliteDb` 最小结构类型 | db、persist、query、migration | 无运行时依赖 |

## 3. 核心契约与状态所有权

### 3.1 `TranscriptRecord`：Provider、持久化与展示之间的接缝

Provider 的 `parse(unit, cursor)` 返回 generator：每 yield 一个 `TranscriptRecord`，共享 persist 可以写库；generator return 的 `Cursor` 则成为下一次发现的进度。Session detail 也能直接消费同一批 records，因此“刚 parse 的详情”和“写库后再读的详情”应保持一致。

```text
Provider.parse()
  → Session / Message / ToolCall / ToolResult / Summary
  → Subagent / Workflow / WorkflowAgent
  → MessageTurnDuration / DeleteSession
  → return Cursor
```

| 状态/字段 | 写入者与时机 | 读取者 | 不变量与后果 |
| --- | --- | --- | --- |
| `IndexUnit.key` | Provider `discover()` | `persist`、下一次 `lastCursor` | 是 `index_state` 的稳定键；不要求是文件路径。 |
| `IndexUnit.meta` | Provider discover | 同 Provider parse | Core 编排层不解释它；Kimi 可放多个 wire，Claude 可放 workflow 主路径。 |
| `SessionRecord.countMode` | Provider parse 完成时 | `persist` | `total` 替换 message count，`delta` 累加；错误选择会让统计漂移。 |
| `MessageRecord.visibility` | Provider parse | `session-detail` | hidden 永不进入详情；展示层不能重新按文本判断。 |
| `MessageRecord.is_meta` | Provider parse | `search/thread` | 默认检索隐藏 meta，但可由 `includeMeta` 显式请求。 |
| `MessageRecord.agent_id` | Provider parse | persist/detail/query | 把 child thread 消息与主 session 关联；详情只显示主线。 |
| `ToolCallRecord.id` / `ToolResultRecord.tool_use_id` | Provider parse | persist/detail/failures | 同一工具调用的关联键；结果不能依赖时间相邻来猜。 |
| `DeleteSessionRecord` | Codex guardian 等 Provider 语义 | persist | 是撤回操作，不是普通表行；必须删除关联工具、消息和编排数据。 |

`ProviderAdapter` 在基础 discover/parse 协议上增加 `descriptor`、`watchRoots()`、`raw()` 与 `indexVersionMarker?`。marker 缺失且该 source 已有数据时，`provider-indexing.ts` 会触发一次全量重放；新 marker 只在该 Provider 没有失败时写入。

### 3.2 SQLite 状态：谁拥有、何时变化

| 状态 | 写入者与时机 | 消费者 | 不变量 |
| --- | --- | --- | --- |
| `sessions/messages/tools/...` | `persist()` 在每个 IndexUnit 的写事务内 | Query API、detail、app | 源会话的派生事实；force build 可删除。 |
| `messages_fts` / `memories_fts` | SQL trigger；indexer finalize 显式 rebuild | `search()` / `memories({query})` | 不是权威数据；必须和主表一致。 |
| `index_state.<unit key>` | `persist()` 在 generator 正常结束后 | Provider 下次 `discover()` | cursor 只由产生它的 Provider 解释。 |
| `__last_build__` | indexer finalize | `shouldSkipBuild()` | 30 秒内普通被动刷新可跳过。 |
| `__app_heartbeat__` | app daemon | CLI/indexer/attune | 60 秒内表示 daemon 拥有写策略；CLI 不得初始化或写库。 |
| Provider version marker | indexer finalize | `createProviderIndexPlan()` | 只代表该 Provider 已成功按当前投影规则完成。 |
| `memories.deleted_at/deleted_reason` | `forget()` | memories/overview | memory 软删除；force build 不得清除。 |

Schema 中的大表结构可按职责理解：`sessions/messages/summaries` 是会话事实，`tool_calls/tool_results` 是执行证据，`subagents/workflows/workflow_agents` 是编排关系，`index_state` 是索引运行时状态，`memories` 是人工沉淀。完整字段以 `packages/core/src/schema.sql` 为单一来源；新增 record 字段通常同时影响 types、schema、persist、detail、query 和 migration。

### 3.3 DB binding 与 migration 边界

`sqlite-types.ts` 只定义 `SqliteStatement(all/get/run)`、`SqliteDb(exec/prepare/close)` 和带 `isTransaction` 的 `NodeSqliteDb`。这让 Core 的共享层可同时兼容 node:sqlite 与 better-sqlite3。

`db.ts` 中：

- `openDb()` 是唯一会创建目录、迁移 legacy DB、设置 WAL/NORMAL、执行 schema/migration 的入口；
- `openReadDb()` 以只读方式打开，只有 250ms busy timeout，绝不迁移或初始化；
- `openWriterLeaseDb()` 只服务独立 lock DB；
- `rebuildMemoryFts()` 封装 memory FTS rebuild。

`migrateCoreSchemaColumns()` 先检查表存在、缓存 `PRAGMA table_info`，仅对缺失列做 `ALTER TABLE ADD COLUMN`。它只处理加列；删列、改类型、数据重写不属于这个模块。`openDb()` 在 schema 前后各调用一次 migration，以兼容已有旧表和新创建表。

## 4. 执行模型：索引、事务与并发

### 4.1 `buildIndex()`：被动索引的编排器

**触发与输入。** `core.ts` 的 search/query 以 `force:false` 调用；CLI `--build` 以 `force:true` 调用。

**关键决策。** 它先问“现在应不应该写”，再问“现在能不能保证只有我在写”。

```text
inspectBuildOwnership()
  ├─ 新鲜 __app_heartbeat__ → daemon_active，直接跳过
  ├─ 非 force 且 __last_build__ 新鲜 → recent_build，直接跳过
  └─ 允许 → acquireWriterLease()
       ├─ 未获得 → writer_busy
       └─ 获得 → 再次 ownership 检查（关闭 TOCTOU）
```

**提交与最终化。** 获得 lease 后：

1. `openDb()`、`nodeSqliteTransactionAdapter()`；
2. force 时在一个可重试事务删除 source-derived 表和多数 index state，保留 memories；
3. `createBuiltinProviderRegistry()`；
4. `createProviderIndexPlan()` 产生 `(provider, unit, cursor)`；
5. `indexProviderPlan()` 对每个 unit 在事务中执行 `persist(db, unit, provider.parse(unit,cursor))`；
6. 一个独立 finalize 事务执行项目路径修复、两张 FTS rebuild、写 `__last_build__` 与成功 marker；
7. finally 关闭 DB 与 release lease。

**失败语义。** 普通 unit parse/persist 失败被收集到 `SkippedFile` 并继续；`BEGIN` busy 返回 `database_busy`；事务仍活动/未知、force cleanup 或 finalize 失败都不能吞掉。

### 4.2 计划、提交与 cursor：`provider-indexing.ts` + `persist.ts`

| 函数 | 角色 | 交接给谁 |
| --- | --- | --- |
| `storedProviderCursor()` | 从 `index_state(mtime,lines_processed)` 重建 opaque cursor | Provider discover/parse |
| `createProviderIndexPlan()` | 对每个 registry Provider 判断 force/marker 重放，再调用 discover | `ProviderIndexPlan.items` |
| `indexProviderPlan()` | 逐 item 调 injected transaction，work 为 parse → persist | `ProviderIndexResult` |
| `writeProviderIndexMarkers()` | 仅为没有 failed/stopped 的 Provider 写 marker | finalize state |
| `persist()` | 消费 generator，按 record kind 写库，最后写 cursor | SQLite + 下一轮 discover |

`persist()` 是 schema 语义集中处：message 用 UUID upsert；session 取最早开始/最晚结束、按 countMode 处理数量；subagent/workflow agent 用 COALESCE 合并不同 unit 的非空字段；tool、summary、workflow 用 replace/upsert；`deleteSession` 执行关联删除。

### 4.3 写事务与 retry：策略和原语分离

`runWriteTransaction()` 只负责：`BEGIN IMMEDIATE → work 一次 → COMMIT`。异常时它仅在事务不是明确 inactive 时尝试 rollback，并把 `phase/code/label/rollback 状态/transaction 状态` 附加到**原始异常**。rollback 失败不能遮蔽原错误。

`write-coordinator.ts` 才决定是否重试：

| 结果 | 处理 |
| --- | --- |
| begin 阶段的 `SQLITE_BUSY*` 且事务 inactive | `isBeginBusyFailure`；交还 indexer，返回 `database_busy`。 |
| work/commit 阶段的 busy 且事务 inactive | `isRetryableWriteFailure`；可重试整个事务。 |
| 事务仍 active 或状态未知 | `hasUnusableTransaction`；停止，不能继续使用连接。 |

`runWithWriteRetry()` 默认最多三次、一秒预算、递增短等待。这里刻意不重试“最后一条 SQL”，只重放整个被证明可重放的事务。

### 4.4 Writer lease：硬互斥的实现

`writerLockPathFor(dbPath)` 生成同目录 `writer.lock.sqlite`。`acquireWriterLease()` 每轮打开该独立 DB，设置 `busy_timeout=0`，尝试 `BEGIN IMMEDIATE`：未结束的事务本身就是跨进程锁。成功返回幂等 `release()`（rollback 后 close）；busy 才在 `waitMs` 内重试，非 busy 直接抛出。

Heartbeat 是“谁应该写”的策略信号；lease 是“任何竞态下都不能并发写”的机制。`buildIndex()` 不等待 lease，`executeAttune()` 最多等一秒。

## 5. Provider 扩展模型：共性一次定义，差异集中比较

### 共性：发现、投影、回源

Provider 的外部数据在 `discover()` 时变成 `IndexUnit[]`，在 `parse()` 时变成 canonical records，在 `raw()` 时按已知 UUID 回到原始文件。`parsing.ts` 统一承载三类共享工作：

- 文件与文本：`readLines`（64KiB 流式、可提前停止）、`trunc/truncJson`、内容类型和 meta 识别；
- 项目路径：绝对 cwd 归一、slug 生成、按观测频率推导 project path；
- Codex 兼容：ID 命名空间、父线程/guardian 识别、event/response 文本、工具输入输出和 token 抽取。

### 三种 Provider 的有意义差异

| 维度 | Claude | Codex | Kimi |
| --- | --- | --- | --- |
| 默认根 | `~/.claude` | `~/.codex` | `$KIMI_CODE_HOME` 或 `~/.kimi-code` |
| 索引单位 | 主/子代理 JSONL 与 workflow JSON | 一个 rollout JSONL | 一个 session 目录（state + 多 wire） |
| cursor/策略 | mtime + 已处理行；可增量 | 全文件重放 | 全 session 重放 |
| 必须全量的原因 | 不需要；仅续读新增行 | event_msg 与 response_item 双向去重 | undo/clear/compaction 会撤回旧事件 |
| 特殊关系 | history 标题、Workflow、subagent meta | guardian 删除、父/子 thread、collab spawn | main/child agent、用户 slash 命令、context 操作 |
| raw 定位 | session/subagent JSONL 内 UUID | `codex:<thread>:<line>` | namespaced event ID 对应 wire 行 |

### Claude：`discoverAt` 与 `parse`

`discoverAt(rootDir,ctx)` 先读 `history.jsonl` 建标题 map，再解释 changed paths：`.meta.json` 会强制关联 transcript，workflow JSON 或主 transcript 变化会重投影 workflow。随后调用 `discoverJsonlFiles()`，用 cursor mtime、强制路径和标题变化判断需要的 unit。

`parse(unit,cursor)` 对普通 transcript 的顺序是：

```text
cursorToSkip → readLines
  → ai-title / away-summary / turn-duration 特殊记录
  → user/assistant：更新 session aggregate、生成 message
  → assistant tool_use：tool_call
  → user tool_result：tool_result
  → 可选 subagent .meta.json：subagent 或 workflow_agent
  → 主 transcript：session(countMode total/delta)
  → return mtime:lineCount
```

workflow unit 委托 `parseWorkflow()`：读取 workflow JSON，调用 `workflowParentToolUseId()` 回主 transcript 查父 `Workflow` tool result，再发 workflow 与 workflow agent records。`rawClaude()` 按 session/agent/workflow 关系定位文件并精确匹配 UUID。

### Codex：`discoverAt` 与全量 `parse`

`discoverAt()` 读取 `session_index.jsonl` 补标题和更新时间；再用 `discoverCodexJsonlFiles()` 遍历 rollouts。即使 mtime 没变，guardian 文件也要再次判断，因为它会要求删除已索引 session。

`parse(unit,_cursor)` 不使用传入 cursor：

1. 全量读取 `{lineNum,obj}`，得到 `mtime:lineCount`；无 `session_meta` 直接结束；
2. guardian/auto-review 则只发 `delete-session`；
3. 从 meta 推 root session、可选 parent、agent ID、project、cwd/model；
4. 第一遍收集 event user/agent 的 `(role,text)` key；
5. 第二遍处理 session/turn context、event messages/reasoning、collab spawn、duration、token、标题；
6. response message 仅在未与 event 重复时写入；tool call/output 用 call map 连接；
7. 子 thread 发 subagent，根 thread 发 `SessionRecord(countMode:'total')`。

内部 `insertMessage()` 是唯一创建 Codex message 的地方，负责 parent、visibility、meta、model、cwd、sidechain、agent ID，以及最近 assistant message 的 token/duration 回填目标。`rawCodex()` 解析 UUID 的 thread/line，再回读相应 rollout。

### Kimi：`projectSession` 是目录投影器

Kimi factory 的 discover 先列 session 目录、state 与 agents wire，使用最大 mtime + 总行数生成 cursor；changed paths 会缩小到对应 session。其私有 `KimiSessionUnitMeta` 带 `sessionDir/statePath/wireFiles/currentCursor`，正是“unit 不是一个文件”的证据。

`projectSession(meta,sessionId,state)`：

1. 初始化 messages、工具、结果、summary、duration、子代理关系；按 main-first 处理 wire；
2. 每条 wire 建 previous UUID、model、step/call map、真实 user 集合与 undo floor；
3. `context.undo` 经 `applyUndo()` 回退消息及关联工具/结果/duration；`context.clear` 推进 undo floor，compaction 重置开放状态；
4. message event 经过文本、meta、slash command、namespaced ID helper 投影；step 事件计算 duration；
5. 工具、child agent、summary 事件分别投影为 canonical record；
6. 返回 `ProjectedSession`，factory 再依次 yield records 与主 session（total）。

`rawFromWire()` 依据 namespaced event ID 回读原行。这里全量重放是正确性需求，不是优化缺失。

## 6. 查询、memory 与详情投影

### 6.1 Query API：只读证据检索

`createQueryApi(db)` 闭包持有只读 DB 和 Provider registry。通用 `normalizeOpts/buildWhere` 将 string/number/object 输入归一为范围过滤；`assertReadOnlySql` 拒绝 DML/DDL；`buildSafeFtsQuery` 在 FTS 特殊字符导致原 query 失败时安全回退。

| 用途 | API | 关键行为 |
| --- | --- | --- |
| 证据定位 | `search`, `context`, `trace`, `thread`, `raw` | FTS 命中补时间邻居；父链与时间邻居明确区分；raw 经 registry 回源。 |
| 范围选择 | `overview`, `sessions`, `recent`, `summaries` | overview 依 opts → project_path 前缀 → 精确 cwd 推当前项目；它不是证据。 |
| 关系/失败 | `subagents`, `workflows`, `workflowTree`, `fileHistory`, `failures` | 通过 schema 关系补 message count、结果、session 和后继消息。 |
| 人工记忆 | `memories` | 永远排除 soft deleted；有 query 时走 memory FTS，且要求英文 token。 |
| SQL 逃生口 | `sql` | 只允许 SELECT/WITH 与参数绑定。 |

`search()` 默认排除 meta；命中后给出同 session、按时间距离选择的 context。`thread()` 同样默认排 meta；`includeMeta:true` 才能显式查看。

### 6.2 Attune API：memory 不是通用写库接口

`createAttuneApi(db)` 只返回 `remember` 和 `forget`：

- `remember()` 要求 path/summary；`resolveMemoryPath()` 以 session project path 或 cwd 解析相对路径，并验证文件存在；`normalizeAnchors()` 只允许对象数组；summary 必须英文；最后插入 memory。
- `forget()` 必须给 reason；仅写 `deleted_at/deleted_reason`，重复调用返回已删除状态。

Query API 不暴露 remember/forget；Attune API 不暴露 search/sql。这个 API 形状本身是权限边界。

### 6.3 `session-detail.ts`：两条输入，唯一展示语义

`assembleSessionDetail(input)` 接受完整 `TranscriptRecord` iterable，或 SQLite `SessionDetailRows`。后者先被 `sessionDetailRecordsFromRows()` 适配回 canonical records；最终都进入 `assembleTranscriptRecords()`。

该组装器：拒绝直接输入 delta session；跳过 hidden message；只显示主线程消息；把 tool result、subagent、workflow 按 ID 挂到 tool call；合并连续 thinking 和可合并的 tool-use；将 skill instructions 附到对应调用。它不检查 `source`，也不再解析文本来恢复 Provider 语义。

## 7. 关键端到端链路：系统里发生什么

### 链路 A：`obelisk --build` 如何成为可查询索引

```text
CLI --build
  → core.buildIndex({force:true})
  → ownership + writer lease
  → force-cleanup transaction：清会话派生行，保留 memories
  → Provider discover()：IndexUnit[]
  → 每 unit：parse(unit,cursor) → TranscriptRecord stream → persist()
  → index_state 写新 cursor
  → finalize：project_path / 两张 FTS / build time / markers
  → 输出 {ok:true, db:DB_PATH}
```

中止点：daemon heartbeat、lease 未获得、BEGIN busy、不可用事务、finalize 失败。普通坏 transcript 不是全局失败，而是进入 `skippedFiles`。

### 链路 B：`obelisk --search` 在 daemon 存在时仍可工作

```text
CLI --search
  → core.searchText
  → buildIndex()
      fresh heartbeat? 是 → 返回 daemon_active，不打开写 DB
  → openReadDb()
  → QueryApi.search(text)
      raw FTS 合法? 是 → MATCH
                    否 → safe token MATCH
      includeMeta? 否 → 过滤 meta
  → 返回 message + session + temporal context
  → close read DB
```

这里的“刷新被跳过”不是失败：daemon 已被视为索引所有者，CLI 仍可在现有 DB 上只读查询。

### 链路 C：`obelisk --attune` 的双重写保护

```text
CLI --attune script
  → buildIndex()：先发现 daemon/busy
  → acquireWriterLease(wait 1s)
  → shouldSkipBuild(ignoreRecentBuild:true)：再次确认 heartbeat
  → openDb()
  → VM 中只提供 remember/forget
  → memories INSERT 或 soft DELETE
  → close + release
```

第一次检查与拿锁后的二次检查共同避免“app 在中间刚启动，但 CLI 已准备写 memory”的竞态。

### 链路 D：同一会话为何能 parse 直出详情，也能落库后再出详情

```text
Provider.parse()
  → canonical TranscriptRecord
  ├─ 直接 → assembleSessionDetail(records)
  └─ persist() → SQLite rows → sessionDetailRecordsFromRows()
                              → assembleSessionDetail(records)
```

两条路径在 canonical language 汇合。Provider 在 parse 阶段确定 hidden/skill/tool/relationship；详情层只负责组装，不重新做来源推断。

### 链路 E：`raw(uuid)` 如何回到截断前的来源证据

```text
QueryApi.raw(uuid)
  → 查 messages/session/agent/workflowAgent
  → 依据 source 调 ProviderRegistry.raw()
  → Claude / Codex / Kimi provider 用 UUID 规则定位原文件和原行
  → Query API 按 offset/limit 切片返回
```

索引文本可以为检索而截断；raw 是按已知 evidence ID 回源，而不是重新搜索原始文件。

## 8. 测试证明的不变量

以下结论不仅来自源码，也由测试固定：

| 测试 | 证明的行为 | 文档中对应结论 |
| --- | --- | --- |
| `tests/daemon-arbitration.test.mjs` | fresh heartbeat 时 passive query 不创建/迁移索引；attune 拒绝；writer lease 被占用时 query 保持只读；ownership 无法读取时 fail closed | heartbeat 是策略所有权，query 是只读，attune 不抢写。 |
| `tests/write-transaction.test.mjs` | rollback 失败不覆盖原异常；自动 rollback 后不再 rollback；未知 transaction state 不可继续；真实 BEGIN lock 可分类为可延迟 busy | 事务原语保留 primary error，retry 有严格前提。 |
| `tests/provider-session-detail.test.mjs` | Provider record 流直出 detail 与 persist 后 rows 组装一致；hidden context 不进 detail；图片 wrapper 去重不伤正文；skill 分类存活 | TranscriptRecord 是 parse/persist/detail 的稳定接缝。 |
| `tests/query.test.mjs` | FTS 特殊字符安全回退；默认过滤 meta；memory query 英文约束；Query/Attune API 互不泄露写/读能力 | 检索与写 memory 是分离权限面。 |
| `tests/indexer.test.mjs` | 观测 cwd 优先于 slug 回退；fresh heartbeat 单独代表 daemon ownership | project_path 是 finalize 推导事实，不是 Provider 直接承诺。 |

测试缺口也应如实保留：本文件未把 app 专用 watcher、renderer 或 Electron 跨进程实现当作 Core 的结论；它们需要在 app 范围内单独分析。

## 9. 扩展点、非目标与改动影响

### 扩展点

| 想改变什么 | 应落的位置 | 还要检查 |
| --- | --- | --- |
| 新会话来源 | 新 `ProviderAdapter` + `builtins.ts` 注册 | ID 命名、cursor、raw、conformance/parse tests、schema 是否足够表达。 |
| 新 transcript 字段 | types + schema + persist | migration、detail、query、FTS 是否需要该字段。 |
| 新查询能力 | `createQueryApi` | read-only guard、范围过滤、技能文档与 query tests。 |
| 新 memory 行为 | `createAttuneApi` | writer lease、soft-delete/审计、路径与语言约束。 |
| 新写操作 | indexer 或明确 mutation API | lease、完整事务、retry 分类、daemon ownership。 |

### Core 刻意不做什么

- 不把 Provider 原始格式统一为一个 JSON schema；它统一的是投影后的 `TranscriptRecord`。
- 不在 query/detail 层添加 Provider 特例；Provider 应先产出 canonical 语义。
- 不把 memory 变成任意 SQL 写入能力；它只登记/软删除被批准的 Markdown 结论。
- 不在 CLI 中维护长期 daemon；CLI 是被动拉取者，app daemon 通过 heartbeat 协调所有权。
- 不承担 UI、会话浏览、渲染或产品级 watcher 策略。

## 心智模型

把 Obelisk Core 记成三条不能混淆的边界：

1. **Provider 边界**：异构原始会话先被翻译成 `TranscriptRecord`；
2. **写入边界**：只有 persist 在受事务与 lease 保护时把 records 提交为 SQLite 事实；
3. **读取边界**：Query/Detail 只消费 canonical 或已持久化事实，memory 写入则由独立、受限的 Attune API 承担。

因此，改解析规则通常应落在 Provider；改写入语义应落在 persist/transaction；改用户可见检索能力应落在 query/detail。若一个改动跨过这些边界，必须同时检查其对应的状态不变量与端到端链路。

## 10. 逐文件、逐函数索引（从地基到命令行）

这一章是前文架构图的“源码目录”。它不重复长链路，而是回答阅读某一文件时：输入是什么、字段如何流动、函数把控制权交给哪里。这里的“全部代码文件”指 `packages/core/src/**` 和 `packages/cli/**` 的源文件；`tsconfig` 与 `package.json` 是构建/发布配置，`schema.sql` 是唯一的 SQL 契约。

### 10.1 数据库契约：`schema.sql`、`sqlite-types.ts`、`schema-migrations.ts`、`db.ts`

`schema.sql` 的表没有外键约束；关联靠显式 ID 与 `persist.deleteSession()` 的应用层级联完成。这是为了能接纳三个来源不完整、到达顺序不同的记录。表可以分为五组：

| 组 | 表与关键字段 | 语义 |
| --- | --- | --- |
| 会话事实 | `sessions(id,title,project,project_path,started_at,ended_at,git_branch,version,message_count,jsonl_path,source)` | 一行一个可查询根会话；`project_path` 由 finalize 根据消息 cwd 推导。 |
| 对话证据 | `messages(uuid,session_id,parent_uuid,timestamp,role,text,content_type,is_meta,visibility,model,is_sidechain,agent_id,input_tokens,output_tokens,cwd,skill,turn_duration_ms,source)` | `uuid` 是跨表锚；`agent_id` 既标识子代理消息又使其仍归属 root session。 |
| 工具/编排 | `tool_calls`、`tool_results`、`subagents`、`workflows`、`workflow_agents` | 调用与结果用 tool ID 相连；workflow/subagent 允许多个解析 unit 对同一行补字段。 |
| 索引控制 | `index_state(jsonl_path,mtime,lines_processed)` | `jsonl_path` 只是历史命名，实际上可存 unit key、build heartbeat、版本 marker。 |
| 人工知识 | `memories(id,session_id,project,message_start,message_end,path,anchors,summary,created_at,deleted_at,deleted_reason)` | 只登记已批准文件，删除是可审计的软删除。 |

两张 FTS5 virtual table 分别以 `messages`、`memories` 为 external content。三条 INSERT/DELETE/UPDATE trigger 把正常行变更同步进 FTS；finalize 仍会执行 FTS 的特殊 `rebuild` 命令，防止 force clean、旧库升级或外部写入造成倒挂。索引如 `idx_tc_file`、`idx_messages_ts`、`idx_wa_run` 不是业务关系本身，而是恰好覆盖 file history、时间上下文和 workflow tree 的访问路径。

`sqlite-types.ts` 是最薄的 binding 边界：`SqliteStatement` 只有 `all/get/run`，`SqliteDb` 只有 `exec/prepare/close`，`NodeSqliteDb` 额外暴露 `isTransaction`。因此 `persist/query/migration` 不需知道调用者是 Node 内置 SQLite 还是 Electron 使用的 better-sqlite3。

`schema-migrations.ts` 的 `COLUMN_MIGRATIONS` 是“加列白名单”：目前补齐 `source`、`content_type`、`is_meta`、`visibility`、tool presentation、workflow 父调用及 memory 审计列。`tableExists()` 防止对尚未由 schema 创建的新库执行 PRAGMA；`migrateCoreSchemaColumns()` 对每张表缓存一次列集合，缺失才 `ALTER TABLE ADD COLUMN`。它故意不能做删除/重命名/数据搬迁——这类破坏性演化必须另写 migration。

`db.ts` 管的是文件与连接，而非业务写入：`migrateLegacyDbIfNeeded()` 只在新路径不存在时从旧 Claude 目录复制；`openDb()` 依次创建 `~/.obelisk`、打开 `DatabaseSync`、配置连接、schema 前后执行 additive migration；`openReadDb()` 只读且绝不建库/迁移；`openWriterLeaseDb()` 只打开独立锁库；`rebuildMemoryFts()` 隔离 memory FTS rebuild SQL。`TEXT_LIMIT=10000`、`CLAUDE_DIR`、`CODEX_DIR` 来自纯工具模块后再导出，避免两套路径常量漂移。

### 10.2 纯解析工具：`parsing.ts`

这个文件的价值在于“共享但不依赖 SQLite”，因而 Provider 和 app 都可复用。`trunc()` 限制单字符串，`truncJson()` 递归截断 JSON 字符串后序列化；它们只影响索引副本，`raw()` 仍可读原文。`extractText()` 聚合 Claude text/thinking block，`extractContentType()` 仅在所有 block 同类时返回 `text/thinking/tool_use/tool_result`，混合或未知返回 `unknown`；`extractMessageIsMeta()` 同时识别显式 isMeta 与 command/system XML envelope，`isSkillInstructions()` 专门识别 skill 基础目录说明，`filePath()` 只为 Read/Edit/Write/NotebookEdit 提取 `file_path`。

文件发现侧，`readLines()` 用 64KiB buffer 处理 JSONL，保存半行 remainder 并允许 callback 返回 false 早停；`isDir()` 将不存在/权限错误归为 false。`discoverJsonlFiles()` 枚举 Claude 项目主 transcript、普通 subagent 与 workflow subagent；`discoverCodexJsonlFiles()` 递归扫描 rollout JSONL。路径侧的 `normalizeObservedCwd()` 要求绝对路径，`inferProjectPath()` 按 cwd 出现次数、首次出现次序选择，而不是盲目反解项目 slug；后者仅由 `legacyProjectPathFromSlug()` 作为无 cwd 时的兼容回退，`projectSlugFromPath()` 则负责反方向编码。

Codex helpers 是命名空间与格式兼容层：`codexDbId/codexRawId` 加/去 `codex:` 前缀，`codexLineUuid` 由 thread + 固定宽度行号构造稳定消息 ID，`codexCallId` 规范工具调用 ID；`codexParentThreadId` 兼容多个 parent 字段，`codexIsGuardianThread/readCodexGuardianThreadInfo` 识别需要撤回的 auto-review guardian；`codexAgentNickname/Role` 取多个可选嵌套字段。`parseCodexJsonInput` 容忍 JSON 字符串或原对象，`codexUsage` 选 last/total usage，`codexEventText` 与 `codexMessagePayloadText` 统一 event/response 文本并跳过 image wrapper，`codexVisibleMessageKey` 支持两遍去重，`codexToolInput/Output` 按 custom/tool-search/web-search 的字段差异投影工具证据。

### 10.3 跨层语言：`providers/types.ts`、`registry.ts`、`builtins.ts`

`Cursor = string | null` 是 Provider 私有的 opaque watermark；Core 仅存取，不能解析其语义。`IndexUnit` 的 `key` 用于 index_state，`sessionId/project/isSubagent/agentId` 是公共归属，`meta` 是不透明的适配器私货；`DiscoverContext.lastCursor()` 与可选 `changedPaths` 是调度器交给 Provider 的唯一输入。

`TranscriptRecord` 的十种分支覆盖“表行”和“状态操作”：`message` 的 `visibility` 已经决定可展示性，`is_meta` 决定默认检索过滤，`input_tokens` 是含 cache input 的规范总量；`tool_call.presentation` 让 skill 调用与普通工具可不同渲染；`subagent/workflow_agent` 多字段可选以支持分散来源的 COALESCE 合并；`message-turn-duration` 是定点 UPDATE；`delete-session` 是撤回；`session.countMode` 区分 Claude 增量和 Codex/Kimi 全量计数。`RawLookup` 带着消息、session、subagent/workflowAgent 上下文交回 provider，`RawRecord` 可给全文及分页信息。

`createProviderRegistry()` 在构造期检查 `provider.name === descriptor.id` 与 provider ID 唯一性；其 `catalog/get/list` 是简单访问器，`watchRoots()` 对各 provider root 去重，`raw()` 依 source 路由且不识别原始格式。`createBuiltinProviderRegistry()` 仅组装 Claude/Codex/Kimi factory；新增来源应先实现完整 `ProviderAdapter`，而不是在 query/persist 里插入 `if (source)`。

### 10.4 三个 Provider：格式差异如何被消解

**`providers/claude.ts`。** `cursorToSkip()` 取 cursor 的行数部分，`totalInputTokens()` 将 input/cache creation/cache read 相加。`discoverAt()` 读 `history.jsonl` 做标题补充，把 changed paths 归类为 transcript、workflow、`.meta.json` 关联变更；再按 mtime、cursor、history 变更筛出单位，并单独产生 workflow JSON unit。`workflowParentToolUseId()` 回扫描主 transcript 的 Workflow tool_use/result，给 workflow 建父调用；`parseWorkflow()` 解析 `workflowProgress`，yield 一个 `WorkflowRecord` 和多个只含其已知字段的 `WorkflowAgentRecord`。普通 `parse()` 的长链可按如下理解：

```text
ClaudeProvider.parse(unit, cursor)
  → cursorToSkip() 跳过已提交行，readLines() 逐行 JSON
  → user / assistant record：extractText、content type、meta、token、cwd
    → yield MessageRecord
    → assistant tool_use → yield ToolCallRecord
    → user tool_result → yield ToolResultRecord
  → ai-title / summary / turn-duration / subagent meta 分别 yield 专门 record
  → 主 transcript 汇总 started/ended/message_count
    → yield SessionRecord(countMode: delta 或首轮 total)
  → return "mtime:lineCount"
```

`rawClaude()` 用 UUID、session/agent/workflow 上下文找回对应 JSONL 行；`createClaudeProvider()` 固化 descriptor、canonical marker、configured root、watch root 和上述 discover/parse/raw，`claudeProvider` 是默认实例。

**`providers/codex.ts`。** `messageVisibility()` 将纯 environment/codex internal envelope 隐藏，避免展示层猜规则。`discoverAt()` 读 session index 补 title/updated metadata，扫描 sessions；即使 cursor 未变，guardian 仍会再检查以保证旧索引可被删除。`findCodexFile()` 按原始 thread ID 找 rollout，`rawCodex()` 再按行号 UUID 精确回源。其 parse 不消费 cursor，因为 event 与 response 必须全局去重、guardian 也可改写历史：

```text
CodexProvider.parse(unit, _cursor)
  → read whole JSONL as {lineNum,obj}[]，找 session_meta
  → guardian? yield DeleteSessionRecord 并 return cursor
  → meta 定 root/parent thread、agent 身份、project/cwd/model
  → pass 1：event user/assistant 的 codexVisibleMessageKey 集合
  → pass 2：turn_context、event_msg、response_item、tool call/output、collab spawn
    → insertMessage() 集中生成 UUID、parent、visibility、agent/source
    → token/duration 用 MessageTurnDurationRecord 回填最近 assistant
    → response 与 event key 重复时跳过，防止双显示
  → child：yield SubagentRecord；root：yield SessionRecord(countMode:'total')
  → return "mtime:lineCount"
```

**`providers/kimi.ts`。** Kimi 的 unit 是 session directory：`readState/readWire/listWireFiles/fileLineCount/cursorFor` 负责安全读 state、多条 wire 和复合 cursor；`normalizeTime`、content/part/message helpers 把可能的数组/对象/文本压成 canonical 值。`namespacedSessionId/AgentId/EventId/ToolId` 防止 Kimi 原生 ID 与其他 Provider 冲突；`numericField/inputUsage/outputUsage` 是宽容字段读取；`isRealUserMessage/userSlashCommandText/projectedMessageText/isMetaMessage/canonicalMessageContentType` 决定哪些用户、slash 指令、系统消息进入索引。

核心 `projectSession()` 不是逐行 append，而是可撤销投影器：main wire 优先，维护消息/工具/结果/summary/duration/agent 的中间集合，`context.undo` 用 `applyUndo` 回退该点之后及其关联事实，`context.clear` 推进 floor，compaction 重置开放状态；随后返回投影结果。`sessionDirectories()` 与 `changedSessionDirectories()` 连接 watcher 路径到 unit；`rawFromWire()` 以 namespaced event ID 回读原行；`createKimiProvider()` 把 `projectSession` 结果依序 yield records 和 total session。全量重放是 undo/clear 正确性的前提。

### 10.5 统一写入与索引编排：`persist.ts`、`provider-indexing.ts`、`indexer.ts`

`persist.statements()` 预编译所有 SQL。message 使用全字段冲突更新，tool/result/summary/workflow 使用 replace，subagent/workflow agent 的可选列使用 `COALESCE(excluded, existing)`，避免 metadata unit 和 transcript unit 抢覆盖。`minStr/maxStr` 用在 session 边界，`deleteSession()` 先删依赖消息的工具结果/调用，再删消息、子代理、workflow、summary、session。

```text
persist(db, unit, generator)
  → statements(db)
  → generator.next() 循环
    → write(record.kind)
      → message/tool/result/... 的预编译 statement
      → session：读取旧行、merge 时间与字段、按 countMode 计数
      → delete-session：显式级联删除
  → generator done，取得 return cursor
  → cursor 非 null → index_state(unit.key, mtime, lines_processed)
  → return cursor
```

`storedProviderCursor()` 将两列还原字符串；`createProviderIndexPlan()` 对每个 adapter 检查 marker 缺失且 source 已有行时的全量 replay，随后调用 discover 产出 `ProviderIndexItem(provider,unit,cursor)`；`indexProviderPlan()` 逐项将 **parse + persist** 置于调用方注入的事务，收集 committed/failed/stopped；`writeProviderIndexMarkers()` 只写完全无失败且未 stopped 的 Provider marker，避免错误地宣布新投影已完成。

`indexer.refreshSessionProjectPaths()` 查询每个 session 的所有非空 cwd，再调用 `inferProjectPath`，这是 project_path 唯一权威写点。`shouldSkipBuild()` 使用 60 秒 daemon heartbeat 和 30 秒 passive debounce；`inspectBuildOwnership()` 在 read-only DB 中检查并对不可判定错误 fail closed，只有缺 `index_state` 被当成可初始化旧库。长函数 `buildIndex()` 是整个写链的所有权边界：

```text
buildIndex({force})
  → inspectBuildOwnership()：daemon/recent 则 skip
  → acquireWriterLease(writerLockPathFor(DB_PATH))：拿不到则 writer_busy
  → 再 inspectBuildOwnership()：关闭 TOCTOU
  → openDb() + nodeSqliteTransactionAdapter()
  → force?
    → runRetryableWriteTransaction(force-cleanup)
      → 清除派生事实与普通 index_state，保留 memories
  → createBuiltinProviderRegistry() → createProviderIndexPlan()
  → indexProviderPlan()
    → 每 unit：runRetryableWriteTransaction(provider label)
      → provider.parse(unit,cursor) → persist(...)
  → runRetryableWriteTransaction(finalize)
    → refreshSessionProjectPaths() → messages/memories FTS rebuild
    → 写 __last_build__ → writeProviderIndexMarkers()
  → finally db.close() → lease.release()
```

普通坏文件进入 `skippedFiles`，但 begin busy、不可用 transaction、force cleanup/finalize 失败不被伪装成成功。

### 10.6 原子性与并发：`tx.ts`、`write-coordinator.ts`、`writer-lease.ts`

`betterSqliteTransactionAdapter/nodeSqliteTransactionAdapter` 将两个 binding 的 transaction 属性转成统一函数。`runWriteTransaction()` 精确执行一次 `BEGIN IMMEDIATE → work → COMMIT`；若异常，`transactionState()` 决定是否尝试 rollback，`busyCode/errorCode` 和 `attachDiagnostics` 将阶段、label、rollback 结果、活跃状态附在原异常的 `obelisk` 字段，绝不以 cleanup 异常替换主错误。`configureConnection()` 统一设置 busy timeout、WAL、NORMAL。

`write-coordinator` 不负责 SQL，它只读上述 diagnostics：`isBeginBusyFailure()` 表示尚未进事务的锁竞争，交给上层返回 busy；`hasUnusableTransaction()` 表示连接仍处于或未知事务，绝不可继续；`isRetryableWriteFailure()` 仅允许 work/commit busy 且已确定 rollback 后的失败。`runWithWriteRetry()` 默认三次/一秒/25ms 递增等待，`runRetryableWriteTransaction()` 只是将其包住 `runWriteTransaction()`。

`writer-lease.ts` 提供更高层的跨进程互斥。`writerLockPathFor()` 固定同目录 `writer.lock.sqlite`；`acquireWriterLease()` 创建锁目录、对该独立 SQLite 设 busy_timeout=0 并 BEGIN IMMEDIATE，成功后一直保持事务到 idempotent `release()` 的 ROLLBACK/close；仅 busy 在 `waitMs` 内重试，其他错误抛出。它与 heartbeat 的区别必须保持：heartbeat 是礼让 daemon 的策略，lease 是任何情况下禁止两名 writer 同时落库的硬保证。

### 10.7 读取、Memory 与详情投影：`query.ts`、`session-detail.ts`、`core.ts`

`query.ts` 先由 `normalizeOpts/buildWhere` 统一 scalar/options 和 session/project/time/branch/source 过滤，`assertReadOnlySql` 只允许 SELECT/WITH 且拒绝任何写/DDL token，`buildSafeFtsQuery` 将不合法 FTS 输入退化为最多 12 个 quoted token。`createQueryApi()` 输出的函数可按作用分组：`search` 命中 FTS 后补最多六条按时间最近的同 session context，默认排 meta；`context` 查消息、parent chain、session、subagent/workflow；`trace` 只沿 parent；`thread` 排序取 session 消息；`sessions/recent/summaries/overview` 做列表和当前项目聚合；`subagents/workflows/workflowTree` 补 message count 和 workflow JSON；`fileHistory` 由 tool_calls.file_path 回溯；`failures` 识别 `is_error` 或 shell Exit code 并给后继消息；`raw` 通过 registry 回源后再做 offset/limit；`memories` 固定排除 soft deleted，query 必须英文并走 memory FTS。`overview` 的 current project 依次尝试显式 opts、最长 project_path 前缀、精确 message.cwd，最后才为空，故它是导航摘要而非证据检索。

`createAttuneApi()` 故意只返回写 memory 的 `remember/forget`。前者经 `resolveMemoryPath()` 将相对路径置于 session project/cwd 下并验证是实际文件，`normalizeAnchors()` 只接收对象数组 JSON，英文 summary 检查后写入带时间和随机后缀的 ID；后者要求 reason，重复删除返回 already_deleted 而不重写审计字段。读 API 不含 remember，写 API 不含 sql/search，是能力分离。

`session-detail.ts` 的大量接口是 renderer 所需形状：message/tool/workflow/subagent/summary/session 行接口映射 DB 行，`SessionDetailSnapshot` 集合化输出。`sessionDetailRecordsFromRows()` 将 SQLite rows 重建为 canonical record，`assembleTranscriptRecords()` 聚合同一流，拒绝 delta session，跳过 hidden 与非主线消息，按 tool ID 把 result/subagent/workflow 挂到调用，合并连续 thinking/兼容 tool-use，并把 skill instruction 贴回 skill 调用；`assembleMessages()` 是该展示合并的局部算法；`assembleSessionDetail()` 是两种输入（records 或 rows）的唯一公共入口。

最后 `core.ts` 是 transport 门面。`runInSandbox()` 以 30 秒 `node:vm` async IIFE 执行用户脚本，只注入 Query 或 Attune API 与基础 JS 全局对象。`searchText()` 先 passive build 后读库 search；`executeQuery()` 同样 build、以 Query API 跑 VM、finally close；`executeAttune()` 先 build 拒绝 daemon/busy，再等待至多一秒 lease，拿锁后重新检查 heartbeat，才 openDb 并仅以 Attune API 跑脚本。它是 memory 写的第二道 TOCTOU 保护。

### 10.8 CLI 与发布：`packages/cli/src/obelisk.ts`、`scripts/build.mjs`

CLI 的 `main()` 是薄 transport，所有成功结构化输出写 stdout JSON，失败也编码为 `{error,stack}` 且 exitCode=1。`--version/-v` 从 package.json 读版本；`--build` 调 `buildIndex({force:true})` 并返回 DB path；`--search` 拼接余下词为 FTS 文本；`--query`/`--attune` 使用绝对化后的脚本文件内容分别交给 Core；`install` 调用 `npx --yes skills add tommy0103/obelisk-skill` 并透传 stdio/status，Windows 特判 `npx.cmd` 与 shell。无匹配参数则打印 usage。

`scripts/build.mjs` 是发布边界而非运行时逻辑：先可恢复地删除 CLI `dist`，用 workspace 的 TypeScript 编译 CLI build tsconfig；因为 TypeScript 不会复制 SQL，最后确保 `dist/core/src/schema.sql` 存在并复制源 schema。于是发布包中的 CLI 可直接 import 同包可读的编译 Core，避免把数据库 DDL 遗漏在 npm payload 外。
