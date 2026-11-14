// Copyright (C) 2026 tommy0103 and contributors.
// Copyright (C) 2026 wutongyuonce and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * SQLite schema 安装与增量迁移。
 *
 * 模块定位：CLI 与桌面 App 打开索引时的唯一入口（installCoreSchema）。它补齐旧库缺少的列、
 * 执行完整 schema、在需要时做一次性数据迁移，并维护 PRAGMA user_version。
 */
import { dropMessageFtsTriggers, ensureMessageFtsTriggers } from './index-finalize.ts';
import { backfillSourceLedger } from './sources.ts';
import { SCHEMA_VERSION, createSnapshotUnlessRecent, hasIndexedData, normalizeKeep } from './snapshots.ts';
import type { SqliteDb } from './sqlite-types.ts';

// 各表新增列的声明清单：[表名, 列名, 列定义]。
const COLUMN_MIGRATIONS = [
  ['sessions', 'source', "TEXT DEFAULT 'claude'"],
  ['sessions', 'source_status', "TEXT DEFAULT 'present'"],
  ['sessions', 'device_id', 'TEXT'],
  ['sessions', 'device_name', 'TEXT'],
  ['sources', 'device_id', 'TEXT'],
  ['sources', 'device_name', 'TEXT'],
  ['messages', 'content_type', 'TEXT'],
  ['messages', 'is_meta', 'INTEGER DEFAULT 0'],
  ['messages', 'visibility', "TEXT DEFAULT 'visible'"],
  ['messages', 'source', "TEXT DEFAULT 'claude'"],
  ['messages', 'source_id', 'INTEGER'],
  ['tool_calls', 'source_id', 'INTEGER'],
  ['tool_results', 'source_id', 'INTEGER'],
  ['subagents', 'source_id', 'INTEGER'],
  ['workflows', 'parent_tool_use_id', 'TEXT'],
  ['workflows', 'source_id', 'INTEGER'],
  ['workflow_agents', 'source_id', 'INTEGER'],
  ['memories', 'anchors', 'TEXT'],
  ['memories', 'deleted_at', 'TEXT'],
  ['memories', 'deleted_reason', 'TEXT'],
  ['summaries', 'agent_id', 'TEXT'],
  ['summaries', 'visibility', "TEXT DEFAULT 'visible'"],
  ['summaries', 'input_tokens', 'INTEGER'],
  ['summaries', 'output_tokens', 'INTEGER'],
  ['summaries', 'source_id', 'INTEGER'],
  ['index_state', 'cursor', 'TEXT'],
] as const;

/** 判断表是否已存在，避免对不存在的表执行 ALTER 报错。 */
function tableExists(db: SqliteDb, table: string): boolean {
  return Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table));
}

function userVersion(db: SqliteDb): number {
  return Number(Object.values(db.prepare('PRAGMA user_version').get() ?? {})[0] ?? 0);
}

/** 只读检查：旧结构（缺表、缺列或版本落后）需要先经写路径迁移。 */
export function coreSchemaNeedsMigration(db: SqliteDb): boolean {
  if (userVersion(db) < SCHEMA_VERSION || !tableExists(db, 'sources')) return true;
  const columnsByTable = new Map<string, Set<string>>();
  for (const [table, column] of COLUMN_MIGRATIONS) {
    if (!tableExists(db, table)) return true;
    let columns = columnsByTable.get(table);
    if (!columns) {
      columns = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((row) => String(row.name)));
      columnsByTable.set(table, columns);
    }
    if (!columns.has(column)) return true;
  }
  return false;
}

/**
 * 对旧数据库做幂等加列迁移。CREATE TABLE IF NOT EXISTS 无法给已存在表补列，故在完整
 * schema 执行前后各调用一次。
 */
export function migrateCoreSchemaColumns(db: SqliteDb): void {
  const columnsByTable = new Map<string, Set<string>>();
  for (const [table, column, definition] of COLUMN_MIGRATIONS) {
    if (!tableExists(db, table)) continue;
    let columns = columnsByTable.get(table);
    if (!columns) {
      columns = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((row) => String(row.name)));
      columnsByTable.set(table, columns);
    }
    if (columns.has(column)) continue;
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    columns.add(column);
  }
}

/**
 * 安装或升级索引 schema（CLI 与 App 共用）。调用方必须持有 writer lease。
 *
 * 版本落后且已有数据时，先在 snapshotDir 拍 `pre-upgrade` 快照（迁移是单向门）；
 * 再补列、执行 schema，并在一个事务里完成来源清单回填与 user_version 更新。
 */
export function installCoreSchema(
  db: SqliteDb,
  schemaSql: string,
  { snapshotDir, snapshotKeep }: { snapshotDir?: string; snapshotKeep?: number } = {},
): void {
  const version = userVersion(db);
  if (version < SCHEMA_VERSION && snapshotDir && tableExists(db, 'sessions') && hasIndexedData(db)) {
    // 先确认索引可写再拍升级前快照，避免在只读索引上留下多余快照。
    db.exec('BEGIN IMMEDIATE; COMMIT;');
    createSnapshotUnlessRecent(db, { dir: snapshotDir, reason: 'pre-upgrade', keep: normalizeKeep(snapshotKeep) });
  }
  migrateCoreSchemaColumns(db);
  db.exec(schemaSql);
  migrateCoreSchemaColumns(db);
  if (version >= SCHEMA_VERSION) return;
  const hasExistingRows = Boolean(
    db.prepare('SELECT 1 FROM sessions LIMIT 1').get()
    ?? db.prepare('SELECT 1 FROM messages LIMIT 1').get(),
  );
  if (!hasExistingRows) {
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    return;
  }
  // 回填 source_id 不改变 FTS 列，但旧库上已有的 AFTER UPDATE 触发器会对每条消息
  // 执行一次 FTS delete/insert（若旧库尚未建好 FTS 还会报错），因此回填期间临时卸下。
  dropMessageFtsTriggers(db);
  db.exec('BEGIN IMMEDIATE');
  try {
    backfillSourceLedger(db, Date.now());
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  } finally {
    ensureMessageFtsTriggers(db);
  }
}
