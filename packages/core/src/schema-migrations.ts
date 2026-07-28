/**
 * SQLite schema 增量迁移模块。
 *
 * 模块定位：为已存在的 Trajex 索引补充新列，不重建数据表。openDb() 在执行完整
 * schema 前后调用它，使旧版本数据库能渐进升级。
 */
import type { SqliteDb } from './sqlite-types.ts';

const COLUMN_MIGRATIONS = [
  ['sessions', 'source', "TEXT DEFAULT 'claude'"],
  ['messages', 'content_type', 'TEXT'],
  ['messages', 'is_meta', 'INTEGER DEFAULT 0'],
  ['messages', 'visibility', "TEXT DEFAULT 'visible'"],
  ['messages', 'source', "TEXT DEFAULT 'claude'"],
  ['tool_calls', 'presentation', "TEXT DEFAULT 'default'"],
  ['workflows', 'parent_tool_use_id', 'TEXT'],
  ['memories', 'anchors', 'TEXT'],
  ['memories', 'deleted_at', 'TEXT'],
  ['memories', 'deleted_reason', 'TEXT'],
] as const;

function tableExists(db: SqliteDb, table: string): boolean {
  return Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table));
}

/** Binding-agnostic additive migrations shared by the CLI and desktop app. */
/**
 * 对旧数据库做幂等加列迁移。CREATE TABLE IF NOT EXISTS 无法给已存在表补列，故该
 * 函数在完整 schema 执行前后均可安全调用。
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
