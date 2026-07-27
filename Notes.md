# Notes：Obelisk `packages/core` 与 `packages/cli` 完整项目解析

> 阅读范围：`packages/core/src/**`、`packages/cli/src/**`、Electron `app/src/**` 与它们直接相关的构建、包发布配置。本笔记按依赖方向从下到上展开；它不是 API 清单，而是解释“原始会话证据为何能安全地变成可检索、可回源的本地知识库”。

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

对应的调用链是：

| 阶段 | 目的 | 入口函数 |
| --- | --- | --- |
| 1. 命令入口 | 将 `--build` 定义为强制重建 | `cli/src/obelisk.ts` → `main()` |
| 2. 写入资格 | 礼让 daemon，并取得唯一 writer | `indexer.ts`、`writer-lease.ts` |
| 3. 初始化与清理 | 打开、迁移 DB；force 时清除旧派生事实 | `db.ts`、`tx.ts`、`write-coordinator.ts` |
| 4. 计划 | 注册 Provider，发现本次需要处理的 units | `builtins.ts`、`provider-indexing.ts` |
| 5. 真正索引 | 每个 unit 原子地 parse → persist | Provider、`persist.ts` |
| 6. 最终化 | 补项目路径、重建 FTS、提交 marker、释放资源 | `indexer.ts`、`db.ts`、`provider-indexing.ts` |

#### 阶段 1：命令入口与实现实体

`packages/cli/src/obelisk.ts` 的 `main()` 识别 `--build`，调用从 `packages/core/src/core.ts` 导入的 `buildIndex({ force: true })`。`core.ts` 不再包一层实现；它只是直接 re-export `packages/core/src/indexer.ts` 中的同名 `buildIndex()`。

因此，真正的总编排器是 `indexer.ts` 的 `buildIndex()`：它负责判断能否写、决定写什么、逐项提交、最后收尾。

#### 阶段 2：先确认“谁有资格写”

```text
indexer.ts / buildIndex()
  → inspectBuildOwnership() + shouldSkipBuild()
    → db.ts / openReadDb()
  → writer-lease.ts / writerLockPathFor(DB_PATH)
  → writer-lease.ts / acquireWriterLease({ openDb: openWriterLeaseDb })
    → db.ts / openWriterLeaseDb()
  → 再次 inspectBuildOwnership()
```

- `inspectBuildOwnership()` 与 `shouldSkipBuild()` 是索引前的所有权判定。若 DB 已存在，它们通过 `openReadDb()` 读取 heartbeat；app daemon 心跳新鲜时 CLI 停止写入。`force` 只忽略 30 秒的最近构建 debounce，不能抢占 daemon。
- `writerLockPathFor()` 计算主库旁的 `writer.lock.sqlite` 路径；`acquireWriterLease()` 在这里竞争跨进程唯一 writer，拿不到立即返回 `writer_busy`。
- `openWriterLeaseDb()` 打开独立 lock DB，lease 用未提交的 `BEGIN IMMEDIATE` 持有硬锁。随后第二次 `inspectBuildOwnership()` 关闭“第一次检查和拿锁之间 daemon 启动”的 TOCTOU 窗口。

#### 阶段 3：打开真实数据库，并在 force 下清旧索引

```text
indexer.ts / buildIndex()
  → db.ts / openDb() + tx.ts / nodeSqliteTransactionAdapter(db)
  → force ? write-coordinator.ts / runRetryableWriteTransaction()
      → tx.ts / runWriteTransaction()
        → BEGIN IMMEDIATE → DELETE 派生表 → COMMIT
```

`openDb()` 创建/迁移真实 SQLite，加载 `schema.sql` 并配置 WAL；`nodeSqliteTransactionAdapter()` 将 node:sqlite 连接包装成共享事务接口。强制构建时，`runRetryableWriteTransaction()` 把清理包进可重试原子事务：删除 messages、tools、sessions 等 source-derived 事实，**但保留人工批准的 memories**，从而绝不留下“删除一半”的索引。

#### 阶段 4：注册 Provider，再生成索引计划

```text
indexer.ts / buildIndex()
  → providers/builtins.ts / createBuiltinProviderRegistry()
  → provider-indexing.ts / createProviderIndexPlan(db, registry)
    → provider-indexing.ts / storedProviderCursor()
    → claude.ts | codex.ts | kimi.ts / provider.discover()
```

`createBuiltinProviderRegistry()` 注册本次可用数据源：Claude、Codex、Kimi 的 adapter、descriptor、默认根目录和 raw 回源能力。`createProviderIndexPlan()` 才将“已注册的数据源”变成实际待处理的 `IndexUnit[]`：它先用 `storedProviderCursor()` 从 `index_state` 取回各 unit 的上次成功水位线，再调用每个 Provider 的 `discover()` 扫描目录、比较 cursor/mtime/changed paths。marker 过期或 force 时，该 Provider 被标为 full replay，避免新旧投影规则混用。

#### 阶段 5：逐 unit 真正开始索引

```text
provider-indexing.ts / indexProviderPlan()
  → for each IndexUnit
    → write-coordinator.ts / runRetryableWriteTransaction()
      → tx.ts / runWriteTransaction()
        → claude.ts | codex.ts | kimi.ts / provider.parse(unit, cursor)
        → persist.ts / persist(db, unit, generator)
          → schema.sql：sessions/messages/tools/... 表
          → index_state：写回新 cursor
```

`indexProviderPlan()` 是真正逐 unit 索引的起点。单个坏文件可以记录到 `skippedFiles` 并让其他 unit 继续；每个健康 unit 都将整段“解析 + 写入”放进一个重试事务，而不是只重试最后一条 SQL。

Provider 的 `parse(unit, cursor)` 读取原始 JSONL、state 或 wire，生成 provider 无关的 `TranscriptRecord` 流。`persist()` 消费该流，按 `kind` 做 upsert、字段合并或删除；它是事实写入 SQLite 的唯一共享入口。只有 generator 正常结束后才把新 cursor 写入 `index_state`，使其成为下一次增量发现的水位线。

#### 阶段 6：统一最终化并释放 writer

```text
indexer.ts / buildIndex()
  → runRetryableWriteTransaction(finalize)
    → indexer.ts / refreshSessionProjectPaths()
      → parsing.ts / inferProjectPath()
    → schema.sql：messages_fts rebuild
    → db.ts / rebuildMemoryFts()
    → provider-indexing.ts / writeProviderIndexMarkers()
    → index_state：写 __last_build__
  → DatabaseSync.close() + writer-lease.ts / lease.release()
```

finalize 只在所有 unit 已提交或被明确跳过后运行；它失败会使 build 失败，不能被当成普通坏文件吞掉。`refreshSessionProjectPaths()` 聚合已写入的 `messages.cwd`，再由 `inferProjectPath()` 按出现频率和首次出现顺序选择可靠路径，必要时才回退 slug 反解。随后重建 messages 与 memories 的 FTS 倒排索引，写入成功 Provider 的版本 marker 和 `__last_build__` debounce 标记。最后无论成功、跳过还是抛错，都会关闭 `DatabaseSync` 并 `lease.release()`，释放数据库连接与跨进程写锁。

上图中的“来自 `core.ts` 的 `buildIndex`”只是在说明 CLI 的 import 位置；运行时真正执行的是 `indexer.ts` 的函数实体。后文所有调用链均遵循同一标注约定：名称后先给定义文件，若是 Provider 接口方法则列出其三个具体实现文件。

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

#### `TranscriptRecord` 的字段字典：每种事实究竟保存什么

下面的记录不是“原始 JSON 的一份副本”，而是所有 Provider 必须说的共同语言。`persist()` 依据 `kind` 把它们落到表中；`session-detail.ts` 则可以不经过 SQLite 直接消费同一条记录流。也因此，字段的含义应在这里固定，而不应该在 query 或 UI 中按来源重新猜测。

| `kind` | 主键及归属 | 主要字段 | 语义与注意点 |
| --- | --- | --- | --- |
| `session` | `id`，并带 `source` | `title`、`project`、`started_at`、`ended_at`、`git_branch`、`version`、`message_count`、`jsonl_path`、`countMode` | 根会话聚合。`countMode: total` 覆盖消息数，`delta` 累加消息数；Claude 增量解析与 Codex/Kimi 全量回放正是靠它共用写入层。`project_path` 不由 Provider 直接填写，而是稍后从消息 cwd 推导。 |
| `message` | `uuid`，`session_id` | `type`、`parent_uuid`、`timestamp`、`role`、`text`、`content_type`、`is_meta`、`visibility`、`model`、`is_sidechain`、`agent_id`、`input_tokens`、`output_tokens`、`cwd`、`skill`、`source` | 对话证据的核心行。`uuid` 是 tool、memory anchor 和 raw 回源的稳定锚点；`parent_uuid` 是因果/对话父链，不等于时间邻居。`visibility=hidden` 由 Provider 决定详情是否展示；`is_meta` 只控制默认检索是否过滤。`agent_id` 非空仍属于父 `session_id`，但说明内容属于子代理。 |
| `tool_call` | `id`，`message_uuid`、`session_id` | `name`、`presentation`、`input_json`、`file_path` | 一条 assistant message 可以发起多个调用。`presentation` 区分 `default` 与 `skill`，使 skill 的说明能被详情层特殊归并。`file_path` 是可选的、面向 file history 的抽取字段，不能把它当作所有工具都有的真相。 |
| `tool_result` | `tool_use_id`，`message_uuid`、`session_id` | `content`、`file_path`、`is_error` | `tool_use_id` 必须对应 `tool_call.id`，不能以相邻行推断配对。结果常承载在下一条 user/tool message，所以 `message_uuid` 不一定等于发起调用的 message。 |
| `summary` | `id`、`session_id` | `timestamp`、`source`、`content` | 例如 Claude `away_summary`。它保留来源标签，避免把机器摘要误当成用户/assistant 正文。 |
| `subagent` | `agent_id`、`session_id` | `parent_tool_use_id`、`agent_type`、`description`、`duration_ms`、`total_tokens` | 这是子代理的“名片”和与启动工具的关系，不是子代理聊天记录；聊天仍是 `messages`，靠其 `agent_id` 关联。可选列允许 spawn 事件与子线程自身分两次补全。 |
| `workflow` / `workflow_agent` | `run_id` / `agent_id`，都含 `session_id` | workflow 有 `parent_tool_use_id/task_id/script/result_json/timestamp/agent_count/duration_ms/total_tokens/status/workflow_name`；agent 有 `run_id/agent_type/description/phase/label/model/state/duration_ms/tokens/tool_calls` | workflow 是一次编排运行，workflow_agent 是其中成员。后者以 `agent_id` upsert，未知字段绝不覆盖已知字段，适合不同 JSON unit 以任意顺序到达。 |
| `message-turn-duration` | `uuid` | `turn_duration_ms` | 不是独立表行，而是对先前或后续 message 的定点 UPDATE。它让 Codex 等延迟出现的 turn 统计不会重写整条消息。 |
| `delete-session` | `sessionId` | 无 | 也是状态操作而非表行。guardian/auto-review 发现会话应撤回时，`persist` 必须删除其所有依赖事实，不能只删除 `sessions` 留下孤儿工具行。 |

从关联方向看，最容易混淆的三层关系如下：

```text
sessions(id)
  → messages(session_id, uuid)
      → tool_calls(message_uuid, id)
          → tool_results(tool_use_id)
  → subagents(session_id, agent_id) ← messages.agent_id
  → workflows(session_id, run_id) → workflow_agents(run_id)

memories(session_id, message_start, message_end)
  → 不是转存原文，而是用户批准的结论；三个 ID 都应能回到证据。
```

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

- `openDb()` 是唯一会创建目录、设置 WAL/NORMAL、执行 schema/additive migration 的入口；当前实现**不会**把旧 `~/.claude/obelisk.sqlite` 自动复制到新库位置；
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

`db.ts` 管的是文件与连接，而非业务写入：`openDb()` 依次创建 `~/.obelisk`、打开 `DatabaseSync`、配置连接、执行 schema 前后的 additive migration；它当前不包含旧 Claude 目录数据库的自动复制逻辑。`openReadDb()` 只读且绝不建库/迁移；`openWriterLeaseDb()` 只打开独立锁库；`rebuildMemoryFts()` 隔离 memory FTS rebuild SQL。`TEXT_LIMIT=10000`、`CLAUDE_DIR`、`CODEX_DIR` 来自纯工具模块后再导出，避免两套路径常量漂移。

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

## 11. Electron App：把 Core 变成常驻本地观察界面

CLI 是一次性 passive pull；`app/` 是第二个运行时，它把同一套 Provider、`persist()`、事务和 writer lease 放进 Electron 主进程中，增加 watcher、IPC、Vue renderer 与会话实时刷新。它没有复制 Provider 解析规则，真正的共享边界仍是 Core 的 `ProviderAdapter → TranscriptRecord → persist`。

### 11.1 主进程：生命周期、DB 与 IPC

`app/src/main/index.ts` 是 Electron 主入口。启动时它读取 `~/.obelisk/settings.json`，由 `getRuntimePaths()` 组合默认及用户指定的 Provider 根目录；`openDb()` 用 better-sqlite3 打开主库并执行同一份 schema/migration。随后 `startBackgroundResources()` 依次创建 worker client 与 indexer service，再由 `createWindow()` 加载 renderer。

主进程还是唯一有权直接访问本地数据库和文件系统的一层：它通过 `ipcMain.handle()` 提供 sessions、消息、tools、subagents、workflows、memories、raw 内容、统计、设置和 recap capture 等能力。查询 session 时，`querySessionSnapshot()` 从多张表读出事实，再经 Core `assembleSessionDetail()` 生成展示快照；`querySessionDisplaySnapshot()` 则经 shared patch 协议生成增量刷新所需的比较基线。

手动 rebuild 不会就地破坏正在显示的数据库：`settings:rebuildIndex` 先停 watcher/worker，在 caller-held lease 下让 worker 写入临时 DB，成功后 `replaceDbWithTemp()` 原子替换正式文件、重开 DB 并通知 renderer；失败时 finally 尝试重开旧库。这与 CLI 的 force cleanup 不同，目的是桌面端保留可用旧索引直到新索引完整成功。

### 11.2 常驻索引：service → worker → app indexer

```text
index.ts / startIndexerService()
  → indexer-service.ts / createIndexerService()
    → chokidar 监听所有 provider.watchRoots()
    → debounce + stability window 收集 changedPaths
    → indexer-worker-client.ts / createWorkerBuildIndex()
      → indexer-worker.ts：线程内调用 app/src/main/indexer.ts / buildIndex()
        → Core 的 createProviderIndexPlan() → indexProviderPlan() → persist()
```

`indexer-service.ts` 不解析任何 transcript。它只解决“何时发起构建”：合并文件变化、等待文件稳定、避免并行 build、busy 时延迟重试、定时写 daemon heartbeat。`indexer-worker-client.ts` 把 build 请求用 id 映射到 `Worker` Promise；worker 崩溃或停止时拒绝所有 pending 请求。真正的 app `buildIndex()` 位于 `app/src/main/indexer.ts`：它用 better-sqlite3 注入 Core 的共享 indexing/persist 模块，额外负责 Electron 下的 schema 路径、临时 DB memory 保留、FTS trigger 优化、affected session ID 与 checkpoint。

### 11.3 preload、shared 协议与 Vue renderer

`app/src/preload/index.ts` 用 `contextBridge` 暴露白名单 `window.obelisk`，所以 renderer 不能直接拿 Node、SQLite 或任意 IPC channel。`app/src/shared/session-detail-assembly.mjs` 将 Core detail assembler 适配给 renderer；`session-patch.mjs` 用稳定 row id/hash/fingerprint 计算 snapshot 的新增、更新、删除、重排补丁，主进程和 renderer 共用同一协议。

renderer 由 `App.vue`、`router.js`、`store.js` 组成壳层。`data.js` 只负责 IPC 请求和会话快照缓存；`SessionDetail.vue` + `session-timeline-*.mjs` 负责虚拟列表、锚点、用户滚动保护、tail follow 和 patch 合并；`Activity.vue` 显示使用量聚合；`MemoryList.vue` 管理人工 memory；`Settings.vue` 配置数据源并触发 rebuild；Recap views 将数据库事实组织为周/月回顾。组件层只渲染 canonical/SQLite 投影，不应再识别 Claude、Codex、Kimi 原始格式。

### 11.4 全项目的最短心智模型

```text
本地 Claude / Codex / Kimi 文件
  → Provider 发现、解析、标准化
  → SQLite 事实库 + FTS + cursor
  ├─ CLI：按需 build 后执行 search / query / attune
  └─ Desktop：watcher 触发 worker build；IPC 把事实快照/patch 提供给 Vue
       → 用户查看证据、raw 回源、管理 memory、生成 recap
```

这里的关键约束是：Provider 决定来源语义，`persist` 决定事实如何写入，事务/lease 决定写入是否安全，Query/IPC/renderer 只读取已规范化的事实。任何功能若跨过这四个边界，才需要同步修改多层。

## 12. 静态审计与验证结论（2026-07-28）

审计口径是：检查运行入口、静态导入/调用关系、TypeScript、ESLint、全量 Node tests；公共 package export 不因“仓库内部没有调用”被误判为无效代码。

- Core/CLI/App 的 TypeScript typecheck 通过；ESLint 没有 error，但 tests 中有四个 unused-variable warning（`require` 或 `mainPath`），属于测试噪声而非运行时代码。
- Core 主链、app watcher/worker、preload IPC 和 renderer 路由均存在可达入口；未发现可安全删除的内部运行时函数。
- `claudeProvider`、`codexProvider`、`kimiProvider` 以及 Claude/Codex 的独立 `discover/parse` export 在仓库内引用少，但它们属于 `@obelisk/core` 的公开子模块 API 或兼容入口，不能仅凭内部引用数判定为死代码。
- `app/obelisk-ui-mini.html` 与 `app/obelisk-session-share.html` 没有被 package scripts、Electron 入口或文档链接引用。它们看起来是独立演示/分享产物，不进入 `electron-builder` 的 `out/**` payload；若不再需要人工打开或分享，应先确认用途后再移除。
- 2026-07-28 审计后，TypeScript typecheck、ESLint 与全量 Node tests 均通过（273 passed / 0 failed）。旧 `~/.claude/obelisk.sqlite` memory 自动迁移已被明确移除，因此对应测试也应删除；schema 变更同步更新 hash 基线；rebuild 测试夹具必须创建当前正式库 `~/.obelisk/obelisk.sqlite`，而不是已弃用的 Claude 根目录数据库。
