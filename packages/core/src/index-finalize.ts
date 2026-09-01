// Copyright (C) 2026 tommy0103 and contributors.
// Copyright (C) 2026 wutongyuonce and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Core 与 App 共享的索引收尾策略。
 *
 * 调用方继续负责发现、事务重试和 watcher；本模块只统一 project_path 与 FTS
 * 的派生数据一致性，避免普通增量构建退化为全库扫描。
 */
import { inferProjectPath } from './parsing.ts';
import type { SqliteDb, SqliteRow } from './sqlite-types.ts';

const FTS_TRIGGERS_READY_MARKER = '__fts_triggers_ready__';
const PROJECT_PATH_BACKFILL_MARKER = '__project_path_backfill_v1__';
const MESSAGE_FTS_TRIGGERS = [
  'messages_fts_ai',
  'messages_fts_ad',
  'messages_fts_au',
] as const;

/** 批量替换消息前临时移除 FTS trigger，完成后由 schema 恢复。 */
export function dropMessageFtsTriggers(db: SqliteDb): void {
  for (const trigger of MESSAGE_FTS_TRIGGERS) {
    db.exec(`DROP TRIGGER IF EXISTS ${trigger}`);
  }
}

/** 普通构建依赖 trigger 增量维护；首次初始化或 force 时才全量修复 FTS。 */
export function ensureFtsReady(db: SqliteDb, { force = false }: { force?: boolean } = {}): boolean {
  const ready = db.prepare('SELECT jsonl_path FROM index_state WHERE jsonl_path = ?')
    .get(FTS_TRIGGERS_READY_MARKER);
  if (ready && !force) return false;
  db.exec("INSERT INTO messages_fts(messages_fts) VALUES('rebuild')");
  db.exec("INSERT INTO memories_fts(memories_fts) VALUES('rebuild')");
  db.prepare(
    'INSERT OR REPLACE INTO index_state (jsonl_path, mtime, lines_processed) VALUES (?, ?, 0)',
  ).run(FTS_TRIGGERS_READY_MARKER, Date.now());
  return true;
}

/** 刷新全部 session（null）或严格限定在本次受影响的 session 集合。 */
export function refreshSessionProjectPaths(
  db: SqliteDb,
  sessionIds: ReadonlySet<string> | null = null,
): void {
  let sessions: SqliteRow[];
  if (sessionIds === null) {
    sessions = db.prepare('SELECT id, project FROM sessions').all();
  } else {
    const sessionById = db.prepare('SELECT id, project FROM sessions WHERE id = ?');
    sessions = [...sessionIds]
      .map(sessionId => sessionById.get(sessionId))
      .filter((session): session is SqliteRow => session !== undefined);
  }

  const cwdStmt = db.prepare(`
    SELECT cwd
    FROM messages
    WHERE session_id = ? AND cwd IS NOT NULL AND cwd != ''
    ORDER BY timestamp IS NULL, timestamp
  `);
  const update = db.prepare('UPDATE sessions SET project_path = ? WHERE id = ?');
  for (const session of sessions) {
    const cwds = cwdStmt.all(session.id).map((row: SqliteRow) => row.cwd);
    const projectPath = inferProjectPath(session.project, cwds);
    if (projectPath) update.run(projectPath, session.id);
  }
}

/** 旧库中尚未解析的 project_path 只补偿一次；新变化由 unit 事务持续维护。 */
export function backfillUnresolvedSessionProjectPathsOnce(db: SqliteDb): boolean {
  const done = db.prepare('SELECT jsonl_path FROM index_state WHERE jsonl_path = ?')
    .get(PROJECT_PATH_BACKFILL_MARKER);
  if (done) return false;
  const unresolved = new Set(db.prepare(
    "SELECT id FROM sessions WHERE project_path IS NULL OR project_path = ''",
  ).all().map((session: SqliteRow) => String(session.id)));
  refreshSessionProjectPaths(db, unresolved);
  db.prepare(
    'INSERT OR REPLACE INTO index_state (jsonl_path, mtime, lines_processed) VALUES (?, ?, 0)',
  ).run(PROJECT_PATH_BACKFILL_MARKER, Date.now());
  return true;
}

export { FTS_TRIGGERS_READY_MARKER, PROJECT_PATH_BACKFILL_MARKER };
