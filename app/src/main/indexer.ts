// Copyright (C) 2026 tommy0103 and contributors.
// Copyright (C) 2026 wutongyuonce and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * 桌面 App 的索引写入入口（运行在 indexer worker 线程里）。
 *
 * 模块定位：在 better-sqlite3 上取得 writer lease、打开并迁移索引，把一次构建交给
 * Core 的 runProviderBuild；另外承载只有 App 才做的写操作：清理缺失来源、拍快照与
 * 从快照恢复（ADR-0014）。所有写操作都在同一个 writer lease 下串行执行。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { createBuiltinProviderRegistry } from '../../../packages/core/src/providers/builtins.ts';
import type { ProviderRegistry } from '../../../packages/core/src/providers/registry.ts';
import { ensureFtsReady } from '../../../packages/core/src/index-finalize.ts';
import { runProviderBuild } from '../../../packages/core/src/index-build.ts';
import { readRecentTranscriptHints } from '../../../packages/core/src/provider-indexing.ts';
import type { ProviderInventoryRootIssue } from '../../../packages/core/src/provider-indexing.ts';
import { installCoreSchema } from '../../../packages/core/src/schema-migrations.ts';
import {
  createSnapshot,
  createSnapshotUnlessRecent,
  hasIndexedData,
  listSnapshots,
  normalizeKeep,
  pruneSnapshots,
  readDurableMemories,
  replaceIndexWithSnapshot,
  restoreDurableMemories,
  snapshotDirFor,
  validateSnapshot,
  type SnapshotInfo,
} from '../../../packages/core/src/snapshots.ts';
import { purgeMissingSources, sourceLedgerSummary } from '../../../packages/core/src/sources.ts';
import { listSyncPeers, removePeerDeviceRows, syncWithFolder } from '../../../packages/core/src/sync.ts';
import { runWriteTransaction, configureConnection, betterSqliteTransactionAdapter } from '../../../packages/core/src/tx.ts';
import { acquireWriterLease, writerLockPathFor } from '../../../packages/core/src/writer-lease.ts';
import { runRetryableWriteTransaction, isBeginBusyFailure, hasUnusableTransaction } from '../../../packages/core/src/write-coordinator.ts';
import { inferProjectPath } from '../../../packages/core/src/parsing.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DEFAULT_CLAUDE_DIR = path.join(os.homedir(), '.claude');
const DEFAULT_TRAJEX_DIR = path.join(os.homedir(), '.trajex');
const DEFAULT_DB_PATH = path.join(DEFAULT_TRAJEX_DIR, 'trajex.sqlite');

type DatabaseCtor = new (dbPath: string, options?: { readonly?: boolean }) => any;

function resolveSchemaPath() {
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  const candidates = [
    path.join(__dirname, 'schema.sql'),
    path.join(__dirname, '..', '..', '..', 'packages', 'core', 'src', 'schema.sql'),
    resourcesPath ? path.join(resourcesPath, 'scripts', 'schema.sql') : null,
  ].filter((c): c is string => Boolean(c));
  const found = candidates.find(p => fs.existsSync(p));
  if (!found) throw new Error('Trajex schema.sql not found');
  return found;
}

/** 打开（必要时创建并迁移）索引。调用方必须持有 writer lease。 */
function openIndexDb({
  dbPath = DEFAULT_DB_PATH,
  schemaPath = resolveSchemaPath(),
  DatabaseImpl = Database,
  snapshotDir,
  snapshotKeep,
}: {
  dbPath?: string; schemaPath?: string; DatabaseImpl?: DatabaseCtor; snapshotDir?: string | null; snapshotKeep?: number;
} = {}) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseImpl(dbPath);
  configureConnection(db, { busyTimeoutMs: 250 });
  try {
    installCoreSchema(db, fs.readFileSync(schemaPath, 'utf8'), {
      snapshotDir: snapshotDir === undefined ? snapshotDirFor(dbPath) : (snapshotDir ?? undefined),
      snapshotKeep,
    });
  } catch (error) {
    db.close();
    throw error;
  }
  return db;
}

// PASSIVE by default: it checkpoints what it can without blocking concurrent
// readers/writers, so it is safe to run after every build. A blocking TRUNCATE
// (which reclaims the -wal file but needs exclusive access and can contend with
// the daemon + queries) is reserved for maintenance/exit — pass mode explicitly.
function checkpointDb(db: { pragma: (statement: string) => void }, mode = 'PASSIVE') {
  try {
    db.pragma(`wal_checkpoint(${mode})`);
  } catch {}
}

function writeIndexMarker(db: { prepare: (sql: string) => { run: (...args: unknown[]) => unknown } }, key: string, value = Date.now()) {
  db.prepare('INSERT OR REPLACE INTO index_state (jsonl_path, mtime, lines_processed) VALUES (?, ?, 0)').run(key, value);
}

interface LeaseOptions {
  dbPath?: string;
  writerLeasePath?: string;
  writerLeaseWaitMs?: number;
  writerLeaseMode?: 'acquire' | 'caller-held';
  LockDatabaseImpl?: DatabaseCtor;
  DatabaseImpl?: DatabaseCtor;
}

/** 在 writer lease 下执行 work；拿不到锁时返回 null（调用方据此报告 writer_busy）。 */
function withWriterLease<T>(
  { dbPath = DEFAULT_DB_PATH, writerLeasePath = writerLockPathFor(dbPath), writerLeaseWaitMs = 2000,
    writerLeaseMode = 'acquire', DatabaseImpl = Database, LockDatabaseImpl = DatabaseImpl }: LeaseOptions,
  work: () => T,
): T | null {
  if (writerLeaseMode !== 'acquire' && writerLeaseMode !== 'caller-held') {
    throw new Error(`Unknown writer lease mode: ${writerLeaseMode}`);
  }
  const lease = writerLeaseMode === 'acquire'
    ? acquireWriterLease({ lockPath: writerLeasePath, openDb: lockPath => new LockDatabaseImpl(lockPath), waitMs: writerLeaseWaitMs })
    : null;
  if (writerLeaseMode === 'acquire' && !lease) return null;
  try {
    return work();
  } finally {
    lease?.release();
  }
}

function writeHeartbeat({
  dbPath = DEFAULT_DB_PATH,
  writerLeasePath = writerLockPathFor(dbPath),
  DatabaseImpl = Database,
  LockDatabaseImpl = DatabaseImpl,
}: LeaseOptions = {}) {
  if (!fs.existsSync(dbPath)) return;
  const written = withWriterLease({ dbPath, writerLeasePath, writerLeaseWaitMs: 0, DatabaseImpl, LockDatabaseImpl }, () => {
    const db = new DatabaseImpl(dbPath);
    configureConnection(db, { busyTimeoutMs: 0 });
    const txDb = betterSqliteTransactionAdapter(db);
    try {
      runWriteTransaction(txDb, () => writeIndexMarker(db, '__app_heartbeat__'), { label: 'heartbeat' });
      return true;
    } finally {
      db.close();
    }
  });
  return written ?? false;
}

interface BuildIndexOptions extends LeaseOptions {
  providerRoots?: Record<string, string>;
  providerRegistry?: ProviderRegistry;
  claudeDir?: string;
  codexDir?: string;
  schemaPath?: string;
  force?: boolean;
  changedPaths?: string[];
  /** 快照策略；snapshotDir 为空时不拍快照。 */
  snapshotDir?: string | null;
  snapshotKeep?: number;
  autoSnapshot?: boolean;
}

interface SkippedFile {
  path: string;
  error: string;
  diagnostics?: unknown;
}

interface BuildIndexResult {
  files: number;
  latestSourceMtime: number;
  affectedSessionIds: string[];
  ftsRebuilt: boolean;
  skipped: number;
  skippedFiles: SkippedFile[];
  inventoryIssues: readonly ProviderInventoryRootIssue[];
  deferred: boolean;
  watchHints?: string[];
  reason?: string;
}

function deferredBuildResult(
  reason: string,
  overrides: Partial<Omit<BuildIndexResult, 'deferred' | 'reason'>> = {},
): BuildIndexResult {
  return {
    files: 0,
    latestSourceMtime: 0,
    affectedSessionIds: [],
    ftsRebuilt: false,
    skipped: 0,
    skippedFiles: [],
    inventoryIssues: [],
    ...overrides,
    deferred: true,
    reason,
  };
}

/** 兼容测试注入的 `claudeDir`：其余默认根随之相对重定位，显式 providerRoots 优先。 */
function resolveProviderRoots(claudeDir: string, codexDir: string, providerRoots: Record<string, string>) {
  const defaultHome = os.homedir();
  const compatibilityHome = path.dirname(claudeDir);
  const relocatedDefaults = Object.fromEntries(
    createBuiltinProviderRegistry().catalog().map((descriptor) => {
      const relativeDefault = path.relative(defaultHome, descriptor.defaultRoot);
      const root = compatibilityHome !== defaultHome
        && relativeDefault
        && !relativeDefault.startsWith('..')
        && !path.isAbsolute(relativeDefault)
        ? path.join(compatibilityHome, relativeDefault)
        : descriptor.defaultRoot;
      return [descriptor.id, root];
    }),
  );
  return { ...relocatedDefaults, claude: claudeDir, codex: codexDir, ...providerRoots };
}

function buildIndex({
  providerRoots = {},
  providerRegistry,
  claudeDir = DEFAULT_CLAUDE_DIR,
  codexDir = path.join(path.dirname(claudeDir), '.codex'),
  dbPath = DEFAULT_DB_PATH,
  schemaPath = resolveSchemaPath(),
  DatabaseImpl = Database,
  LockDatabaseImpl = DatabaseImpl,
  force = false,
  changedPaths = undefined,
  snapshotDir = null,
  snapshotKeep,
  autoSnapshot = true,
  writerLeasePath = writerLockPathFor(dbPath),
  writerLeaseWaitMs = 2000,
  writerLeaseMode = 'acquire',
}: BuildIndexOptions = {}): BuildIndexResult {
  const built = withWriterLease({ dbPath, writerLeasePath, writerLeaseWaitMs, writerLeaseMode, DatabaseImpl, LockDatabaseImpl }, () => {
    const keep = normalizeKeep(snapshotKeep);
    const db = openIndexDb({ dbPath, schemaPath, DatabaseImpl, snapshotDir, snapshotKeep: keep });
    const txDb = betterSqliteTransactionAdapter(db);
    try {
      const registry = providerRegistry ?? createBuiltinProviderRegistry(resolveProviderRoots(claudeDir, codexDir, providerRoots));
      const affectedSessionIds = new Set<string>();
      const skipped: SkippedFile[] = [];
      let latestSourceMtime = 0;
      let files = 0;
      const partial = (reason: string, inventoryIssues: readonly ProviderInventoryRootIssue[] = []) => deferredBuildResult(reason, {
        files, latestSourceMtime, affectedSessionIds: [...affectedSessionIds], skipped: skipped.length, skippedFiles: skipped, inventoryIssues,
      });
      let run;
      try {
        run = runProviderBuild({
          db,
          registry,
          force,
          changedPaths,
          snapshots: { dir: snapshotDir ?? undefined, keep, daily: autoSnapshot },
          runTransaction: (label, work) => runRetryableWriteTransaction(txDb, work, { label }),
          onCommitted: (_item, cursor, sessionIds) => {
            files++;
            if (cursor) latestSourceMtime = Math.max(latestSourceMtime, Number(cursor.split(':')[0]) || 0);
            for (const sessionId of sessionIds) affectedSessionIds.add(sessionId);
          },
          onUnitError: (error, { provider, unit }) => {
            if (isBeginBusyFailure(error)) return 'stop';
            if (hasUnusableTransaction(error)) throw error;
            skipped.push({
              path: unit.key,
              error: (error as Error).message,
              diagnostics: (error as { trajex?: unknown }).trajex,
            });
            console.warn(`Warning: failed to index ${provider.name} unit ${unit.key}: ${(error as Error).message}`);
            return 'skip';
          },
        });
      } catch (error) {
        if (isBeginBusyFailure(error)) return partial('database_busy');
        throw error;
      }
      if (!run.finalized) return partial('database_busy', run.plan.inventoryIssues);
      runRetryableWriteTransaction(txDb, () => {
        writeIndexMarker(db, '__app_last_successful_build__');
        if (latestSourceMtime) writeIndexMarker(db, '__last_source_mtime__', latestSourceMtime);
      }, { label: 'app-markers' });
      return {
        files: run.plan.items.length,
        latestSourceMtime,
        affectedSessionIds: [...affectedSessionIds],
        ftsRebuilt: run.ftsRebuilt,
        skipped: skipped.length,
        skippedFiles: skipped,
        inventoryIssues: run.plan.inventoryIssues,
        deferred: false,
        watchHints: readRecentTranscriptHints(db),
      };
    } finally {
      checkpointDb(db);
      db.close();
    }
  });
  return built ?? deferredBuildResult('writer_busy');
}

interface MaintenanceOptions extends LeaseOptions {
  schemaPath?: string;
  snapshotDir?: string;
  snapshotKeep?: number;
}

type MaintenanceResult<T> = ({ ok: true } & T) | { ok: false; reason: 'writer_busy' };

function maintenance<T>(options: MaintenanceOptions, work: (db: any, dir: string, keep: number) => T): MaintenanceResult<T> {
  const dbPath = options.dbPath ?? DEFAULT_DB_PATH;
  const dir = options.snapshotDir ?? snapshotDirFor(dbPath);
  const keep = normalizeKeep(options.snapshotKeep);
  const result = withWriterLease({ ...options, dbPath }, () => {
    const db = openIndexDb({
      dbPath,
      schemaPath: options.schemaPath ?? resolveSchemaPath(),
      DatabaseImpl: options.DatabaseImpl ?? Database,
      snapshotDir: dir,
      snapshotKeep: keep,
    });
    try {
      return { ok: true as const, ...work(db, dir, keep) };
    } finally {
      checkpointDb(db);
      db.close();
    }
  });
  return result ?? { ok: false, reason: 'writer_busy' };
}

/** 设置页概览：来源清单状态、现有快照与已连接的同步设备。 */
function getRetentionSummary(
  options: MaintenanceOptions & { missingBefore?: number; syncDir?: string | null; deviceId?: string } = {},
) {
  return maintenance(options, (db, dir) => ({
    ...sourceLedgerSummary(db, { missingBefore: options.missingBefore }),
    snapshots: listSnapshots(dir),
    peers: listSyncPeers(db, options.syncDir, options.deviceId ?? ''),
  }));
}

/** 双向文件夹同步：导出本机分片并导入其他设备的分片。 */
function syncFolder(options: MaintenanceOptions & { syncDir: string; deviceId: string; deviceName: string }) {
  const DatabaseImpl = options.DatabaseImpl ?? Database;
  const dbPath = options.dbPath ?? DEFAULT_DB_PATH;
  return maintenance(options, (db) => {
    const txDb = betterSqliteTransactionAdapter(db);
    return syncWithFolder(db, {
      syncDir: options.syncDir,
      deviceId: options.deviceId,
      deviceName: options.deviceName,
      trajexDir: path.dirname(dbPath),
      openDb: (p, opts) => new DatabaseImpl(p, opts),
      runTransaction: (label, work) => runRetryableWriteTransaction(txDb, work, { label }),
    });
  });
}

/** 移除某个同步设备在本机索引中的导入数据。 */
function removeSyncPeer(options: MaintenanceOptions & { peerDeviceId: string }) {
  return maintenance(options, (db) => {
    const txDb = betterSqliteTransactionAdapter(db);
    runRetryableWriteTransaction(txDb, () => removePeerDeviceRows(db, options.peerDeviceId), { label: 'remove-peer' });
    return { removed: options.peerDeviceId };
  });
}

/** 手动拍快照。 */
function takeSnapshot(options: MaintenanceOptions = {}) {
  return maintenance(options, (db, dir, keep) => ({ snapshot: createSnapshot(db, { dir, keep, reason: 'manual' }) }));
}

/**
 * 显式清理缺失来源（ADR-0014 唯一的删除操作）。先拍 `pre-purge` 快照，拍不成就不清理；
 * 删除与 FTS 由触发器同步维护。
 */
function purgeMissing(options: MaintenanceOptions & { missingBefore?: number } = {}) {
  return maintenance(options, (db, dir, keep) => {
    const preview = sourceLedgerSummary(db, { missingBefore: options.missingBefore });
    if (preview.missingSources === 0) return { sources: 0, sessions: 0, snapshot: null as SnapshotInfo | null };
    const snapshot = hasIndexedData(db) ? createSnapshotUnlessRecent(db, { dir, keep, reason: 'pre-purge' }) : null;
    const txDb = betterSqliteTransactionAdapter(db);
    const purged = runRetryableWriteTransaction(txDb, () => purgeMissingSources(db, { missingBefore: options.missingBefore }), { label: 'purge' });
    return { ...purged, snapshot };
  });
}

/**
 * 从快照恢复。调用方（主进程）必须已停止 indexer 并关闭所有本进程连接；本函数持有
 * writer lease 完成：校验 → pre-restore 快照 → 替换文件 → 合并当前 memories → 迁移。
 * 校验失败时当前索引不变。
 */
function restoreSnapshot(options: MaintenanceOptions & { snapshotPath: string }) {
  const dbPath = options.dbPath ?? DEFAULT_DB_PATH;
  const DatabaseImpl = options.DatabaseImpl ?? Database;
  const dir = options.snapshotDir ?? snapshotDirFor(dbPath);
  const keep = normalizeKeep(options.snapshotKeep);
  const schemaPath = options.schemaPath ?? resolveSchemaPath();
  const target = path.resolve(options.snapshotPath);
  if (path.dirname(target) !== path.resolve(dir)) throw new Error('Only snapshots in the Trajex snapshot directory can be restored');
  const result = withWriterLease({ ...options, dbPath, writerLeaseWaitMs: options.writerLeaseWaitMs ?? 5000 }, () => {
    validateSnapshot(target, p => new DatabaseImpl(p, { readonly: true }));
    let safety: SnapshotInfo | null = null;
    let preservedMemories: Array<Record<string, unknown>> = [];
    if (fs.existsSync(dbPath)) {
      const current = new DatabaseImpl(dbPath);
      configureConnection(current, { busyTimeoutMs: 1000 });
      try {
        // 先不修剪，以免在复制 target 之前把旧快照 target 自己修剪掉；复制完成后再按 keep 修剪。
        if (hasIndexedData(current)) safety = createSnapshot(current, { dir, keep, reason: 'pre-restore', prune: false });
        preservedMemories = readDurableMemories(current);
      } finally {
        current.close();
      }
    }
    replaceIndexWithSnapshot(target, dbPath);
    pruneSnapshots(dir, keep);
    const db = new DatabaseImpl(dbPath);
    configureConnection(db, { busyTimeoutMs: 1000 });
    try {
      installCoreSchema(db, fs.readFileSync(schemaPath, 'utf8'), { snapshotDir: undefined, snapshotKeep: keep });
      const txDb = betterSqliteTransactionAdapter(db);
      runRetryableWriteTransaction(txDb, () => {
        restoreDurableMemories(db, preservedMemories);
        // 恢复后的索引用当前设置的快照数量修剪；cursor 原样保留，下一次构建增量同步。
        db.prepare("DELETE FROM index_state WHERE jsonl_path = '__last_build__'").run();
        ensureFtsReady(db, { force: true });
      }, { label: 'restore' });
    } finally {
      checkpointDb(db, 'TRUNCATE');
      db.close();
    }
    return { ok: true as const, restored: path.basename(target), safety };
  });
  return result ?? { ok: false as const, reason: 'writer_busy' as const };
}

export {
  buildIndex,
  getRetentionSummary,
  inferProjectPath,
  openIndexDb,
  purgeMissing,
  removeSyncPeer,
  restoreSnapshot,
  syncFolder,
  takeSnapshot,
  writeHeartbeat,
};
