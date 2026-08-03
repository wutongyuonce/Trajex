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
}

/** 连接抽象。业务层只依赖 exec/prepare/close，不依赖具体驱动的运行时对象。 */
export interface SqliteDb {
  exec(sql: string): unknown;
  prepare(sql: string): SqliteStatement;
  close(): void;
}

/** node:sqlite 驱动的扩展标记，供协调层判断当前是否处于事务中。 */
export interface NodeSqliteDb extends SqliteDb {
  readonly isTransaction: boolean;
}
