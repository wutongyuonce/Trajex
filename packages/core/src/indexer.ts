// Copyright (C) 2026 tommy0103 and contributors.
// Copyright (C) 2026 wutongyuonce and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * CLI 侧索引构建入口。
 *
 * 模块定位：在 node:sqlite 上取得写入所有权（App heartbeat 软所有权 + 跨进程 writer
 * lease），探测索引可写，再把一次构建交给 index-build.ts 的共享流程；不理解任何具体
 * Provider 格式。
 */
import { existsSync } from 'node:fs';
import { DB_PATH, TRAJEX_DIR, openDb, openReadDb, openWriterLeaseDb } from './db.ts';
import { healWorkflowParentLinks, runProviderBuild } from './index-build.ts';
import { refreshSessionProjectPaths } from './index-finalize.ts';
import { inferProjectPath } from './parsing.ts';
import { createBuiltinProviderRegistry } from './providers/builtins.ts';
import { coreSchemaNeedsMigration } from './schema-migrations.ts';
import { readSnapshotSettings, snapshotDirFor } from './snapshots.ts';
import { nodeSqliteTransactionAdapter } from './tx.ts';
import { acquireWriterLease, writerLockPathFor } from './writer-lease.ts';
import { runRetryableWriteTransaction, isBeginBusyFailure, hasUnusableTransaction } from './write-coordinator.ts';
import type { NodeSqliteDb } from './sqlite-types.ts';

/** 单个失败 unit 的摘要：路径 + 错误消息 + 可选 trajex 诊断。 */
interface SkippedFile {
  path: string;
  error: string;
  diagnostics?: unknown;
}

/** buildIndex 检查阶段的配置：可注入时钟与是否忽略最近 build 防抖。 */
interface BuildCheckOptions {
  now?: number;
  ignoreRecentBuild?: boolean;
}

/** 统一把任意错误转成可打印字符串（诊断信息保留在错误对象的 trajex 字段）。 */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** node:sqlite 给出数字（可能为扩展）结果码，其他绑定用 SQLITE_READONLY*；不按 Provider 文案归类。 */
function isReadOnlyFailure(error: unknown): boolean {
  const detail = error as { code?: unknown; errcode?: unknown } | null;
  return (typeof detail?.errcode === 'number' && (detail.errcode & 0xff) === 8)
    || (typeof detail?.code === 'string' && /^SQLITE_READONLY(?:_|$)/.test(detail.code));
}

/**
 * 把索引访问边界上的只读/无法打开/权限拒绝错误包装成指明索引路径的错误，并保留原始错误。
 * 其他错误原样返回；不切换到旧结果、不自动改权限、不选择备用索引。
 */
function indexAccessFailure(error: unknown): unknown {
  const detail = error as { code?: unknown; errcode?: unknown; trajex?: unknown } | null;
  const readOnly = isReadOnlyFailure(error);
  const cantOpen = (typeof detail?.errcode === 'number' && (detail.errcode & 0xff) === 14)
    || (typeof detail?.code === 'string' && /^SQLITE_CANTOPEN(?:_|$)/.test(detail.code));
  const denied = typeof detail?.code === 'string' && ['EACCES', 'EPERM', 'EROFS'].includes(detail.code);
  if (!readOnly && !cantOpen && !denied) return error;
  const failure = Object.assign(new Error(
    `Cannot ${readOnly ? 'refresh' : 'access'} the Trajex index at ${DB_PATH}: ${errorMessage(error)}. `
    + (readOnly ? 'The index database, its directory and writer-lease file must be writable; ' : '')
    + 'if this command is sandboxed, retry the same command with host-approved permissions.',
    { cause: error },
  ), { code: detail?.code, errcode: detail?.errcode, trajex: detail?.trajex });
  if (error instanceof Error) failure.stack += `\nCaused by: ${error.stack}`;
  return failure;
}

/** 执行一次不改变任何行的写事务：只读文件也能以读写模式打开，必须实际写一次才能确认。 */
function probeIndexWritability(db: NodeSqliteDb): void {
  runRetryableWriteTransaction(nodeSqliteTransactionAdapter(db), () => {
    db.prepare('UPDATE index_state SET mtime=mtime WHERE 0').run();
  }, { label: 'index-writability' });
}

/**
 * 单元级只读错误不一定来自索引（Provider 可能只读打开来源库）。安全回滚后探测共享 writer，
 * 确认是索引不可写才整体中止；事务状态不确定时不再开启新事务。
 */
function rethrowIfIndexWriterReadOnly(db: NodeSqliteDb, error: unknown): void {
  if (!isReadOnlyFailure(error)) return;
  if (hasUnusableTransaction(error)) throw error;
  try {
    probeIndexWritability(db);
  } catch (probeError) {
    if (isReadOnlyFailure(probeError)) throw indexAccessFailure(error);
    // 探测以其他方式失败时归因未知：保留原始错误并中止，而不是掩盖它继续执行。
    throw error;
  }
}

const BUILD_DEBOUNCE_MS = 30000;
const APP_HEARTBEAT_FRESH_MS = 60000;

/**
 * 根据 App heartbeat 与最近 build 标记决定是否跳过。heartbeat 是软所有权提示；
 * writer-lease 才是跨进程硬互斥。
 */
function shouldSkipBuild(db: NodeSqliteDb, { now = Date.now(), ignoreRecentBuild = false }: BuildCheckOptions = {}) {
  const appHeartbeat = db.prepare("SELECT mtime FROM index_state WHERE jsonl_path='__app_heartbeat__'").get();
  if (appHeartbeat && now - appHeartbeat.mtime < APP_HEARTBEAT_FRESH_MS) {
    return { skip: true, reason: 'daemon_active' };
  }
  if (!ignoreRecentBuild) {
    const last = db.prepare("SELECT mtime FROM index_state WHERE jsonl_path='__last_build__'").get();
    if (last && now - last.mtime < BUILD_DEBOUNCE_MS) {
      return { skip: true, reason: 'recent_build' };
    }
  }
  return { skip: false };
}

/** 错误是否为缺少 index_state 表（首次初始化/旧库场景，允许写路径继续）。 */
function isMissingIndexStateTable(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /no such table:\s*(?:main\.)?index_state\b/i.test(message);
}

/** 只读预检查写入所有权；新库缺 index_state 时允许写路径初始化。 */
function inspectBuildOwnership(options: { force?: boolean } = {}) {
  try {
    return readBuildOwnership(options);
  } catch (error) {
    throw indexAccessFailure(error);
  }
}

function readBuildOwnership({ force = false }: { force?: boolean } = {}) {
  if (!existsSync(DB_PATH)) return { skip: false };
  const db = openReadDb();
  try {
    const ownership = shouldSkipBuild(db, { ignoreRecentBuild: force });
    if (!ownership.skip || ownership.reason === 'daemon_active') return ownership;
    return coreSchemaNeedsMigration(db) ? { skip: false } : ownership;
  } catch (error) {
    // A missing table means the write path must initialize a new/legacy index.
    // Any other read failure leaves daemon ownership unknown, so fail closed.
    if (isMissingIndexStateTable(error)) return { skip: false };
    throw error;
  } finally {
    db.close();
  }
}

/**
 * 查询入口的 schema 就绪门：只读检查发现旧结构时，先尊重 daemon 软所有权，
 * 再尝试取得 writer lease 并通过 openDb() 执行幂等迁移。不能安全写入时返回明确
 * 原因，调用方不得继续把底层缺列错误暴露给用户。
 */
function ensureReadableSchema(): { ready: boolean; reason?: string } {
  const inspect = (): { ready: boolean; reason?: string } => {
    if (!existsSync(DB_PATH)) return { ready: false };
    const db = openReadDb();
    try {
      if (!coreSchemaNeedsMigration(db)) return { ready: true };
      try {
        if (shouldSkipBuild(db, { ignoreRecentBuild: true }).reason === 'daemon_active') {
          return { ready: false, reason: 'daemon_active' };
        }
      } catch (error) {
        if (!isMissingIndexStateTable(error)) throw error;
      }
      return { ready: false };
    } finally {
      db.close();
    }
  };

  let state = inspect();
  if (state.ready || state.reason) return state;
  const lease = acquireWriterLease({
    lockPath: writerLockPathFor(DB_PATH),
    openDb: openWriterLeaseDb,
    waitMs: 1000,
  });
  if (!lease) return { ready: false, reason: 'writer_busy' };
  try {
    state = inspect();
    if (state.ready || state.reason) return state;
    try {
      const db = openDb();
      db.close();
    } catch (error) {
      throw indexAccessFailure(error);
    }
    return { ready: true };
  } finally {
    lease.release();
  }
}

/**
 * 执行一次 CLI 构建。force 以空 cursor 重放全部来源；任何时候都不删除历史，
 * 已缺失的来源及人工确认的 memories 原样保留（ADR-0014）。
 */
function buildIndex({ force = false }: { force?: boolean } = {}) {
  const ownership = inspectBuildOwnership({ force });
  if (ownership.skip) return ownership; // skip 为 false 有资格写，为 true 直接返回
  let lease;
  try {
    lease = acquireWriterLease({
      lockPath: writerLockPathFor(DB_PATH),
      openDb: openWriterLeaseDb,
    });
  } catch (error) {
    throw indexAccessFailure(error);
  }
  if (!lease) return { skip: true, reason: 'writer_busy' };
  try {
    // 首次检查与取得硬锁之间 daemon 可能启动，因此持锁后再次检查。
    const ownershipAfterLease = inspectBuildOwnership({ force });
    if (ownershipAfterLease.skip) return ownershipAfterLease;

    let db: NodeSqliteDb;
    try {
      db = openDb();
    } catch (error) {
      throw indexAccessFailure(error);
    }
    const txDb = nodeSqliteTransactionAdapter(db);
    const skippedFiles: SkippedFile[] = [];
    const busy = () => ({ skip: true, reason: 'database_busy', skipped: skippedFiles.length, skippedFiles });
    try {
      try {
        // 只读 SQLite 文件也能以读写模式打开：在发现/解析来源前先实际写一次，避免逐个 transcript 重试。
        probeIndexWritability(db);
      } catch (error) {
        if (isBeginBusyFailure(error)) return busy();
        throw indexAccessFailure(error);
      }
      const settings = readSnapshotSettings(TRAJEX_DIR);
      let built;
      try {
        built = runProviderBuild({
          db,
          registry: createBuiltinProviderRegistry(),
          force,
          // CLI 只拍变更前快照；每日快照由 App 负责，避免短命令都去 VACUUM。
          snapshots: { dir: snapshotDirFor(DB_PATH), keep: settings.keep, daily: false },
          runTransaction: (label, work) => runRetryableWriteTransaction(txDb, work, { label }),
          onUnitError: (error, { provider, unit }) => {
            // 确认是共享 writer 还是单个来源失败；初始探测之后的权限变化也必须中止本批。
            rethrowIfIndexWriterReadOnly(db, error);
            if (isBeginBusyFailure(error)) return 'stop';
            if (hasUnusableTransaction(error)) throw error;
            const detail = error as { message?: unknown; trajex?: unknown } | null;
            const message = errorMessage(error);
            skippedFiles.push({ path: unit.key, error: message, diagnostics: detail?.trajex });
            process.stderr.write(`Warning: failed to index ${provider.name} unit ${unit.key}: ${message}\n`);
            return 'skip';
          },
        });
      } catch (error) {
        if (isBeginBusyFailure(error)) return busy();
        throw indexAccessFailure(error);
      }
      if (!built.finalized) return busy();
      return { skip: false, skipped: skippedFiles.length, skippedFiles };
    } finally {
      db.close();
    }
  } finally {
    lease.release();
  }
}

export {
  buildIndex,
  ensureReadableSchema,
  healWorkflowParentLinks,
  inferProjectPath,
  refreshSessionProjectPaths,
  shouldSkipBuild,
};
