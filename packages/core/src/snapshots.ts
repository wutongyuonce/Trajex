// Copyright (C) 2026 tommy0103 and contributors.
// Copyright (C) 2026 wutongyuonce and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * 索引快照（见 docs/adr/0014）。
 *
 * 快照是 `VACUUM INTO` 生成的完整、一致、紧凑副本，放在 `<TRAJEX_DIR>/snapshots/`。
 * 本模块只做文件与 SQL 层面的操作，不绑定 SQLite 驱动；何时拍、何时恢复由调用方决定。
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { SqliteDb } from './sqlite-types.ts';

/** 当前 schema 版本，写在 PRAGMA user_version；更新的快照不能被本版本恢复。 */
export const SCHEMA_VERSION = 1;
const DEFAULT_SNAPSHOT_KEEP = 3;
const MAX_SNAPSHOT_KEEP = 20;
/** 同一批变更前只拍一次：10 分钟内已有快照时跳过“变更前”快照。 */
const PRE_CHANGE_DEDUPE_MS = 10 * 60 * 1000;
const DAILY_SNAPSHOT_MS = 24 * 60 * 60 * 1000;

export type SnapshotReason = 'daily' | 'manual' | 'pre-upgrade' | 'pre-rebuild' | 'pre-replay' | 'pre-purge' | 'pre-restore';

export interface SnapshotInfo {
  readonly path: string;
  readonly name: string;
  readonly createdAt: number;
  readonly reason: string;
  readonly bytes: number;
}

const SNAPSHOT_NAME_RE = /^trajex-(\d{8}T\d{9}Z)-([a-z-]+)\.sqlite$/;

export function snapshotDirFor(dbPath: string): string {
  return join(dirname(dbPath), 'snapshots');
}

function stamp(ms: number): string {
  return new Date(ms).toISOString().replace(/[-:.]/g, '');
}

function parseStamp(value: string): number {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(\d{3})Z$/.exec(value);
  return m ? Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!, +m[7]!) : 0;
}

/** 读取 App 设置中的快照保留份数；设置缺失或损坏时用默认值（CLI 与 App 共用同一份文件）。 */
export function readSnapshotSettings(trajexDir: string): { keep: number } {
  let settings: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(readFileSync(join(trajexDir, 'settings.json'), 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) settings = parsed;
  } catch { /* 默认值 */ }
  return { keep: normalizeKeep(settings.snapshotKeep) };
}

export function normalizeKeep(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isInteger(n) ? Math.max(1, Math.min(MAX_SNAPSHOT_KEEP, n)) : DEFAULT_SNAPSHOT_KEEP;
}

/** 列出快照，最新在前；不认识的文件（包括写到一半的 .partial）一律忽略。 */
export function listSnapshots(dir: string): SnapshotInfo[] {
  let names: string[];
  try { names = readdirSync(dir); } catch { return []; }
  return names.flatMap((name) => {
    const match = SNAPSHOT_NAME_RE.exec(name);
    if (!match) return [];
    const path = join(dir, name);
    try {
      return [{ path, name, createdAt: parseStamp(match[1]!), reason: match[2]!, bytes: statSync(path).size }];
    } catch {
      return [];
    }
  }).sort((a, b) => b.createdAt - a.createdAt || b.name.localeCompare(a.name));
}

/** 只保留最新的 keep 份。 */
export function pruneSnapshots(dir: string, keep: number): void {
  for (const snapshot of listSnapshots(dir).slice(normalizeKeep(keep))) {
    rmSync(snapshot.path, { force: true });
  }
}

/**
 * 拍一份快照并按 keep 修剪。先写 `.partial` 再改名，列表永远看不到半成品。
 * 不能在事务内调用（VACUUM 的限制）。失败时抛错，调用方据此中止依赖快照的操作。
 */
export function createSnapshot(
  db: SqliteDb,
  { dir, reason, keep, now = Date.now(), prune = true }: {
    dir: string; reason: SnapshotReason; keep: number; now?: number; prune?: boolean;
  },
): SnapshotInfo {
  mkdirSync(dir, { recursive: true });
  let at = now;
  let path = join(dir, `trajex-${stamp(at)}-${reason}.sqlite`);
  while (existsSync(path)) path = join(dir, `trajex-${stamp(++at)}-${reason}.sqlite`);
  const partial = `${path}.partial`;
  rmSync(partial, { force: true });
  try {
    db.prepare('VACUUM INTO ?').run(partial);
    renameSync(partial, path);
  } catch (error) {
    rmSync(partial, { force: true });
    const detail = error as { code?: unknown; errcode?: unknown } | null;
    throw Object.assign(
      new Error(`Trajex snapshot could not be written to ${dir}: ${error instanceof Error ? error.message : String(error)}`, { cause: error }),
      { code: detail?.code, errcode: detail?.errcode },
    );
  }
  if (prune) pruneSnapshots(dir, keep);
  return { path, name: basename(path), createdAt: at, reason, bytes: statSync(path).size };
}

/** “变更前”快照：最近 withinMs 内已有任何快照时复用它，不再重复拍。 */
export function createSnapshotUnlessRecent(
  db: SqliteDb,
  options: { dir: string; reason: SnapshotReason; keep: number; now?: number; withinMs?: number },
): SnapshotInfo | null {
  const now = options.now ?? Date.now();
  const newest = listSnapshots(options.dir)[0];
  if (newest && now - newest.createdAt < (options.withinMs ?? PRE_CHANGE_DEDUPE_MS)) return null;
  return createSnapshot(db, { ...options, now });
}

/** 每日快照是否到期：最新的任意快照早于 intervalMs。 */
export function snapshotDue(dir: string, now = Date.now(), intervalMs = DAILY_SNAPSHOT_MS): boolean {
  const newest = listSnapshots(dir)[0];
  return !newest || now - newest.createdAt >= intervalMs;
}

/** 数据库是否有值得保护的数据（新库或空库不拍快照）。 */
export function hasIndexedData(db: SqliteDb): boolean {
  try {
    return Boolean(db.prepare('SELECT 1 FROM sessions LIMIT 1').get() ?? db.prepare('SELECT 1 FROM memories LIMIT 1').get());
  } catch {
    return false;
  }
}

/**
 * 恢复前的完整性与版本检查；任何失败都在动当前索引之前报告。
 * openReadOnly 由调用方提供（不同进程使用不同 SQLite 驱动）。
 */
export function validateSnapshot(path: string, openReadOnly: (path: string) => SqliteDb): { userVersion: number } {
  if (!SNAPSHOT_NAME_RE.test(basename(path)) || !existsSync(path)) throw new Error(`Not a Trajex snapshot: ${path}`);
  const db = openReadOnly(path);
  try {
    const check = String(Object.values(db.prepare('PRAGMA quick_check').get() ?? {})[0] ?? '');
    if (check !== 'ok') throw new Error(`Snapshot failed its integrity check: ${check}`);
    const userVersion = Number(Object.values(db.prepare('PRAGMA user_version').get() ?? {})[0] ?? 0);
    if (userVersion > SCHEMA_VERSION) {
      throw new Error(`Snapshot was written by a newer Trajex (schema ${userVersion}; this build reads up to ${SCHEMA_VERSION})`);
    }
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'sessions'").get()) {
      throw new Error('Snapshot does not contain a Trajex index');
    }
    return { userVersion };
  } finally {
    db.close();
  }
}

/**
 * 用快照替换索引文件。调用方必须已关闭所有连接并持有 writer lease。先复制到同目录临时
 * 文件再改名，替换是原子的；旧的 WAL/SHM 必须删除，否则会被套用到新文件上。
 */
export function replaceIndexWithSnapshot(snapshotPath: string, dbPath: string): void {
  const temp = `${dbPath}.restore-${process.pid}-${Date.now()}.tmp`;
  copyFileSync(snapshotPath, temp);
  try {
    for (const sidecar of [`${dbPath}-wal`, `${dbPath}-shm`]) rmSync(sidecar, { force: true });
    renameSync(temp, dbPath);
  } finally {
    rmSync(temp, { force: true });
  }
}

const MEMORY_COLUMNS = [
  'id', 'session_id', 'project', 'message_start', 'message_end',
  'path', 'anchors', 'summary', 'created_at', 'deleted_at', 'deleted_reason',
] as const;

/** 读取当前索引中的全部 memories（若表或列不存在则兼容补空），供恢复后合并回新索引。 */
export function readDurableMemories(db: SqliteDb): Array<Record<string, unknown>> {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'memories'").get()) return [];
  const available = new Set(db.prepare('PRAGMA table_info(memories)').all().map(column => String(column.name)));
  const select = MEMORY_COLUMNS.map(column => (available.has(column) ? column : `NULL AS ${column}`)).join(', ');
  return db.prepare(`SELECT ${select} FROM memories`).all() as Array<Record<string, unknown>>;
}

/** 将读取出的 memories 合并写入目标索引（同 id 以传入为准）。 */
export function restoreDurableMemories(db: SqliteDb, rows: ReadonlyArray<Record<string, unknown>>): void {
  if (!rows.length) return;
  const placeholders = MEMORY_COLUMNS.map(() => '?').join(',');
  const stmt = db.prepare(`INSERT OR REPLACE INTO memories (${MEMORY_COLUMNS.join(',')}) VALUES (${placeholders})`);
  for (const row of rows) {
    stmt.run(...MEMORY_COLUMNS.map(column => row[column] ?? null));
  }
}
