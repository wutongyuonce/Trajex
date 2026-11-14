// Copyright (C) 2026 tommy0103 and contributors.
// Copyright (C) 2026 wutongyuonce and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * CLI 与 App 共用的一次索引构建（见 docs/adr/0003、0014）。
 *
 * 模块定位：计划 → 变更前快照 → 逐单元事务 → 收尾事务 → 每日快照。调用方只负责
 * 所有权（writer lease、App heartbeat）、打开连接与把错误映射成自己的返回形状；
 * 这里不绑定 SQLite 驱动，事务通过 runTransaction 注入。
 *
 * 不删除任何历史：rebuild 只是以空 cursor 重放全部单元，每个仍存在的来源在自己的
 * 事务里替换自己的投影；缺失与受保护的来源保持原样（ADR-0014）。
 */
import {
  backfillUnresolvedSessionProjectPathsOnce,
  dropMessageFtsTriggers,
  ensureFtsReady,
  refreshSessionProjectPaths,
} from './index-finalize.ts';
import {
  assertRebuildRootsAvailable,
  createProviderIndexPlan,
  indexProviderPlan,
  planRewritesExistingProjections,
  writeProviderIndexMarkers,
  type ProviderIndexItem,
  type ProviderIndexPlan,
  type ProviderIndexResult,
} from './provider-indexing.ts';
import type { ProviderRegistry } from './providers/registry.ts';
import type { Cursor } from './providers/types.ts';
import { createSnapshot, createSnapshotUnlessRecent, hasIndexedData, snapshotDue } from './snapshots.ts';
import { dropEmptyLegacySources } from './sources.ts';
import type { SqliteDb } from './sqlite-types.ts';

/** 快照策略；dir 为空时不拍任何快照（测试、临时索引）。 */
export interface SnapshotPolicy {
  readonly dir?: string;
  readonly keep: number;
  /** 构建成功后是否拍每日快照。变更前快照不受此开关影响。 */
  readonly daily: boolean;
}

export interface RunBuildOptions {
  db: SqliteDb;
  registry: ProviderRegistry;
  force?: boolean;
  changedPaths?: string[];
  snapshots?: SnapshotPolicy;
  runTransaction: <T>(label: string, work: () => T) => T;
  /** 单元失败时决定跳过还是停止整批；可抛错以中止。 */
  onUnitError: (error: unknown, item: ProviderIndexItem) => 'skip' | 'stop';
  onCommitted?: (item: ProviderIndexItem, cursor: Cursor, sessionIds: ReadonlySet<string>) => void;
  now?: () => number;
}

export interface RunBuildResult {
  readonly plan: ProviderIndexPlan;
  readonly result: ProviderIndexResult;
  /** 收尾是否已完成；stopped 时为 false，下一次构建会从已提交的 cursor 继续。 */
  readonly finalized: boolean;
  readonly ftsRebuilt: boolean;
}

/** 在全部单元提交后运行的收尾：只能整体成功，否则 FTS、project_path 与 marker 会处于不同版本。 */
function finalize(db: SqliteDb, plan: ProviderIndexPlan, result: ProviderIndexResult, now: number): boolean {
  const rewrote = planRewritesExistingProjections(plan);
  if (rewrote) refreshSessionProjectPaths(db, null);
  backfillUnresolvedSessionProjectPathsOnce(db);
  healWorkflowParentLinks(db);
  if (plan.replayKeys.size > 0) dropEmptyLegacySources(db);
  const ftsRebuilt = ensureFtsReady(db, { force: plan.fullRebuild });
  db.prepare('INSERT OR REPLACE INTO index_state (jsonl_path, mtime, lines_processed) VALUES (?, ?, 0)').run('__last_build__', now);
  writeProviderIndexMarkers(db, plan, result);
  return ftsRebuilt;
}

export function runProviderBuild({
  db,
  registry,
  force = false,
  changedPaths,
  snapshots,
  runTransaction,
  onUnitError,
  onCommitted,
  now = Date.now,
}: RunBuildOptions): RunBuildResult {
  const plan = createProviderIndexPlan(db, registry, { force, changedPaths });
  assertRebuildRootsAvailable(plan);
  // 重写已有投影前先保留一份可恢复的副本；拍不成就不动索引。
  if (snapshots?.dir && planRewritesExistingProjections(plan) && hasIndexedData(db)) {
    createSnapshotUnlessRecent(db, { dir: snapshots.dir, keep: snapshots.keep, reason: force ? 'pre-rebuild' : 'pre-replay', now: now() });
  }
  if (plan.fullRebuild) {
    // 强制重放不删任何业务表，只清掉文件 cursor 并暂卸 FTS 触发器，收尾时一次性恢复并重建 FTS。
    runTransaction('force-cleanup', () => {
      dropMessageFtsTriggers(db);
      db.prepare("DELETE FROM index_state WHERE substr(jsonl_path, 1, 2) != '__'").run();
      db.prepare("DELETE FROM index_state WHERE jsonl_path = '__fts_triggers_ready__'").run();
    });
  }
  const result = indexProviderPlan({
    db,
    plan,
    runTransaction,
    now,
    // project_path 与单元在同一事务提交：中途停止或 App 退出也不会留下空路径。
    onPersisted: (_item, sessionIds) => refreshSessionProjectPaths(db, sessionIds),
    onCommitted,
    onError: onUnitError,
  });
  if (result.stopped) return { plan, result, finalized: false, ftsRebuilt: false };
  const ftsRebuilt = runTransaction('finalize', () => finalize(db, plan, result, now()));
  // 每日快照在收尾之后、事务之外（VACUUM INTO 不能在事务内）；失败只告警，下次构建重试。
  if (snapshots?.dir && snapshots.daily && snapshotDue(snapshots.dir, now()) && hasIndexedData(db)) {
    try {
      createSnapshot(db, { dir: snapshots.dir, keep: snapshots.keep, reason: 'daily', now: now() });
    } catch (error) {
      process.emitWarning(error instanceof Error ? error.message : String(error), { code: 'TRAJEX_SNAPSHOT' });
    }
  }
  return { plan, result, finalized: true, ftsRebuilt };
}

/**
 * 补齐 workflow → Workflow tool_use 的延迟关联。
 * workflow JSON 可能先于主 transcript 的 tool_result 入库；此时首次解析只能留下 null。
 * finalize 时 tool_results 已经是完整投影，因此用 run_id 做一次幂等补偿。
 */
export function healWorkflowParentLinks(db: SqliteDb): void {
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
