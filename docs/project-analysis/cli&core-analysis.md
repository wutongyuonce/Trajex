## 项目定位

> CodeAct 代表了一种先进的 AI 智能体设计范式，它通过将 **“编写可执行代码”** 作为核心行动方式，极大地增强了 AI 处理复杂任务、操作数据和与外部世界交互的能力。

Trajex 是“Coding Agent 的显式记忆基础设施”（Claude Code、Codex、Pi）：

1. 读取本机已有的 Agent 会话历史。

2. 把不同供应商的日志格式统一成一套 canonical(规范的) transcript records。

3. 持久化到 `~/.trajex/trajex.sqlite` 并索引，提供 FTS5 全文搜索和记忆管理能力。

4. 提供两类访问方式：

   - Agent 侧：`trajex` Skill 通过 CLI 让 Agent 用 JS 查询历史证据。

     ```js
     const hits = search("auth bug", { limit: 10 });
     const details = hits.map(h => context(h.message.uuid));
     return { hits, details };
     ```

     这里 JS 是编排语言，`search/context/sessions/failures/fileHistory` 等是预设查询 API；脚本在独立的 **Node.js Worker Thread + `node:vm` context** 中执行。

   - 人类侧：Electron 桌面 app 浏览 session、memory、activity。

核心设计不是“为每个 provider 写一套 app/CLI 逻辑”，而是：

```text
Provider 适配器解析不同格式原始日志 (claude.ts / codex.ts / pi.ts)
    │  统一流式 yield TranscriptRecord，结束时 return Cursor
    ▼
persist.ts (写库 SQLite)
    │  INSERT / UPDATE / DELETE
    ▼
┌────────────────────────────────────────────────────┐
│  sessions  ← 工具调用时用到的文件路径索引             │
│  messages  ← 触发器 -> messages_fts (FTS 全文搜索)    │
│  tool_calls  工具调用与结果关联                       │
│  tool_results  ↓                                    │
│  subagents    子代理（含 workflow_agents）            │
│  workflows    ↓                                     │
│  workflow_agents                                   │
│  summaries                                         │
├────────────────────────────────────────────────────┤
│  index_state  ← 索引进度追踪（__last_build__ 等）     │
├────────────────────────────────────────────────────┤
│  memories  ← 人工写入 -> memories_fts (FTS 记忆搜索)  │
│              (attend API: remember / forget)        │
└────────────────────────────────────────────────────┘
    ▲
query.ts (查询 API)
    │  search() / context() / sessions() / memories()
    │  sql() / overview() / raw()
    ▼
CLI / Electron App
```

这个设计的稳定中心是 `TranscriptRecord`，不是数据库表，也不是某个 provider 的 JSONL 格式。

## 心智模型

Trajex 的主线不是“解析 JSONL 然后展示”。更准确地说，它有三条稳定边界：

1. provider adapter 边界
   - 每个 provider 自己理解原始日志。
   - 输出统一 `TranscriptRecord`。
   - Codex 的去重、root-thread 筛选和全量重建都在这里完成。

2. persist 写入/query 检索边界
   - persist 是唯一写库语义。
   - SQLite 是证据层，不是 provider 语义源头。
   - query sandbox 给 Agent 一个可编程、只读、证据优先的检索面。

3. app presentation 边界
   - app 不直接理解 Codex wire format。
   - app 从 DB rows 或 canonical records assembly 出可读 timeline。
   - 实时刷新通过 daemon、worker、patch、虚拟列表保证体验。

二开时最重要的是守住这三条边界：provider 差异留在 provider，写库语义留在 persist，改用户可见检索能力应落在 query，阅读体验留在 assembly/renderer。这样新增 provider 或扩展 Codex 时，改动面会很小，也不会让 app、CLI、query API 被 provider-specific 逻辑污染。

## 各文件定位与关系

```ts
一、公共门面
  packages/cli/src/trajex.ts   ← CLI 参数、脚本读取、JSON 输出
  packages/core/src/core.ts    ← 4 个高层函数：buildIndex / searchText / executeQuery / executeAttune

二、索引主线

  4、索引编排与并发层                                             
    indexer.ts                 ← 索引编排引擎：所有权、计划、提交、finalize      
    provider-indexing.ts       ← Provider 计划与每 unit 执行
               │                                                
  3、Provider 适配层                                             
    providers/types.ts         ← TranscriptRecord / Provider 契约
    providers/{claude,codex,pi}.ts ← 原始文件 -> 统一记录         
    providers/{registry,builtins}.ts ← 注册、根目录、watch/raw 回源
               │                                                
  2、持久化层                                                    
    persist.ts                 ← TranscriptRecord -> SQLite 行   
               │                                                
  1、数据库契约与工具层                                            
    db.ts 数据库生命周期管理 / schema.sql DDL 定义 / schema-migrations.ts 渐进式列迁移 / sqlite-types.ts SQLite 抽象接口 / tx.ts 事务抽象、write-lease.ts 跨进程单 writer 锁、write-coordinator.ts 可重试写入协调器
    parsing.ts                 ← 纯工具函数库：文件发现、JSONL、文本、Codex ID   
                                                                
三、读取与投影
  检索与记忆层
    query.ts               ← 查询 API + 记忆操作

  展示投影层
    session-detail.ts      ← 会话详情组装：canonical transcript / SQLite rows -> SessionDetailSnapshot，被桌面应用或渲染层使用
```

```text
buildIndex()
  │
  ├─ writer-lease.ts：取得跨进程唯一写入权
  │    └─ 拿不到：返回 writer_busy，不进行写入
  │
  ├─ db.ts：打开主数据库并完成初始化
  │    ├─ 配置 WAL、busy timeout 等连接参数
  │    ├─ schema-migrations.ts：给旧数据库补充缺失列
  │    ├─ schema.sql：创建缺失的表、索引、FTS 表等
  │    └─ 再执行一次列迁移，兼容刚新建的表
  │
  ├─ sqlite-types.ts：约束“数据库连接应提供哪些方法”
  │
  └─ tx.ts + write-coordinator.ts：执行原子、可重试的写入
       └─ BEGIN IMMEDIATE -> SQL 写入 -> COMMIT
          出错 -> ROLLBACK
```

### @trajex/core（核心包）

1、统一入口

| 文件       | 定位                             | 提供内容 / 作用                                               | 关键关系                                                     |
| ---------- | -------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------ |
| core.ts    | **Core 的聚合面**                | 对外暴露构建、搜索、查询脚本与记忆操作等高层函数。             | 依赖 `db.ts`、`indexer.ts`、`query.ts`、`writer-lease.ts`；被 CLI 的 `trajex.ts` 直接 `import`。 |
| persist.ts | **唯一写数据库的持久化层**       | 消费 `TranscriptRecord` 流，并将会话、消息、工具等事实写入 SQLite。 | 被 `provider-indexing.ts` 调用；依赖 `sqlite-types.ts` 和 `providers/types.ts`。 |

2、数据库层

| 文件                 | 定位                         | 提供内容 / 作用                                               | 关键关系                                                     |
| -------------------- | ---------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------ |
| db.ts                | **数据库生命周期管理**       | 提供 `openDb()`、`openReadDb()`、`openWriterLeaseDb()`、`rebuildMemoryFts()`。`openDb()` 创建并初始化主库；`openReadDb()` 不建库、不迁移；锁库连接不承载业务表。 | 被 `core.ts`、`indexer.ts`、`query.ts` 使用；依赖 `parsing.ts` 的路径工具、`tx.ts` 的连接配置和 `schema-migrations.ts`。 |
| schema.sql           | **DDL 定义**                 | 定义新数据库的表、初始列、索引、FTS5 虚拟表和触发器。          | 由 `db.ts` 的 `openDb()` 通过 `exec` 加载。                  |
| schema-migrations.ts | **渐进式列迁移**             | 提供 `migrateCoreSchemaColumns()`；仅为已有表补充缺失列，不删除列、不修改类型、不搬迁数据。 | 由 `db.ts` 在打开数据库时调用。                              |
| sqlite-types.ts      | **SQLite 类型抽象**          | 定义 `SqliteDb`、`SqliteStatement`、`NodeSqliteDb` 等 TypeScript 类型，约束连接、语句和结果行可使用的 API。 | 被几乎所有数据库操作文件作为类型依赖引用；只参与开发/编译，不执行 SQL。 |

`db.ts` 为 node:sqlite 提供可写、只读和 writer-lease 三种连接工厂，并负责 schema 初始化和 FTS 重建。桌面 App 可通过结构接口复用上层逻辑。

```ts
function openDb(): NodeSqliteDb {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  const db = new DatabaseSync(DB_PATH);
  configureConnection(db, { busyTimeoutMs: 250 });
  migrateCoreSchemaColumns(db);
  db.exec(SCHEMA);
  migrateCoreSchemaColumns(db);
  return db;
}

/** 打开只读主索引，供查询和 daemon 所有权判断使用。 */
function openReadDb(): NodeSqliteDb {
  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  db.exec('PRAGMA busy_timeout=250');
  return db;
}

/** 打开独立锁库；该连接只承载 writer lease，不承载业务表。 */
function openWriterLeaseDb(lockPath: string): NodeSqliteDb {
  return new DatabaseSync(lockPath);
}

/** 批量写入结束后，由 memories 表重新派生 content-backed FTS。 */
function rebuildMemoryFts(db: SqliteDb): void {
  db.exec("INSERT INTO memories_fts(memories_fts) VALUES('rebuild')");
}
```

3、事务与并发控制

| 文件                 | 定位                   | 提供内容 / 作用                                              | 关键关系                                                     |
| -------------------- | ---------------------- | ------------------------------------------------------------ | ------------------------------------------------------------ |
| tx.ts                | **事务抽象**           | 它把 CLI 使用的 `node:sqlite` 与桌面端使用的 `better-sqlite3` 适配成同一种 `BEGIN IMMEDIATE -> work -> COMMIT` 原子写事务，并在失败时尽力回滚，保留足够诊断信息，交给上层判断能否重试。提供 `runWriteTransaction()`、两个 SQLite binding adapter 和 `configureConnection()`。 | 被 `db.ts`、`indexer.ts`、`write-coordinator.ts` 使用。      |
| write-coordinator.ts | **可重试写入协调器**   | 提供 `runRetryableWriteTransaction()` 及 busy/事务状态判断；只对可确认安全的失败进行有限重试。 | 被 `indexer.ts` 使用；包装 `tx.ts` 的单次事务函数。          |
| writer-lease.ts      | **跨进程单 writer 锁** | 提供 `writerLockPathFor()`、`acquireWriterLease()`；使用独立 `writer.lock.sqlite` 保证同一时刻仅一个进程可写索引。 | 被 `core.ts`、`indexer.ts` 使用；在主库事务之前取得并在构建结束时释放。 |

4、索引引擎

| 文件                 | 定位                       | 提供内容 / 作用                                               | 关键关系                                                     |
| -------------------- | -------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------ |
| indexer.ts           | **索引编排引擎**           | 提供 `buildIndex()`；依次取得租约、创建 Provider 计划、执行各 unit、最终回填 `project_path` 并重建 FTS。 | 被 `core.ts` 调用；协调 `db.ts`、事务模块、Provider 注册表和 `provider-indexing.ts`。 |
| provider-indexing.ts | **Provider 索引流水线**    | 提供 `createProviderIndexPlan()`、`indexProviderPlan()`、`writeProviderIndexMarkers()`，分别负责计划、执行和写入进度标记。 | 被 `indexer.ts` 调用；执行时将解析出的记录交给 `persist.ts`。 |

provider-indexing.ts 导出字段：

```ts
/** 计划中的单个执行单元：哪个 Provider 解析哪个 unit，以及从哪个 cursor 续读（null 为全量）。 */
export interface ProviderIndexItem {
  readonly provider: ProviderAdapter;
  readonly unit: IndexUnit;
  readonly cursor: Cursor;
}

/** 一次 build 的完整计划：有序执行项 + 待写回的版本完成标记（Provider 版本升级时置入）。 */
export interface ProviderIndexPlan {
  readonly items: ProviderIndexItem[];
  readonly pendingMarkers: ReadonlyMap<string, string>;
}

/** 执行结果：已提交项、失败 Provider 集合；stopped 表示数据库忙等原因中途停止的位置。 */
export interface ProviderIndexResult {
  readonly committed: ProviderIndexItem[];
  readonly failedProviders: ReadonlySet<string>;
  readonly stopped?: { item: ProviderIndexItem; error: unknown };
}
```

5、查询与记忆

| 文件              | 定位                         | 提供内容 / 作用                                               | 关键关系                                                     |
| ----------------- | ---------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------ |
| query.ts          | **查询 API 与记忆操作**     | 提供 `createQueryApi()` 的 `search`、`context`、`thread`、`sessions`、`overview`、`memories` 等查询，以及 `createAttuneApi()` 的 `remember` / `forget`。 | 被 `core.ts` 调用；查询使用索引数据，记忆操作进入 writer lease 保护的写入路径。 |
| session-detail.ts | **会话详情组装**             | 将 `TranscriptRecord` 流或数据库行组装为 `SessionDetailSnapshot`，供界面展示。 | 纯函数，不依赖数据库；被桌面应用或渲染层使用。                |

6、工具函数

| 文件       | 定位                   | 提供内容 / 作用                                               | 关键关系                                                     |
| ---------- | ---------------------- | --------------------------------------------------------------- | ------------------------------------------------------------ |
| parsing.ts | **纯工具函数库**       | 提供文件发现、JSONL 行读取、文本截断、内容类型提取、项目路径推导等无状态工具。 | 除 `node:fs/path/os` 外零依赖；被 `db.ts`、`indexer.ts` 和所有 Provider 适配器（`claude.ts`、`codex.ts`、`pi.ts`）引用。 |

7、Provider 适配器体系

| 文件                  | 定位                       | 提供内容 / 作用                                               | 关键关系                                                     |
| --------------------- | -------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------ |
| providers/types.ts    | **Transcript 类型体系**   | 定义 `Provider`、`ProviderAdapter`、`TranscriptRecord` 联合类型及全部 Record 接口。 | 被所有 Provider 文件、`persist.ts`、`session-detail.ts` 引用，是核心类型契约。 |
| providers/registry.ts | **Provider 注册表**       | 提供 `createProviderRegistry()`，管理多个 Provider 的发现与路由。 | 由 `builtins.ts` 创建；被 `indexer.ts`、`query.ts` 使用。     |
| providers/builtins.ts | **内置 Provider 组装工厂** | 将内置 Provider 组合成单一注册表。                            | 被 `indexer.ts` 在构建时、被 `query.ts` 在创建查询 API 时调用。 |
| providers/claude.ts   | **Claude Code 适配器**    | 发现 `~/.claude/projects/` 下的 JSONL；逐行解析并生成 `TranscriptRecord` 流。 | 依赖 `parsing.ts`，实现 `ProviderAdapter`；由注册表路由至索引流程。 |
| providers/codex.ts    | **Codex 适配器**          | 发现 `~/.codex/sessions/` 下的 JSONL；全量重解析并关联 `event_msg` / `response_item`。 | 依赖 `parsing.ts`，实现 `ProviderAdapter`；由注册表路由至索引流程。 |

### @trajex-apps/cli（CLI 包）

| 文件          | 定位                       | 提供内容 / 作用                                               | 关键关系                                                     |
| ------------- | -------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------ |
| src/trajex.ts | **CLI 入口**               | 解析命令行参数，执行 `--build`、`--search`、`--query`、`--attune` 等命令并输出结果。 | 直接 `import` `core.ts` 导出的 `buildIndex`、`searchText`、`executeQuery`、`executeAttune`、`DB_PATH`。 |

`package.json` 中的 `"bin": {"trajex": "dist/cli/src/trajex.js"}` 使其可通过 `trajex` 命令调用。

CLI 的 `main()` 是薄 transport，所有成功结构化输出写 stdout JSON，失败也编码为 `{error,stack}` 且 exitCode=1。`--version/-v` 从 package.json 读版本；`--build` 调 `buildIndex({force:true})` 并返回 DB path；`--search` 拼接余下词为 FTS 文本；`--query`/`--attune` 使用绝对化后的脚本文件内容分别交给 Core；无匹配参数则打印 usage。

`scripts/build.mjs` 是发布边界而非运行时逻辑：先可恢复地删除 CLI `dist`，用 workspace 的 TypeScript 编译 CLI build tsconfig；因为 TypeScript 不会复制 SQL，最后确保 `dist/core/src/schema.sql` 存在并复制源 schema。于是发布包中的 CLI 可直接 import 同包可读的编译 Core，避免把数据库 DDL 遗漏在 npm payload 外。

## CLI 入口核心调用链 `cli/src/trajex.ts`

安装 CLI 只是安装 `trajex` 命令：

```bash
npm install -g @trajex-apps/cli
```

真正索引发生在运行命令时：

```bash
trajex --build
trajex --search "auth bug"
trajex --query query.js
```

CLI 只做参数路由、脚本文件读取和 JSON 输出。它不拥有数据库连接、Provider 选择或检索逻辑。

| 用户动作                  | CLI 调用                               | 可观察结果                         |
| ------------------------- | -------------------------------------- | ---------------------------------- |
| `trajex --version` / `-v` | 读取 CLI 自身 `package.json`           | 纯文本版本；不访问数据库           |
| `trajex --build`          | core.ts `buildIndex({ force: true })`  | 强制重建会话派生数据，输出 DB 路径 |
| `trajex --search "text"`  | core.ts `searchText(text)`             | 刷新可用时的索引，再输出 FTS 命中  |
| `trajex --query file.js`  | core.ts `executeQuery(scriptContent)`  | 在只读 JS 沙箱执行，输出 return 值 |
| `trajex --attune file.js` | core.ts `executeAttune(scriptContent)` | 在 writer lease 内执行 memory 变更 |

CLI 每次查询前会调用 `buildIndex()`，这叫 **passive pull mode：没有后台常驻，运行时拉取更新**。

## build 索引主链路

| 阶段            | 目的                                        | 入口函数                                      |
| --------------- | ------------------------------------------- | --------------------------------------------- |
| 1. 命令入口     | 将 `--build` 定义为强制重建                 | `cli/src/trajex.ts` -> `main()`               |
| 2. 写入资格     | 礼让 daemon，并取得唯一 writer              | `indexer.ts`、`writer-lease.ts`               |
| 3. 初始化与清理 | 打开、迁移 DB；force 时清除旧派生事实       | `db.ts`、`tx.ts`、`write-coordinator.ts`      |
| 4. 计划         | 注册 Provider，发现本次需要处理的 units     | `builtins.ts`、`provider-indexing.ts`         |
| 5. 真正索引     | 每个 unit 原子地 parse -> persist           | Provider、`persist.ts`                        |
| 6. 最终化       | 补项目路径、重建 FTS、提交 marker、释放资源 | `indexer.ts`、`db.ts`、`provider-indexing.ts` |

### 阶段 1：命令入口与实现实体

```ts
async function main() {
  const args = process.argv.slice(2);
  if (args[0] === '--build') {
    try {
      buildIndex({ force: true });
      process.stdout.write(JSON.stringify({ ok: true, db: DB_PATH }) + '\n');
    } catch (error) { fail(error); }
    return;
  }
}
```

`cli/src/trajex.ts` 的 `main()` 识别 `--build`，调用从 `core/src/core.ts` 导入的 `buildIndex({ force: true })`。`core.ts` 不再包一层实现；它只是直接 re-export `packages/core/src/indexer.ts` 中的同名 `buildIndex()`。

因此，真正的总编排器是 `indexer.ts` 的 `buildIndex()`：它负责判断能否写、决定写什么、逐项提交、最后收尾。

### 阶段 2：先确认“谁有资格写”

```ts
indexer.ts / buildIndex()
  -> inspectBuildOwnership() + shouldSkipBuild()
    -> db.ts / openReadDb()
  -> writer-lease.ts / writerLockPathFor(DB_PATH)
  -> writer-lease.ts / acquireWriterLease({ openDb: openWriterLeaseDb })
    -> db.ts / openWriterLeaseDb()
  -> 再次 inspectBuildOwnership()
```

- `inspectBuildOwnership()` 与 `shouldSkipBuild()` 是索引前的所有权判定。若 DB 已存在，它们通过 `openReadDb()` 读取 heartbeat；app daemon 心跳新鲜时 CLI 停止写入。`force` 只忽略 30 秒的最近构建 debounce 防抖，不能抢占 daemon。

- `writerLockPathFor()` 计算主库旁的 `writer.lock.sqlite` 路径；`acquireWriterLease()` 在这里竞争跨进程唯一 writer，拿不到立即返回 `writer_busy`。

  ```ts
  // acquireWriterLease() 步骤：
  ① mkdirSync 确保锁目录存在
  ② startedAt = now() 记下开始时间
  ③ maxAttempts = waitMs > 0 ? ceil(waitMs/retryDelayMs)+1 : 1
     → waitMs=0 表示"只试一次，抢不到就算了"
  ④ 循环尝试：
      a. openDb(lockPath)     打开锁库连接
      b. PRAGMA busy_timeout=0   ← 关键：关掉 SQLite 自带的"排队等锁"
      c. BEGIN IMMEDIATE          ← 关键：这一步真正去抢写锁
      d. 抢到了 → 返回 { release() }   持有锁，事务悬着不提交
      e. 抢不到（抛 SQLITE_BUSY）→ close 连接，算一下预算还剩多少，
         预算没花完就 syncSleep 一下再试；花完就返回 null
  ```

- 随后第二次 `inspectBuildOwnership()` 关闭“第一次检查和拿锁之间 daemon 启动”的 TOCTOU 窗口。

### 阶段 3：打开真实数据库，并在 force 下清旧索引

```ts
indexer.ts / buildIndex()
  -> db.ts / openDb() + tx.ts / nodeSqliteTransactionAdapter(db)
  -> force ? write-coordinator.ts / runRetryableWriteTransaction()
      -> tx.ts / runWriteTransaction()
        -> BEGIN IMMEDIATE -> DELETE 派生表 -> COMMIT
```

* `openDb()` 创建/迁移真实 SQLite，加载 `schema.sql` 并配置 WAL；

* `nodeSqliteTransactionAdapter()` 将 node:sqlite 连接包装成共享事务接口（因为桌面端用的是另一个 SQLite 驱动 `better-sqlite3` 所以这里做适配）；

  ```ts
  const db = openDb();
  const txDb = nodeSqliteTransactionAdapter(db);
  ```

* 强制构建时，`runRetryableWriteTransaction()` 把清理包进可重试原子事务 `runWriteTransaction()`：删除 messages、tools、sessions 等 source-derived 事实，**但保留人工批准的 memories**，从而绝不留下“删除一半”的索引。

  ```ts
  runRetryableWriteTransaction(txDb, () => {
      db.prepare("DELETE FROM index_state WHERE jsonl_path != '__last_build__'").run();
      for (const table of ['messages', 'tool_calls', 'tool_results', 'sessions', 'summaries', 'subagents', 'workflows', 'workflow_agents']) {
        db.prepare(`DELETE FROM ${table}`).run();
      }
    }, { label: 'force-cleanup' });
  }
  ```

  ```ts
  /** 将统一事务原语放入上述幂等重试策略，是 indexer 每个写入阶段的入口。 */
  export function runRetryableWriteTransaction<T>(
    db: WriteTxDb,
    work: () => T, // 这里传入的是 force-cleanup 
    transactionOptions: WriteTxOptions = {},
    retryOptions: WriteRetryOptions = {},
  ): T {
    return runWithWriteRetry(
      () => runWriteTransaction(db, work, transactionOptions),
      retryOptions,
    );
  }
  ```

### 阶段 4：注册 Provider，再生成索引计划

```ts
indexer.ts / buildIndex()
  -> providers/builtins.ts / createBuiltinProviderRegistry()
  -> provider-indexing.ts / createProviderIndexPlan(db, registry)
    -> provider-indexing.ts / storedProviderCursor()
    -> claude.ts | codex.ts | pi.ts / provider.discover()
```

* `createBuiltinProviderRegistry()` 注册本次可用数据源：Claude、Codex、Pi 的 adapter、descriptor、默认根目录和 raw 回源能力。

* `createProviderIndexPlan()` 才将“已注册的数据源”变成实际待处理的 `IndexUnit[]`：
* 它先用 `storedProviderCursor()` 从 `index_state` 取回各 unit 的上次成功水位线；
  
* 再调用每个 Provider 的 `discover()` 扫描目录、比较 cursor/mtime/changed paths。marker 过期或 force 时，该 Provider 被标为 full replay，避免新旧投影规则混用。

### 阶段 5：逐 unit 真正开始解析和写入

```ts
provider-indexing.ts / indexProviderPlan()
  -> for each IndexUnit
    -> write-coordinator.ts / runRetryableWriteTransaction()
      -> tx.ts / runWriteTransaction()
        -> claude.ts | codex.ts | pi.ts / provider.parse(unit, cursor)
        -> persist.ts / persist(db, unit, generator)
          -> schema.sql：sessions/messages/tools/... 表
          -> index_state：写回新 cursor
```

`indexProviderPlan()` 是真正逐 unit 索引的起点。单个坏文件可以记录到 `skippedFiles` 并让其他 unit 继续；每个健康 unit 都将整段“解析 + 写入”放进一个 `runRetryableWriteTransaction()` 重试事务，而不是只重试最后一条 SQL，收集 committed/failed/stopped 的 `ProviderIndexItem[]`。

* Provider 的 `parse(unit, cursor)` 读取原始 JSONL，生成 provider 无关的 `TranscriptRecord` 流。
* `persist()` 消费该流，按 `kind` 做 upsert、字段合并或删除；它是事实写入 SQLite 的唯一共享入口。只有 generator 正常结束后才把新 cursor 写入 `index_state`，使其成为下一次增量发现的水位线。

### 阶段 6：统一最终化并释放 writer

```ts
indexer.ts / buildIndex()
  -> runRetryableWriteTransaction(finalize)
    -> indexer.ts / refreshSessionProjectPaths()
      -> parsing.ts / inferProjectPath()
    -> schema.sql：messages_fts rebuild
    -> db.ts / rebuildMemoryFts()
    -> provider-indexing.ts / writeProviderIndexMarkers() // 只写完全无失败且未 stopped 的 Provider marker，避免错误地宣布新投影已完成。
    -> index_state：写 __last_build__
  -> DatabaseSync.close() + writer-lease.ts / lease.release()
```

finalize 只在所有 unit 已提交或被明确跳过后运行；它失败会使 build 失败，不能被当成普通坏文件吞掉。

* `refreshSessionProjectPaths()` 聚合已写入的 `messages.cwd`，再由 `inferProjectPath()` 按出现频率和首次出现顺序选择可靠路径，必要时才回退 slug 反解。

  > **为什么不直接用文件名 slug？**
  >
  > 因为 slug 是压缩过的，逆转回去不一定正确，`projectSlugFromPath()` 把所有 / 替换成 - ：
  >
  > ```
  > /Users/a/My-Repo  →  -Users-a-My-Repo
  > ```
  >
  > 逆向 `legacyProjectPathFromSlug()` 把所有 - 换回 / ：
  >
  > ```
  > -Users-a-My-Repo  →  /Users/a/My/Repo   ❌
  > （原路径里 My-Repo 是一个目录，被拆成了两个）
  > ```

* 随后重建 messages 与 memories 的 FTS 倒排索引，写入成功 Provider 的版本 marker 和 `__last_build__` debounce 标记。
* 最后无论成功、跳过还是抛错，都会关闭 `DatabaseSync` 并 `lease.release()`，释放数据库连接与跨进程写锁。

## 一、Provider Adapter 与统一事实流的完整契约 `providers/types.ts`

`types.ts` 的作用是规定跨模块传递的数据形状。可以把它看成 Trajex 的“海关申报单”：Claude、Codex、Pi 各自带着不同的原始文件格式进来，但一旦越过 Provider 的解析边界，后面的索引和写库只消费这份统一申报单，不再判断原始 JSONL 是谁生成的。查询、CLI 与 Electron 主要消费 SQLite 投影；只有需要证据回源时，才经 `raw()` 回到 Provider。

```text
Provider 专有世界                         Provider 无关世界
────────────────────────────────────    ──────────────────────────────────────
claude.ts / codex.ts / pi.ts             provider-indexing.ts
目录、JSONL、SQLite、mtime、辅助文件       persist.ts / schema.sql / query.ts
    │                                      							    │
    └── types.ts：IndexUnit、Cursor、TranscriptRecord、ProviderAdapter ──┘
```

这条边界有两个方向：

- 向下，索引编排层把“上一次处理到哪里”和“本次应处理什么”交给 Provider；对应 `DiscoverContext`、`Cursor`、`IndexUnit`。
- 向上，Provider 只 `yield TranscriptRecord`，持久化层将其写入 SQLite，读取层只查询 SQLite 或在需要原文时调用统一的 `raw()` 回源接口。

因此本节应配合主线阅读：先了解一个 adapter 如何发现和解析，再看同一份 `TranscriptRecord` 怎样被 `persist.ts` 分派到各表，最后看 `query.ts`、CLI、Electron 如何消费写好的事实。

### Provider 接口：谁负责发现，谁负责解析

```ts
interface Provider {
  readonly name: string;
  discover(ctx: DiscoverContext): IndexUnit[];
  parse(unit: IndexUnit, cursor: Cursor): Generator<TranscriptRecord, Cursor>;
}
```

| 成员                  | 职责与边界                                                   |
| --------------------- | ------------------------------------------------------------ |
| `name`                | 稳定 provider 标签，如 `claude`、`codex`。adapter 应把它显式写入消息和 session 的 `source`；类型系统不会自动注入。它是数据身份，不应随 UI 文案变化。 |
| `discover(ctx)`       | 扫描自己的根目录/数据库/辅助文件，读取 `ctx.lastCursor()` 做变更判断，返回待处理 unit。它不应写 Trajex 主数据库。 |
| `parse(unit, cursor)` | 读取一个已发现 unit，从 cursor 继续或全量解析，将来源事件翻译为规范 record 流，最终 `return` 新 cursor。它不应直接调用 SQLite SQL。 |

这就是“Provider Adapter 解析不同格式”的精确定义：不是让三个解析器遵循相同文件格式，而是让它们都实现相同的发现、流式解析和回源能力。格式相关的目录结构、mtime 规则、原始 ID 生成、子线程发现和字段提取留在各 Provider；跨来源的一致写入留在 `persist.ts`。

### `parse()` 实际返回流式 Generator，不是一次性数组

主线图里常写成“Provider 统一 yield `TranscriptRecord[]`”，它表达的是“产出统一记录集合”，但 TypeScript 中的准确签名是流式 Generator：

```ts
parse(unit: IndexUnit, cursor: Cursor): Generator<TranscriptRecord, Cursor>
```

含义分成两半：

```text
provider.parse(unit, oldCursor)
  -> yield record 1：session / message / tool_call / ...
  -> yield record 2
  -> ...
  -> return newCursor
```

`persist.ts` 一边迭代 generator，一边将每条 record 写入当前 SQLite 事务；generator 正常结束后，它才取得 `return` 的 `newCursor` 并写进 `index_state`。这样一个超长 transcript 不必先在内存里堆成数组，并且“事实已写入”和“进度已经前移”位于同一个 unit 的原子事务内。

这里的“写进”有一项现状限制：`Cursor` 的类型是 `string | null`，但当前 `persist.ts` 会把非空值按 `mtime:lines` 拆成 `index_state.mtime` 和 `index_state.lines_processed`；`storedProviderCursor()` 再按同一格式拼回。因此存储层强制所有内置 adapter 的 cursor 外形都符合两个可转数字的冒号分隔字段。实际消费方式仍由 provider 决定：Claude 用 mtime 判断变化、用 lines 跳过已处理行；Codex 和 Pi 都是全量重放，只真正使用 mtime，lines 目前只是兼容字段和索引检查信息。当前实现尚不支持任意 provider 私有字符串或 rowid/时间戳编码。

### 索引调度契约：`Cursor`、`IndexUnit`、`DiscoverContext`

#### `Cursor`

```ts
type Cursor = string | null;
```

它在 `Provider` 接口上是进度水位；不过当前 Core 的存储实现仍把非空 cursor 解释为 `"mtime:lines"`，存入 `index_state` 的两个数值列并在下次拼回。也就是说，存储格式对所有 provider 都是统一的 `mtime:lines` 外形，但消费语义并不统一：Claude 用两部分做增量恢复，Codex/Pi 全量重放且只用 mtime，lines 只是兼容/检查字段。任意字符串 cursor、rowid 或纯时间戳目前不能正确持久化。

```text
index_state 的 key = unit.key
index_state 的 value = Cursor
       │
       ├─ Claude 使用 "mtime:已处理行数"，两者都参与增量恢复
       ├─ Codex 使用 "mtime:总行数"，实际只用 mtime，整文件重放
       ├─ Pi 使用 "mtime:总行数"，实际只用 mtime，整文件重放
       └─ 新 provider 也必须先适配该格式，或先扩展持久化协议
```

`null` 表示没有可恢复进度：初次索引、强制 replay，或 Provider 认为旧游标不再可靠时都会从这一状态开始。用 `string` 而不是一个共享结构仍保留了将来隔离 Provider cursor schema 的空间；要兑现这点，`index_state` 与 `persist()` 需先改为原样保存 cursor。

#### `IndexUnit`

一个 `IndexUnit` 是“本次索引最小的可提交工作单元”，并不等同于“一个 JSONL 文件”。JSONL Provider 可以用文件作为 unit；未来 SQLite/目录树 Provider 也可以用 `数据库路径#内部会话 ID` 作为 unit。`indexProviderPlan()` 对 unit 逐个开事务，意味着坏的一个文件可以被记录为 skipped，而不污染其他 unit。

| 字段                   | 含义与去向                                                   |
| ---------------------- | ------------------------------------------------------------ |
| `key: string`          | unit 的稳定身份，也是 `index_state` 查询/写回 cursor 的 key。它必须在同一来源下稳定；路径、内部 ID 或二者组合都可以。 |
| `sessionId: string`    | 这个 unit 归属的规范化 session ID。它由 Provider 在 `parse()` 中用于生成 `SessionRecord`、`MessageRecord` 等关联键。 |
| `project?: string`     | 来源已经能识别出的项目 slug。可缺失；真正的 `sessions.project_path` 不由它直接决定，而是在所有消息写完后用 `cwd` 全局推断。 |
| `isSubagent?: boolean` | 表示此 unit 是子 Agent transcript，而非主线会话。它指导解析器关联 agent，而不是把它当作独立顶层会话。 |
| `agentId?: string`     | 子 Agent 的规范 ID。`isSubagent` 是布尔语义，`agentId` 是可关联的具体身份；解析出的 `messages.agent_id` 与 `subagents.agent_id` 用它相连。 |
| `meta?: unknown`       | Provider 私有负载，例如扫描时已取得的辅助路径、线程 metadata 或解析提示。编排层绝不读取或序列化解释它，只把原对象传给 `parse()`。 |

这里 `meta` 是 `unknown` 而不是 `any`：Provider 在自己的实现中必须先收窄类型；共享层无法偶然依赖某个 Provider 的私有结构。

#### `DiscoverContext`

这是 `provider.discover(ctx)` 获得的唯一共享上下文：

| 成员                      | 含义                                                         |
| ------------------------- | ------------------------------------------------------------ |
| `lastCursor(key)`         | 读取某个候选 unit 上次成功提交的 cursor。当前内置 Provider 用它比较 mtime 决定是否变化；Claude 另外用已处理行数增量恢复，Codex/Pi 则忽略行数并全量 replay。 |
| `changedPaths?: string[]` | Electron daemon 监听到文件变化时提供的路径缩小范围。它是优化提示，不是事实来源；Provider 仍要保证漏传或没有它时的完整 discover 正确。 |

所以发现阶段不是“索引”。`discover()` 只回答“有哪些 unit 值得处理”；真正读取原始内容从 `parse()` 开始，真正改变数据库从 `persist()` 开始。

### `TranscriptRecord`：十种规范事实/操作

```ts
type TranscriptRecord =
  | SessionRecord | MessageRecord | ToolCallRecord | ToolResultRecord
  | SummaryRecord | SubagentRecord | WorkflowRecord | WorkflowAgentRecord
  | MessageTurnDurationRecord | DeleteSessionRecord;
```

前八种主要是事实投影；最后两种是对既有事实做定点更新或撤回的操作。以下“表”指 `schema.sql` 中的持久化目标；所有记录都会在 `persist.ts` 的同一事务内被消费。

**1、`SessionRecord` -> `sessions`**

`SessionRecord` 是一次会话的聚合行，通常在一个 unit 的消息流已扫描完后发出，因为开始/结束时间和 message count 往往要跨整份 transcript 才能确定。

| 字段                      | 含义                                                         |
| ------------------------- | ------------------------------------------------------------ |
| `kind: 'session'`         | 联合类型的分派标记。                                         |
| `id`                      | 规范 session 主键；其他记录的 `session_id` 必须指向它。Claude 常用原 session ID，Codex 会使用带 `codex:` 前缀的规范 ID。 |
| `title`                   | 会话标题；可来自主 transcript 或 provider 辅助索引。`null` 表示来源没有可靠标题。 |
| `project`                 | 项目 slug，用于筛选/分组；不是实际磁盘路径。                 |
| `started_at` / `ended_at` | 会话开始和最后活动时间；允许 `null`，因为部分来源不完整。    |
| `git_branch`              | 当时的 Git 分支；没有就为 `null`。                           |
| `version`                 | 产生记录的 Agent CLI/应用版本。                              |
| `message_count`           | 当前 unit 此次提供的主线消息计数，具体合并方式由 `countMode` 决定。 |
| `countMode`               | `'delta'` 表示本次只有新增消息、持久化时累加；`'total'` 表示本次给出完整数量、持久化时覆盖。Claude 增量解析通常用 delta，Codex 全量线程解析通常用 total；空 cursor 下的 delta 等价于 total。 |
| `jsonl_path`              | 此 session 的主要原始 transcript 路径，用于证据定位/回源；它不是工具使用的文件路径。 |
| `source`                  | Provider 名称，例如 `claude`、`codex`、`pi`，由 adapter 显式写入 `sessions.source`。 |

`project_path` 不在该接口中。`indexer.ts` 的 `refreshSessionProjectPaths()` 会在所有 unit 写完后，从持久化的 `messages.cwd` 统计并调用 `inferProjectPath()` 推断它。这避免 Provider 在各自局部视角中做不一致的路径猜测。

2、**`MessageRecord` -> `messages`，并由触发器同步 `messages_fts`**

`MessageRecord` 是整个模型最核心的事实。`MessageVisibility` 的取值只允许 `'visible' | 'inactive' | 'hidden'`：可见性是在 Provider 解析时规范化的，展示层不会靠文本内容或 provider 分支标记再次猜测当前上下文。

| 字段                             | 含义                                                         |
| -------------------------------- | ------------------------------------------------------------ |
| `kind: 'message'`                | 分派标记。                                                   |
| `uuid`                           | 消息主键。Claude 通常复用原 uuid；没有天然 uuid 的来源可稳定地构造，例如 `codex:<thread>:<line>`。 |
| `session_id`                     | 所属 session，关联 `sessions.id`。                           |
| `type`                           | 来源消息类别原样/规范化后的分类，如 user、assistant。        |
| `parent_uuid`                    | 父消息 ID；`null` 表示根节点。`query.trace()` 和 context 会用它回溯对话链。 |
| `timestamp`                      | 消息时间；可为 `null`。                                      |
| `role`                           | 对话角色，如 user、assistant、developer；可为 `null`。       |
| `text`                           | 可检索、可展示的文本投影；可能截断、可能为 `null`。原始完整内容应通过 `raw()` 回源。 |
| `content_type`                   | 内容性质，如 text、thinking、tool_use、tool_result、skill_instructions、unknown。它帮助详情层决定怎样组合/渲染。 |
| `is_meta`                        | `0 | 1`，系统自动插入、命令包装、环境提示、skill 指令等“元消息”。整数而非 boolean 是 SQLite 友好表示。 |
| `visibility`                     | `visible` / `inactive` / `hidden`；inactive 是保留但不在当前上下文的分支证据，hidden 是来源明确抑制展示的内容；二者默认展示都会排除。 |
| `model`                          | 模型名称；来源未报告时为 `null`。                            |
| `agent_id`                       | 所属子 Agent ID；主线消息为 `null`。关联 `subagents.agent_id` 或 workflow agent 身份。 |
| `input_tokens` / `output_tokens` | 归一化 token 用量；输入包含 Provider 报告的缓存输入。没有可靠数字时为 `null`，不能伪造 0。 |
| `cwd`                            | 消息产生时的工作目录，是最终推断 `sessions.project_path` 的主要证据。 |
| `skill`                          | Claude attribution skill 等 skill 来源；普通消息为 `null`。  |
| `source`                         | 来源标签，支持按 provider 筛选、展示图标和回源；adapter 应与自己的 `Provider.name` 保持一致。 |

`messages` 写入、更新、删除会触发 `messages_fts` 同步。FTS 保存的是全文检索倒排索引；`query.search()` 用它找候选消息，再 join 回普通表取 session、时间和上下文，不能把 FTS 虚表当作权威消息存储。

3、**`ToolCallRecord` -> `tool_calls`**

一条 assistant 消息可以发起零到多次工具调用：

| 字段                | 含义                                                         |
| ------------------- | ------------------------------------------------------------ |
| `kind: 'tool_call'` | 分派标记。                                                   |
| `id`                | 工具调用主键，也是结果和 subagent/workflow 父引用使用的 ID。 |
| `message_uuid`      | 发起调用的 assistant 消息，关联 `messages.uuid`。            |
| `session_id`        | 冗余保存的 session 外键，便于按会话检索而不用每次 join。     |
| `name`              | 工具名，如 Read、Edit、Bash、Agent、Workflow、shell。        |
| `input_json`        | 工具输入的 JSON 字符串；保留字符串可避免 Provider 之间参数形状被强行统一。 |
| `file_path`         | 能从调用参数识别出的目标文件路径。`query.fileHistory()` 正是从 `tool_calls.file_path` 查文件历史。 |

4、**`ToolResultRecord` -> `tool_results`**

| 字段                  | 含义                                                         |
| --------------------- | ------------------------------------------------------------ |
| `kind: 'tool_result'` | 分派标记。                                                   |
| `tool_use_id`         | 对应的工具调用，关联 `tool_calls.id`。                       |
| `message_uuid`        | 承载结果的消息，常是 Claude 的 user/tool-result 消息，也可能是其他 Provider 关联出的消息。 |
| `session_id`          | 所属会话。                                                   |
| `content`             | 工具返回文本；可能由索引策略截断。                           |
| `file_path`           | 结果关联的文件路径；可为空。                                 |
| `is_error`            | `0 | 1` 错误标记。`query.failures()` 会结合它与 shell 退出信息定位失败。 |

关系是 `messages -> tool_calls -> tool_results`，但结果在 transcript 中可晚于调用出现，所以 Provider 只需按原始顺序 yield；`persist` 负责以 ID 建立可查询事实。

5、**`SummaryRecord` -> `summaries`**

| 字段              | 含义                                                         |
| ----------------- | ------------------------------------------------------------ |
| `kind: 'summary'` | 分派标记。                                                   |
| `id`              | 摘要主键，不同 Provider 的来源不同，Codex 的 id 为 `"codex:<thread-id>:<line-number>"`。 |
| `session_id`      | 所属会话。                                                   |
| `timestamp`       | 摘要时间，可为空。                                           |
| `source`          | 摘要来源标签。由 adapter 写入；Claude/Codex 通常写 provider 名，Pi 可能写具体 entry type。schema 允许来源标签比 provider 更细。 |
| `content`         | 摘要正文。                                                   |

`query.summaries()` 读取这张表。它保存的是来源已经产生的摘要，不等同于用户批准的长期 memory。

6、**`SubagentRecord` -> `subagents`**

| 字段                  | 含义                                                        |
| --------------------- | ----------------------------------------------------------- |
| `kind: 'subagent'`    | 分派标记。                                                  |
| `agent_id`            | 子 Agent 主键，同时匹配该子线程消息的 `messages.agent_id`。 |
| `session_id`          | 所挂靠的父会话。                                            |
| `parent_tool_use_id?` | 启动子 Agent 的工具调用 ID；未知时省略或 `null`。           |
| `agent_type?`         | 类型，如 reviewer、general-purpose。                        |
| `description?`        | 任务描述或昵称。                                            |
| `duration_ms?`        | 运行时长。                                                  |
| `total_tokens?`       | 子 Agent 总 token。                                         |

问号表示调用方可不提供该属性，`| null` 表示提供但来源明确为空；两者最终都允许写成 SQL NULL。之所以宽松，是因为 spawn 事件和子线程自身文件可能分别贡献不同字段。`persist` 对这类上游分段事实按列合并，不用后到的空值覆盖先到的已知值。

`subagents` 不是子 Agent 的对话正文。正文仍在 `messages`，并以 `messages.agent_id = subagents.agent_id` 表示归属。

7、**`WorkflowRecord` -> `workflows`**

| 字段                           | 含义                                                         |
| ------------------------------ | ------------------------------------------------------------ |
| `kind: 'workflow'`             | 分派标记。                                                   |
| `run_id`                       | 一次 workflow run 的主键。                                   |
| `session_id`                   | 所属会话。                                                   |
| `parent_tool_use_id?`          | 发起 Workflow 工具调用的 ID。                                |
| `task_id`                      | 来源中的任务 ID。                                            |
| `script`                       | workflow 脚本内容。                                          |
| `result_json`                  | 结果 JSON 原文。                                             |
| `timestamp`                    | run 时间。                                                   |
| `agent_count`                  | Provider 报告的 agent 数量，持久化层直接写入该值；当前不会根据 `workflow_agents` 重新计算。 |
| `duration_ms` / `total_tokens` | 总耗时、总 token；未知为 `null`。                            |
| `status`                       | 如 running、completed、failed。                              |
| `workflow_name`                | workflow 名称；可为空。                                      |

8、**`WorkflowAgentRecord` -> `workflow_agents`**

它是 workflow 内的成员明细，不是 `subagents` 的子表。两者都描述 Agent，但关联维度不同：`subagents` 描述由会话工具启动的子线程；`workflow_agents` 描述某个 `run_id` 内的执行成员。

公共键是 `agent_id`、`run_id`、`session_id`；其余字段都可选/可空：

| 字段                                    | 含义                                          |
| --------------------------------------- | --------------------------------------------- |
| `agent_type` / `description`            | agent 类型和任务说明，常来自子代理 metadata。 |
| `phase` / `label`                       | workflow 内阶段和展示标签。                   |
| `model`                                 | 此 workflow agent 所用模型。                  |
| `state`                                 | 执行状态。                                    |
| `duration_ms` / `tokens` / `tool_calls` | 该成员的耗时、token、工具调用次数。           |

同一 row 可能由两个独立 unit、且以任意顺序产出：子代理 `.meta.json` 只知道类型/描述，workflow run JSON 只知道阶段、状态和统计。`persist` 的冲突更新使用逐列 `COALESCE(excluded.col, col)` 合并，因此所有贡献者必须生成相同的 `agent_id`，否则会变成两条不完整记录。

9、**`MessageTurnDurationRecord` -> 定向更新 `messages.turn_duration_ms`**

```ts
{ kind: 'message-turn-duration', uuid, turn_duration_ms }
```

它不是一张独立表，而是补写一条已经存在的消息的 assistant turn 耗时。来源可能在后续事件/文件中才透露该时长，所以 Provider 不必重写完整 `MessageRecord`；`persist` 按 `uuid` 做定向 `UPDATE`，只影响 `turn_duration_ms`，不触碰消息其余列。

10、**`DeleteSessionRecord` -> 删除该会话的派生事实**

```ts
{ kind: 'delete-session', sessionId }
```

同样不是表行。Pi 和 Codex 根 thread 都在全量重放前发出它，先移除旧投影，再写入当前完整 session；Codex 不再把它作为 guardian / auto-review 的特殊撤回协议。child/fork/guardian 在发现阶段直接忽略，因此不会进入 `parse`，也不会产生 `delete-session`。`persist` 会删除该 session 的 session、消息、工具、workflow、subagent 和全部摘要，但保留 `memories`；其他 session 或未关联 session 的记忆也不会受影响。

### 描述、监视、原文回源：`ProviderDescriptor`、`RawLookup`、`RawRecord`、`ProviderAdapter`

#### `ProviderDescriptor`

```ts
interface ProviderDescriptor {
  readonly id: string;
  readonly name: string;
  readonly vendor: string;
  readonly defaultRoot: string;
  readonly color: string;
}
```

它是给 registry、设置页和 renderer 使用的序列化展示元数据，而不是索引记录：

| 字段          | 含义                                                         |
| ------------- | ------------------------------------------------------------ |
| `id`          | 稳定机器 ID，用 registry 查找、配置 `providerRoots` 和版本 marker。 |
| `name`        | 面向用户的名称，例如 Claude/Codex/Pi。                       |
| `vendor`      | 厂商名称，用于设置与 UI 分组。                               |
| `defaultRoot` | 默认数据根目录。用户可覆盖它；它不是已发现的具体 session 路径。 |
| `color`       | UI 的来源颜色提示。它不参与 SQL 或解析语义。                 |

所有属性都是 `readonly`：Consumer 只能读取 descriptor，不能在运行时把 Provider 的身份或默认目录改坏。

#### `RawLookup`：读已索引行后如何回到来源

数据库的 `messages.text` 是查询/展示投影，可能截断；当详情页要展开原始 JSONL 行时，`query.raw()` 经 registry 调用对应 adapter 的 `raw(input)`。传入值为：

| 字段             | 含义                                                         |
| ---------------- | ------------------------------------------------------------ |
| `source`         | 应选择哪个 ProviderAdapter；通常来自已查询 message/session 的 source。 |
| `messageUuid`    | 要取的规范消息 ID。Provider 用它定位原始事件/行。            |
| `session`        | 已查出的 session 行，或 `null`；其中的 `jsonl_path`、项目等帮助 Provider 定位来源。用 `Record<string, unknown>` 防止类型层绑定某个 SQLite binding 的 Row 类型。 |
| `agentId`        | 子 Agent 身份；主线消息为 `null`。可帮助 Provider 选择 child transcript。 |
| `subagent?`      | 已查出的子代理行；没有子代理上下文时省略或 `null`。          |
| `workflowAgent?` | 已查出的 workflow agent 行；没有 workflow 上下文时省略或 `null`。 |

这些辅助行不是绕开 SQLite 的捷径，而是让 Provider 无需重新猜测 session 与子线程关系。`readonly` 也表明 `raw()` 只能读取来源，不应修改上游或数据库。

#### `RawRecord`：原文回源响应

| 字段           | 含义                                                         |
| -------------- | ------------------------------------------------------------ |
| `text`         | 本次请求应展示的文本片段。必填，即使为空也以空字符串表达。   |
| `totalLength?` | 完整文本总长度；当前内置 adapter 返回整行时等于 `text.length`。 |
| `offset?`      | 此片段在完整文本中的起始位置；当前内置 adapter 固定为 `0`。  |
| `limit?`       | 本次返回长度；当前内置 adapter 固定为整行长度。              |
| `hasMore?`     | 后面是否还有内容；当前内置 adapter 固定为 `false`。          |
| `messageText?` | Provider 投影的完整消息体，可为 `null`；用于展示完整解析消息，不一定等于原始行的 `text`。 |

这些字段为分页响应预留了形状，但 `RawLookup` 尚无 `offset` / `limit` 请求参数，Claude、Codex、Pi 的当前实现也都读取并返回完整 JSONL 行；因此它现在不是可协商的分页协议。若原始行长度成为问题，应先给 `RawLookup` 加请求范围，再让 adapter 按范围返回并设置这四个字段。

#### `ProviderAdapter`：完整可注册对象

```ts
interface ProviderAdapter extends Provider {
  readonly descriptor: ProviderDescriptor;
  readonly indexVersionMarker?: string;
  watchRoots(configuredRoot: string): string[];
  raw(input: RawLookup): RawRecord | null;
}
```

它在 `Provider` 的索引能力之外，补齐产品运行时需要的能力：

| 成员                         | 用途                                                         |
| ---------------------------- | ------------------------------------------------------------ |
| `descriptor`                 | 让 `providers/builtins.ts` / registry 将 adapter 暴露给设置页、CLI/App 配置和 UI。 |
| `indexVersionMarker?`        | Provider 的投影规则版本。它本身是 `index_state` 中的特殊 key；换成新字符串会使新 key 缺失。若库中已有任一 provider 的旧 projection，`createProviderIndexPlan()` 会安排全库 canonical rebuild，全部 unit 成功后才写入待定 markers。可选是为了兼容尚未定义版本语义的 adapter。 |
| `watchRoots(configuredRoot)` | 根据用户配置根目录给 Electron watcher 返回实际需要监听的目录；一个 Provider 可监听主 transcript、history、session index 等多个根。 |
| `raw(input)`                 | 根据规范 lookup 回读原始消息。找不到、来源不支持或已删除时返回 `null`，而不是抛出“数据库记录必然存在原文”的错误。 |

`ProviderAdapter` 因而是 registry 真正接受的完整适配器；`Provider` 则是索引编排只需要的最小子集。前者不要求 `persist` 知道 UI，后者也不要求每个索引调用方依赖 Electron watcher。



## 二、Provider Adapter 适配器：Provider 原始条目 -> `TranscriptRecord` 映射

Provider adapter 是 Trajex 的适配层。**每个 provider 自己负责理解自己的日志格式，翻译成统一 TranscriptRecord**：

| 维度           | Claude                                | Codex                                     | Pi                                      |
| -------------- | ------------------------------------- | ----------------------------------------- | --------------------------------------- |
| 默认根         | `~/.claude`                           | `~/.codex`                                | `~/.pi/agent/sessions`                  |
| 索引单位       | 主/子代理 JSONL 与 workflow JSON      | 一个 rollout JSONL                        | 一个 v3 session JSONL                   |
| cursor/策略    | mtime + 已处理行；流式逐行            | mtime 判断变化；全文件重放，lines 仅记录 | mtime 判断变化；全文件重放，lines 仅记录 |
| 必须全量的原因 | 不需要；仅续读新增行                  | event_msg 与 response_item 双向去重       | 树状分支与 compaction 需要重算可见上下文 |
| 特殊关系       | history 标题、Workflow、subagent meta | root-thread 筛选、父/子 thread、collab spawn | durable leaf、branch、compaction、hidden/inactive |
| raw 定位       | session/subagent JSONL 内 UUID        | `codex:<thread>:<line>`                   | `pi:<session-scope>:<entry>`            |

它负责：

  - 负责找到变化了的来源单元：`discover()` 按 Provider 自己的目录结构发现 JSONL/JSON 文件，通过比较文件当前 `mtime` 和 `index_state` 中保存的上次 cursor 判断是否需要处理；例如 Codex 扫描 `~/.codex/sessions`，Pi 扫描配置的 session directory。

    > cursor 是每个 transcript 文件的索引进度记录，用来判断文件是否变化，以及在支持增量解析的 provider 中知道从哪一行继续处理。
    >
    > * Claude 是 line-incremental，所以 Claude cursor 里的 `linesProcessed` 会被用来跳过旧行。
    >
    > * Codex 是 full-reparse，所以对 Codex：
    >
    >   ```
    >   mtime 用来判断文件有没有变
    >   linesProcessed 更多是记录文件当前总行数
    >   ```

  - 负责解析文件内容：`parse()` 读取某个 JSONL，把它翻译成 TranscriptRecord

  - 负责回查原文：`raw()` 根据 SQLite message uuid 找回原始 JSONL 行

  - 负责告诉 app 监听哪里：`watchRoots()` 告诉 app daemon 应该监听哪些目录

### Claude Code：主会话、子会话与 Workflow 的 JSONL/JSON 映射 `claude.ts`

> [Claude Code JSONL 格式参考文档](./claude-code-jsonl.md)

#### 增量发现 `discoverAt()`

调用 `parsing.ts` 中的 `discoverJsonlFiles(projectsDir)` 在指定根目录下枚举 Claude 主会话、subagent 与 workflow-agent JSONL 的文件级元数据，转换成 Core 统一的 `IndexUnit[]`：

```txt
主 Agent JSONL Unit
普通子 Agent JSONL Unit
Workflow 子 Agent JSONL Unit
Workflow JSON Unit（Workflow JSON 由 discoverAt() 自己发现）
```

```ts
[
  {
    key: 'session-001.jsonl',
    sessionId: 'session-001',
    isSubagent: false
  },
  {
    key: 'subagents/agent-a0f.jsonl',
    sessionId: 'session-001',
    isSubagent: true,
    agentId: 'agent-a0f'
  },
  {
    key: 'subagents/workflows/wf-001/agent-b123.jsonl',
    sessionId: 'session-001',
    isSubagent: true,
    agentId: 'agent-b123',
    meta: {
      workflowRunId: 'wf-001'
    }
  },
  {
    key: 'workflows/wf-001.json',
    sessionId: 'session-001',
    meta: {
      kind: 'workflow',
      mainTranscriptPath: 'session-001.jsonl'
    }
  }
]
```

普通主会话与 subagent JSONL 的 cursor 形状为 `mtimeMs:linesProcessed`。发现阶段先比较文件 mtime；解析阶段再用 `linesProcessed` 跳过已消费行，只处理新增尾部。

文件监听提供 `changedPaths` 时，`discoverAt()` 会只安排受影响的 unit（由 Electron daemon 通过 chokidar 传入，属优化提示）：

* `.jsonl` 变更：只重排该 transcript；
* 同名 `.meta.json` 变更：强制重排对应 `.jsonl`（即使 JSONL 自身 mtime 未变），使 agent 元数据能重新落库；

* workflow `.json` 变更：重排该 workflow；主会话 JSONL 变更时也会重排该 session 的 workflow JSON，以重新确认 parent_tool_use_id。

changedPaths 未提供时不做过滤，全量发现。

workflow JSON 的 cursor 恒为 `mtimeMs:1`：它每次作为完整 JSON 对象整体解析，

#### JSON/JSONL → Record 转换 `parse()`

Claude Code 当前按项目目录组织数据：

```
~/.claude/projects/<project-slug>/
        ├── <session-uuid>.jsonl				 ← 主会话转录
        └── <session-uuid>/						 ← 仅有子 agent/spawn 时才存在
            ├── subagents/
            │   ├── <agent-id>.jsonl             ← 子 agent 完整转录（格式=主jsonl）
            │   ├── <agent-id>.meta.json		 ← 子 agent 元数据（agentType, description...）
            │   └── workflows/
            │       └── <run-id>/
            │           ├── <agent-id>.jsonl	 ← workflow 内每个 agent 的对话
            │           └── <agent-id>.meta.json ← {"agentType":"workflow-subagent",...}
            └── workflows/
                └── <run-id>.json		 ← workflow run 元数据
```

Trajex 不从 JSONL 行的 `sessionId` 决定归属，而是从**文件路径**生成 `IndexUnit`：

```
主文件                 → session_id = 文件名
子代理文件             → session_id = 父目录名；agent_id = 文件名
workflow 子代理文件    → session_id = 父目录名；agent_id = 文件名；run_id = workflow 目录名
```

产出：

```json
主会话 <session-id>.jsonl
├── user / assistant
│   └── message
├── assistant.content.tool_use
│   └── message、tool_call
├── user.content.tool_result
│   └── message、tool_result
├── user.isCompactSummary
│   └── summary
├── system.turn_duration
│   └── message-turn-duration
├── ai-title
│   └── 修改 session.title
└── 文件扫描结束
    └── session

普通子会话 <agent-id>.jsonl
├── user / assistant
│   └── message（挂父 session，带 agent_id）
├── tool_use
│   └── tool_call
├── tool_result
│   └── tool_result
├── ... 
└── <agent-id>.meta.json
    └── subagent

workflow <run-id>.json
├── workflow 根对象
│   └── workflow
└── workflowProgress[].type=workflow_agent
    └── workflow_agent

workflow 子会话 <agent-id>.jsonl
└── <agent-id>.meta.json
    └── workflow_agent
```

需要解析时，`parse()` 会读取完整文件但跳过 cursor 已消费的行，只为新增行产出 record，最后消费的行号作为新 cursor 返回。主会话首次完整解析的 `session.countMode` 为 `total`，增量续读时为 `delta`。workflow JSON 走的是 `parseWorkflow()`，不适用行数 skip 逻辑（JSON 文件 cursor 恒为 `mtime:1`，全量重读）。

1、**user / assistant 消息行**

```json
{"type":"user"|"assistant","uuid":"…","parentUuid":"…","timestamp":"…","message":{"role":"…","content":"…"|[…]}}
```

```json
{
  "type": "user",
  "uuid": "msg-001",
  "parentUuid": null,
  "timestamp": "2026-07-31T10:00:00.000Z",
  "cwd": "/Users/me/project",
  "version": "1.0.0",
  "message": {
    "role": "user",
    "content": [
      {
        "type": "text",
        "text": "请解释这个问题"
      }
    ]
  }
}
```

```json
{
  "type": "assistant",
  "uuid": "msg-002",
  "parentUuid": "msg-001",
  "timestamp": "2026-07-31T10:00:05.000Z",
  "message": {
    "role": "assistant",
    "model": "claude-sonnet",
    "content": [
      {
        "type": "text",
        "text": "问题出在这里……"
      }
    ],
    "usage": {
      "input_tokens": 100,
      "output_tokens": 200
    }
  }
}
```

产出：一条 user/assistant JSONL 行产出一条 `message` record。

```ts
{
  kind: "message",
  uuid: obj.uuid,
  session_id: sessionId,
  type: obj.type,
  parent_uuid: obj.parentUuid || null,
  timestamp: obj.timestamp || null,
  role: obj.message.role || obj.type,
  text: extractText(obj.message.content),
  content_type: extractContentType(obj.message.content),
  is_meta: 0 | 1,
  visibility: "visible",
  model: obj.message.model || null,
  agent_id: null,
  input_tokens: ...,
  output_tokens: ...,
  cwd: obj.cwd || null,
  skill: obj.attributionSkill || null,
  source: "claude"
}
```

* 保留 `uuid`、`parent_uuid`、`type`、`timestamp` 时间、`role` 角色、`text` 文本 、`cwd`、`model`、`token` 和 `skill`；

  > 主会话 unit 通常没有 `agent_id`；若原始行顶层带有 `obj.agentId`，代码会原样保留该值，而不是强制改为 `null`。子代理 unit 则始终优先使用文件路径推导出的 `unit.agentId`。

* `message.is_meta` 是系统自动插入、命令包装、环境提示、skill 指令等“元消息”的标记；

  ```ts
  const isMeta = extractMessageIsMeta(obj, text); // parsing.ts 提供的工具函数
  ```

  判断 `is_meta = 1` 的规则有三种：

  （1）顶层显式标记

  ```json
  {
    "isMeta": true,
    "type": "user",
    "message": {
      "content": "..."
    }
  }
  ```

  （2）`message` 对象显式标记

  ```json
  {
    "type": "user",
    "message": {
      "isMeta": true,
      "content": "..."
    }
  }
  ```

  （3）文本匹配特殊 envelope

  ```txt
  <command-name>...</command-name>
  <task-notification>...</task-notification>
  <system-reminder>...</system-reminder>
  <local-command>...</local-command>
  ```

* `message.content` 的内容类型 `type` 决定 `content_type`；

  * 调用 parsing.ts 的 `extractContentType()` 得到 `"text"`/`"thinking"`/`"tool_use"`/`"tool_result"`/`"unknown"` 作为 `rawContentType`（有多种 type 就设置为 `"unknown"`）；

  * 还可能是 `"skill_instructions"`，条件是 `isMeta=1` 且 text 长得像 `Base directory for this skill: /tmp/skill`：

    ```ts
    const contentType =
      isMeta && isSkillInstructions(text)
        ? "skill_instructions"
        : rawContentType;
    ```

    因此，系统插入的 skill 内容消息可能变成：

    ```ts
    {
      kind: "message",
      text: "Base directory for this skill: ...",
      content_type: "skill_instructions",
      is_meta: 1,
      ...
    }
    ```

    这表示：这是 skill 的指令内容，不是普通用户问题。

* Claude 的 message 均为 `visibility: 'visible'`，即使被识别为 meta/skill instruction；

* skill 字段对应原 JSON 对象中的 `attributionSkill` 字段，表示该消息是 Skill 触发的

* **Thinking 内容如何解析**

  `claude.ts` 不在本文件中单独判断 `content[].type === "thinking"`，而是复用 `parsing.ts` 的两个共享函数：

  ```ts
  const text = extractText(obj.message.content);
  const content_type = extractContentType(obj.message.content);
  ```

  它们会遍历 `message.content`：`{ type: "thinking", thinking: "…" }` 的 `thinking` 文本进入 `messages.text`；当该数组所有内容块都是 `thinking` 时，`messages.content_type` 为 `thinking`。例如：

  ```json
  {
    "type": "assistant",
    "message": {
      "content": [{ "type": "thinking", "thinking": "先分析一下…" }]
    }
  }
  ```

  会产出 `text: "先分析一下…", content_type: "thinking"`。详情组装层会将连续的纯 thinking 消息合并到后续 assistant 消息的 `_thinking`，无后续消息可附着时才显示独立 Thinking 卡片。

  若同一条消息混合 `text`、`thinking` 或工具块，`extractText()` 会拼接可读 `text`、`thinking` 文本，但 `extractContentType()` 会保守地标为 `unknown`，不会再单独拆出 thinking。


2、**assistant 消息行 `message.content[]` 中 `{type:"tool_use",id,name,input}`**

message 是承载 Claude 工具调用的锚点，Claude 的工具调用不是单独的顶层 JSONL 类型，而是嵌在 assistant 的 `message.content` 中的 `{type:"tool_use",id,name,input}`。并且一个 assistant 行可以产生多个 tool call，`message.content` 不一定只有一个 block。

```json
{
  "type": "assistant",
  "message": {
    "content": [
      {
        "type": "text",
        "text": "我先读取两个文件"
      },
      {
        "type": "tool_use",
        "id": "toolu_read_1",
        "name": "Read",
        "input": {
          "file_path": "/tmp/a.ts"
        }
      },
      {
        "type": "tool_use",
        "id": "toolu_read_2",
        "name": "Read",
        "input": {
          "file_path": "/tmp/b.ts"
        }
      }
    ]
  }
}
```

产出：一条 assistant `message`，以及与 `message.content` 中 `tool_use` block 数量相同的 `tool_call` records。若同一行混有 `text`/`thinking` 和 `tool_use`，该 message 的 `content_type` 为 `unknown`；只有单一 `tool_use` 类型时才是 `tool_use`。

```ts
{
  kind: "tool_call",
  id: "toolu_read", // 工具调用的稳定关联键
  name: "Read", // 调用了什么工具
  input_json: "{...}", // JSON 参数投影；超长字符串会按索引长度上限截断
  file_path: "/tmp/b.ts" // 常见文件工具的标准化快捷字段
}
{
  kind: "tool_call",
  id: "toolu_bash", 
  name: "Bash", 
  input_json: "{...}", 
  file_path: null 
}
```

当前代码只对结构明确的工具提取 `file_path`：Read、Edit、Write、NotebookEdit。

3、**user 消息行 `message.content[]` 中 `{type:"tool_result",tool_use_id,content,is_error}`**

```json
{
  "type": "user",
  "uuid": "msg-004",
  "message": {
    "role": "user",
    "content": [
      {
        "type": "tool_result",
        "tool_use_id": "tool-001",
        "content": "文件内容……",
        "is_error": false
      }
    ]
  },
  "toolUseResult": {
    "filePath": "/Users/me/project/src/app.ts"
  }
}
```

产出：`content_type: "tool_result"` 的 user `message`、`tool_result` 两类记录。

```ts
{
  kind: "tool_result",
  tool_use_id: "tool-001",
  message_uuid: "msg-004",
  session_id: sessionId,
  content: "文件内容……",
  file_path: "/Users/me/project/src/app.ts",
  is_error: 0
}
```

> 总结一下，**一次完整的工具调用**会产出 `content_type: "tool_use"/"unknown"` 的 assistant `message` → 工具 `tool_call` → `content_type = "tool_result"` 的 user `message` → `tool_result` 记录。后两条 tool-result 记录可能不存在，因为工具可能尚未返回或原始日志缺少结果。
>
> Claude Code 的 Skill 本质也是 `Skill` 工具调用，并且没有工具结果，按顺序产出 `content_type: "tool_use"/"unknown"` 的 `assistant message` → `Skill tool_call` → `content_type: skill_instructions` 的 `assistant message` 记录。

> 可以发现，除了 `tool_result` 记录之外，工具结果还会保存一条 `content_type = "tool_result"` 的 user `message`，目的是：
>
> 1. 进全文索引（最关键） FTS 只挂在 messages 和 memories 上， schema.sql 的 messages_fts 只索引 messages.text ， tool_results 没有任何 FTS 索引 。工具输出里往往藏着最关键的证据——Bash 报错、Read 的文件内容、lint 结果。如果只存 tool_results ，这些内容就永远搜不到；存成 message 后，"Exit code 1" 或某段报错文本就能命中检索。
>
> 2. 保留会话链/时间线位置 messages 行带 timestamp 、 session_id 、 parent_uuid 、 cwd 、 model 。原文链是 assistant(tool_use) → user(tool_result) ，保留 message 行才能维持 parent_uuid 链完整，让 query.ts 的 context() / trace() 能回溯"这次工具调用之后发生了什么"。 tool_results 表只有 content + tool_use_id，没有这些元数据。
>
> 3. 统一检索语义 search() / thread() 都只读 messages ，Agent 脚本写 search(...) 就能命中工具输出，或直接过滤 content_type='tool_result' 查"某次任务的失败输出"，不需要感知 tool_results 表的存在。
>
> 4. 统计计数 message_count 等聚合统计依赖 message 行计数。
>
> 一个容易误解的点：详情展示层 session-detail.ts 会 continue 跳过 content_type === 'tool_result' 的消息，不把它们独立渲染——因为内容已经挂在对应 tool call 的 result 上了。 所以存这条 message 不是为了展示，而是为了"可被搜索 + 链完整 + 可过滤" ，展示由 tool_results 那份承担。

4、**user 消息行中 `"isCompactSummary": true,`**

```json
{
  "type": "user",
  "isCompactSummary": true,
  "message": {
    "role": "user",
    "content": "此前对话摘要"
  }
}
```

产出：`summary` 记录

```ts
{
  kind: "summary",
  source: "claude",
  content: "此前对话摘要"
}
```

5、**system `turn_duration` 行**

每一轮（用户发消息 -> Claude Code 完成回复）结束时，都会写入一行 `turn_duration`。

```json
{
  "type": "system",
  "subtype": "turn_duration",
  "parentUuid": "msg-002",
  "durationMs": 3200
}
```

产出：一个定向更新 `message-turn-duration` record

```ts
{
  kind: "message-turn-duration",
  uuid: "msg-002",
  turn_duration_ms: 3200
}
```

`persist()` 收到后执行：

```sql
UPDATE messages SET turn_duration_ms = ? WHERE uuid = ?
```

因此它只补写已经存在的 assistant message 的耗时，不覆盖该消息的文本、角色、token 或其他字段；如果 `parentUuid` 或 `durationMs` 缺失，则不产出 record。

6、**`ai-title` 行**

```json
{
  "type": "ai-title",
  "aiTitle": "解释搜索 self-hit 问题"
}
```

不产生独立 TranscriptRecord。

Claude parser 先在内存里维护：

```
sm.title
```

如果一个 session 有多个 `ai-title`，后出现的覆盖先出现的。

解析完整个主会话 JSONL 后，才产出 `session` 记录：

```json
{
  kind: "session",
  id: sessionId,
  title: sm.title,
  ...
}
```

7、**主会话 `<session-id>.jsonl` 完整解析结束后，最终产生一条 `session` 记录**

```ts
{
  kind: "session",
  id: sessionId,
  title: sm.title,
  project: unit.project || null,
  started_at: sm.started_at,
  ended_at: sm.ended_at,
  git_branch: sm.git_branch,
  version: sm.version,
  message_count: sm.n,
  countMode: skip > 0 ? "delta" : "total",
  jsonl_path: unit.key,
  source: "claude"
}
```

这个 `session` 不是某一条固定 JSONL 行直接产生的，而是整个主会话聚合出来的。首次完整解析使用 `countMode: "total"` 覆盖消息计数；仅在 cursor 跳过既有行、解析新增尾部时使用 `"delta"` 累加消息计数。

8、**普通子 Agent JSONL**

```
<session-id>/subagents/<agent-id>.jsonl
```

可以把它理解成：父 session 下的 agent 关联消息

产出方式与主 Agent 相同，用的是同一套 parser：

```ts
export function* parse(
  unit: IndexUnit,
  cursor: Cursor
): Generator<TranscriptRecord, Cursor>
```

子 Agent 只是传入了不同的 `unit`：

```ts
{
  key: ".../subagents/agent-a0f....jsonl",
  sessionId: "父 session id",
  isSubagent: true, // 主 agent 为 false
  agentId: "agent-a0f..." // 主 agent 为 undefined
}
```

parse 通过：

```ts
const isSubagent = unit.isSubagent === true;
```

区分主 Agent 和子 Agent。

都产出：`message`、`tool_call`、`tool_result`、`summary`、`message-turn-duration` 记录，但子 Agent 不产出 `session` 记录。

在生成 `message` 时，子代理文件会将所属 agent 写入 `agent_id`，并继续使用父会话的 `session_id`：

```ts
agent_id: "<agent-id>" // 主 agent 为 null
session_id: "<parent-session-id>" // 和主 agent 一样都是父 session id
```

`isSubagent` 负责决定是否读取 `.meta.json`、是否产出 `session` 记录，以及 `agent_id` 的来源；Claude 子代理和 workflow 子代理由 `agent_id` 单独展示。

9、**子代理 `.meta.json`**

普通子代理旁边可能有：

```
<session-id>/subagents/<agent-id>.meta.json
```

内容为：

```json
{
  "toolUseId": "call_123",
  "agentType": "Explore",
  "description": "查找相关实现",
  "spawnDepth": 1
}
```

产出：`subagent` 记录

```ts
{
  kind: "subagent",
  agent_id: "agent-001",
  session_id: "parent-session-001",
  parent_tool_use_id: "tool-001",
  agent_type: "Explore",
  description: "查找相关实现",
  duration_ms: 12000,
  total_tokens: 5000
}
```

这里的 `duration_ms` 和 `total_tokens` 由子会话 JSONL 中的消息时间戳与 usage 统计出来。

> 这也是为什么**先解析 JSONL，再读取 `.meta.json`**：
>
> 因为两个文件的信息不完整：
>
> * `.meta.json` 只有：
>
>   ```
>   Agent 身份
>   Agent 类型
>   description 描述
>   父工具调用 ID
>   ```
>
>   它没有：
>
>   ```
>   开始时间、结束时间
>   token usage
>   完整消息、工具调用 tool_use、工具结果 tool_result
>   ```
>
> * 子会话 JSONL 则相反，它有：
>
>   ```
>   timestamp
>   usage
>   完整消息、tool_use、tool_result
>   ```
>
>   但它不一定包含可靠的父工具调用关系。因此 parser 需要把两边的信息合并。
>
> 它们最终建立这条关系：
>
> ```ts
> 父消息中的 Agent tool_call
> tool_calls.id = call_123
>               ↓
> subagents.parent_tool_use_id = call_123
>               ↓
> subagents.agent_id = agent-a0f...
>               ↓
> 子会话 messages.agent_id = agent-a0f...
> ```

10、**Workflow `.json` 及其子代理 `.meta.json` `.jsonl`**

```
<session-id>/workflows/<run-id>.json
```

当前代码要求至少存在：

```json
{ "runId": "run-001" }
```

典型格式：

```json
{
  "runId": "run-001",
  "taskId": "task-001",
  "workflowName": "Code Review",
  "script": "review script",
  "result": {
    "status": "ok"
  },
  "timestamp": "2026-07-31T10:00:00.000Z",
  "durationMs": 12000,
  "totalTokens": 5000,
  "status": "success",
  "workflowProgress": [
    {
      "type": "workflow_agent",
      "agentId": "001",
      "phaseTitle": "Review",
      "label": "检查实现",
      "model": "claude-sonnet",
      "state": "completed",
      "durationMs": 5000,
      "tokens": 2000,
      "toolCalls": 4
    }
  ]
}
```

整体产出：`workflow` 记录

```ts
{
  kind: "workflow",
  run_id: "run-001",
  session_id: "session-001",
  parent_tool_use_id: "tool-001",
  task_id: "task-001",
  script: "review script",
  result_json: "{\"status\":\"ok\"}",
  timestamp: "2026-07-31T10:00:00.000Z",
  agent_count: 1,
  duration_ms: 12000,
  total_tokens: 5000,
  status: "success",
  workflow_name: "Code Review"
}
```

`parent_tool_use_id` 不一定来自 workflow JSON 本身。当前代码会回扫主会话，寻找对应的：

```
assistant 中的 Workflow tool_use
user 中的 Workflow tool_result
```

然后只根据 workflow JSON 中的唯一 `runId` 匹配。`workflowName` 只是展示字段，不能作为关联键：同一个主会话可以多次调用同名 workflow，使用名称兜底会把新 workflow 错误关联到旧的 Workflow tool call，进而使数据库中的 `workflows.parent_tool_use_id` 指向错误的 `tool_calls.id`。如果主 transcript 中找不到包含该 `runId` 的调用，`parent_tool_use_id` 应保持未知（`null`），不能猜测关联对象。

`workflowProgress` 中的每个 block 产出一条 `workflow_agent`：

```ts
{
  kind: "workflow_agent",
  agent_id: "agent-agent-001",
  run_id: "run-001",
  session_id: "session-001",
  phase: "Review",
  label: "检查实现",
  model: "claude-sonnet",
  state: "completed",
  duration_ms: 5000,
  tokens: 2000,
  tool_calls: 4
}
```

workflow 子代理的 '`<agent-id>.jsonl` 与普通 jsonl 一样被解析产出 `message` `tool_call` `tool_result` 等记录且 `messages.agent_id = <agent-id>`，不产生 `session` record。解析该 JSONL 时会：

1. 从文件路径知道它属于哪个 `workflowRunId`；
2. 读取同名 `<agent-id>.meta.json`；
3. 因而额外产出一条带 `agent_type`、`description` 的 `workflow_agent`。

两条 `workflow_agent` 记录通过 `agent_id` 合并：

```
.meta.json
-> agent_type / description

workflow JSON
-> phase / label / model / state / duration / tokens / tool_calls
```

这是当前设计中比较特殊的一点：一个 `workflow_agent` 可能由两个不同文件共同补齐。

`workflowProgress[].agentId` 是不带 `agent-` 前缀的原始 ID；workflow JSON 解析时会补成规范 ID `agent-<agentId>`，与文件名 `<agent-id>.jsonl` 及其 `.meta.json` 使用的 ID 一致。例如原始 `agentId: "001"` 对应 `agent-001.jsonl` 和数据库中的 `agent_id: "agent-001"`。

#### 原文回查 `rawClaude()`

Claude 的消息 UUID 来自原始 JSONL 行本身，而不含行号；`rawClaude()` 必须选择正确文件后扫描匹配的 `uuid`：

* 它先用 session 的 `jsonl_path` 定位主 transcript，普通消息留在主 JSONL 中查找；
* 消息有 `agent_id` 时，若关联的 `workflow_agent` 带 `run_id`，则读取 `subagents/workflows/<run-id>/<agent-id>.jsonl`，否则读取普通 `subagents/<agent-id>.jsonl`。
* 它按消息 UUID 找到原始 JSONL 行，并返回原始行以及可展示的完整 `messageText`；桌面 App 用后者展开索引时截断的消息。

`subagent` 和 `workflowAgent` 不是替代 UUID 的二级查询条件，而是选择原始文件的路由信息。两者都缺失时，Claude 只在主 transcript 中查找。

### Codex：主 rollout、子线程与顶层 JSONL 行的映射 `codex.ts`

> [Codex JSONL 格式参考文档](./codex-jsonl.md)

Codex 的原始转录以一份 rollout JSONL 表示一个 thread。`discoverAt()` 先读取 `~/.codex/session_index.jsonl`，取得 thread 标题和最近更新时间；随后递归枚举 `~/.codex/sessions/**/*.jsonl`。每个根 thread 的 rollout 都会成为一个统一的 `IndexUnit`：

```ts
{
  key: '~/.codex/sessions/2026/08/02/rollout-…jsonl',
  sessionId: 'codex:<thread-id>',
  meta: {
    source: 'codex',
    indexedTitle: '…',
    indexedUpdatedAt: '…'
  }
}
```

#### 完整产出关系

Codex 的目录按日期分层；文件名和目录本身不携带父子关系，关系由 rollout 中的 `session_meta.payload` 决定：

```text
~/.codex/
├── session_index.jsonl
│   └── { id, thread_name, updated_at }
└── sessions/<year>/<month>/<day>/
    ├── rollout-<root-thread-id>.jsonl       ← 根 thread，当前会被索引为 session
    └── rollout-<child-thread-id>.jsonl      ← child / fork / subagent thread
```

```json
{
  "type": "session_meta",
  "payload": {
    "id": "<thread-id>",
    "cwd": "/Users/me/project",
    "git": { "branch": "main" },
    "cli_version": "…"
  }
}
```

`session_meta` 是每个可解析 rollout 的锚点。当前实现从它取得 root ID、初始 `cwd`、Git 分支和 CLI 版本；`project` 由 `cwd` 推导。数据库 ID 均加 `codex:` 命名空间，例如 `codex:<thread-id>`；每一条投影消息用 `codex:<thread-id>:<6 位行号>` 作为稳定 UUID。

子线程的父 ID 可来自以下任一个字段：

```text
source.subagent.thread_spawn.parent_thread_id
forked_from_id
source.subagent.parent_thread_id
```

但这不是 Claude Code 那种“主 session + 独立 subagent transcript 均索引”的实现：当前 `discoverAt()` 会跳过任何带父 ID 或 `thread_source === "subagent"` 的 thread。因此根 rollout 会产生 `session`，普通 child/fork/subagent/guardian rollout 都不产生 `subagent`、消息、工具或删除记录。根 rollout 进入 parse 后先发 `delete-session`，再全量写入当前完整投影。

```text
根 rollout JSONL
├── session_meta
│   └── session（最后一次统一发出）
├── turn_context
│   └── 只更新后续 message 的 cwd / model
├── event_msg.user_message / agent_message
│   └── message
├── event_msg.agent_reasoning
│   └── message(content_type: 'thinking')
├── event_msg.context_compacted
│   └── summary
├── event_msg.task_complete / token_count / thread_name_updated
│   └── 回填最近 message 或 session，不独立产出
├── response_item.message
│   └── message（若不是 event_msg 的镜像）
├── response_item.*_call
│   └── message(content_type: 'tool_use') + tool_call
└── response_item.*_call_output
    └── tool_result
```

#### 为什么 Codex 必须全量 replay

同一条可见消息会同时以事件流和 response item 出现，且两种行的先后顺序不可靠：

```json
{"type":"event_msg","payload":{"type":"agent_message","message":"hi"}}
{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"text":"hi"}]}}
```

两行只应投影为一条 assistant `message`。因此 `parse(unit, _cursor)` 忽略传入 cursor：先读完整个 JSONL，第一遍收集所有 `event_msg.user_message` / `agent_message` 的 `(role, text)`，第二遍再投影记录，遇到同键的 `response_item.message` 就跳过。最后 cursor 仍记录为 `mtime:lineCount`，而 `session` 使用 `countMode: 'total'`，表示本次重放得到的是完整事实而不是可累加的增量。

`insertMessage()` 是唯一创建 Codex message 的位置：它顺序串联 `parent_uuid`，记录当时的 `cwd` 与 model，并把环境上下文 user message 设为 hidden、skill instruction 等设为 meta；最近一条 assistant text message 还会成为 token 和 turn-duration 的回填目标。

#### 顶层行到 TranscriptRecord 的映射

| 原始行 / 条件 | 产出 | 细节 |
| --- | --- | --- |
| `session_meta` | 最后的 `session` | 无 `payload.id` 的 rollout 直接跳过；标题优先取 `session_index.jsonl`，也可被后续事件更新。 |
| `turn_context` | 无独立 record | 更新之后 message 的 `cwd`、`model`；其 `summary` 字段是配置模式，不是摘要。 |
| `event_msg.user_message` / `agent_message` | text `message` | 文本从 `message`、`text_elements` 或 `text` 提取。 |
| `event_msg.agent_reasoning` | assistant `message` | `content_type: 'thinking'`。 |
| `event_msg.context_compacted` | `summary` | `{ source: 'codex', content: '已 compact' }`；它是压缩完成标记。 |
| `event_msg.task_complete` | `message-turn-duration` | 将 `duration_ms` 回填到最近 assistant text message。 |
| `event_msg.token_count` | 无独立 record | 从 `last_token_usage` 或 `total_token_usage` 回填最近 assistant text message 的 input/output tokens。 |
| `event_msg.thread_name_updated` | 无独立 record | 更新最终 `session.title`。 |
| 其他 `event_msg`（含 `collab_agent_spawn_end`、`web_search_end`） | 当前不产出 | 当前 adapter 没有把它们投影为 `subagent`、tool call 或 tool result。 |
| `response_item.message` | text `message` | 忽略 `developer` role；同 role/text 已存在于 event_msg 时去重。`<image>…</image>` 包裹的输入图片不写入 text。 |
| `response_item.reasoning` / 顶层 `compacted` | 当前不产出 | reasoning 正文可能只有加密字段，且 `reasoning.summary` 不是 compaction 事件。 |

#### 工具调用与结果

```json
{"type":"response_item","payload":{"type":"function_call","call_id":"…","name":"…","arguments":"…"}}
{"type":"response_item","payload":{"type":"custom_tool_call","call_id":"…","name":"…","input":"…"}}
{"type":"response_item","payload":{"type":"tool_search_call","call_id":"…","arguments":"…"}}
```

三类调用都会产生一条 assistant `message(content_type: 'tool_use')` 和一条 `tool_call`。调用 ID 同样加 thread 命名空间：`codex:<thread-id>:<call-id>`；`arguments` / `input` 会尽可能解析为 JSON，再保存为 `input_json`。

`web_search_call` 也走同一分支，但前提是 payload 有 `call_id`；否则当前不会投影。工具输出只处理下列带 `call_id` 的行：

```json
{"type":"response_item","payload":{"type":"function_call_output","call_id":"…","output":"…","is_error":false}}
{"type":"response_item","payload":{"type":"custom_tool_call_output","call_id":"…","output":"…","is_error":false}}
{"type":"response_item","payload":{"type":"tool_search_output","call_id":"…","output":"…","is_error":false}}
```

每一行产生一条 `content_type: 'tool_result'` 的 user `message` 和一条 `tool_result`；后者以 namespaced call ID 关联前述 `tool_call`，`message_uuid` 指向这条结果 message。若输出先于调用被读取，结果 message 仍会产生，tool call 可稍后通过 call ID 关联。没有 `web_search_output` 的专门映射。

与 Claude 的工具行相同，Trajex 把一次原始调用拆成时间线锚点和工具事实：

```text
response_item.*_call
  ├── message(content_type: 'tool_use')       ← 时间、顺序、parent chain、UI 位置
  └── tool_call                                ← 名称、输入、与 tool_result 的关联
```

`tool_result` 同时保留规范结果记录，并投影为 user `message`，与 Claude 的查询和 FTS 语义统一。

#### 原文回查 `rawCodex()`：从规范 UUID 精确回读 JSONL 行

Codex 的 message UUID 由 Trajex 按原线程 ID 与 JSONL 行号构造：`codex:<threadId>:<lineNumber>`，例如 `codex:019e8951-xxx:37`。因此 `rawCodex()` 不需要扫描消息正文来猜测目标：

1. 解析 `messageUuid`，取得 thread ID 和 line number；不符合该形状直接返回 `null`。
2. 主会话（`agentId === null`）优先使用 `session.jsonl_path`；子线程则在 Codex `sessions/` 树中按 thread ID 查找对应 rollout JSONL。
3. 顺序读取目标文件至该行，返回完整原始 JSONL 文本；找不到文件或行则返回 `null`。
4. 对 `event_msg` 的文本字段和 `response_item.message.content` 额外投影 `messageText`，使 UI 可展示未截断的可读正文，而 `text` 仍是原始 JSONL 行。

这一路径选择依赖 `RawLookup` 提供的 `session.jsonl_path` 与 `agentId`，但用于精确定位的主键仍是 UUID 内的 thread ID 和行号。

### Pi：一份具有分支树的 v3 session JSONL

> [Pi JSONL 格式参考文档](./pi-jsonl.md)

Pi 只支持官方 v3 文件，递归发现。第一行是 `{type:"session",version:3,id,cwd,…}`；其余条目有 `id` 和 `parentId`，并通过 durable `leaf` 指向当前上下文。解析器全量 replay，结合 leaf、compaction 的 `firstKeptEntryId` 与 `retainedTail` 重建 active context；当前上下文投影为 `visible`，仍保留但已被分支替代的证据投影为 `inactive`，来源明确不展示的 custom message 投影为 `hidden`。

| 原始条目或字段                                               | 产出的 record                                                | 设计细节 / 不产出情况                                        |
| ------------------------------------------------------------ | ------------------------------------------------------------ | ------------------------------------------------------------ |
| session header                                               | 最后的 `session`                                             | 提供 session ID、cwd、version、起止时间；自身不产出 message。 |
| `{type:"session_info",name}` / `{type:"model_change",modelId}` | 无独立 record                                                | 前者更新最后的 session title；后者只参与后续 message 的 model 继承。 |
| `{type:"compaction"|"branch_summary",summary}`               | `summary` + retained tail messages                           | `source: 'pi'`；compaction 的保留尾部也投影为 canonical message，避免 active context 丢失。 |
| `{type:"custom_message",content,display}`                    | custom `message`                                             | 扩展插入的 Entry，role 为 `custom`、`is_meta: 1`；`display:false` 映射为 `visibility: 'hidden'`。 |
| `{type:"message",message:{role:"user",content}}`             | user `message`                                               | 仅文本 content 产生消息。                                    |
| assistant 的 `content[]` text / thinking / toolCall part     | 每个 part 各产生 assistant `message`；toolCall 另有 `tool_call` | 以 `:partIndex` 后缀生成稳定 message ID，并串成 parent chain；usage 只附到最后一个可导航 part。 |
| `message.role === "toolResult"`                              | tool-result `message` + `tool_result`                        | `toolCallId` 关联前述工具；错误状态写入 result。             |
| `message.role === "bashExecution"`                           | bash `message`                                               | 形成 `content_type: 'bash'` 的文本投影；不另造 `tool_result`。未知条目和无可投影文本的条目不产出。 |

#### 增量发现 `discoverAt()`

Pi 的 session 文件按工作目录分层存放：

```text
~/.pi/agent/sessions/
└── --<project-path>--/                 ← 目录名 = cwd 的 / 换成 -
    ├── <timestamp>_<uuid>.jsonl        ← 一份 v3 session
    └── ...
```

`discoverAt()` 用 `sessionFiles()` 递归枚举 session 目录下的全部 `*.jsonl`（Pi 支持任意子目录嵌套，不像 Claude 固定两级结构）。每个文件经过三重过滤，全部通过才产出 `IndexUnit`：

1. **changedPaths 优化**（Electron daemon 通过 chokidar 传入，属优化提示）：只保留命中 changedPaths 中"该文件本身"或"sessionDir 本身"的候选。命中 sessionDir 本身是兜底——新增目录等只产生目录级事件时，也能把目录内文件重新纳入检查；
2. **mtime 增量过滤**：读取 `index_state` 中保存的 cursor（`mtimeMs:lines`），cursor 非空且文件当前 mtime ≤ cursor 的 mtime 时跳过，认为没有变化；
3. **header 校验**：读取文件第一行，必须是 `{"type":"session","version":3,"id":…}` 才接受；版本不是 3、第一行解析失败或 id 缺失的文件直接跳过（不报错，视为非 Pi 文件）。

```ts
{
  key: '~/.pi/agent/sessions/--home-user-proj--/20260228_143022_abc123.jsonl',
  sessionId: 'pi:abc123:…',             // pi:<encodeURIComponent(rawId)>:<sha256(cwd)>
  project: 'home-user-proj',            // 由 header.cwd 推导
  meta: {
    sessionId: 'abc123',                // 原始 session id（不保证跨项目唯一）
    cwd: '/home/user/proj'
  }
}
```

数据库级 session id 是 `pi:<rawId>:<cwd 哈希>`。raw id 可能按项目局部生成（如显式传入 `--session-id`），且同一份 session 文件可能出现在多个项目目录下，只靠 raw id 会跨项目撞主键；把 cwd 哈希并进主键是防御性兜底，同时让文件移动后身份保持稳定。

cursor 形状同为 `mtimeMs:lines`，但与 Claude 的"行增量续读"不同：Pi 的 `parse(unit, _cursor)` 忽略 cursor 里的行数，总是**全量重放**整份文件——active context 由 durable leaf、compaction 的 `firstKeptEntryId` / `retainedTail` 从整棵树推导，无法从某个行号恢复。lines 只是记录文件当前总行数。因此 Pi 每次产出的 `session.countMode` 恒为 `'total'`，并在记录流开头发出 `delete-session`，让 persist 清理旧投影，避免全量重放叠加出重复行。

`watchRoots(configuredRoot)` 直接返回配置的 session 目录本身（递归监听），不做任何路径拼接——App Settings 里填的就是最终 session directory，这也与 README 中"Pi 不再追加路径"的约定一致。

#### 原文回查 `rawPi()`

Pi 的 message UUID 由 Trajex 构造：`pi:<rawId>:<cwdHash>:<entryId>`（assistant 的多 part 消息会再拼 `:<partIndex>` 后缀）。因此 `rawPi()` 不需要扫描正文猜测目标：

* 用 `input.session.jsonl_path` 定位文件，并防御性校验它必须位于 session 目录内，防止越界读任意路径；
* 把 message UUID 按 `:` 切分，取 `parts[3]` 作为 entry id（part 后缀在 `parts[4]`，不影响定位）；
* 逐行 `JSON.parse` 比对 `entry.id`，命中即返回该行原文。

```ts
// uuid = "pi:<rawId>:<cwdHash>:<entryId>[:<partIndex>]"
const parts = input.messageUuid.split(':');
const entryId = parts[3];
```

与 `rawClaude()` / `rawCodex()` 的两个差异：

* **不提取 messageText**：`rawPi()` 的返回值只有原始行 `text`。分页字段呈一次性直读形态——`totalLength` = 行长度、`offset: 0`、`limit` = 行长度、`hasMore: false`，即把整行当作一段返回，不像 `rawClaude()` 那样顺带解析出可展示的完整文本（`messageText`）。App 在详情页展开被截断的消息时，对 Pi 只能回落到数据库里已 `trunc` 截断的 `msg.text`，拿不到原始完整行；
* **按 entry id 定位，而非按消息定位**：同一 entry 投影出的多条消息（assistant 的 text / thinking / toolCall part，以及 toolResult 消息与它附带的 `tool_result` 记录）共享同一个 entry id，回查都会返回同一行原始 entry；compaction `retainedTail` 合成的消息 UUID 指向 compaction entry id，回查实际命中 compaction 行本身，无法还原合成消息的"原文"。

### `registry.ts`、 `builtins.ts`

```ts
builtins.ts  = 装配（依赖注入）：把 adapter 实例拼起来 → 产出 registry
registry.ts  = 契约 + 实现：定义 ProviderRegistry 接口，并提供不可变查找实现
```

`registry.ts` 提供 Provider 注册表接口和构建函数：

```ts
/** Provider 注册表接口。所有方法均为查找/枚举，不包含写入或 mutate 能力。 */
export interface ProviderRegistry {
  /** 返回所有 provider 的只读元数据快照（深度复制 descriptor，防止外部修改）。 */
  catalog(): ProviderDescriptor[];
  /** 按 source 名称（如 'claude' | 'codex' | 'pi'）查找对应的 adapter。 */
  get(source: string): ProviderAdapter | undefined;
  /** 返回当前注册的所有 adapter 列表（byId 快照的副本）。 */
  list(): ProviderAdapter[];
  /** 聚合所有 adapter 需要监视的文件/目录路径，去重后返回。
   *  configuredRoots 允许调用方覆盖某个 provider 的默认根目录，
   *  未覆盖时使用 provider.descriptor.defaultRoot。 */
  watchRoots(configuredRoots?: Readonly<Record<string, string>>): string[];
  /** 按来源定位 adapter 并查询原始消息行；未找到对应的 adapter 时返回 null。 */
  raw(input: RawLookup): RawRecord | null;
}
```

```ts
/** 构建按 source 名称查找的 registry。构造时执行验证，保证持久化 source 与 adapter 选择之间存在一对一的稳定映射。 */
export function createProviderRegistry(providers: readonly ProviderAdapter[]): ProviderRegistry {
  ...
}
```

`builtins.ts` 提供装配函数调用 registry 接口构建函数，被 `indexer.ts` 使用：

```ts
createBuiltinProviderRegistry({ claudeRoot, codexRoot, piSessionDir } = {}) → createProviderRegistry([
  createClaudeProvider({ rootDir: claudeRoot }),
  createCodexProvider({ rootDir: codexRoot }),
  createPiProvider({ sessionDir: piSessionDir }),
])
```

- **零参调用** = 用各 adapter 的默认根目录（`~/.claude`、`~/.codex`、Pi 的 `~/.pi/agent/sessions`）
- **Pi 路径覆盖** = App Settings 直接保存最终 session directory；不接受环境变量、CLI 参数或任意额外路径

**设计意图总结：**

- **调用方从不自己维护 provider 列表** — 新增 provider 只改 `builtins.ts` 一行
- **registry 是只读门面** — 索引器、设置页、watcher、raw 回源四类消费者共用同一份查询逻辑，不会各写各的
- **source 是唯一身份** — 从数据库行到 adapter 实例的单射由构造时校验保证

## 三、SQLite Schema 数据模型 `schema.sql`

此文件保存可再生 transcript 索引与人工确认的 memories。Provider 先输出 TranscriptRecord，persist 再按本 schema 写表；FTS 虚表与 trigger 由 SQLite 从 messages/memories 自动维护，查询层使用 MATCH 而不是扫描原表，即搜索时用：`SELECT ... FROM messages_fts WHERE text MATCH 'keywords'` 而不是：`SELECT ... FROM messages WHERE text LIKE '%keywords%'`，前者走 FTS 索引（快），后者全表扫描（慢）。

### 表总览和字段解析

Trajex 不是把一整个 JSONL 原样塞进数据库，而是拆成多张关系表：

`schema.sql` 只声明了各表的**PK 主键**，没有写 SQLite `FOREIGN KEY ... REFERENCES` 约束。下表及字段解析中的“逻辑 FK”表示代码、`persist()` 和查询层按该字段关联，而不是数据库会拒绝不合法值；因此 Provider 必须保证 ID 一致。

| 表名 | 用途 | 主键（PK） | persist 持久化来源 |
| --- | --- | --- | --- |
| `sessions` | 会话元信息 | `id` | **provider 产出，TranscriptRecord** |
| `messages`（核心表） | 用户 / assistant 消息 | `uuid` | TranscriptRecord |
| `tool_calls` | 工具调用 | `id` | TranscriptRecord |
| `tool_results` | 工具执行结果，每个 tool call 最多一条结果 | `tool_use_id` | TranscriptRecord |
| `subagents` | 子 Agent / Codex child thread | `agent_id` | TranscriptRecord |
| `workflows` | Claude workflow 工作流 | `run_id` | TranscriptRecord |
| `workflow_agents` | 工作流中的子代理，同一 Agent 的零散元数据最终汇总成 `workflow_agents` 中一条完整记录 | `agent_id` | TranscriptRecord |
| `summaries` | 会话摘要 | `id` | TranscriptRecord |
| `index_state` | 索引进度、heartbeat、版本 marker | `jsonl_path` | **provider 不产出**该 Record，而是 `parse()` 在 generator 结束时返回 `newCursor` |
| `memories` | 用户批准沉淀的长期记忆 | `id` | **用户手动创建** |
| `messages_fts` | 消息全文倒排索引（FTS5 虚表） | `rowid` 映射 | **派生，trigger 自动维护** |
| `memories_fts` | 记忆全文倒排索引（FTS5 虚表） | `rowid` 映射 | 派生，trigger 自动维护 |

```
provider.parse(unit, oldCursor)
  -> yield messages / tools / ... 等 TranscriptRecord
  -> return newCursor —— "mtime:lines"

persist()
  -> INSERT OR REPLACE index_state(...)
```

1、**`sessions` — 会话**

`id` 是 **PK**。`messages.session_id`、`tool_calls.session_id`、`tool_results.session_id`、`subagents.session_id`、`workflows.session_id`、`workflow_agents.session_id`、`summaries.session_id`、`memories.session_id` 都以它作为**逻辑 FK**；SQLite schema 没有声明物理 FOREIGN KEY 约束。

| 字段            | 类型                  | 说明                                  |
| --------------- | --------------------- | ------------------------------------- |
| `id`            | TEXT PK               | 会话唯一 ID                           |
| `title`         | TEXT                  | 会话标题                              |
| `project`       | TEXT                  | 项目名（slug 格式）                   |
| `project_path`  | TEXT                  | 真实项目绝对路径                      |
| `started_at`    | TEXT                  | ISO 时间                              |
| `ended_at`      | TEXT                  | ISO 时间                              |
| `git_branch`    | TEXT                  | Git 分支                              |
| `version`       | TEXT                  | CLI 版本                              |
| `message_count` | INTEGER               | 消息数                                |
| `jsonl_path`    | TEXT                  | 来源 JSONL 文件路径                   |
| `source`        | TEXT DEFAULT 'claude' | 来源标识：`claude` / `codex` / `pi` |

2、**`messages` — 消息**

`uuid` 是 **PK**；`session_id` 是 -> `sessions.id` 的**逻辑 FK**，`parent_uuid` 是 -> `messages.uuid` 的自关联键，`agent_id` 逻辑关联 `subagents.agent_id`。`session_id`、`agent_id`、`(session_id, timestamp)`、`source` 另有 B-Tree 查询索引，`text` 由 trigger 投影到 FTS。

| 字段               | 类型                   | 说明                                                         |
| ------------------ | ---------------------- | ------------------------------------------------------------ |
| `uuid`             | TEXT PK                | 消息唯一 ID                                                  |
| `session_id`       | TEXT                   | 所属会话                                                     |
| `type`             | TEXT                   | `user` / `assistant`                                         |
| `parent_uuid`      | TEXT                   | 父消息（构建线程链）                                         |
| `timestamp`        | TEXT                   | ISO 时间                                                     |
| `role`             | TEXT                   | 同 type                                                      |
| `text`             | TEXT                   | 消息内容（FTS 索引列）                                       |
| `content_type`     | TEXT                   | `text` / `thinking` / `tool_use` / `unknown` / `skill_instructions` |
| `is_meta`          | INTEGER                | 是否系统消息                                                 |
| `visibility`       | TEXT DEFAULT 'visible' | `visible` / `inactive` / `hidden`                            |
| `model`            | TEXT                   | 模型名                                                       |
| `agent_id`         | TEXT                   | 所属子代理 ID                                                |
| `input_tokens`     | INTEGER                | 输入 token 数                                                |
| `output_tokens`    | INTEGER                | 输出 token 数                                                |
| `cwd`              | TEXT                   | 当前工作目录                                                 |
| `skill`            | TEXT                   | 使用的 skill 名                                              |
| `turn_duration_ms` | INTEGER                | 轮次耗时                                                     |
| `source`           | TEXT DEFAULT 'claude'  | 来源标识                                                     |

3、**`tool_calls` — 工具调用**

`id` 是 **PK**；`message_uuid` 逻辑关联 `messages.uuid`，`session_id` 逻辑关联 `sessions.id`。`message_uuid`、`(session_id, name)` 和 `file_path` 有查询索引。

| 字段           | 类型                   | 说明                                         |
| -------------- | ---------------------- | -------------------------------------------- |
| `id`           | TEXT PK                | 工具调用 ID                                  |
| `message_uuid` | TEXT                   | 所属消息                                     |
| `session_id`   | TEXT                   | 所属会话                                     |
| `name`         | TEXT                   | 工具名（`Read`, `Edit`, `Bash`, `Skill` 等） |
| `presentation` | TEXT DEFAULT 'default' | `default` / `skill`                          |
| `input_json`   | TEXT                   | 调用参数 JSON                                |
| `file_path`    | TEXT                   | 操作的文件路径                               |

4、**`tool_results` — 工具执行结果**

`tool_use_id` 是 **PK**，同时逻辑关联 `tool_calls.id`，所以一个 tool call 最多对应一条结果；`message_uuid` 与 `session_id` 分别逻辑关联消息和会话，且都建有查询索引。

| 字段           | 类型    | 说明                 |
| -------------- | ------- | -------------------- |
| `tool_use_id`  | TEXT PK | 对应 `tool_calls.id` |
| `message_uuid` | TEXT    | 所属消息             |
| `session_id`   | TEXT    | 所属会话             |
| `content`      | TEXT    | 执行结果文本         |
| `file_path`    | TEXT    | 文件路径             |
| `is_error`     | INTEGER | 是否错误             |

5、**`subagents` — 子代理**

`agent_id` 是 **PK**；`session_id` 逻辑关联 `sessions.id`，`parent_tool_use_id` 逻辑关联 `tool_calls.id`。`session_id` 有查询索引；子 Agent 的正文不在本表，而以 `messages.agent_id` 回连。

| 字段                 | 类型    | 说明                      |
| -------------------- | ------- | ------------------------- |
| `agent_id`           | TEXT PK | 子代理 ID                 |
| `session_id`         | TEXT    | 所属会话                  |
| `parent_tool_use_id` | TEXT    | 触发该子代理的工具调用 ID |
| `agent_type`         | TEXT    | 代理类型描述              |
| `description`        | TEXT    | 描述                      |
| `duration_ms`        | INTEGER | 耗时                      |
| `total_tokens`       | INTEGER | Token 总数                |

6、**`workflows` — 工作流**

`run_id` 是 **PK**；`session_id` 逻辑关联 `sessions.id`，`parent_tool_use_id` 逻辑关联 `tool_calls.id`。`session_id` 有查询索引。

| 字段                 | 类型    | 说明                |
| -------------------- | ------- | ------------------- |
| `run_id`             | TEXT PK | 运行 ID             |
| `session_id`         | TEXT    | 所属会话            |
| `parent_tool_use_id` | TEXT    | 触发的工作流工具 ID |
| `task_id`            | TEXT    | 任务 ID             |
| `script`             | TEXT    | CodeAct 脚本        |
| `result_json`        | TEXT    | 结果 JSON           |
| `timestamp`          | TEXT    | 时间                |
| `agent_count`        | INTEGER | 子代理数            |
| `duration_ms`        | INTEGER | 耗时                |
| `total_tokens`       | INTEGER | Token 总数          |
| `status`             | TEXT    | 状态                |
| `workflow_name`      | TEXT    | 工作流名            |

7、**`workflow_agents` — 工作流中的子代理**

`agent_id` 是 **PK**；`run_id` 逻辑关联 `workflows.run_id`，`session_id` 逻辑关联 `sessions.id`。`run_id` 有查询索引，重复写入相同 `agent_id` 时由 `persist()` 用 `COALESCE` 合并字段。

| 字段          | 类型    | 说明         |
| ------------- | ------- | ------------ |
| `agent_id`    | TEXT PK | 代理 ID      |
| `run_id`      | TEXT    | 所属工作流   |
| `session_id`  | TEXT    | 所属会话     |
| `agent_type`  | TEXT    | 类型         |
| `description` | TEXT    | 描述         |
| `phase`       | TEXT    | 阶段         |
| `label`       | TEXT    | 标签         |
| `model`       | TEXT    | 模型         |
| `state`       | TEXT    | 状态         |
| `duration_ms` | INTEGER | 耗时         |
| `tokens`      | INTEGER | Token 数     |
| `tool_calls`  | INTEGER | 工具调用次数 |

8、**`summaries` — 摘要**

**键：** `id` 是 **PK**；`session_id` 逻辑关联 `sessions.id`，并有查询索引。

| 字段         | 类型    | 说明                                    |
| ------------ | ------- | --------------------------------------- |
| `id`         | TEXT PK | 摘要 ID                                 |
| `session_id` | TEXT    | 所属会话                                |
| `timestamp`  | TEXT    | 时间                                    |
| `source`     | TEXT    | 来源 provider 或事件类型（如 `claude`、`codex`、`pi`、`compaction`、`branch_summary`） |
| `content`    | TEXT    | 摘要内容                                |

9、**`index_state` — 索引进度**

`jsonl_path` 是 **PK**，这个列名虽然叫“JSONL 路径”，但实际被当作任意状态项的唯一 key 使用：

```
普通索引单元：
jsonl_path = "/.../sessions/abc.jsonl"
              ↑ 真的是 JSONL 路径 / unit key

上次构建时间戳，用于防抖：
jsonl_path = "__last_build__"
              ↑ 不是路径，而是状态 key

App 心跳，用于判断 daemon 是否存活：
jsonl_path = "__app_heartbeat__"
              ↑ 不是路径，而是状态 key

Provider Adapter 版本标记：
jsonl_path = "__claude_canonical_transcript_v3__" / "__codex_canonical_transcript_v3__" / "__pi_canonical_transcript_v3__"
              ↑ 不是路径，而是状态 key
```

| 字段              | 类型    | 说明                                                         |
| ----------------- | ------- | ------------------------------------------------------------ |
| `jsonl_path`      | TEXT PK | 文件路径 或 特殊标记（`__last_build__`、`__app_heartbeat__`） |
| `mtime`           | REAL    | 文件修改时间或心跳时间                                       |
| `lines_processed` | INTEGER | 已处理行数                                                   |

`index_state` 不对应一种 `TranscriptRecord`。它由 `persist()` 在一个 unit 的 generator 正常结束后保存 cursor，也由编排层保存 Provider marker 和 `__last_build__` 等状态；它回答的是“已经处理到哪里”，不是“对话中发生了什么”。

10、**`memories` — 人工记忆**

**键：** `id` 是 **PK**；`session_id` 逻辑关联 `sessions.id`，`message_start` / `message_end` 分别逻辑关联 `messages.uuid` 的证据范围。`project`、`session_id`、`created_at` 有查询索引；这些关联同样不是物理 FOREIGN KEY。

| 字段             | 类型    | 说明                   |
| ---------------- | ------- | ---------------------- |
| `id`             | TEXT PK | 记忆 ID                |
| `session_id`     | TEXT    | 关联会话               |
| `project`        | TEXT    | 关联项目               |
| `message_start`  | TEXT    | 起始消息 UUID          |
| `message_end`    | TEXT    | 结束消息 UUID          |
| `path`           | TEXT    | 引用的文件路径         |
| `summary`        | TEXT    | 记忆摘要（FTS 索引列） |
| `created_at`     | TEXT    | 创建时间               |
| `deleted_at`     | TEXT    | 删除时间（软删除）     |
| `deleted_reason` | TEXT    | 删除原因               |

`memories` / `memories_fts` 也不由 Provider 产出。它们属于用户批准的长期记忆域，`createAttuneApi()` 的 `remember()` / `forget()` 写入或软删除；`query.memories()` 搜索它。二者与 Provider 事实库的连接来自 session/message anchor，而不是 `TranscriptRecord.kind = 'memory'`。这条分离保证强制重建来源索引时不会把人工记忆误当作可重放数据清空。

#### B-Tree 索引：加速 messages、memories 常用查询路径

```sql
CREATE INDEX idx_messages_session ON messages(session_id);
```

- ON messages -> 在 messages 这张表上建索引
- (session_id) -> 对 session_id 这一列建索引

意思是： 给 messages 表的 session_id 列建一个索引 ，方便按会话 ID 快速查找消息。每次查询 WHERE session_id = 'abc-123' 时走索引，不用逐行扫描整张表。

| 索引名                  | 表              | 列                      | 用途             |
| ----------------------- | --------------- | ----------------------- | ---------------- |
| `idx_messages_session`  | messages        | `session_id`            | 按会话查消息     |
| `idx_messages_agent`    | messages        | `agent_id`              | 按子代理查消息   |
| `idx_messages_ts`       | messages        | `session_id, timestamp` | 按时间排序       |
| `idx_sessions_source`   | sessions        | `source`                | 按来源筛选       |
| `idx_messages_source`   | messages        | `source`                | 按来源筛选       |
| `idx_tc_session_name`   | tool_calls      | `session_id, name`      | 按会话+工具名查  |
| `idx_tc_message`        | tool_calls      | `message_uuid`          | 按消息查工具调用 |
| `idx_tc_file`           | tool_calls      | `file_path`             | 按文件路径查历史 |
| `idx_tr_session`        | tool_results    | `session_id`            | 按会话查结果     |
| `idx_tr_message`        | tool_results    | `message_uuid`          | 按消息查结果     |
| `idx_sa_session`        | subagents       | `session_id`            | 按会话查子代理   |
| `idx_wf_session`        | workflows       | `session_id`            | 按会话查工作流   |
| `idx_wa_run`            | workflow_agents | `run_id`                | 按工作流查代理   |
| `idx_summaries_session` | summaries       | `session_id`            | 按会话查摘要     |
| `idx_memories_project`  | memories        | `project`               | 按项目查记忆     |
| `idx_memories_session`  | memories        | `session_id`            | 按会话查记忆     |
| `idx_memories_created`  | memories        | `created_at`            | 按时间排序       |

### 2 个 FTS5 虚拟表和 6 个触发器 trigger 自动同步

#### `messages_fts` 表

```sql
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  uuid UNINDEXED,                  -- 透传字段，不参与全文检索
  session_id UNINDEXED,            -- 透传字段，不参与全文检索
  text,                            -- FTS 索引列：消息文本
  content=messages,                -- 外挂 messages 表
  content_rowid=rowid);            -- 使用 messages 的 rowid 做映射
```

- **content-backed**

  正常的 FTS5 表会自己存一份数据副本，但这里用了 `content=messages`，表示 messages_fts 不存原始文本 ，直接外挂 `messages` 表，只存**倒排索引（text 词 -> rowid 的映射）**。当你 MATCH 查询时：

  1. FTS 查倒排索引找到匹配的 rowid 列表
  2. 然后自动去 messages 表读对应行的数据（SELECT * FROM messages WHERE rowid = ?）

- **只索引 `text` 列** — `uuid` 和 `session_id` 标记为 `UNINDEXED`（不参与全文检索，只做元数据透传）

- 被 `query.ts` 中的 `search()` 和 `overview()` 使用

对应三个触发器：

1、**`messages_fts_ai` — messages 插入后**

```sql
CREATE TRIGGER messages_fts_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, uuid, session_id, text)
  VALUES (new.rowid, new.uuid, new.session_id, new.text);
END;
```

新消息写入时 -> 自动将 `uuid`、`session_id`、`text` 同步到 FTS。

2、**`messages_fts_ad` — messages 删除后**

```sql
CREATE TRIGGER messages_fts_ad AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, uuid, session_id, text)
  VALUES ('delete', old.rowid, old.uuid, old.session_id, old.text);
END;
```

`INSERT INTO messages_fts(messages_fts, ...) VALUES('delete', ...)` 是 FTS5 的特殊语法，从 FTS 索引中移除对应行。

3、**`messages_fts_au` — messages 更新后**

先 delete 旧数据，再 insert 新数据，两步合在一起。

#### `memories_fts` 表

```sql
CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
  id UNINDEXED,                    -- 透传字段
  path,                            -- 文件路径（可搜索）
  summary,                         -- 摘要（可搜索）
  content=memories,                -- 外挂 memories 表
  content_rowid=rowid,
  tokenize='unicode61 remove_diacritics 1');  -- 多语言分词，去除变音符号
```

- 索引 `path` 和 `summary` 两列
- 使用 `unicode61 remove_diacritics 1` 分词器 — 去变音符号的多语言支持
- 被 `query.ts` 中的 `memories()` 使用

同样对应三个触发器：**`memories_fts_ai / _ad / _au`**

和 messages 同理，但 FTS 只索引 `id`、`path`、`summary` 三列。

### *区分 B-Tree 索引和 FTS（全文搜索）

#### B-Tree 索引

**数据结构**：平衡树（B-Tree），排好序的键值对

**用在哪**：普通 SQL 查询的 `WHERE` / `ORDER BY` / `JOIN`

```sql
-- B-Tree 索引加速这种查询：
SELECT * FROM messages WHERE session_id = 'abc-123';
-- B-Tree 在 session_id 列上排好序，二分查找 -> O(log n)，不走全表扫描

SELECT * FROM messages WHERE session_id = 'abc-123' ORDER BY timestamp;
-- 复合索引 (session_id, timestamp) 让排序也不走全表
```

**能做什么**：
- 等值匹配：`WHERE col = ?`
- 范围查询：`WHERE col > ? AND col < ?`
- 排序：`ORDER BY col`
- 前缀匹配：`WHERE col LIKE 'prefix%'`（仅前缀，`%suffix` 不行）

**不能做什么**：
- `WHERE text LIKE '%keyword%'` — 仍然全表扫描
- `WHERE text MATCH 'keyword'` — 这不是 B-Tree 的能力
- **模糊内容搜索、关键词搜索**

#### FTS（全文搜索）

**数据结构**：倒排索引（Inverted Index）— 记录"哪个词出现在哪一行"

```
倒排索引示例：
"fix"   -> 出现在 rowid 1, 5, 23
"bug"   -> 出现在 rowid 1, 87
"api"   -> 出现在 rowid 5, 42, 99
```

**用在哪**：文本内容的模糊搜索

```sql
-- FTS 加速这种查询：
SELECT * FROM messages_fts WHERE text MATCH 'fix bug';
-- 在倒排索引里找到 fix -> [1,5,23]、bug -> [1,87]，交集 -> rowid 1
```

**能做什么**：
- 关键词搜索：`MATCH 'keyword'`
- 多词组合：`MATCH 'fix AND bug'`, `MATCH 'bug OR error'`
- 短语搜索：`MATCH '"fix bug"'`
- 前缀通配：`MATCH 'fix*'`
- 近邻搜索：`MATCH 'bug NEAR/3 fix'`
- 排序：按相关性 `ORDER BY rank`

**不能做什么**：
- `=`, `>`, `<`, `ORDER BY col` — 这些还是 B-Tree 的事

#### 两者在项目中实际分工

`messages` 表有一条查询路径是**两条索引配合使用**，以 `query.ts` 中的 `search()` 为例：

```
用户搜索："修复按钮颜色"
                   │
        messages_fts MATCH '修复 按钮 颜色'
                   │
        返回匹配的 rowid 和 session_id
                   │
                   ▼
        JOIN messages 获取完整消息行
                   │
           WHERE session_id = ?
           ORDER BY timestamp     ← 走 idx_messages_ts B-Tree
                   │
                   ▼
              展示结果
```

**FTS** 负责"找出内容匹配的消息"，**B-Tree** 负责"按会话和时间的筛选排序"。当前 `search()` 会优先保留用户输入的 FTS5 语法；遇到非法语法时才退回为逐 token 加引号的安全查询。各管各的，互不替代。

|          | B-Tree 索引                                      | FTS5 全文索引                           |
| -------- | ------------------------------------------------ | --------------------------------------- |
| 数据结构 | 平衡树                                           | 倒排索引                                |
| 适用操作 | `=`, `>`, `<`, `ORDER BY`, `LIKE 'pre%'`         | `MATCH`, 关键词、短语、模糊搜索         |
| 你的用途 | 按 session_id 查消息、按时间排序、按 source 筛选 | 搜聊天记录内容、搜记忆摘要              |
| 数量     | 每个表可以有多个                                 | 每个表一个虚拟表                        |
| 维护方式 | SQLite 自动                                      | 触发器同步（你 schema.sql 里的那 6 个） |

### 数据库表关系

数据库表关系**没有通过数据库的外键约束实现**（SQLite 默认不开启外键，需要 PRAGMA foreign_keys = ON 才生效），所有的关联都是**应用层代码 persist.ts 维护的**。

**没有外键约束不影响查询**，因为查询时是你写 JOIN 来关联的：

```sql
-- 有外键或没有外键，查询写法一样
SELECT m.text, t.name
FROM messages m
JOIN tool_calls t ON t.message_uuid = m.uuid
WHERE m.session_id = 'abc';
```

**数据库表关系的本质**：`sessions` 是主会话，下面挂 messages、tools、subagents、workflows、summaries；`memories` 则通过 session/message ID 回到原始证据。

1、**`sessions -> messages -> tool_calls -> tool_results`**

意思是：会话里有消息，消息里有工具调用，工具调用有返回结果。

```
一个 session 里有很多 messages
一条 assistant message 可能发起 tool_calls
一个 tool_call 可能有 tool_result
```

具体靠这些字段关联：

```
messages.session_id = sessions.id

tool_calls.session_id = sessions.id
tool_calls.message_uuid = messages.uuid

tool_results.session_id = sessions.id
tool_results.tool_use_id = tool_calls.id
tool_results.message_uuid = messages.uuid
```

例子：

```
session s1
  message a1: assistant 说“我来读文件”
    tool_call tc1: Read /src/a.ts
      tool_result: 文件内容
```

2、**`sessions -> subagents -> messages(agent_id)`**

意思是：

```
一个 session 可以启动子 Agent
subagents 表保存子 Agent 的元信息
子 Agent 的具体对话仍然存在 messages 表里
```

靠这些字段关联：

```
subagents.session_id = sessions.id

messages.session_id = sessions.id
messages.agent_id = subagents.agent_id
```

例子：

```
session s1
  subagent agent-reviewer
    message m10: 子 Agent 的 user prompt
    message m11: 子 Agent 的 assistant 回答
```

所以 `subagents` 不是聊天内容本身，它只是子 Agent 的“名片”。真正聊天内容还是 messages，只是多了 `agent_id`。

3、**`sessions -> workflows -> workflow_agents`**

意思是：

```
一个 session 可以运行 workflow
workflows 表保存一次 workflow run 的整体信息
workflow_agents 表保存这个 workflow 里面各个 agent 的执行信息
```

靠这些字段关联：

```
workflows.session_id = sessions.id

workflow_agents.session_id = sessions.id
workflow_agents.run_id = workflows.run_id
```

例子：

```
session s1
  workflow wf1: Review workflow
    workflow_agent agent-1: inspect phase
    workflow_agent agent-2: summarize phase
```

4、**`sessions -> summaries`**

意思是：

```
一个 session 可以有摘要
```

靠字段：

```
summaries.session_id = sessions.id
```

例子：

```
session s1
  summary: 摘要内容
```

5、**`memories -> sessions/messages 作为证据锚点`**

`memories` 是用户批准沉淀的长期记忆。它不是凭空来的，应该能回到原始证据。

靠字段：

```
memories.session_id = sessions.id
memories.message_start = messages.uuid
memories.message_end = messages.uuid
```

意思是：

```
这条 memory 是从哪个 session、哪一段 message 范围总结出来的
```

例子：

```
memory: “auth bug 是因为 token refresh race condition”
  session_id = s1
  message_start = m20
  message_end = m35
```

也就是说，之后你看到这条 memory，可以回头查：

```
它是根据 s1 里 m20 到 m35 这段对话得出的
```

## 四、Persist Layer `persist.ts`

`persist()` 是唯一直接写 SQLite 的层。它消费一个 Provider 产出的 `TranscriptRecord` generator；Provider 负责把原始格式消化成规范 record，persist 只按 record 的写入语义执行 SQL。

```ts
provider.parse(unit, oldCursor)
  → yield message / tool_call / ... / session
  → return newCursor
       ↓
persist(db, unit, generator)
  → statements(db) 预编译所有语句
  → generator.next() 循环
    → write(record.kind) 按 record.kind 执行 INSERT / UPSERT / UPDATE / DELETE
      → message/tool/result/... 的预编译 statement
      → delete-session：先显式级联删除旧投影
      → session/message/tool/result/...：全量写入当前投影
  → generator 完成后 return cursor
  → cursor 非 null → 更新 index_state(unit.key, mtime, lines_processed)
  → return cursor
```

每个 IndexUnit 的 `persist()` 调用由 `provider-indexing.ts` 包在同一个 `BEGIN IMMEDIATE → COMMIT` 事务中。record 的顺序由 adapter 决定（Claude 的 session 聚合 record 通常在最后才 yield），并不是 persist 先写 session 再写 messages。

```ts
BEGIN IMMEDIATE
  -> persist(): 先写 session，再写 
  messages，再写 tool_calls，再写 
  tool_results...
  -> 所有 FK 关系在应用层通过 
  TranscriptRecord 保证
COMMIT
```

```ts
function statements(db: SqliteDb) {
  return {
    msg: db.prepare('...'), 
    tc: db.prepare('...'), 
    tr: db.prepare('...'), 
    sum: db.prepare('...'), 
    ses: db.prepare('...'), 
    sub: db.prepare('...'), 
    wf: db.prepare('...'), 
    wa: db.prepare('...'), 
    turn: db.prepare('...'), 
    idx: db.prepare('...'), 
    getSession: db.prepare('...'),
  };
}
```

### 写入策略

`statements(db)` 会预编译所有语句，但不是所有表都采用同一种 upsert。选择取决于“新 record 是否是完整快照”以及“字段是否由多个 record 分段提供”。

| 语义 | 表 / record | 冲突时行为 | 原因 |
| --- | --- | --- | --- |
| 精确 upsert | `messages` / `message` | 更新指定列 | 适用于不先删除的增量 Provider；Codex/Pi 在 session 级重建前仍要求记录写入幂等。 |
| replace 完整行 | `tool_calls`、`tool_results`、`summaries`、`sessions`、`workflows`、`index_state` | 删除旧行再插入新行 | 每次 record 已提供该行所需的完整列；`sessions` 的“新行”会先在 TS 中合并。 |
| 字段级合并 | `subagents`、`workflow_agents` | 只用非 `NULL` 新字段覆盖旧字段 | 同一实体的信息由不同来源、不同时间到达。 |
| 定点更新 / 删除 | `message-turn-duration`、`delete-session` | `UPDATE` / 多表 `DELETE` | 它们不是独立行的完整快照。 |

`INSERT OR REPLACE` 在 SQLite 中不是普通 UPDATE：发生主键/唯一键冲突时，它会先删除旧行，再插入新行。因此它只用于 persist 已经构造出完整行的场景；需要保留旧字段时，不能直接使用它。

**1、`message`：精确 upsert，不会累积旧字段**

`messages.uuid` 是主键。Claude 追加解析时可能重新看到已有 message，Codex 则每次 full-reparse 都会重新 emit 整个会话；单纯 `INSERT` 会主键冲突。

```sql
INSERT INTO messages
  (uuid, session_id, type, parent_uuid, timestamp, role, text, content_type,
   is_meta, visibility, model, agent_id, input_tokens,
   output_tokens, cwd, skill, source)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(uuid) DO UPDATE SET
  session_id=excluded.session_id,
  type=excluded.type,
  parent_uuid=excluded.parent_uuid,
  timestamp=excluded.timestamp,
  role=excluded.role,
  text=excluded.text,
  content_type=excluded.content_type,
  is_meta=excluded.is_meta,
  visibility=excluded.visibility,
  model=excluded.model,
  agent_id=excluded.agent_id,
  input_tokens=excluded.input_tokens,
  output_tokens=excluded.output_tokens,
  cwd=excluded.cwd,
  skill=excluded.skill,
  source=excluded.source;
```

也就是说：UUID 不存在就 INSERT；已存在就用本次解析到的每个 listed 字段更新。这里**没有** `COALESCE`，因为 message record 被视为完整的当前投影，旧的文本、meta 标记或 token 不应残留。

**2、`session`：先 merge，再 `INSERT OR REPLACE`**

session 是一个主 transcript 聚合后的 record。写入前 persist 会查询旧行，并在 TypeScript 里形成完整替换行：

```ts
const prev = st.getSession.get(r.id);
const message_count = r.countMode === 'delta'
  ? (prev?.message_count || 0) + r.message_count
  : r.message_count;

st.ses.run(
  r.id,
  r.title ?? prev?.title ?? null,
  r.project ?? prev?.project ?? null,
  prev?.project_path ?? null,
  minStr(prev?.started_at ?? null, r.started_at),
  maxStr(prev?.ended_at ?? null, r.ended_at),
  r.git_branch ?? prev?.git_branch ?? null,
  r.version ?? prev?.version ?? null,
  message_count,
  r.jsonl_path,
  r.source,
);
```

随后 `INSERT OR REPLACE INTO sessions (...) VALUES (...)` 写入这行。合并规则是：

- `started_at` 取旧新两者更早值，`ended_at` 取更晚值；
- title、project、branch、version 只有新值为 `null` 时才保留旧值；
- `project_path` 始终保留旧值，它由索引 finalize 的 `refreshSessionProjectPaths()` 统一计算；
- Claude 的增量尾部解析传 `countMode: 'delta'`，新增 5 条会累加到旧计数；Codex full-reparse 传 `countMode: 'total'`，本次数会直接替换旧计数，避免 20 + 25 变成错误的 45。

因此 `countMode` 是 adapter 交给 persist 的写入语义提示；除了这个增量差异，provider-specific 格式不应泄漏到 persist。

**3、`tool_call` / `tool_result`：完整关系行的 replace**

二者分别以 `tool_calls.id` 和 `tool_results.tool_use_id` 为主键，使用 `INSERT OR REPLACE`。每次 record 都提供这两张表的所有列，因此重放时直接覆盖为当前解析结果。

以 Claude 为例：assistant message `a1` 内的 tool use `tc1` 产生：

```text
messages.uuid = a1                 （承载发起调用的 assistant 消息）
tool_calls.id = tc1
tool_calls.message_uuid = a1
```

之后 user message `u2` 内的 tool result 引用 `tc1`，产生：

```text
messages.uuid = u2                 （承载工具结果的 user 消息）
tool_results.tool_use_id = tc1
tool_results.message_uuid = u2
```

关系为：

```text
messages(a1).uuid  ← tool_calls(tc1).message_uuid
tool_calls(tc1).id ← tool_results(tc1).tool_use_id
messages(u2).uuid  ← tool_results(tc1).message_uuid
```

`summaries`、`workflows` 也采用相同的完整行 replace；它们分别按 `id`、`run_id` 重放当前记录。

**4、`subagent` / `workflow_agent`：字段级合并**

这两种实体的事实会分散到不同 record。例如 spawn 元数据知道 `parent_tool_use_id` 和 description，子线程解析完成后才知道 duration 和 token。两条 record 使用同一个 `agent_id`，但都不应将对方未知字段清空。

```sql
INSERT INTO subagents (...)
VALUES (...)
ON CONFLICT(agent_id) DO UPDATE SET
  parent_tool_use_id=COALESCE(excluded.parent_tool_use_id, subagents.parent_tool_use_id),
  description=COALESCE(excluded.description, subagents.description),
  duration_ms=COALESCE(excluded.duration_ms, subagents.duration_ms),
  total_tokens=COALESCE(excluded.total_tokens, subagents.total_tokens);
```

`workflow_agents` 同理：workflow JSON 提供 phase、label、state、model、统计，而子代理 `.meta.json` 提供 `agent_type`、description；`COALESCE` 将各自已知字段合并到同一行。

**5、非“插入行”的 record**

- `message-turn-duration`：执行 `UPDATE messages SET turn_duration_ms=? WHERE uuid=?`，因为 duration 晚于 message 才出现，不创建新 message。
- `delete-session`：显式删除该 session 及其关联的 `tool_results`、`tool_calls`、`messages`、`subagents`、`workflow_agents`、`workflows`、`summaries` 和 `sessions` 行，但保留 `memories`。没有数据库级外键级联，删除顺序由 persist 维护；Pi 与 Codex 根 thread 都在全量重放前使用它。
- generator 正常结束且 cursor 非 `null`：把 `"mtime:lines"` 拆成数值，`INSERT OR REPLACE` 写入 `index_state(jsonl_path, mtime, lines_processed)`；下次 `discover()` 以此判断文件是否变化、Claude 是否能跳过已消费行。

未被 `switch (r.kind)` 覆盖的 record 会抛错，避免新增 Provider record 后静默丢数据。

## 五、query helpers `query.ts`

> CodeAct 代表了一种先进的 AI 智能体设计范式，它通过将 **“编写可执行代码”** 作为核心行动方式，极大地增强了 AI 处理复杂任务、操作数据和与外部世界交互的能力。
>
> 1. **接收任务**：智能体收到用户的自然语言指令，例如：“分析这份销售数据并生成趋势图”。
> 2. **生成代码**：智能体（大语言模型）根据指令，生成一段可执行的 **JavaScript 代码**作为它的“行动”。
> 3. **执行代码**：这段代码会被发送到一个**沙盒环境**（一个安全的隔离执行空间）中运行。
> 4. **获取反馈**：智能体收到代码执行的**结果**，可能是正确的输出，也可能是报错信息。
> 5. **迭代优化**：如果结果不正确或出现错误，智能体会根据反馈**动态修改**代码并重新执行，直到问题解决。

1、搜索流程

```ts
trajex.ts --search "xxx"
  -> core.ts searchText("xxx")
    -> buildIndex()                    // 先索引最新数据
    -> openReadDb()
    -> createQueryApi(db).search("xxx")
      -> 在 messages_fts 中全文搜索
    -> db.close()
```

2、查询流程

```ts
trajex --query <file.js>
  -> core.ts executeQuery(scriptContent)
    -> buildIndex()
    -> 启动 sandbox worker
      -> worker openReadDb()
      -> createQueryApi(db)
      -> node:vm 在受限 context 中执行脚本
         -> 沙箱内提供 sql(), search(), context(), sessions(), etc.
      -> worker finally 关闭 db
    -> 主线程接收结果并 emit() 序列化 stdout JSON
  	-> Agent 根据 JSON 回答自然语言
```

3、记忆操作流程

```ts
trajex.ts --attune <file.js>
  -> core.ts executeAttune(scriptContent)
    -> buildIndex()
    -> 启动 sandbox worker
      -> acquireWriterLease()         // worker 内获取写入锁
      -> 锁内再次检查 daemon 活跃状态
      -> openDb()
      -> BEGIN IMMEDIATE
      -> node:vm 在受限 context 中执行脚本
        -> 沙箱内仅提供 remember() / forget()
      -> COMMIT；失败则 ROLLBACK
      -> 关闭 db 并 release()
```

```ts
searchText ：无脚本 → 无沙箱；只读 → 无锁
executeQuery：有脚本 → 沙箱；只读 → 无锁
executeAttune：有脚本 → 沙箱；写库 → 锁 + 双检查
```

* 是否沙箱 = 是否有用户代码

  - searchText 没有用户代码，只是个固定内置操作 `createQueryApi(db).search(...)` 直接调，不需要 VM；

  - executeQuery / executeAttune 跑的是用户提供的脚本，必须 runInSandbox 隔离全局。

* 是否拿锁 = 是否写库

  - searchText / executeQuery 都只使用 `openReadDb()`（只读连接；executeQuery 由 sandbox worker 打开），不可能改数据，所以不需要 lease；

  - executeAttune 要写 memories，先由主线程执行 buildIndex 检查，再由 sandbox worker 完成 acquireWriterLease → 锁内复查 heartbeat → openDb → 事务执行脚本 → 关库放锁。

> vm sandbox 本质就是：Node 把 V8 的 context 单独开一个，把自己注入的全局全部撤掉。
>
> - V8 自带的东西（ JSON 、 Math 、 Array 、 Date …）在任何 context 里都在；
> - process 、 require 、 module 、 fs 、 Buffer 这些是 Node 层加进全局的，不是 V8 的 ——所以新 context 里默认没有，脚本才碰不到文件系统。sandbox 的隔离就是"去掉 Node 的注入，只留 V8 的核心"。

### Query API：只读证据检索

`createQueryApi(db)` 创建 16 个只读方法注入沙箱。全部是闭包捕获 `db`（查询 worker 打开的只读连接，生命周期由 worker 的 `finally` 管理）；返回值都是纯数据对象，脚本 `return` 后由 CLI 序列化为 JSON。

#### 输入契约与过滤机制（类型层怎么发挥作用）

**契约类型**（query.ts 顶部四个 interface，定义沙箱 API 的参数形状）：

- `QueryOptions extends Record<string, any>`：统一过滤/选项对象，几乎每个方法都接收。字段即沙箱公开参数名：`limit`（条数）、`sessionId`/`sessions[]`（单/多会话）、`project`（LIKE 模糊）、`after`/`before`（时间窗口）、`cwd`/`branch`（目录/分支）、`source`（Provider 来源，'all' 不过滤）、`includeMeta`（是否含 System 卡片）、`includeInactive`（是否含已被替代的分支证据）、`query`（FTS 检索词）、`projectLimit`/`memoryLimit`（overview 专用）。`extends Record<string, any>` 保留**宽松索引签名**：脚本可能传任意键进来，编译期不卡死，各方法只读自己关心的字段。
- `ColumnAliases`：`buildWhere` 的白名单列名映射（sessionId/project/timestamp/branch/source）——**过滤条件里出现的列名只可能来自这里，绝不来自用户输入**。
- `RememberInput` / `ForgetInput`：remember/forget 的参数契约；必填字段的校验在函数内抛错。

**参数重载**：

- `normalizeOpts`：字符串→`{ sessionId }`、数字→`{ limit }`、null/undefined→`{}`、对象原样返回；所有列查询方法共用（`sessions`/`subagents`/`workflows`/`summaries`/`memories`…）。
- `normalizeOverviewOpts`：overview 专用变体——字符串映射到 **`project`** 而非 sessionId（overview 的语义是"聚焦哪个项目"，不是"哪个会话"）。

**过滤编译**：

- `buildWhere(opts, aliases)`：把 opts 中出现的过滤字段逐个编译成 SQL 片段——`sessionId → 列=?`、`sessions[] → 列 IN (?,?,...)`、`project → 列 LIKE ?`、`after/before → 列 > ? / < ?`、`branch → 列=?`、`source → COALESCE(列,'claude')=?`——用 `AND` 连接；无过滤时兜底 `'1=1'`，调用方不必分支"有没有 WHERE"。列名只取 `aliases` 白名单（防注入），值全部走 `?` 绑定。各方法调用时传自己的别名：`sessions` 传 `s.id/s.project/s.started_at...`，`subagents`/`failures` 等需要 join `sessions` 的传 `sa.session_id` + `LEFT JOIN`。

**只读与 FTS 防护**：

- `assertReadOnlySql`：`sql()` 双重校验——只允许 `SELECT`/`WITH` 开头，且黑名单命中 `INSERT/UPDATE/DELETE/REPLACE/CREATE/DROP/ALTER/PRAGMA/VACUUM/ATTACH/DETACH` 即抛错。**它是沙箱内唯一能拿到原生 SQL 的入口，必须锁死只读**；
- `buildSafeFtsQuery`：把文本拆成 ≤12 个 token 逐个加引号，规避 FTS5 把连字符/标点误解析为运算符（`search()` 在原始 FTS 语法抛错时退回此写法）；
- `assertEnglishMemoryText`：记忆层只按英文索引，`memories()` 的 query 与 `remember()` 的 summary 含 CJK 字符直接抛错，引导先翻译术语。

#### 16 个方法一览

| 方法 | 作用 |
|---|---|
| `sql(sql, ...params)` | 受控只读 SQL 入口：先校验只读，再执行并返回全部行 |
| `search(text, opts)` | FTS5 全文检索，附带每条命中附近 ±6 条会话上下文 |
| `context(uuid)` | 单条消息 + 沿 parent_uuid 回溯父链 + session/subagent/workflow 装配 |
| `trace(uuid)` | 自底向上回溯完整父消息链（含起点本身） |
| `thread(sid, opts)` | 单 session 内按时间排序的消息（默认剔除 meta） |
| `subagents(opts)` | 子代理列表，附带各自 messageCount |
| `workflows(opts)` | workflow 运行记录（可按 project/branch/source 过滤） |
| `workflowTree(runId)` | 单个 workflow 完整树：解析 result_json + 全部 agents（带消息数） |
| `fileHistory(fp, opts)` | 按文件路径回查相关工具调用历史（含所属 session 与时间戳） |
| `failures(opts)` | 失败的工具结果（`is_error=1` 或内容以 `Exit code %` 开头），附后续消息 |
| `sessions(opts)` | session 列表，默认按 ended_at 倒序 50 条 |
| `recent(n)` | `sessions({ limit: n })` 的便捷包装 |
| `summaries(opts)` | 会话摘要列表（可附带 session 标题与 project） |
| `raw(uuid, opts)` | 调对应 Provider 的 raw lookup，从 SQLite 消息回到原始日志证据（分片 offset/limit/hasMore） |
| `memories(opts)` | 记忆检索：带 query 走 memories_fts 相关度排序，否则按创建时间倒序 |
| `overview(opts)` | 概览：解析"当前项目"（cwd→project_path 最长匹配 + messages.cwd 兼容）+ 全项目统计 |

### Attune API：memory 不是通用写库接口

`createAttuneApi(db)`（`packages/core/src/query.ts`）只暴露两个写函数，且只写 `memories` 一张表：

| 方法 | 作用 |
|---|---|
| `remember({ path, session_id, message_start, message_end, summary, project })` | 写一条记忆（INSERT OR REPLACE），返回新记录关键字段 |
| `forget({ id, reason })` | 软删除记忆（写 deleted_at/deleted_reason）；对同一 id 重复调用返回 `already_deleted` |

"不是通用写库接口"体现在三层约束：

1. **能力面极窄**：没有 `sql()`、没有任意 UPDATE/DELETE，只能"新增记忆 / 软删记忆"，碰不到 sessions、messages 等索引数据。
2. **物理隔离**：`createQueryApi` / `createAttuneApi` 是两个独立工厂；core.ts 只在 `executeQuery` 注入 Query API、只在 `executeAttune` 注入 Attune API——读能力与写能力在入口处就分家，脚本拿不到不属于自己的那套。
3. **写入本身也受限**：
   - `remember` 必填 `path` + `summary`，且 summary 必须英文（记忆层按英文索引，CJK 直接抛错，引导先翻译术语）；`path` 经 `resolveMemoryPath` 校验必须已存在且是文件（有 session_id 时以其 `project_path` 为基准，否则 cwd）；`message_start` / `message_end` 可选，用于标记同一 session 内的消息证据范围；
   - `forget` 必填 `id` + `reason`，找不到即抛错。

所以即便拿到了 Attune API，脚本能做的也只有"往记忆层追加一条、软删一条"，无法改写任何索引数据——这是 `executeAttune` 敢给它开写库连接 + 写锁的底气。

## 六、Session detail assembly：app 展示用投影 `session-detail.ts`

唯一的组装 seam，公开入口 `assembleSessionDetail()`。

这层是"原始索引事实 → 详情展示模型"的纯转换层：不碰数据库、不重新解析文本、不检查 Provider 来源。它把规范 `TranscriptRecord`（或持久化表行）投影成 renderer 直接消费的 `SessionDetailSnapshot`。

> *为什么需要 assembly ？*
>
> 数据库是规范化存储：messages / tool_calls / tool_results / subagents / workflows 各自一张表；但 UI 需要的是嵌套结构：
>
> ```text
> message
>   tool_calls[]
>     result
>     subagent
>     workflow
> ```
>
> 并且需要合并连续 thinking、相邻 tool_use，让人读起来像一条自然时间线。

### 输出契约 `SessionDetailSnapshot`

```ts
interface SessionDetailSnapshot {
  session: SessionDetailSession | null;   // 会话头（无 session 记录时为 null）
  messages: AssembledMessage[];           // 有序、已合并工具调用的消息
  workflows: SessionDetailWorkflow[];     // workflow 树，每个含 agents[]
  summaries: SessionDetailSummary[];      // 摘要列表
}
```

关键类型：

- `AssembledMessage = SessionDetailMessage + tool_calls?: AssembledToolCall[] + _thinking?: string`；
- `AssembledToolCall = { id, name, input_json, result, workflow?, subagent? }`——一个 tool call 可同时挂 result、workflow、subagent 三类附属物；
- `SessionDetailWorkflow = { run_id, parent_tool_use_id, ..., agents: SessionDetailWorkflowAgent[] }`。

### 两条输入，唯一展示语义

`assembleSessionDetail(input)` 只认两种形态：

1. **`Iterable<TranscriptRecord>`**：Provider 全新全量解析（cursor = null）的记录流；
2. **`SessionDetailRows`**：renderer/持久化层的多表行集合。先被 `sessionDetailRecordsFromRows()` **逆投影回 canonical records**——注意它会把每个 workflow 行的 `agents[]` 展开成独立的 `workflow_agent` 记录，使两条路径进入同一套组装逻辑。

用 `Symbol.iterator in input` 判据区分两种输入；之后统一进 `assembleTranscriptRecords()`。它不检查 `source`，也不再解析文本来恢复 Provider 语义——Provider 的线协议差异必须在调用这个 seam 之前已经解决。

> *为什么要支持多表行集合的输入 ？*
>
> 打开一个 **已经索引过** 的 session 详情页时，app 不去重新解析 JSONL，而是直接从 SQLite 读行、逆投影、再走同一套展示逻辑。

### `assembleTranscriptRecords(records)`

遍历记录流，按 `record.kind` 分桶处理：

| kind | 处理 |
|---|---|
| `session` | `countMode === 'delta'` 直接抛错——详情组装要求全新全量解析，不允许 delta 续读；否则写入 session 头 |
| `message` | `visibility === 'hidden'` 跳过（真正从展示中消失）；`type` 取 `type \|\| role`；`agent_id === null` 的消息记入主线程集合 |
| `tool_call` / `tool_result` / `subagent` / `workflow` / `summary` | 进各自桶，等待装配 |
| `workflow_agent` | 按 `agent_id` 合并：同一 agent 可能由多条记录补齐字段，非 null 值覆盖旧值 |
| `message-turn-duration` | 按 `uuid` 回填到已收集 message 的 `turn_duration_ms` |
| `delete-session` | 忽略（详情层不消费删除指令） |

分桶之后依次：

1. **workflow 树组装**：遍历 workflows，从合并后的 workflowAgents 里筛出 `run_id` 匹配的 agent 组成数组；`agent_count` 缺省时用 `agents.length`。
2. **主线程过滤**：**仅当 session 存在时才过滤**（`session === null` 表示无头数据，显示全部消息）——只保留 `agent_id === null` 的主线消息，subagent 消息在 subagent detail 里单独看。
3. **排序**：按 `timestamp` 升序，相同再按 `uuid` 字典序。
4. 调 `assembleMessages(...)` 做最后的合并装配，产出 `SessionDetailSnapshot`。

### `assembleMessages(...)`：UI 可读性的核心

先把扁平记录转成三个索引，再按 message_uuid 挂回：

- `resultsByCallId`：`tool_use_id → result`（剥离 kind 字段）；
- `workflowsByCallId` / `subagentsByCallId`：`parent_tool_use_id → workflow / subagent`；
- `callsByMessageUuid`：`message_uuid → AssembledToolCall[]`——每个 tool call 组装为 `{ id, name, input_json, result, workflow?, subagent? }`，一次挂齐三类附属物。

然后顺序扫描消息做**合并**（`output` 是结果数组）：

1. `content_type === 'tool_result'` 的消息**直接跳过**——它的内容已挂到对应 tool call 上，不再单独占一条时间线；
2. **assistant thinking**：连续的 thinking 合并为一个文本块；若紧跟一条非 thinking 的 assistant 消息，则整体挂到那条的 `_thinking`（折叠展示）；若没有后续正文，则单独保留为一条 thinking 消息；
3. **assistant tool_use**：合并相邻的 tool_use 消息（各自的 `tool_calls`、`text` 并到一起），中间夹着的 tool_result 直接跨过；
4. **assistant 普通正文**：吸收后面紧跟的 tool_use 的 `tool_calls`，形成"正文 + 工具调用"的一条消息；没有可吸收的调用时删除空的 `tool_calls` 字段。

这正是为什么 provider 层只需产出规范 records——最终的 UI 可读结构（合并、折叠、嵌套）全部收敛在 assembly 这一层。
