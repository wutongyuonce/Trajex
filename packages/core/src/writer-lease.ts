// Copyright (C) 2026 tommy0103 and contributors.
// Copyright (C) 2026 wutongyuonce and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * 跨进程 SQLite writer lease。
 *
 * 模块定位：所有 Trajex 写操作的硬互斥锁。锁放在独立 SQLite 文件中，以便
 * node:sqlite 与 better-sqlite3 复用相同锁语义；它与 index_state heartbeat 的
 * 软所有权提示互补。
 */
// Cross-process single-writer lease shared by every Trajex mutation. The
// lock lives in a dedicated SQLite database so node:sqlite and better-sqlite3
// share identical locking semantics on every supported platform.

import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** 锁库连接的最小抽象，两种驱动均可作为 openDb 的返回类型。 */
export interface WriterLeaseDb {
  exec(sql: string): unknown;
  close(): void;
}

/** 写租约句柄；调用方用完必须调用 release() 归还硬锁。 */
export interface WriterLease {
  release(): void;
}

export interface AcquireWriterLeaseOptions {
  lockPath: string;
  openDb: (path: string) => WriterLeaseDb;
  waitMs?: number;
  retryDelayMs?: number;
  now?: () => number;
  sleep?: (ms: number) => void;
}

// SQLite 忙错误的常见文案；BEGIN IMMEDIATE 竞争时会抛出其一。
const BUSY_MESSAGE = /SQLITE_BUSY|database is locked|database is busy/i;

/** 判断错误是否属于 SQLite 忙：优先看 code 前缀，再以 message 文案兜底。 */
function isBusy(error: unknown): boolean {
  const raw = error as { code?: unknown; errcode?: unknown; message?: unknown } | null;
  const code = raw?.code ?? raw?.errcode;
  return (
    (typeof code === 'string' && code.startsWith('SQLITE_BUSY')) ||
    (typeof raw?.message === 'string' && BUSY_MESSAGE.test(raw.message))
  );
}

/** 同步阻塞 sleep：用 Atomics.wait 模拟，供非 async 的轮询循环使用。 */
function syncSleep(ms: number): void {
  if (ms <= 0) return;
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    // 同步 sleep 不可用时，上方有界的尝试次数仍能防止无限获取循环。
  }
}

/** 从主库路径派生同目录独立锁库路径，避免锁表与业务 schema 耦合。 */
export function writerLockPathFor(dbPath: string): string {
  return join(dirname(dbPath), 'writer.lock.sqlite');
}

/**
 * 尝试取得 SQLite BEGIN IMMEDIATE 写租约。成功时保持事务不提交，release() 通过
 * ROLLBACK/关闭连接释放锁；超出有限等待预算则返回 null 而非无限阻塞。
 */
export function acquireWriterLease({
  lockPath,
  openDb,
  waitMs = 0,
  retryDelayMs = 25,
  now = Date.now,
  sleep = syncSleep,
}: AcquireWriterLeaseOptions): WriterLease | null {
  mkdirSync(dirname(lockPath), { recursive: true });
  const startedAt = now();
  const maxAttempts = waitMs > 0 ? Math.ceil(waitMs / Math.max(1, retryDelayMs)) + 1 : 1;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const db = openDb(lockPath);
    try {
      db.exec('PRAGMA busy_timeout=0');
      db.exec('BEGIN IMMEDIATE');
      let released = false;
      return {
        release() {
          if (released) return;
          released = true;
          try {
            db.exec('ROLLBACK');
          } catch {
            // Closing the connection releases any remaining SQLite lock.
          } finally {
            db.close();
          }
        },
      };
    } catch (error) {
      db.close();
      if (!isBusy(error)) throw error;
      const remaining = waitMs - (now() - startedAt);
      if (remaining <= 0 || attempt + 1 >= maxAttempts) return null;
      sleep(Math.min(retryDelayMs, remaining));
    }
  }
  return null;
}
