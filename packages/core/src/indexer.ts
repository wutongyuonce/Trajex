// Copyright (C) 2026 tommy0103 and contributors.
// Copyright (C) 2026 wutongyuonce and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Core 索引构建协调器。
 *
 * 模块定位：组织一次发现 → Provider 解析 → persist → FTS 收尾的 build。它负责
 * daemon heartbeat 判断、跨进程 writer lease、事务重试和最终派生数据一致性；
 * 不理解任何具体 Provider JSONL 格式。
 */
// Passive-pull indexing orchestration for the Core package.
import { existsSync } from 'node:fs';
import { DB_PATH, openDb, openReadDb, openWriterLeaseDb } from './db.ts';
import {
  backfillUnresolvedSessionProjectPathsOnce,
  ensureFtsReady,
  refreshSessionProjectPaths,
} from './index-finalize.ts';
import { inferProjectPath } from './parsing.ts';
import {
  assertRebuildRootsAvailable,
  createProviderIndexPlan,
  indexProviderPlan,
  writeProviderIndexMarkers,
} from './provider-indexing.ts';
import { nodeSqliteTransactionAdapter } from './tx.ts';
import { acquireWriterLease, writerLockPathFor } from './writer-lease.ts';
import { runRetryableWriteTransaction, isBeginBusyFailure, hasUnusableTransaction } from './write-coordinator.ts';
import { createBuiltinProviderRegistry } from './providers/builtins.ts';
import { coreSchemaNeedsMigration } from './schema-migrations.ts';
import type { NodeSqliteDb, SqliteDb } from './sqlite-types.ts';

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


/**
 * 补齐 workflow → Workflow tool_use 的延迟关联。
 * workflow JSON 可能先于主 transcript 的 tool_result 入库；此时首次解析只能留下 null。
 * finalize 时 tool_results 已经是完整投影，因此用 run_id 做一次幂等补偿。
 */
function healWorkflowParentLinks(db: SqliteDb): void {
  db.prepare(`
    UPDATE workflows
    SET parent_tool_use_id = (
      SELECT tr.tool_use_id
      FROM tool_results tr
      JOIN tool_calls tc ON tc.id = tr.tool_use_id AND tc.session_id = tr.session_id
      WHERE tr.session_id = workflows.session_id
        AND tc.name = 'Workflow'
        AND instr(tr.content, workflows.run_id) > 0
      ORDER BY tr.rowid
      LIMIT 1
    )
    WHERE parent_tool_use_id IS NULL
      AND EXISTS (
        SELECT 1
        FROM tool_results tr
        JOIN tool_calls tc ON tc.id = tr.tool_use_id AND tc.session_id = tr.session_id
        WHERE tr.session_id = workflows.session_id
          AND tc.name = 'Workflow'
          AND instr(tr.content, workflows.run_id) > 0
      )
  `).run();
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
function inspectBuildOwnership({ force = false }: { force?: boolean } = {}) {
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
    const db = openDb();
    db.close();
    return { ready: true };
  } finally {
    lease.release();
  }
}

/**
 * 执行发现 → parse → persist → finalize 的完整索引流程。force 时只清除可再生的
 * transcript 数据，人工确认的 memories 永远保留。
 */
function buildIndex({ force = false }: { force?: boolean } = {}) {
  const ownership = inspectBuildOwnership({ force });
  if (ownership.skip) return ownership; // skip 为 false 有资格写，为 true 直接返回
  const lease = acquireWriterLease({
    lockPath: writerLockPathFor(DB_PATH),
    openDb: openWriterLeaseDb,
  });
  if (!lease) return { skip: true, reason: 'writer_busy' };
  try {
    // 首次检查与取得硬锁之间 daemon 可能启动，因此持锁后再次检查。
    const ownershipAfterLease = inspectBuildOwnership({ force });
    if (ownershipAfterLease.skip) return ownershipAfterLease;

    const db = openDb();
    const txDb = nodeSqliteTransactionAdapter(db);
    const skippedFiles: SkippedFile[] = [];
    const providerPlan = createProviderIndexPlan(db, createBuiltinProviderRegistry(), { force });
    assertRebuildRootsAvailable(providerPlan);
    try {
      try {
        if (providerPlan.fullRebuild) {
          runRetryableWriteTransaction(txDb, () => {
            db.prepare("DELETE FROM index_state WHERE jsonl_path != '__last_build__'").run();
            // Clearing index_state alone re-indexes existing files but leaves rows for
            // files that no longer exist on disk (stale sessions accumulate). A force
            // build is a clean rebuild: drop every derived table, then re-index from the
            // current files. `memories` is the durable, human-approved layer and is never
            // cleared; messages_fts is repopulated by the 'rebuild' command in finalize.
            for (const table of ['messages', 'tool_calls', 'tool_results', 'sessions', 'summaries', 'subagents', 'workflows', 'workflow_agents']) {
              db.prepare(`DELETE FROM ${table}`).run();
            }
          }, { label: 'force-cleanup' });
        }
      } catch (error) {
        if (isBeginBusyFailure(error)) {
          return { skip: true, reason: 'database_busy', skipped: skippedFiles.length, skippedFiles };
        }
        throw error;
      }

      const providerResult = indexProviderPlan({
        db,
        plan: providerPlan,
        runTransaction: (label, work) => runRetryableWriteTransaction(txDb, work, { label }),
        onPersisted: ({ unit }) => {
          refreshSessionProjectPaths(db, new Set([
            unit.sessionId,
            ...(unit.retractSessionIds ?? []),
          ]));
        },
        onError: (error, { provider, unit }) => {
          if (isBeginBusyFailure(error)) return 'stop';
          if (hasUnusableTransaction(error)) throw error;
          const detail = error as { message?: unknown; trajex?: unknown } | null;
          const message = errorMessage(error);
          skippedFiles.push({ path: unit.key, error: message, diagnostics: detail?.trajex });
          process.stderr.write(`Warning: failed to index ${provider.name} unit ${unit.key}: ${message}\n`);
          return 'skip';
        },
      });
      if (providerResult.stopped) {
        return { skip: true, reason: 'database_busy', skipped: skippedFiles.length, skippedFiles };
      }
      // 收尾必须是不可吞错的单一事务，否则 FTS、project_path 与 cursor 会处于不同版本。
      try {
        runRetryableWriteTransaction(txDb, () => {
          if (providerPlan.fullRebuild) {
            refreshSessionProjectPaths(db, null);
            backfillUnresolvedSessionProjectPathsOnce(db);
          } else {
            backfillUnresolvedSessionProjectPathsOnce(db);
          }
          healWorkflowParentLinks(db);
          ensureFtsReady(db, { force: providerPlan.fullRebuild });
          db.prepare("INSERT OR REPLACE INTO index_state (jsonl_path, mtime, lines_processed) VALUES ('__last_build__', ?, 0)").run(Date.now());
          writeProviderIndexMarkers(db, providerPlan, providerResult);
        }, { label: 'finalize' });
      } catch (error) {
        if (isBeginBusyFailure(error)) {
          return { skip: true, reason: 'database_busy', skipped: skippedFiles.length, skippedFiles };
        }
        throw error;
      }
      return { skip: false, skipped: skippedFiles.length, skippedFiles };
    } finally {
      db.close();
    }
  } finally {
    lease.release();
  }
}

export { buildIndex, ensureReadableSchema, healWorkflowParentLinks, inferProjectPath, refreshSessionProjectPaths, shouldSkipBuild };
