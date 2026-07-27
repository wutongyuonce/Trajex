/**
 * 可重试写入协调模块。
 *
 * 模块定位：位于 transaction 原语之上，为可幂等索引写入提供有限次数重试、
 * SQLite busy 判断和诊断保留；调用方仍拥有总时限与失败后的产品语义。
 */
// Core's bounded retry policy above the transaction primitive. Callers opt in only for
// idempotent work; BEGIN contention and an uncertain/live transaction are never
// retried here.

import { runWriteTransaction, type WriteTxDb, type WriteTxOptions } from './tx.ts';

interface TransactionDiagnostics {
  phase?: string;
  code?: string | null;
  transactionActive?: boolean | null;
  attempts?: number;
}

export interface WriteRetryOptions {
  maxAttempts?: number;
  budgetMs?: number;
  retryDelayMs?: number;
  now?: () => number;
  sleep?: (ms: number) => void;
}

function diagnostics(error: unknown): TransactionDiagnostics | null {
  if (!error || typeof error !== 'object') return null;
  return (error as { obelisk?: TransactionDiagnostics }).obelisk ?? null;
}

function isBusyCode(code: unknown): boolean {
  return typeof code === 'string' && code.startsWith('SQLITE_BUSY');
}

function syncSleep(ms: number): void {
  if (ms <= 0) return;
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    // Bounded attempts still prevent an infinite retry loop.
  }
}

export function isBeginBusyFailure(error: unknown): boolean {
  const info = diagnostics(error);
  return (
    info?.phase === 'begin' &&
    isBusyCode(info.code) &&
    info.transactionActive === false
  );
}

export function hasUnusableTransaction(error: unknown): boolean {
  const info = diagnostics(error);
  return Boolean(info && info.transactionActive !== false);
}

export function isRetryableWriteFailure(error: unknown): boolean {
  const info = diagnostics(error);
  return (
    (info?.phase === 'work' || info?.phase === 'commit') &&
    isBusyCode(info.code) &&
    info.transactionActive === false
  );
}

/**
 * 仅对“work 或 commit 后事务已明确结束”的 SQLITE_BUSY 有限重试。BEGIN 阶段竞争
 * 与未知存活事务交给调用方处理，避免重试造成重复或覆盖。
 */
export function runWithWriteRetry<T>(operation: () => T, {
  maxAttempts = 3,
  budgetMs = 1000,
  retryDelayMs = 25,
  now = Date.now,
  sleep = syncSleep,
}: WriteRetryOptions = {}): T {
  const startedAt = now();
  for (let attempt = 1; ; attempt += 1) {
    try {
      return operation();
    } catch (error) {
      const info = diagnostics(error);
      if (info) info.attempts = attempt;
      if (!isRetryableWriteFailure(error) || attempt >= maxAttempts) throw error;
      const remaining = budgetMs - (now() - startedAt);
      if (remaining <= 0) throw error;
      sleep(Math.min(retryDelayMs * attempt, remaining));
    }
  }
}

/** 将统一事务原语放入上述幂等重试策略，是 indexer 每个写入阶段的入口。 */
export function runRetryableWriteTransaction<T>(
  db: WriteTxDb,
  work: () => T,
  transactionOptions: WriteTxOptions = {},
  retryOptions: WriteRetryOptions = {},
): T {
  return runWithWriteRetry(
    () => runWriteTransaction(db, work, transactionOptions),
    retryOptions,
  );
}
