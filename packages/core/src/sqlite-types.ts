/**
 * SQLite 抽象类型模块。
 *
 * 模块定位：抹平 node:sqlite 与 better-sqlite3 的最小结构差异；业务层通过这些
 * 类型依赖 prepare/run/get/all，而不把某个驱动的运行时对象泄漏到 Core。
 */
// Minimal structural types shared by node:sqlite and better-sqlite3 consumers.
// SQLite rows and bindings are dynamic at this boundary; domain records become
// strongly typed after parsing, in providers/types.ts.

export type SqliteRow = Record<string, any>;

export interface SqliteStatement {
  all(...bindings: any[]): SqliteRow[];
  get(...bindings: any[]): SqliteRow | undefined;
  run(...bindings: any[]): unknown;
}

export interface SqliteDb {
  exec(sql: string): unknown;
  prepare(sql: string): SqliteStatement;
  close(): void;
}

export interface NodeSqliteDb extends SqliteDb {
  readonly isTransaction: boolean;
}
