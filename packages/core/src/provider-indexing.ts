// Copyright (C) 2026 tommy0103 and contributors.
// Copyright (C) 2026 wutongyuonce and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Provider 索引计划模块。
 *
 * 模块定位：将 registry 发现的 IndexUnit 排成计划，取回 Provider 私有 cursor，
 * 并在调用方提供的事务中执行 parse → persist。它不绑定具体 SQLite 驱动。
 */
import { statSync } from 'node:fs';
import { persist } from './persist.ts';
import type { ProviderRegistry } from './providers/registry.ts';
import type {
  Cursor,
  IndexUnit,
  InventoryRootIssue,
  ProviderAdapter,
  IndexedSession,
} from './providers/types.ts';
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
  readonly fullRebuild: boolean;
  readonly inventoryIssues: readonly ProviderInventoryRootIssue[];
}

/** 带 Provider 身份的来源根诊断，供 build 决定是否允许破坏性清理。 */
export interface ProviderInventoryRootIssue extends InventoryRootIssue {
  readonly provider: string;
}

/** 旧数据库中的 Provider session provenance，供临时库 rebuild 预检使用。 */
export interface ProviderSessionProvenance extends IndexedSession {
  readonly source: string;
}

/** force/canonical rebuild 的来源根预检失败；抛出前数据库尚未执行清理。 */
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

/** 执行结果：已提交项、失败 Provider 集合；stopped 表示数据库忙等原因中途停止的位置。 */
export interface ProviderIndexResult {
  readonly committed: ProviderIndexItem[];
  readonly failedProviders: ReadonlySet<string>;
  readonly stopped?: { item: ProviderIndexItem; error: unknown };
}

/** 优先返回 Provider 原样 cursor；旧库没有值时兼容 mtime:lines。 */
export function storedProviderCursor(db: SqliteDb, key: string): Cursor {
  const row = db.prepare('SELECT mtime, lines_processed, cursor FROM index_state WHERE jsonl_path = ?').get(key);
  if (!row) return null;
  return typeof row.cursor === 'string' ? row.cursor : `${String(row.mtime)}:${String(row.lines_processed)}`;
}

/** 读取已有 session 的来源与路径，不携带 transcript 内容。 */
export function readProviderSessionProvenance(db: SqliteDb): ProviderSessionProvenance[] {
  return db.prepare(`
    SELECT id, jsonl_path, COALESCE(source, 'claude') AS source
    FROM sessions
    WHERE jsonl_path IS NOT NULL AND jsonl_path != ''
  `).all().map((row) => ({
    sessionId: String(row.id),
    jsonlPath: String(row.jsonl_path),
    source: String(row.source),
  }));
}

/**
 * 创建本次 build 的 IndexUnit 计划。版本标记缺失且已存在该 Provider 的旧数据时，
 * 以 null cursor 全量回放，防止旧解析语义与新 schema/逻辑混用。
 */
export function createProviderIndexPlan(
  db: SqliteDb,
  registry: ProviderRegistry,
  {
    force = false,
    changedPaths,
    priorSessions,
  }: {
    force?: boolean;
    changedPaths?: string[];
    priorSessions?: readonly ProviderSessionProvenance[];
  } = {},
): ProviderIndexPlan {
  const items: ProviderIndexItem[] = [];
  const pendingMarkers = new Map<string, string>();
  const inventoryIssues: ProviderInventoryRootIssue[] = [];
  const providers = registry.list();
  const provenance = priorSessions ?? readProviderSessionProvenance(db);
  const markerMissing = new Map<string, boolean>();
  for (const provider of providers) {
    const marker = provider.indexVersionMarker;
    const missing = marker !== undefined && !db.prepare(
      'SELECT jsonl_path FROM index_state WHERE jsonl_path = ?',
    ).get(marker);
    markerMissing.set(provider.name, missing);
    if (missing) pendingMarkers.set(provider.name, marker);
  }
  const fullRebuild = force || providers.some(provider => (
    markerMissing.get(provider.name) === true
    && provenance.some(session => session.source === provider.name)
  ));
  for (const provider of providers) {
    const providerSessions = provenance
      .filter(session => session.source === provider.name)
      .map(({ sessionId, jsonlPath }) => ({ sessionId, jsonlPath }));
    const indexedSessions = (): readonly IndexedSession[] => providerSessions;
    const fullReindex = fullRebuild;
    const units = provider.discover({
      lastCursor: fullReindex ? () => null : (key) => storedProviderCursor(db, key),
      changedPaths: fullReindex ? undefined : changedPaths,
      indexedSessions,
      reportUnavailableRoot: (issue) => {
        // 没有旧快照的内建 Provider 是可选来源，不阻断 force rebuild。
        if (indexedSessions().length === 0) return;
        inventoryIssues.push({ provider: provider.name, ...issue });
      },
    });
    for (const unit of units) {
      items.push({
        provider,
        unit,
        cursor: fullReindex ? null : storedProviderCursor(db, unit.key),
      });
    }
  }
  return { items, pendingMarkers, fullRebuild, inventoryIssues };
}

/** 任何全量清理都必须在写入前通过现有 Provider 来源根预检。 */
export function assertRebuildRootsAvailable(plan: ProviderIndexPlan): void {
  if (plan.fullRebuild && plan.inventoryIssues.length > 0) {
    throw new ProviderRootUnavailableError(plan.inventoryIssues);
  }
}

/**
 * 在调用方给定的事务中逐 unit 执行 provider.parse() → persist()。坏文件可跳过，
 * 数据库忙则通过 onError 通知上层停止，避免把 SQLite binding 细节泄漏进 Provider。
 */
export function indexProviderPlan({
  db,
  plan,
  runTransaction,
  onPersisted = () => {},
  onCommitted = () => {},
  onError,
}: {
  db: SqliteDb;
  plan: ProviderIndexPlan;
  runTransaction: <T>(label: string, work: () => T) => T;
  /** persist 成功后、同一事务提交前运行派生数据收尾。 */
  onPersisted?: (item: ProviderIndexItem, cursor: Cursor) => void;
  onCommitted?: (item: ProviderIndexItem, cursor: Cursor) => void;
  onError: (error: unknown, item: ProviderIndexItem) => 'skip' | 'stop';
}): ProviderIndexResult {
  const committed: ProviderIndexItem[] = [];
  const failedProviders = new Set<string>();
  for (const item of plan.items) {
    try {
      const cursor = runTransaction(`provider:${item.provider.name}:${item.unit.key}`, () => {
        const nextCursor = persist(db, item.unit, item.provider.parse(item.unit, item.cursor));
        onPersisted(item, nextCursor);
        return nextCursor;
      });
      committed.push(item);
      onCommitted(item, cursor);
    } catch (error) {
      failedProviders.add(item.provider.name);
      if (onError(error, item) === 'stop') {
        return { committed, failedProviders, stopped: { item, error } };
      }
    }
  }
  return { committed, failedProviders };
}

/** 仅当 Provider 的所有 unit 全部成功提交且未整体停止时，才写入版本完成标记。 */
export function writeProviderIndexMarkers(
  db: SqliteDb,
  plan: ProviderIndexPlan,
  result: ProviderIndexResult,
): void {
  const write = db.prepare(
    'INSERT OR REPLACE INTO index_state (jsonl_path, mtime, lines_processed) VALUES (?, ?, 0)',
  );
  for (const [provider, marker] of plan.pendingMarkers) {
    if (!result.failedProviders.has(provider) && result.stopped === undefined) {
      write.run(marker, Date.now());
    }
  }
}
