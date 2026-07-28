/**
 * SQLite 写事务原语与连接配置。
 *
 * 模块定位：Core 写入链的最低层事务边界。它把 CLI 使用的 `node:sqlite` 与桌面端
 * 使用的 `better-sqlite3` 适配成同一种 `BEGIN IMMEDIATE → work → COMMIT` 协议，
 * 并在失败时保留足够诊断信息，交给上层判断能否重试。
 *
 * 调用链：
 *   indexer.ts / app main indexer
 *     → write-coordinator.ts / runRetryableWriteTransaction()
 *       → 本文件 / runWriteTransaction()
 *         → persist() 或 force-cleanup / finalize 写操作
 *
 * 边界与不变量：
 * - 本文件只执行“一次事务”；不自行 sleep 或重试，避免不知道 work 是否幂等时重复写入。
 * - 失败后 rollback 只是尽力清理，绝不能覆盖最初的业务/SQLite 异常。
 * - 事务是否仍然存活是上层是否还能复用该连接的关键信号。
 * - 注入的 db 仅需 `exec(sql)`；这与 persist 层的 binding-agnostic 注入模型一致。
 *
 * 相关设计：docs/adr/0006-write-transaction-rollback-and-concurrency.md。
 */

export interface WriteTxDb {
  /** 执行事务控制语句或调用方 work 中需要的 SQL。 */
  exec(sql: string): unknown;
  /** 查询底层 binding 是否认为当前连接仍处于事务内。 */
  inTransaction(): boolean;
}

export interface SqliteConnection {
  exec(sql: string): unknown;
}

/** 出错时所在的精确阶段；重试策略据此区分“尚未开始”和“已写入后失败”。 */
type Phase = 'begin' | 'work' | 'commit' | 'rollback';

export interface WriteTxDiagnostics {
  /** 原始异常发生于 begin、用户 work、commit 或 rollback 的哪一段。 */
  phase: Phase;
  /** 规范化后的 SQLite error code；忙锁会归一成 SQLITE_BUSY。 */
  code: string | null;
  /** 调用方提供的业务标签，例如 unit 文件路径、force-cleanup、finalize。 */
  label?: string;
  /** null 表示无需 rollback 或状态无法判定；false 表示 rollback 本身失败。 */
  rollbackSucceeded: boolean | null;
  /** rollback 失败的文本，仅作诊断，不能替换原始异常。 */
  rollbackError: string | null;
  /** 清理后连接是否仍在事务中；null 表示 binding 无法查询。 */
  transactionActive: boolean | null;
  /** 此原语永远只执行一次；retry coordinator 会在外部增加此计数。 */
  attempts: number;
}

export interface WriteTxOptions {
  /** 仅用于错误诊断的事务标签，例如文件路径或 `finalize`。 */
  label?: string;
}

/** Node SQLite 有时只在 message 中暴露 busy，而不是在 code/errcode 中暴露。 */
const BUSY_MESSAGE = /SQLITE_BUSY|database is locked|database is busy/i;

/**
 * 把不同 binding 的锁竞争错误归一为 `SQLITE_BUSY`。
 *
 * 被 `runWriteTransaction()` 调用，供 write-coordinator 区分可延迟的 BEGIN 竞争、
 * 可重放的 work/commit 竞争，以及不能继续使用连接的异常状态。
 */
function busyCode(error: unknown): string | null {
  const raw = error as { code?: unknown; errcode?: unknown; message?: unknown } | null;
  const code = (raw?.code ?? raw?.errcode);
  if (typeof code === 'string' && code.startsWith('SQLITE_BUSY')) return code;
  if (typeof raw?.message === 'string' && BUSY_MESSAGE.test(raw.message)) return 'SQLITE_BUSY';
  return null;
}

/** 读取非 busy 情况下 binding 暴露的原始 code，避免诊断信息丢失。 */
function errorCode(error: unknown): string | null {
  const raw = error as { code?: unknown } | null;
  return typeof raw?.code === 'string' ? raw.code : null;
}

interface BetterSqliteHandle {
  exec(sql: string): unknown;
  readonly inTransaction: boolean;
}

interface NodeSqliteHandle {
  exec(sql: string): unknown;
  readonly isTransaction: boolean;
}

/**
 * 将 better-sqlite3 的只读 `inTransaction` 属性适配为统一方法接口。
 *
 * 调用方：Electron app 的 `app/src/main/indexer.ts`。
 * 这样 `runWriteTransaction()` 无需知道底层状态是属性还是 node:sqlite 的属性名。
 */
export function betterSqliteTransactionAdapter(db: BetterSqliteHandle): WriteTxDb {
  return {
    exec: sql => db.exec(sql),
    inTransaction: () => db.inTransaction,
  };
}

/**
 * 将 node:sqlite 的 `isTransaction` 属性适配为统一方法接口。
 *
 * 调用方：CLI/Core `indexer.ts`。两个 adapter 只做形状转换，不改变连接所有权。
 */
export function nodeSqliteTransactionAdapter(db: NodeSqliteHandle): WriteTxDb {
  return {
    exec: sql => db.exec(sql),
    inTransaction: () => db.isTransaction,
  };
}

/**
 * 防御性读取事务状态。
 *
 * 某些 native error 后 binding 可能无法可靠读取状态；此时返回 null，而不是把未知
 * 错当作“已安全回滚”。write-coordinator 会把 null 视为连接不可安全复用。
 */
function transactionState(db: WriteTxDb): boolean | null {
  try {
    return db.inTransaction();
  } catch {
    return null;
  }
}

/**
 * 将结构化诊断挂到原始 Error 的 `trajex` 扩展字段。
 *
 * 这里刻意不创建包装 Error：上层仍需看到 SQLite 原始 message/stack。冻结对象或
 * native Error 不允许写字段时直接忽略，随后照常抛回原异常。
 */
function attachDiagnostics(error: unknown, diagnostics: WriteTxDiagnostics): void {
  if (!error || typeof error !== 'object') return;
  try {
    (error as { trajex?: WriteTxDiagnostics }).trajex = diagnostics;
  } catch {
    // frozen/native Error 不可扩展时，仍需原样抛出，不能因记录诊断再次失败。
  }
}

/**
 * 精确执行一次 `BEGIN IMMEDIATE → work → COMMIT`，失败时尽力 rollback。
 *
 * 定位：所有索引 unit、force-cleanup、finalize 的原子写入原语。
 * 调用方：`write-coordinator.ts/runRetryableWriteTransaction()`；它拥有重试次数、
 * 等待时间和幂等性策略，本函数绝不重放 work。
 *
 * 为什么使用 BEGIN IMMEDIATE：在执行 work 前就尝试取得 SQLite 的保留写锁，避免读完
 * 来源后到 commit 才发现写锁冲突，并使“BEGIN 阶段 busy”可被上层明确分类为 deferred。
 *
 * @param db 已由对应 binding adapter 包装的连接
 * @param work 同步写入工作；成功时返回值会透明返回给调用方
 * @param options 可选诊断标签
 * @returns work 的返回值
 * @throws 始终抛出原始异常，但可在 `error.trajex` 读取 WriteTxDiagnostics
 */
export function runWriteTransaction<T>(db: WriteTxDb, work: () => T, options: WriteTxOptions = {}): T {
  const { label } = options;
  let phase: Phase = 'begin';
  try {
    // 先拿写锁；若这里 BUSY，work 从未执行，外层可安全延后整个 build。
    db.exec('BEGIN IMMEDIATE');

    // work 通常是 provider.parse() → persist()；它抛错表示本 unit 的写入不可提交。
    phase = 'work';
    const value = work();

    // 仅在 work 完整结束后提交；commit 也可能因 I/O/锁竞争失败。
    phase = 'commit';
    db.exec('COMMIT');
    return value;
  } catch (error) {
    let rollbackSucceeded: boolean | null = null;
    let rollbackError: string | null = null;
    // binding 已自动 rollback 时状态为 false，无需再发 ROLLBACK；未知状态则宁可尝试
    // 一次清理，把最终是否仍活动如实交给上层，避免默认为安全。
    const activeBeforeRollback = transactionState(db);
    if (activeBeforeRollback !== false) {
      try {
        db.exec('ROLLBACK');
        rollbackSucceeded = true;
      } catch (rollbackFailure) {
        rollbackSucceeded = false;
        rollbackError = rollbackFailure instanceof Error ? rollbackFailure.message : String(rollbackFailure);
      }
    }
    // 清理结果只进入诊断；最初捕获的 error 才是必须保留的失败原因。
    const busy = busyCode(error);
    const diagnostics: WriteTxDiagnostics = {
      phase,
      code: busy ?? errorCode(error),
      label,
      rollbackSucceeded,
      rollbackError,
      transactionActive: transactionState(db), // rollback 后仍 active/unknown 时禁止继续复用连接
      attempts: 1,
    };
    attachDiagnostics(error, diagnostics);
    throw error;
  }
}

/**
 * 为所有读写连接设置一致的 SQLite PRAGMA。
 *
 * 调用方：Core `db.ts/openDb()` 与 app `indexer.ts/openIndexDb()`。
 * 使用 `exec()` 而不是 better-sqlite3 专有的 `.pragma()`，从而同一实现覆盖两种 binding。
 *
 * - `busy_timeout`：锁竞争时的短暂等待；node:sqlite 没有合适默认值，better-sqlite3 也
 *   显式设置以避免两端行为漂移。
 * - `journal_mode=WAL`：允许读者与单一 writer 更好地并行，适合本地索引的读多写少模型。
 * - `synchronous=NORMAL`：在 WAL 下平衡落盘安全与索引吞吐。
 *
 * busy_timeout 不是并发正确性机制；跨进程“最多一个 writer”仍由 writer lease 保证。
 */
export function configureConnection(db: SqliteConnection, { busyTimeoutMs = 5000 } = {}): void {
  db.exec(`PRAGMA busy_timeout=${busyTimeoutMs}`);
  db.exec('PRAGMA journal_mode=WAL');
  db.exec('PRAGMA synchronous=NORMAL');
}
