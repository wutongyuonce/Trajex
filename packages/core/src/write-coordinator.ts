// Copyright (C) 2026 tommy0103 and contributors.
// Copyright (C) 2026 wutongyuonce and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

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

/** tx.ts 写入失败时附加的诊断信息：失败阶段、错误码、事务是否存活、已尝试次数。 */
interface TransactionDiagnostics {
  phase?: string;
  code?: string | null;
  transactionActive?: boolean | null;
  attempts?: number;
}

export interface WriteRetryOptions {
  /** BEGIN 尚未执行 work，只有明确选择的短事务可重试此类忙锁。 */
  retryOnBeginBusy?: boolean;
  maxAttempts?: number;
  budgetMs?: number;
  retryDelayMs?: number;
  now?: () => number;
  sleep?: (ms: number) => void;
}

/** 提取 tx.ts 在错误对象上挂的 trajex 诊断字段，供重试决策使用。 */
function diagnostics(error: unknown): TransactionDiagnostics | null {
  if (!error || typeof error !== 'object') return null;
  return (error as { trajex?: TransactionDiagnostics }).trajex ?? null;
}

/** 只认 SQLITE_BUSY 前缀，避免把其他 SQLite 错误误判为可重试。 */
function isBusyCode(code: unknown): boolean {
  return typeof code === 'string' && code.startsWith('SQLITE_BUSY');
}

/** 同步阻塞 sleep：用 Atomics.wait 模拟，供非 async 的重试循环使用。 */
function syncSleep(ms: number): void {
  if (ms <= 0) return;
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    // 有界尝试次数仍可防止无限重试循环。
  }
}

/** BEGIN 阶段因 SQLITE_BUSY 失败且事务确未开启：此时重试安全（尚未产生副作用）。 */
export function isBeginBusyFailure(error: unknown): boolean {
  const info = diagnostics(error);
  return (
    info?.phase === 'begin' &&
    isBusyCode(info.code) &&
    info.transactionActive === false
  );
}

/** 事务状态不明或仍存活（transactionActive 不是 false）：不可安全重试。 */
export function hasUnusableTransaction(error: unknown): boolean {
  const info = diagnostics(error);
  return Boolean(info && info.transactionActive !== false);
}

/** work/commit 阶段失败且事务已明确结束：可按幂等语义重试。 */
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
  retryOnBeginBusy = false,
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
      if (!(isRetryableWriteFailure(error) || (retryOnBeginBusy && isBeginBusyFailure(error))) || attempt >= maxAttempts) throw error;
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
