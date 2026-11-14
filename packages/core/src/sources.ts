// Copyright (C) 2026 tommy0103 and contributors.
// Copyright (C) 2026 wutongyuonce and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * 来源清单（source ledger，见 docs/adr/0014）。
 *
 * 这是“哪个来源还在、它拥有哪些行”的唯一权威：persist 通过 declareSource 声明当前
 * 来源，调度层通过 markSourcesMissing 记录消失，App 通过 purgeMissingSources 显式清理。
 * 来源消失只改状态，不删除任何投影行；只有 supersede（同一路径换了主人）与 purge 删除。
 */
import type { KnownSource } from './providers/types.ts';
import type { SqliteDb } from './sqlite-types.ts';

/** 会话自身的来源（主 transcript / Codex thread / Pi 文件 / DeepSeek 根会话）。 */
export const SESSION_MEMBER = '';

/** 每张由来源拥有的投影表。sessions 行另由 member '' 的来源拥有，见 persist。 */
export const OWNED_TABLES = [
  'messages', 'tool_calls', 'tool_results', 'summaries', 'subagents', 'workflows', 'workflow_agents',
] as const;


/** Provider 发现阶段可见的本机来源清单（不含同步导入的其他设备来源，也不暴露 transcript 内容）。 */
export function readKnownSources(db: SqliteDb, provider: string): KnownSource[] {
  return db.prepare(
    'SELECT path, session_id, member, status FROM sources WHERE provider = ? AND path IS NOT NULL AND device_id IS NULL',
  ).all(provider).map((row) => ({
    path: String(row.path),
    sessionId: String(row.session_id),
    member: String(row.member),
    status: row.status === 'missing' ? 'missing' : 'present',
  }));
}

/** 删除一个来源拥有的全部投影行（不含 sessions 行与来源本身）。 */
function deleteSourceRows(db: SqliteDb, sourceId: number): void {
  for (const table of OWNED_TABLES) db.prepare(`DELETE FROM ${table} WHERE source_id = ?`).run(sourceId);
}

/** 删除来源及其行；主来源被删但仍有子来源时把会话清为占位行；没有任何来源时一并删除会话行。 */
export function removeSource(db: SqliteDb, sourceId: number, sessionId: string, member?: string): void {
  const actualMember = member ?? String(db.prepare('SELECT member FROM sources WHERE id = ?').get(sourceId)?.member ?? '');
  deleteSourceRows(db, sourceId);
  db.prepare('DELETE FROM sources WHERE id = ?').run(sourceId);
  if (!db.prepare('SELECT 1 FROM sources WHERE session_id = ? LIMIT 1').get(sessionId)) {
    db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
  } else if (actualMember === SESSION_MEMBER) {
    db.prepare('UPDATE sessions SET jsonl_path = NULL, message_count = 0 WHERE id = ?').run(sessionId);
  }
}

export interface DeclaredSource {
  readonly id: number;
  /** 被本次声明取代的其他来源所属的会话（同一路径换了主人）。 */
  readonly supersededSessionIds: readonly string[];
}

/**
 * 声明 `(sessionId, member)` 当前位于 `path` 并已被读取。同一路径原先属于其他来源时，
 * 那个来源被取代：证据换了身份（例如被收编的 DeepSeek 子会话），旧投影删除。
 * 来源移动（同一键换路径）只更新路径；missing 的来源重新出现时恢复 present。
 */
export function declareSource(
  db: SqliteDb,
  { provider, sessionId, member, path, now }: {
    provider: string; sessionId: string; member: string; path: string; now: number;
  },
): DeclaredSource {
  const supersededSessionIds: string[] = [];
  const holders = db.prepare(
    'SELECT id, session_id, member FROM sources WHERE device_id IS NULL AND path = ? AND NOT (session_id = ? AND member = ?)',
  ).all(path, sessionId, member);
  for (const holder of holders) {
    removeSource(db, Number(holder.id), String(holder.session_id), String(holder.member));
    supersededSessionIds.push(String(holder.session_id));
  }
  // 本机也出现了某个此前仅从其他设备同步导入的 sessionId 时，整会话归本机所有，先清理对端遗留来源。
  const remoteSources = db.prepare(
    'SELECT id, session_id, member FROM sources WHERE session_id = ? AND device_id IS NOT NULL',
  ).all(sessionId);
  for (const remote of remoteSources) {
    removeSource(db, Number(remote.id), String(remote.session_id), String(remote.member));
  }
  db.prepare('DELETE FROM sessions WHERE id = ? AND device_id IS NOT NULL').run(sessionId);
  const existing = db.prepare('SELECT id FROM sources WHERE session_id = ? AND member = ?').get(sessionId, member);
  if (existing) {
    db.prepare(`UPDATE sources SET provider = ?, path = ?, status = 'present', missing_since = NULL,
      last_seen_at = ?, device_id = NULL, device_name = NULL WHERE id = ?`).run(provider, path, now, existing.id);
    return { id: Number(existing.id), supersededSessionIds };
  }
  db.prepare(`INSERT INTO sources (provider, session_id, member, path, status, first_seen_at, last_seen_at)
    VALUES (?, ?, ?, ?, 'present', ?, ?)`).run(provider, sessionId, member, path, now, now);
  const inserted = db.prepare('SELECT id FROM sources WHERE session_id = ? AND member = ?').get(sessionId, member);
  return { id: Number(inserted!.id), supersededSessionIds };
}

/** 记录一个已索引路径从权威 inventory 中消失；行全部保留。返回受影响的会话。 */
export function markSourcesMissing(db: SqliteDb, provider: string, path: string, now: number): string[] {
  const rows = db.prepare(
    "SELECT id, session_id FROM sources WHERE device_id IS NULL AND provider = ? AND path = ? AND status = 'present'",
  ).all(provider, path);
  const mark = db.prepare("UPDATE sources SET status = 'missing', missing_since = ? WHERE id = ?");
  for (const row of rows) mark.run(now, row.id);
  return rows.map(row => String(row.session_id));
}

/**
 * 由来源清单推导会话状态：present（主来源与其余来源都在）、partial（部分缺失，或主来源
 * 不在/缺失）、missing（一个都不在）。存储下来是为了查询与筛选，权威仍是 sources。
 */
export function refreshSessionSourceStatus(db: SqliteDb, sessionIds: Iterable<string> | null): void {
  const sql = `UPDATE sessions SET source_status = CASE
      WHEN NOT EXISTS (SELECT 1 FROM sources s WHERE s.session_id = sessions.id AND s.status = 'present') THEN 'missing'
      WHEN EXISTS (SELECT 1 FROM sources s WHERE s.session_id = sessions.id AND s.status = 'missing')
        OR NOT EXISTS (SELECT 1 FROM sources s WHERE s.session_id = sessions.id AND s.member = '' AND s.status = 'present')
        THEN 'partial'
      ELSE 'present' END`;
  if (sessionIds === null) {
    db.prepare(sql).run();
    return;
  }
  const update = db.prepare(`${sql} WHERE id = ?`);
  for (const sessionId of new Set(sessionIds)) update.run(sessionId);
}

export interface PurgeResult {
  readonly sources: number;
  readonly sessions: number;
}

/**
 * 显式清理：删除 missing 的来源（可只删缺失早于 `missingBefore` 的）及其拥有的行，
 * 再删除因此没有任何来源的会话。memories 永不触及。这是唯一会删除历史的操作。
 */
export function purgeMissingSources(db: SqliteDb, { missingBefore }: { missingBefore?: number } = {}): PurgeResult {
  const rows = missingBefore === undefined
    ? db.prepare("SELECT id, session_id, member FROM sources WHERE device_id IS NULL AND status = 'missing'").all()
    : db.prepare("SELECT id, session_id, member FROM sources WHERE device_id IS NULL AND status = 'missing' AND COALESCE(missing_since, 0) <= ?").all(missingBefore);
  const sessionsBefore = Number(db.prepare('SELECT COUNT(*) AS n FROM sessions').get()?.n ?? 0);
  const touched = new Set<string>();
  for (const row of rows) {
    removeSource(db, Number(row.id), String(row.session_id), String(row.member));
    touched.add(String(row.session_id));
  }
  refreshSessionSourceStatus(db, touched);
  const sessionsAfter = Number(db.prepare('SELECT COUNT(*) AS n FROM sessions').get()?.n ?? 0);
  return { sources: rows.length, sessions: sessionsBefore - sessionsAfter };
}

/** 统计本机清单状态，供设置页与清理预览使用。 */
export function sourceLedgerSummary(db: SqliteDb, { missingBefore }: { missingBefore?: number } = {}) {
  const missingSources = Number(db.prepare(
    "SELECT COUNT(*) AS n FROM sources WHERE device_id IS NULL AND status = 'missing' AND COALESCE(missing_since, 0) <= ?",
  ).get(missingBefore ?? Number.MAX_SAFE_INTEGER)?.n ?? 0);
  const byStatus = Object.fromEntries(db.prepare(
    "SELECT source_status AS status, COUNT(*) AS n FROM sessions WHERE device_id IS NULL GROUP BY source_status",
  ).all().map(row => [String(row.status ?? 'present'), Number(row.n)]));
  return {
    missingSources,
    partialSessions: byStatus.partial ?? 0,
    missingSessions: byStatus.missing ?? 0,
  };
}

/**
 * 0.3.x → 0.4.0 迁移：为既有行建立来源清单并归属所有权（幂等）。主来源来自
 * sessions.jsonl_path；带 agent_id 的行先归到无路径的成员来源，状态 missing，
 * 首次重放时 Provider 声明真实路径即恢复 present；只拥有零行的遗留来源由
 * dropEmptyLegacySources 清掉。
 */
export function backfillSourceLedger(db: SqliteDb, now: number): void {
  // 没有会话行却有投影的会话（旧版孤儿数据）补占位会话，保证“每个来源都有会话行”。
  const orphanSources = OWNED_TABLES.map(table => `SELECT session_id FROM ${table}`).join(' UNION ');
  db.prepare(`INSERT OR IGNORE INTO sessions (id, source, message_count)
    SELECT o.session_id, COALESCE((SELECT m.source FROM messages m WHERE m.session_id = o.session_id LIMIT 1), 'claude'), 0
    FROM (${orphanSources}) o
    WHERE o.session_id IS NOT NULL AND o.session_id NOT IN (SELECT id FROM sessions)`).run();
  db.prepare(`INSERT OR IGNORE INTO sources (provider, session_id, member, path, status, first_seen_at, last_seen_at, missing_since)
    SELECT COALESCE(source, 'claude'), id, '', NULLIF(jsonl_path, ''),
      CASE WHEN COALESCE(jsonl_path, '') = '' THEN 'missing' ELSE 'present' END, ?, ?,
      CASE WHEN COALESCE(jsonl_path, '') = '' THEN ? END
    FROM sessions`).run(now, now, now);
  db.prepare(`INSERT OR IGNORE INTO sources (provider, session_id, member, path, status, first_seen_at, last_seen_at, missing_since)
    SELECT COALESCE(MAX(source), 'claude'), session_id, agent_id, NULL, 'missing', ?, ?, ?
    FROM messages WHERE agent_id IS NOT NULL AND agent_id != '' AND session_id IS NOT NULL
    GROUP BY session_id, agent_id`).run(now, now, now);
  const owner = (member: string) => `(SELECT s.id FROM sources s WHERE s.session_id = t.session_id AND s.member = ${member})`;
  const main = owner("''");
  db.exec(`UPDATE messages AS t SET source_id = COALESCE(${owner("COALESCE(t.agent_id, '')")}, ${main}) WHERE source_id IS NULL`);
  for (const table of ['tool_calls', 'tool_results']) {
    db.exec(`UPDATE ${table} AS t SET source_id = COALESCE(
      (SELECT m.source_id FROM messages m WHERE m.uuid = t.message_uuid), ${main}) WHERE source_id IS NULL`);
  }
  db.exec(`UPDATE summaries AS t SET source_id = COALESCE(${owner("COALESCE(t.agent_id, '')")}, ${main}) WHERE source_id IS NULL`);
  db.exec(`UPDATE subagents AS t SET source_id = COALESCE(${owner('t.agent_id')}, ${main}) WHERE source_id IS NULL`);
  for (const table of ['workflows', 'workflow_agents']) {
    db.exec(`UPDATE ${table} AS t SET source_id = ${main} WHERE source_id IS NULL`);
  }
  refreshSessionSourceStatus(db, null);
}

/** 迁移遗留的无路径来源在重放后若不再拥有任何行（证据已归到真实来源），删除它们。 */
export function dropEmptyLegacySources(db: SqliteDb): void {
  const owns = OWNED_TABLES.map(table => `EXISTS (SELECT 1 FROM ${table} WHERE source_id = sources.id)`).join(' OR ');
  const rows = db.prepare(`SELECT id, session_id FROM sources WHERE path IS NULL AND member != '' AND NOT (${owns})`).all();
  for (const row of rows) db.prepare('DELETE FROM sources WHERE id = ?').run(row.id);
  if (rows.length) refreshSessionSourceStatus(db, rows.map(row => String(row.session_id)));
}
