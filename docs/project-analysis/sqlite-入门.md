# SQLite 入门：以 Trajex 为例

SQLite 是嵌入式关系型数据库：数据保存在一个文件中，应用直接打开这个文件执行 SQL，不需要单独部署数据库服务。Trajex 将本地 Agent 会话索引保存在 `~/.trajex/trajex.sqlite`。

本文以项目的实际代码为准，介绍一套够用的 SQLite 使用方式：双驱动适配、建表、写入、查询、全文搜索、迁移和并发写入。

## 1. 本项目中的 SQLite 分层

```text
schema.sql              定义新数据库的表、索引、FTS 和触发器
schema-migrations.ts    为已有数据库补充新增列
db.ts                   打开数据库并完成初始化
sqlite-types.ts         抹平 node:sqlite 与 better-sqlite3 的最小结构类型
tx.ts                   统一事务原语、连接 PRAGMA，以及双驱动适配
persist.ts              把 TranscriptRecord 写入表
query.ts                执行只读查询
writer-lease.ts         跨进程保证同一时间只有一个写入者
```

最小心智模型是：`schema` 定义数据，`sqlite-types.ts` 定义"驱动无关的最小接口"，`prepare` 预编译带参数的 SQL，`run` 写入，`get/all` 读取，`tx.ts` 保证一组写入要么全成功、要么全失败。

## 2. 双驱动适配：node:sqlite 与 better-sqlite3

Trajex 有两套运行环境，各自使用不同的 SQLite 驱动：

- **CLI / Core**：使用 Node 22+ 自带的 `node:sqlite`。
- **桌面 App**：Electron 打包的 Node 运行时没有 `node:sqlite`，改用 `better-sqlite3`。

Core 的解析、持久化、事务协调层都**不绑定具体驱动**。靠两层抽象：

### 2.1 结构类型：`sqlite-types.ts`

它只声明业务层依赖的"最小公共面"，不引入任何驱动的运行时对象：

```ts
export type SqliteRow = Record<string, any>;              // 一行查询结果，列名即键

export interface SqliteStatement {
  all(...bindings: any[]): SqliteRow[];                   // 多行
  get(...bindings: any[]): SqliteRow | undefined;         // 单行
  run(...bindings: any[]): unknown;                       // 写入
}

export interface SqliteDb {
  exec(sql: string): unknown;                             // 执行 DDL / 批处理
  prepare(sql: string): SqliteStatement;
  close(): void;
}

export interface NodeSqliteDb extends SqliteDb {
  readonly isTransaction: boolean;                        // 仅 node:sqlite 有
}
```

要点：

- 两个驱动在 `prepare/run/get/all/exec` 上 API 兼容，这是能共用同一套 Core 写库代码的前提。
- `NodeSqliteDb.isTransaction` 是 node:sqlite 扩展标记，供协调层判断当前是否在事务中。
- better-sqlite3 对应的状态属性叫 `inTransaction`（不是 `isTransaction`）——这个属性名差异正是适配层要抹平的。

### 2.2 事务边界适配：`tx.ts`

事务原语 `runWriteTransaction()` 不直接接收驱动对象，而是接收统一接口：

```ts
export interface WriteTxDb {
  exec(sql: string): unknown;        // 事务控制语句或 work 中的 SQL
  inTransaction(): boolean;          // 查询底层 binding 是否仍处于事务内
}
```

`tx.ts` 提供两个形状转换 adapter，把驱动的状态**属性**包装成统一**方法**，并转发 `exec`：

```ts
// CLI / Core：node:sqlite 的 isTransaction
export function nodeSqliteTransactionAdapter(db: NodeSqliteHandle): WriteTxDb {
  return {
    exec: sql => db.exec(sql),
    inTransaction: () => db.isTransaction,
  };
}

// 桌面 App：better-sqlite3 的 inTransaction
export function betterSqliteTransactionAdapter(db: BetterSqliteHandle): WriteTxDb {
  return {
    exec: sql => db.exec(sql),
    inTransaction: () => db.inTransaction,
  };
}
```

调用方：Core 的 `indexer.ts` 用 `nodeSqliteTransactionAdapter`，app 的 `app/src/main/indexer.ts` 用 `betterSqliteTransactionAdapter`。两者只做形状转换，不改变连接所有权。

连接配置同样驱动无关：`configureConnection()` 用 `exec()` 执行 PRAGMA，而不是 better-sqlite3 专有的 `.pragma()`，所以同一实现覆盖两种 binding。

> 结论：**业务层只见 `sqlite-types.ts` 的最小类型和 `tx.ts` 的 `WriteTxDb`**；换驱动时只需在入口处换一个 adapter 调用。

## 3. 单驱动最小方案：只用 node:sqlite 的 SOP

如果只有一套运行时（比如纯 CLI 或纯桌面应用），不需要 `sqlite-types.ts` 的抽象、不需要 `tx.ts` 的两个 adapter，也不需要 writer-lease。直接拿一个连接对象从头用到尾，最小流程如下：

```ts
// 1. 打开连接。Node 22+ 的 ESM 可直接 import；项目用 createRequire 是为兼容打包环境
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync('/path/to/app.sqlite');

// 2. 配置连接（可选但推荐）：WAL 提升读多写少场景的并行，busy_timeout 应对短暂竞争
db.exec('PRAGMA journal_mode=WAL');
db.exec('PRAGMA busy_timeout=250');

// 3. 建表：IF NOT EXISTS 让建表可重复执行（这也是项目把 DDL 集中到 schema.sql 的原因）
db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    uuid TEXT PRIMARY KEY,
    session_id TEXT,
    timestamp TEXT,
    text TEXT
  )
`);

// 4. 写入：prepare 预编译一次、run 绑定参数多次，绝不拼字符串
const insert = db.prepare(
  'INSERT INTO messages (uuid, session_id, timestamp, text) VALUES (?, ?, ?, ?)'
);
insert.run(uuid, sessionId, timestamp, text);

// 5. 读取：get 单行 / all 多行，公开查询永远带 LIMIT
const thread = db.prepare(
  'SELECT * FROM messages WHERE session_id=? ORDER BY timestamp LIMIT ?'
).all(sessionId, 50);

// 6. 一组写入用事务：BEGIN IMMEDIATE 先拿写锁，任一步失败整体回滚
db.exec('BEGIN IMMEDIATE');
try {
  insert.run(a, s1, t1, x1);
  insert.run(b, s1, t2, x2);
  db.exec('COMMIT');
} catch (error) {
  db.exec('ROLLBACK');
  throw error;
}

// 7. 用完关闭（放 finally 里保证）
db.close();
```

对照 Trajex 的分层，单驱动时它们各自折叠成什么：

| Trajex 分层 | 单驱动最小做法 |
|---|---|
| `sqlite-types.ts` | 不需要：只有一个驱动，没有形状差异要抹平 |
| `tx.ts` 两个 adapter | 不需要：`db.exec('BEGIN IMMEDIATE')` 直接写在调用处即可 |
| `writer-lease.ts` | 不需要：单进程内 SQLite 自己保证同一时刻只有一个 writer |
| `db.ts` / `schema.sql` | 仍建议保留：建表 DDL 集中、可重复执行 |
| `persist.ts` / `query.ts` | 仍建议保留：写 SQL 集中在少数文件，全部参数绑定 |

什么时候才需要升级到 Trajex 那套：出现第二套运行时（如桌面 App 没有 `node:sqlite` 要用 `better-sqlite3`）、出现跨进程写入、或需要事务失败重试策略时，再引入对应分层。

## 4. 打开并初始化数据库

CLI/Core 使用 Node 22+ 自带的 `node:sqlite`。项目是 ESM，因此通过 `createRequire` 加载它：

```ts
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync('/tmp/example.sqlite');
```

实际项目把初始化收敛在 `packages/core/src/db.ts` 的 `openDb()`：先创建目录，配置连接，再执行 schema。`CREATE TABLE IF NOT EXISTS` 使这件事可重复执行。

```ts
db.exec('PRAGMA busy_timeout=250');
db.exec('PRAGMA journal_mode=WAL');
db.exec('PRAGMA synchronous=NORMAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS notes (
    id TEXT PRIMARY KEY,
    body TEXT NOT NULL,
    created_at TEXT NOT NULL
  )
`);
```

- `WAL` 适合 Trajex 这类本地读多写少场景：读者通常不阻塞单个写者。
- `busy_timeout` 只是在锁短暂竞争时等待；它不是并发正确性的替代品。
- 只读查询应打开只读连接。Trajex 的 `openReadDb()` 不建表、不迁移，避免查询意外改库。
- 桌面 App 打开的是同一份 schema，用 better-sqlite3 驱动；建表、迁移逻辑两边共用。

## 5. 建表、主键和索引

`packages/core/src/schema.sql` 用 `sessions`、`messages` 等表保存规范化数据。一个简化版的会话与消息关系如下：

```sql
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  title TEXT,
  started_at TEXT
);

CREATE TABLE IF NOT EXISTS messages (
  uuid TEXT PRIMARY KEY,
  session_id TEXT,
  timestamp TEXT,
  text TEXT
);

CREATE INDEX IF NOT EXISTS idx_messages_session_time
  ON messages(session_id, timestamp);
```

主键保证唯一性；索引应对应真实查询条件。Trajex 常按 `session_id` 查消息并按时间排序，因此原项目有 `messages(session_id, timestamp)` 索引。不要为每一列都建索引：索引会占空间，也会增加写入成本。

本项目没有依赖 SQLite 外键级联删除，而是在 `persist.ts` 的 `deleteSession()` 明确按依赖顺序删掉工具结果、工具调用、消息等数据。这意味着：若你采用外键，应显式执行 `PRAGMA foreign_keys=ON`；若不采用，就把删除规则集中在一个地方。

## 6. 安全写入：参数绑定和 upsert

绝不把外部数据拼进 SQL 字符串。使用 `?` 占位符，再把值传给 `.run()`：

```ts
const insert = db.prepare(
  'INSERT INTO messages (uuid, session_id, timestamp, text) VALUES (?, ?, ?, ?)'
);
insert.run(uuid, sessionId, timestamp, text);
```

Trajex 的解析可重复运行，因此 `persist.ts` 对消息使用 upsert：相同 `uuid` 再次出现时更新，而不是插入重复行。

```ts
const saveMessage = db.prepare(`
  INSERT INTO messages (uuid, session_id, timestamp, text)
  VALUES (?, ?, ?, ?)
  ON CONFLICT(uuid) DO UPDATE SET
    session_id=excluded.session_id,
    timestamp=excluded.timestamp,
    text=excluded.text
`);
saveMessage.run(uuid, sessionId, timestamp, text);
```

`INSERT OR REPLACE` 也能实现"同键覆盖"，项目用于部分完整记录；但它的语义是删除旧行再插新行，可能影响关联数据和触发器。需要保留未提供的旧字段时，优先使用 `ON CONFLICT DO UPDATE`，并按 Trajex 对 `subagents` 所做的那样用 `COALESCE(excluded.column, table.column)` 合并。

## 7. 读取：`get`、`all` 和分页

`get()` 用于单行，`all()` 用于多行。查询同样必须参数绑定：

```ts
const message = db.prepare('SELECT * FROM messages WHERE uuid=?').get(uuid);

const thread = db.prepare(`
  SELECT * FROM messages
  WHERE session_id=?
  ORDER BY timestamp
  LIMIT ? OFFSET ?
`).all(sessionId, limit, offset);
```

Trajex 的 `query.ts` 将 SQL 限制在只读范围，并为公开查询接口加入 `LIMIT`。这是本地库也值得保留的边界：避免调用方无意扫描所有历史记录，或把任意写 SQL 暴露到查询入口。

## 8. 全文搜索：FTS5 和触发器

`LIKE '%词%'` 会随着数据量增长变慢。Trajex 为 `messages` 和 `memories` 建立 FTS5 虚拟表，并用触发器在原表变更后同步索引。

```sql
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  uuid UNINDEXED,
  text,
  content=messages,
  content_rowid=rowid
);

CREATE TRIGGER IF NOT EXISTS messages_fts_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, uuid, text)
  VALUES (new.rowid, new.uuid, new.text);
END;
```

查询时用 `MATCH`，而不是 `LIKE`：

```ts
const hits = db.prepare(`
  SELECT m.*, f.rank
  FROM messages_fts f
  JOIN messages m ON m.rowid=f.rowid
  WHERE messages_fts MATCH ?
  ORDER BY f.rank
  LIMIT ?
`).all('sqlite AND transaction', 20);
```

因为这里是 content-backed FTS，普通消息增删改由 trigger 同步，不需要每次重建。Trajex 只在首次建立 readiness marker 或 force/canonical rebuild 修复完整索引时执行：

```sql
INSERT INTO messages_fts(messages_fts) VALUES('rebuild');
```

普通增量索引会直接跳过这条全量命令；`__fts_triggers_ready__` 表示两张 FTS 已完成首次建立。force rebuild 仍无条件重建，作为派生索引损坏时的完整修复路径。

## 9. 原子写入：事务

一次索引会写入会话、消息、工具调用和进度；其中任何一步失败，都不应留下半套数据。Trajex 在 `tx.ts` 中统一使用：

```ts
db.exec('BEGIN IMMEDIATE');
try {
  persist(db, unit);
  db.exec('COMMIT');
} catch (error) {
  if (db.isTransaction) db.exec('ROLLBACK');
  throw error;
}
```

真实的 `tx.ts/runWriteTransaction()` 与上面等价但更严格，且**接收的是适配后的 `WriteTxDb`**，所以 CLI（node:sqlite）与桌面 App（better-sqlite3）共用同一事务原语：

- `BEGIN IMMEDIATE` 会在执行写入前尝试取得写锁，能更早发现写者竞争；若此阶段 BUSY，work 从未执行，外层可安全延后整个 build。
- 失败时尽力 `ROLLBACK`，但 rollback 结果只进诊断（`error.trajex`），绝不覆盖最初的异常。
- 诊断记录 `phase`（begin/work/commit/rollback）、归一化的 `code`（锁竞争统一成 `SQLITE_BUSY`）、`transactionActive` 等，交给 write-coordinator 判断"能否安全重试"。
- 重试放在外层协调器（`write-coordinator.ts` 的 `runRetryableWriteTransaction`）；不要在一个不知道写入是否幂等的底层函数里悄悄重试。

SQLite 同一时刻只能有一个 writer。WAL 改善读写并行，但不能让多个 writer 同时安全写入。Trajex 因此另用 `writer.lock.sqlite` 的事务 lease 做跨进程互斥；普通单进程应用不需要先照搬这层，出现多个写进程时再加。

## 10. 旧数据库升级：schema 与迁移分开

把新列加入 `CREATE TABLE IF NOT EXISTS` 不会修改已存在的表。因此 Trajex 另有幂等迁移：先查看 `PRAGMA table_info`，确认缺列后才 `ALTER TABLE ... ADD COLUMN`。

```ts
const columns = new Set(
  db.prepare('PRAGMA table_info(messages)').all().map(row => String(row.name))
);
if (!columns.has('source')) {
  db.exec("ALTER TABLE messages ADD COLUMN source TEXT DEFAULT 'claude'");
}
```

项目在执行完整 schema 前后各跑一次迁移：前一次升级旧表，后一次覆盖刚创建的新表。这个模式只适合"加列"演进；涉及删除列、改类型或搬迁数据时，应写带版本和数据迁移的专门步骤，并先备份数据库。

## 11. 适合 Trajex 的最小检查清单

1. 新库：改 `packages/core/src/schema.sql`，并让 DDL 可重复执行。
2. 旧库兼容：新增列同时改 `packages/core/src/schema-migrations.ts`。
3. 写入：在 `persist.ts` 集中准备 SQL，全部使用参数绑定。
4. 驱动无关：新增 SQL/写法前，确认它落在 `sqlite-types.ts` 的最小接口内；事务状态读取走 `tx.ts` 的 adapter，不直接读驱动专有属性。
5. 查询：根据真实 `WHERE` / `ORDER BY` 添加索引，结果始终限制数量。
6. 搜索：文本检索使用 FTS5；改动 content-backed 表后确认 FTS 是否同步或需要 rebuild。
7. 多写者：写入放进事务；出现跨进程写入时再引入 lease 和明确重试策略。
