// Copyright (C) 2026 tommy0103 and contributors.
// Copyright (C) 2026 wutongyuonce and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * SQLite schema 增量迁移模块。
 *
 * 模块定位：为已存在的 Trajex 索引补充新列。openDb()
 * 在执行完整 schema 前后调用它，使旧版本数据库能渐进升级。
 */
import type { SqliteDb } from './sqlite-types.ts';

// 各表新增列的声明清单：[表名, 列名, 列定义]。
const COLUMN_MIGRATIONS = [
  ['sessions', 'source', "TEXT DEFAULT 'claude'"],
  ['messages', 'content_type', 'TEXT'],
  ['messages', 'is_meta', 'INTEGER DEFAULT 0'],
  ['messages', 'visibility', "TEXT DEFAULT 'visible'"],
  ['messages', 'source', "TEXT DEFAULT 'claude'"],
  ['workflows', 'parent_tool_use_id', 'TEXT'],
  ['memories', 'anchors', 'TEXT'],
  ['memories', 'deleted_at', 'TEXT'],
  ['memories', 'deleted_reason', 'TEXT'],
  ['summaries', 'agent_id', 'TEXT'],
] as const;

/** 判断表是否已存在，避免对不存在的表执行 ALTER 报错。 */
function tableExists(db: SqliteDb, table: string): boolean {
  return Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table));
}

export function coreSchemaNeedsMigration(db: SqliteDb): boolean {
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
 * 对旧数据库做幂等加列迁移。CREATE TABLE IF NOT EXISTS 无法给已存在表补列，故该
 * 函数在完整 schema 执行前后均可安全调用（CLI 与桌面 App 共用）。
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
