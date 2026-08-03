/**
 * Provider 索引计划模块。
 *
 * 模块定位：将 registry 发现的 IndexUnit 排成计划，取回 Provider 私有 cursor，
 * 并在调用方提供的事务中执行 parse → persist。它不绑定具体 SQLite 驱动。
 */
import { persist } from './persist.ts';
import type { ProviderRegistry } from './providers/registry.ts';
import type { Cursor, IndexUnit, ProviderAdapter } from './providers/types.ts';
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
}

/** 执行结果：已提交项、失败 Provider 集合；stopped 表示数据库忙等原因中途停止的位置。 */
export interface ProviderIndexResult {
  readonly committed: ProviderIndexItem[];
  readonly failedProviders: ReadonlySet<string>;
  readonly stopped?: { item: ProviderIndexItem; error: unknown };
}

/** 从 index_state 还原 adapter 私有 cursor，Core 不解释其编码。 */
export function storedProviderCursor(db: SqliteDb, key: string): Cursor {
  const row = db.prepare('SELECT mtime, lines_processed FROM index_state WHERE jsonl_path = ?').get(key);
  return row ? `${String(row.mtime)}:${String(row.lines_processed)}` : null;
}

/** 该来源是否已有历史 session（用于判定是否必须全量回放）。 */
function sourceAlreadyIndexed(db: SqliteDb, source: string): boolean {
  return Boolean(db.prepare('SELECT 1 FROM sessions WHERE source = ? LIMIT 1').get(source));
}

/**
 * 创建本次 build 的 IndexUnit 计划。版本标记缺失且已存在该 Provider 的旧数据时，
 * 以 null cursor 全量回放，防止旧解析语义与新 schema/逻辑混用。
 */
export function createProviderIndexPlan(
  db: SqliteDb,
  registry: ProviderRegistry,
  { force = false, changedPaths }: { force?: boolean; changedPaths?: string[] } = {},
): ProviderIndexPlan {
  const items: ProviderIndexItem[] = [];
  const pendingMarkers = new Map<string, string>();
  for (const provider of registry.list()) {
    const marker = provider.indexVersionMarker;
    const markerMissing = marker !== undefined && !db.prepare(
      'SELECT jsonl_path FROM index_state WHERE jsonl_path = ?',
    ).get(marker);
    if (markerMissing) pendingMarkers.set(provider.name, marker);
    const fullReindex = force || (markerMissing && sourceAlreadyIndexed(db, provider.name));
    const units = provider.discover({
      lastCursor: fullReindex ? () => null : (key) => storedProviderCursor(db, key),
      changedPaths: fullReindex ? undefined : changedPaths,
    });
    for (const unit of units) {
      items.push({
        provider,
        unit,
        cursor: fullReindex ? null : storedProviderCursor(db, unit.key),
      });
    }
  }
  return { items, pendingMarkers };
}

/**
 * 在调用方给定的事务中逐 unit 执行 provider.parse() → persist()。坏文件可跳过，
 * 数据库忙则通过 onError 通知上层停止，避免把 SQLite binding 细节泄漏进 Provider。
 */
export function indexProviderPlan({
  db,
  plan,
  runTransaction,
  onCommitted = () => {},
  onError,
}: {
  db: SqliteDb;
  plan: ProviderIndexPlan;
  runTransaction: <T>(label: string, work: () => T) => T;
  onCommitted?: (item: ProviderIndexItem, cursor: Cursor) => void;
  onError: (error: unknown, item: ProviderIndexItem) => 'skip' | 'stop';
}): ProviderIndexResult {
  const committed: ProviderIndexItem[] = [];
  const failedProviders = new Set<string>();
  for (const item of plan.items) {
    try {
      const cursor = runTransaction(`provider:${item.provider.name}:${item.unit.key}`, () => (
        persist(db, item.unit, item.provider.parse(item.unit, item.cursor))
      ));
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
