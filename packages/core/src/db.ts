/**
 * SQLite 连接生命周期。
 *
 * 模块定位：为 node:sqlite 提供可写、只读和 writer-lease 三种连接工厂，并负责
 * schema 初始化和 FTS 重建。桌面 App 可通过结构接口复用上层逻辑。
 */
// node:sqlite lifecycle and migrations for the Core package.
import { mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { CLAUDE_DIR, CODEX_DIR, TEXT_LIMIT, trunc, truncJson, extractText, extractContentType, extractMessageIsMeta, filePath, isDir, readLines } from './parsing.ts';
import { configureConnection } from './tx.ts';
import { migrateCoreSchemaColumns } from './schema-migrations.ts';
import type { NodeSqliteDb, SqliteDb } from './sqlite-types.ts';

const TRAJEX_DIR = join(homedir(), '.trajex');
const DB_PATH = join(TRAJEX_DIR, 'trajex.sqlite');
// 将同目录下的 schema.sql 文件内容读取为字符串，存入常量 SCHEMA 。
const SCHEMA = readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'); // new URL('./schema.sql', import.meta.url) — ESM 中获取当前文件同目录下另一个文件的 绝对 URL 。


/** 打开（必要时创建）主索引连接：建目录 → 配置 busy_timeout → 双次加列迁移。 */
function openDb(): NodeSqliteDb {
  mkdirSync(dirname(DB_PATH), { recursive: true });
  const db = new DatabaseSync(DB_PATH);
  configureConnection(db, { busyTimeoutMs: 250 });
  migrateCoreSchemaColumns(db);
  db.exec(SCHEMA);
  migrateCoreSchemaColumns(db);
  return db;
}

// Queries and daemon-arbitration checks must never migrate/configure the index.
// The caller is responsible for ensuring the database exists first.
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


export { CLAUDE_DIR, CODEX_DIR, TRAJEX_DIR, DB_PATH, TEXT_LIMIT, openDb, openReadDb, openWriterLeaseDb, rebuildMemoryFts, trunc, truncJson, extractText, extractContentType, extractMessageIsMeta, filePath, isDir, readLines };
