// Copyright (C) 2026 tommy0103 and contributors.
// Copyright (C) 2026 wutongyuonce and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Provider 索引计划模块。
 *
 * 模块定位：将 registry 发现的 IndexUnit 排成计划，取回 Provider 私有 cursor，
 * 并在调用方提供的事务中执行 parse → persist，或把缺失单元记入来源清单（ADR-0014）。
 * 它不绑定具体 SQLite 驱动。
 */
import { statSync } from 'node:fs';
import { persist } from './persist.ts';
import type { ProviderRegistry } from './providers/registry.ts';
import type {
  Cursor,
  IndexUnit,
  InventoryRootIssue,
  KnownSource,
  ProviderAdapter,
} from './providers/types.ts';
import { markSourcesMissing, readKnownSources, refreshSessionSourceStatus } from './sources.ts';
import type { SqliteDb } from './sqlite-types.ts';

/** 计划中的单个执行单元：哪个 Provider 解析哪个 unit，以及从哪个 cursor 续读（null 为全量）。 */
export interface ProviderIndexItem {
  readonly provider: ProviderAdapter;
  readonly unit: IndexUnit;
  readonly cursor: Cursor;
}

/** 一次 build 的完整计划：有序执行项 + 待写回的版本完成标记（Provider 版本升级时置入）。 */
export interface ProviderIndexPlan {
  readonly items: ProviderIndexItem[];
  readonly pendingMarkers: ReadonlyMap<string, string>;
  /** 版本标记缺失且已有来源的 Provider：这些 unit key 的 cursor 需在重放前清除。 */
  readonly replayKeys: ReadonlyMap<string, readonly string[]>;
  /** 仅 force 为 true：所有 unit 用空 cursor 重放。缺 version marker 只重放该 Provider。 */
  readonly fullRebuild: boolean;
  readonly inventoryIssues: readonly ProviderInventoryRootIssue[];
}

/** 带 Provider 身份的来源根诊断，供 build 决定是否允许全量重放。 */
export interface ProviderInventoryRootIssue extends InventoryRootIssue {
  readonly provider: string;
}

/** 来源根不可用时拒绝 force 重放；抛出前数据库未被修改。 */
export class ProviderRootUnavailableError extends Error {
  readonly issues: readonly ProviderInventoryRootIssue[];

  constructor(issues: readonly ProviderInventoryRootIssue[]) {
    const detail = issues.map(issue => `${issue.provider} (${issue.path}): ${issue.error}`).join('; ');
    super(`Provider root unavailable; rebuild aborted before cleanup: ${detail}`);
    this.name = 'ProviderRootUnavailableError';
    this.issues = issues;
  }
}

/** 为 macOS 热文件轮询提供最近活跃的 transcript，系统 marker 不参与。 */
export function readRecentTranscriptHints(db: SqliteDb, limit = 64): string[] {
  const rows = db.prepare(
    "SELECT jsonl_path FROM index_state WHERE jsonl_path NOT LIKE '\\_\\_%' ESCAPE '\\' ORDER BY mtime DESC LIMIT ?",
  ).all(limit * 4);
  const hints: string[] = [];
  for (const row of rows) {
    if (hints.length >= limit) break;
    const file = String(row.jsonl_path);
    try {
      if (!statSync(file).isDirectory()) hints.push(file);
    } catch {
      // 文件可能在 build 结束后被删除，不把失效 hint 放入热集合。
    }
  }
  return hints;
}

/** 执行结果：已提交项、失败项、状态变化的会话；stopped 表示数据库忙等原因中途停止的位置。 */
export interface ProviderIndexResult {
  readonly committed: ProviderIndexItem[];
  readonly failedItems: ProviderIndexItem[];
  readonly affectedSessionIds: ReadonlySet<string>;
  readonly stopped?: { item: ProviderIndexItem; error: unknown };
}

/** 优先返回 Provider 原样 cursor；旧库没有值时兼容 mtime:lines。 */
export function storedProviderCursor(db: SqliteDb, key: string): Cursor {
  const row = db.prepare('SELECT mtime, lines_processed, cursor FROM index_state WHERE jsonl_path = ?').get(key);
  if (!row) return null;
  return typeof row.cursor === 'string' ? row.cursor : `${String(row.mtime)}:${String(row.lines_processed)}`;
}

/**
 * 创建本次 build 的 IndexUnit 计划。版本标记缺失且已存在该 Provider 的旧来源时，
 * 以 null cursor 全量回放，防止旧解析语义与新 schema/逻辑混用。
 */
export function createProviderIndexPlan(
  db: SqliteDb,
  registry: ProviderRegistry,
  { force = false, changedPaths }: { force?: boolean; changedPaths?: string[] } = {},
): ProviderIndexPlan {
  const items: ProviderIndexItem[] = [];
  const pendingMarkers = new Map<string, string>();
  const replayKeys = new Map<string, readonly string[]>();
  const inventoryIssues: ProviderInventoryRootIssue[] = [];
  for (const provider of registry.list()) {
    const known: readonly KnownSource[] = readKnownSources(db, provider.name);
    const marker = provider.indexVersionMarker;
    const markerMissing = marker !== undefined
      && !db.prepare('SELECT jsonl_path FROM index_state WHERE jsonl_path = ?').get(marker);
    if (markerMissing) pendingMarkers.set(provider.name, marker);
    const replay = markerMissing && known.length > 0;
    const fullReindex = force || replay;
    if (replay) replayKeys.set(provider.name, [...new Set(known.map(source => source.path))]);
    const reportIssue = (issue: InventoryRootIssue) => {
      // 没有已知来源的内建 Provider 是可选来源，不阻断 force 重放。
      if (known.length === 0) return;
      inventoryIssues.push({ provider: provider.name, ...issue });
    };
    let units: IndexUnit[];
    try {
      units = provider.discover({
        lastCursor: fullReindex ? () => null : (key) => storedProviderCursor(db, key),
        changedPaths: fullReindex ? undefined : changedPaths,
        knownSources: () => known,
        reportUnavailableRoot: reportIssue,
      });
    } catch (error) {
      // 一个 Provider 的发现异常只阻断它自己：保留其上次快照，其他 Provider 照常索引。
      const message = error instanceof Error ? error.message : String(error);
      process.emitWarning(`${provider.name} discovery failed: ${message}`, { code: 'TRAJEX_PROVIDER_DISCOVERY' });
      reportIssue({ path: provider.descriptor.defaultRoot, error: message });
      units = [];
    }
    // 缺失单元排在最后：同一轮里移动到新路径的来源先被重新声明，之后旧路径上已无该来源。
    for (const unit of [...units.filter(unit => !unit.missing), ...units.filter(unit => unit.missing)]) {
      items.push({
        provider,
        unit,
        cursor: fullReindex || unit.missing ? null : storedProviderCursor(db, unit.key),
      });
    }
  }
  return { items, pendingMarkers, replayKeys, fullRebuild: force, inventoryIssues };
}

/** force 重放要求每个已有来源的 Provider 来源根都可读。 */
export function assertRebuildRootsAvailable(plan: ProviderIndexPlan): void {
  if (plan.fullRebuild && plan.inventoryIssues.length > 0) {
    throw new ProviderRootUnavailableError(plan.inventoryIssues);
  }
}

/** 计划是否会重写已有投影（force 或版本升级重放），供调用方决定是否先拍快照。 */
export function planRewritesExistingProjections(plan: ProviderIndexPlan): boolean {
  return plan.fullRebuild || plan.replayKeys.size > 0;
}

/**
 * 在调用方给定的事务中逐 unit 执行：普通单元 parse → persist，缺失单元只更新来源清单。
 * 坏文件可跳过，数据库忙则通过 onError 通知上层停止，避免把 SQLite binding 细节泄漏进 Provider。
 */
export function indexProviderPlan({
  db,
  plan,
  runTransaction,
  onPersisted = () => {},
  onCommitted = () => {},
  onError,
  now = Date.now,
}: {
  db: SqliteDb;
  plan: ProviderIndexPlan;
  runTransaction: <T>(label: string, work: () => T) => T;
  /** 写入成功后、同一事务提交前运行派生数据收尾；sessionIds 为本单元影响的会话。 */
  onPersisted?: (item: ProviderIndexItem, sessionIds: ReadonlySet<string>) => void;
  onCommitted?: (item: ProviderIndexItem, cursor: Cursor, sessionIds: ReadonlySet<string>) => void;
  onError: (error: unknown, item: ProviderIndexItem) => 'skip' | 'stop';
  now?: () => number;
}): ProviderIndexResult {
  const committed: ProviderIndexItem[] = [];
  const failedItems: ProviderIndexItem[] = [];
  const failedSessionIds = new Set<string>();
  const affectedSessionIds = new Set<string>();
  const blocked = new Set(plan.inventoryIssues.map(issue => issue.provider));
  let replayScheduleCommitted = plan.pendingMarkers.size === 0 && plan.replayKeys.size === 0;
  for (const item of plan.items) {
    // 同一会话的新路径在本轮解析失败时，不执行旧路径的 missing 单元，避免误标 missing。
    if (item.unit.missing && item.unit.sessionId && failedSessionIds.has(item.unit.sessionId)) continue;
    try {
      const { cursor, sessionIds } = runTransaction(`provider:${item.provider.name}:${item.unit.key}`, () => {
        // Commit the replay schedule with its first completed unit. After an
        // interruption, newly written cursors identify exactly what can resume.
        if (!replayScheduleCommitted) {
          const clear = db.prepare('DELETE FROM index_state WHERE jsonl_path = ?');
          const keysToReplay = new Set(
            plan.items
              .filter(({ provider }) => plan.pendingMarkers.has(provider.name) && !blocked.has(provider.name))
              .map(({ unit }) => unit.key),
          );
          for (const [provider, keys] of plan.replayKeys) {
            if (blocked.has(provider)) continue;
            for (const key of keys) keysToReplay.add(key);
          }
          for (const key of keysToReplay) clear.run(key);
          writePendingMarkers(db, plan);
        }
        let result: { cursor: Cursor; sessionIds: ReadonlySet<string> };
        if (item.unit.missing) {
          result = markMissing(db, item.provider.name, item.unit.key, now());
        } else {
          let persistedSessions: ReadonlySet<string> = new Set([item.unit.sessionId]);
          const nextCursor = persist(db, item.unit, item.provider.parse(item.unit, item.cursor), {
            provider: item.provider.name,
            now: now(),
            onSessionIds: (ids) => { persistedSessions = ids; },
          });
          result = { cursor: nextCursor, sessionIds: persistedSessions };
        }
        onPersisted(item, result.sessionIds);
        return result;
      });
      replayScheduleCommitted = true;
      committed.push(item);
      for (const sessionId of sessionIds) affectedSessionIds.add(sessionId);
      onCommitted(item, cursor, sessionIds);
    } catch (error) {
      failedItems.push(item);
      if (!item.unit.missing && item.unit.sessionId) failedSessionIds.add(item.unit.sessionId);
      if (onError(error, item) === 'stop') {
        return { committed, failedItems, affectedSessionIds, stopped: { item, error } };
      }
    }
  }
  return { committed, failedItems, affectedSessionIds };
}

/** 缺失单元：路径上的来源标记 missing，丢弃它的 cursor；不删除任何投影。 */
function markMissing(db: SqliteDb, provider: string, path: string, now: number) {
  const sessionIds = new Set(markSourcesMissing(db, provider, path, now));
  refreshSessionSourceStatus(db, sessionIds);
  db.prepare('DELETE FROM index_state WHERE jsonl_path = ?').run(path);
  return { cursor: null, sessionIds };
}

/** Write every pending version marker, so the first-unit transaction and finalize share one marker row shape. */
function writePendingMarkers(db: SqliteDb, plan: ProviderIndexPlan): void {
  const blocked = new Set(plan.inventoryIssues.map(issue => issue.provider));
  const write = db.prepare(
    'INSERT OR REPLACE INTO index_state (jsonl_path, mtime, lines_processed) VALUES (?, ?, 0)',
  );
  const now = Date.now();
  for (const [provider, marker] of plan.pendingMarkers) {
    if (blocked.has(provider)) continue;
    write.run(marker, now);
  }
}

/**
 * 计划完整跑完才写 version marker。单个坏文件 skip 不挡标记，但它的 cursor 被清除以便
 * 下次以新语义重试；中途 stop（数据库忙 / 连接不可用）或该 Provider 来源根不可用时不写，
 * 以免把未完成的投影升级宣布为完成。
 */
export function writeProviderIndexMarkers(
  db: SqliteDb,
  plan: ProviderIndexPlan,
  result: ProviderIndexResult,
): void {
  if (result.stopped !== undefined) return;
  const blocked = new Set(plan.inventoryIssues.map(issue => issue.provider));
  const retry = db.prepare('DELETE FROM index_state WHERE jsonl_path = ?');
  const committed = new Set(result.committed.map(
    (item) => `${item.provider.name}\0${item.unit.key}`,
  ));
  for (const [provider, keys] of plan.replayKeys) {
    if (blocked.has(provider)) continue;
    for (const key of keys) {
      if (!committed.has(`${provider}\0${key}`)) retry.run(key);
    }
  }
  for (const item of result.failedItems) {
    if (plan.pendingMarkers.has(item.provider.name) && !blocked.has(item.provider.name)) {
      retry.run(item.unit.key);
    }
  }
  writePendingMarkers(db, plan);
}
