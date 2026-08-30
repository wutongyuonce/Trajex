// Copyright (C) 2026 tommy0103 and contributors.
// Copyright (C) 2026 wutongyuonce and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * SQLite 抽象类型模块。
 *
 * 模块定位：抹平 node:sqlite 与 better-sqlite3 的最小结构差异；业务层通过这些
 * 类型依赖 prepare/run/get/all，而不把某个驱动的运行时对象泄漏到 Core。
 */
// 该边界处行与绑定值都是动态的；领域记录在 parse 之后由 providers/types.ts 提供强类型。

/** 一行查询结果：动态键值对，SQLite 列名即键。 */
export type SqliteRow = Record<string, any>;

/** prepare 出的语句抽象，抹平 node:sqlite 与 better-sqlite3 的 all/get/run 差异。 */
export interface SqliteStatement {
  all(...bindings: any[]): SqliteRow[];
  get(...bindings: any[]): SqliteRow | undefined;
  run(...bindings: any[]): unknown;
  /** better-sqlite3：语句没有写入效果时为 true。 */
  readonly readonly?: boolean;
  /** node:sqlite：SQLite 实际编译的第一条语句文本。 */
  readonly sourceSQL?: string;
}

/** node:sqlite authorizer 回调的共享签名。 */
export type SqliteAuthorizer = (
  action: number,
  p1: string | null,
  p2: string | null,
  dbName: string | null,
  triggerOrView: string | null,
) => number;

/** 连接抽象。业务层只依赖共享能力，可选能力由驱动在运行时提供。 */
export interface SqliteDb {
  exec(sql: string): unknown;
  prepare(sql: string): SqliteStatement;
  close(): void;
  /** node:sqlite >= 24.10；旧版 Node 和 better-sqlite3 不提供。 */
  setAuthorizer?(callback: SqliteAuthorizer): void;
}

/** node:sqlite 驱动的扩展标记，供协调层判断当前是否处于事务中。 */
export interface NodeSqliteDb extends SqliteDb {
  readonly isTransaction: boolean;
}
