// Copyright (C) 2026 wutongyuonce and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * 多端文件夹同步（方案 A，见 docs/adr/0014）。
 *
 * 每台设备只写自己的只读分片 `<syncDir>/devices/<deviceId>.sqlite`（由 VACUUM INTO
 * 生成临时文件再原子改名），并把其他设备的分片按 `device_id` 导入本机 SQLite。
 * 这样多台设备通过 iCloud Drive / Dropbox / Syncthing / NAS 同步时绝不会并发写同一个
 * SQLite 文件，本机的 discover / rebuild / purge 也只触及 `device_id IS NULL` 的本机数据。
 */
import { randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { ensureFtsReady } from './index-finalize.ts';
import { SCHEMA_VERSION, validateSnapshot } from './snapshots.ts';
import { OWNED_TABLES, refreshSessionSourceStatus, removeSource } from './sources.ts';
import type { SqliteDb } from './sqlite-types.ts';

const DEVICE_ID_RE = /^[a-zA-Z0-9_-]{4,64}$/;

const TABLE_COLUMNS: Record<(typeof OWNED_TABLES)[number], readonly string[]> = {
  messages: [
    'uuid', 'session_id', 'type', 'parent_uuid', 'timestamp', 'role', 'text',
    'content_type', 'is_meta', 'visibility', 'model', 'agent_id',
    'input_tokens', 'output_tokens', 'cwd', 'skill', 'turn_duration_ms', 'source', 'source_id',
  ],
  tool_calls: ['id', 'message_uuid', 'session_id', 'name', 'input_json', 'file_path', 'source_id'],
  tool_results: ['tool_use_id', 'message_uuid', 'session_id', 'content', 'file_path', 'is_error', 'source_id'],
  summaries: ['id', 'session_id', 'agent_id', 'timestamp', 'source', 'content', 'visibility', 'input_tokens', 'output_tokens', 'source_id'],
  subagents: ['agent_id', 'session_id', 'parent_tool_use_id', 'agent_type', 'description', 'duration_ms', 'total_tokens', 'source_id'],
  workflows: ['run_id', 'session_id', 'parent_tool_use_id', 'task_id', 'script', 'result_json', 'timestamp', 'agent_count', 'duration_ms', 'total_tokens', 'status', 'workflow_name', 'source_id'],
  workflow_agents: ['agent_id', 'run_id', 'session_id', 'agent_type', 'description', 'phase', 'label', 'model', 'state', 'duration_ms', 'tokens', 'tool_calls', 'source_id'],
};

export interface SyncPeerInfo {
  readonly deviceId: string;
  readonly deviceName: string;
  readonly sessions: number;
  readonly exportedAt: number | null;
  readonly lastSyncedAt: number | null;
}

export interface SyncFolderResult {
  readonly exportedSessions: number;
  readonly exportedMemories: number;
  readonly importedPeers: number;
  readonly importedSessions: number;
  readonly skippedPeers: ReadonlyArray<{ deviceId: string; error: string }>;
  readonly peers: readonly SyncPeerInfo[];
}

export function ensureDeviceIdentity(settings: Record<string, unknown>): { deviceId: string; deviceName: string; changed: boolean } {
  let changed = false;
  let deviceId = typeof settings.deviceId === 'string' && DEVICE_ID_RE.test(settings.deviceId) ? settings.deviceId : '';
  if (!deviceId) {
    deviceId = `dev-${randomBytes(6).toString('hex')}`;
    settings.deviceId = deviceId;
    changed = true;
  }
  const fallbackName = hostname() || deviceId;
  const deviceName = typeof settings.deviceName === 'string' && settings.deviceName.trim()
    ? settings.deviceName.trim()
    : fallbackName;
  if (settings.deviceName !== deviceName) {
    settings.deviceName = deviceName;
    changed = true;
  }
  return { deviceId, deviceName, changed };
}

/** 删除某个同步设备在本机索引中的全部导入数据。 */
export function removePeerDeviceRows(db: SqliteDb, peerDeviceId: string): void {
  const sources = db.prepare('SELECT id, session_id, member FROM sources WHERE device_id = ?').all(peerDeviceId);
  const touched = new Set<string>();
  for (const row of sources) {
    removeSource(db, Number(row.id), String(row.session_id), String(row.member));
    touched.add(String(row.session_id));
  }
  db.prepare('DELETE FROM sessions WHERE device_id = ?').run(peerDeviceId);
  db.prepare('DELETE FROM index_state WHERE jsonl_path = ?').run(`__sync_peer_${peerDeviceId}__`);
  if (touched.size) refreshSessionSourceStatus(db, touched);
}

/** 导出本机分片到 `<syncDir>/devices/<deviceId>.sqlite`，并同步 memories 的 Markdown 文件。 */
export function exportDeviceShard(
  db: SqliteDb,
  {
    syncDir,
    deviceId,
    deviceName,
    openDb,
    now = Date.now(),
  }: {
    syncDir: string;
    deviceId: string;
    deviceName: string;
    openDb: (path: string, options?: { readonly?: boolean }) => SqliteDb;
    now?: number;
  },
): { sessions: number; memories: number; shardPath: string } {
  if (!DEVICE_ID_RE.test(deviceId)) throw new Error(`Invalid deviceId: ${deviceId}`);
  const devicesDir = join(syncDir, 'devices');
  const memoriesDir = join(syncDir, 'memories');
  mkdirSync(devicesDir, { recursive: true });
  mkdirSync(memoriesDir, { recursive: true });

  const shardPath = join(devicesDir, `${deviceId}.sqlite`);
  const tempPath = join(devicesDir, `.${deviceId}.${process.pid}.${now}.tmp`);
  rmSync(tempPath, { force: true });
  let exportedSessions: number;
  let exportedMemories: number;
  try {
    db.prepare('VACUUM INTO ?').run(tempPath);
    const shard = openDb(tempPath);
    try {
      // 分片只携带本机自己的来源与会话，绝不转发其他设备的分片数据。
      const remotePeers = shard.prepare('SELECT DISTINCT device_id FROM sources WHERE device_id IS NOT NULL').all();
      for (const row of remotePeers) removePeerDeviceRows(shard, String(row.device_id));
      shard.exec('DELETE FROM sessions WHERE device_id IS NOT NULL');
      shard.exec('DELETE FROM index_state');
      shard.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
      exportedSessions = Number(shard.prepare('SELECT COUNT(*) AS n FROM sessions').get()?.n ?? 0);
      exportedMemories = Number(shard.prepare('SELECT COUNT(*) AS n FROM memories').get()?.n ?? 0);
    } finally {
      shard.close();
    }

    // 先写记忆 Markdown 与 .meta.json，最后原子发布 .sqlite 分片，使对端看到新分片时配套文件已就位。
    const memoryRows = db.prepare('SELECT id, path FROM memories WHERE deleted_at IS NULL').all();
    for (const row of memoryRows) {
      const filePath = typeof row.path === 'string' ? row.path : '';
      if (!filePath || !existsSync(filePath)) continue;
      try {
        copyFileSync(filePath, join(memoriesDir, `${encodeURIComponent(String(row.id))}.md`));
      } catch { /* 单个记忆文件不可读时不阻塞同步 */ }
    }

    const metaPath = join(devicesDir, `${deviceId}.meta.json`);
    const tempMeta = `${metaPath}.${process.pid}.tmp`;
    writeFileSync(tempMeta, JSON.stringify({
      deviceId,
      deviceName,
      exportedAt: now,
      schemaVersion: SCHEMA_VERSION,
      sessions: exportedSessions,
      memories: exportedMemories,
    }, null, 2));
    renameSync(tempMeta, metaPath);

    renameSync(tempPath, shardPath);
  } finally {
    rmSync(tempPath, { force: true });
  }
  return { sessions: exportedSessions, memories: exportedMemories, shardPath };
}

function readPeerMeta(devicesDir: string, peerId: string): { deviceName: string; exportedAt: number | null } {
  try {
    const parsed = JSON.parse(readFileSync(join(devicesDir, `${peerId}.meta.json`), 'utf8'));
    return {
      deviceName: typeof parsed?.deviceName === 'string' && parsed.deviceName.trim() ? parsed.deviceName.trim() : peerId,
      exportedAt: typeof parsed?.exportedAt === 'number' ? parsed.exportedAt : null,
    };
  } catch {
    return { deviceName: peerId, exportedAt: null };
  }
}

/** 从 `<syncDir>/devices/` 导入其他设备的分片。 */
export function importPeerShards(
  db: SqliteDb,
  {
    syncDir,
    deviceId,
    trajexDir,
    openDb,
    runTransaction,
    now = Date.now(),
  }: {
    syncDir: string;
    deviceId: string;
    trajexDir: string;
    openDb: (path: string, options?: { readonly?: boolean }) => SqliteDb;
    runTransaction: <T>(label: string, work: () => T) => T;
    now?: number;
  },
): { importedPeers: number; importedSessions: number; skippedPeers: Array<{ deviceId: string; error: string }> } {
  const devicesDir = join(syncDir, 'devices');
  const memoriesDir = join(syncDir, 'memories');
  let names: string[];
  try { names = readdirSync(devicesDir); } catch { return { importedPeers: 0, importedSessions: 0, skippedPeers: [] }; }

  let importedPeers = 0;
  let importedSessions = 0;
  const skippedPeers: Array<{ deviceId: string; error: string }> = [];

  for (const name of names.sort()) {
    if (!name.endsWith('.sqlite') || name.startsWith('.')) continue;
    const peerId = name.slice(0, -'.sqlite'.length);
    if (!DEVICE_ID_RE.test(peerId) || peerId === deviceId) continue;
    const shardPath = join(devicesDir, name);
    const meta = readPeerMeta(devicesDir, peerId);
    const peerName = meta.deviceName;
    let signature: string;
    try {
      const st = statSync(shardPath);
      signature = `${st.mtimeMs}:${st.size}:${meta.exportedAt ?? ''}:${peerName}`;
    } catch {
      continue;
    }
    const markerKey = `__sync_peer_${peerId}__`;
    const prevMarker = db.prepare('SELECT cursor FROM index_state WHERE jsonl_path = ?').get(markerKey);
    if (prevMarker?.cursor === signature) continue;

    try {
      validateSnapshot(shardPath, p => openDb(p, { readonly: true }), { requireSnapshotName: false });
    } catch (error) {
      skippedPeers.push({ deviceId: peerId, error: error instanceof Error ? error.message : String(error) });
      continue;
    }

    const peerDb = openDb(shardPath, { readonly: true });
    let peerSources: Array<Record<string, unknown>> = [];
    let peerSessions: Array<Record<string, unknown>> = [];
    const peerTableRows = new Map<(typeof OWNED_TABLES)[number], Array<Record<string, unknown>>>();
    let peerMemories: Array<Record<string, unknown>> = [];
    try {
      const hasSources = Boolean(peerDb.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='sources'").get());
      peerSessions = peerDb.prepare('SELECT * FROM sessions').all() as Array<Record<string, unknown>>;
      if (hasSources) {
        peerSources = peerDb.prepare('SELECT * FROM sources WHERE device_id IS NULL').all() as Array<Record<string, unknown>>;
      } else {
        // 兼容 0.3.x 快照格式的分片：每个会话生成一条主来源。
        peerSources = peerSessions.map((s, idx) => ({
          id: idx + 1,
          provider: s.source ?? 'claude',
          session_id: s.id,
          member: '',
          path: s.jsonl_path ?? null,
          status: 'present',
          first_seen_at: now,
          last_seen_at: now,
          missing_since: null,
        }));
      }
      for (const table of OWNED_TABLES) {
        if (!peerDb.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) {
          peerTableRows.set(table, []);
          continue;
        }
        peerTableRows.set(table, peerDb.prepare(`SELECT * FROM ${table}`).all() as Array<Record<string, unknown>>);
      }
      if (peerDb.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='memories'").get()) {
        peerMemories = peerDb.prepare('SELECT * FROM memories').all() as Array<Record<string, unknown>>;
      }
    } finally {
      peerDb.close();
    }

    // 绝不直接采用对端分片中的本机文件路径（既在对端机器路径下无效，也防止指向本机敏感文件后被下次导出）。
    // 统一落入本机 synced-memories/<id>.md。
    const syncedMemoriesDir = join(trajexDir, 'synced-memories');
    for (const mem of peerMemories) {
      const encodedId = `${encodeURIComponent(String(mem.id))}.md`;
      const sharedMd = join(memoriesDir, encodedId);
      const targetMd = join(syncedMemoriesDir, encodedId);
      if (existsSync(sharedMd)) {
        try {
          mkdirSync(syncedMemoriesDir, { recursive: true });
          copyFileSync(sharedMd, targetMd);
        } catch { /* ignore */ }
      }
      mem.path = existsSync(targetMd) ? targetMd : '';
    }

    const sessionsAdded = runTransaction(`sync-import:${peerId}`, () => {
      removePeerDeviceRows(db, peerId);
      const peerSessionIdSet = new Set(peerSessions.map(s => String(s.id)));
      const hasLocalOrOtherPeerSession = db.prepare(
        'SELECT 1 FROM sessions WHERE id = ? UNION SELECT 1 FROM sources WHERE session_id = ? LIMIT 1',
      );
      const allowedSessionIds = new Set<string>();
      for (const sid of peerSessionIdSet) {
        if (!hasLocalOrOtherPeerSession.get(sid, sid)) allowedSessionIds.add(sid);
      }

      const sourceIdMap = new Map<number, number>();
      const sessionDefaultSource = new Map<string, number>();
      const importedSessionIds = new Set<string>();

      const insertSource = db.prepare(`
        INSERT OR IGNORE INTO sources
          (provider, session_id, member, path, status, first_seen_at, last_seen_at, missing_since, device_id, device_name)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const findSource = db.prepare('SELECT id, device_id FROM sources WHERE session_id = ? AND member = ?');

      for (const src of peerSources) {
        const sid = String(src.session_id);
        if (!allowedSessionIds.has(sid)) continue;
        const member = String(src.member ?? '');
        insertSource.run(
          String(src.provider ?? 'claude'),
          sid,
          member,
          src.path ?? null,
          src.status === 'missing' ? 'missing' : 'present',
          src.first_seen_at ?? now,
          src.last_seen_at ?? now,
          src.missing_since ?? null,
          peerId,
          peerName,
        );
        const row = findSource.get(sid, member);
        if (row && row.device_id === peerId) {
          const localId = Number(row.id);
          sourceIdMap.set(Number(src.id), localId);
          if (member === '' || !sessionDefaultSource.has(sid)) sessionDefaultSource.set(sid, localId);
          importedSessionIds.add(sid);
        }
      }

      const insertSession = db.prepare(`
        INSERT OR IGNORE INTO sessions
          (id, title, project, project_path, started_at, ended_at, git_branch, version, message_count, jsonl_path, source, source_status, device_id, device_name)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const checkInserted = db.prepare('SELECT 1 FROM sessions WHERE id = ? AND device_id = ?');
      let count = 0;
      for (const s of peerSessions) {
        const sid = String(s.id);
        if (!importedSessionIds.has(sid)) continue;
        insertSession.run(
          sid,
          s.title ?? null,
          s.project ?? null,
          s.project_path ?? null,
          s.started_at ?? null,
          s.ended_at ?? null,
          s.git_branch ?? null,
          s.version ?? null,
          s.message_count ?? 0,
          s.jsonl_path ?? null,
          s.source ?? 'claude',
          s.source_status ?? 'present',
          peerId,
          peerName,
        );
        if (checkInserted.get(sid, peerId)) count++;
      }

      for (const table of OWNED_TABLES) {
        const cols = TABLE_COLUMNS[table];
        const placeholders = cols.map(() => '?').join(', ');
        const stmt = db.prepare(`INSERT OR IGNORE INTO ${table} (${cols.join(', ')}) VALUES (${placeholders})`);
        for (const row of peerTableRows.get(table) ?? []) {
          const mappedSourceId = row.source_id != null
            ? sourceIdMap.get(Number(row.source_id))
            : sessionDefaultSource.get(String(row.session_id ?? ''));
          if (mappedSourceId === undefined) continue;
          const values = cols.map(col => (col === 'source_id' ? mappedSourceId : (row[col] ?? null)));
          stmt.run(...values);
        }
      }

      refreshSessionSourceStatus(db, importedSessionIds);

      const insertMemory = db.prepare(`
        INSERT OR IGNORE INTO memories
          (id, session_id, project, message_start, message_end, path, anchors, summary, created_at, deleted_at, deleted_reason)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const softDeleteMemory = db.prepare(`
        UPDATE memories SET deleted_at = ?, deleted_reason = ? WHERE id = ? AND deleted_at IS NULL
      `);
      const healMemoryPath = db.prepare(`
        UPDATE memories SET path = ? WHERE id = ? AND (path IS NULL OR path = '')
      `);
      for (const m of peerMemories) {
        const memId = String(m.id);
        const memPath = String(m.path ?? '');
        insertMemory.run(
          memId,
          m.session_id ?? null,
          m.project ?? null,
          m.message_start ?? null,
          m.message_end ?? null,
          memPath,
          m.anchors ?? null,
          String(m.summary ?? ''),
          String(m.created_at ?? new Date(now).toISOString()),
          m.deleted_at ?? null,
          m.deleted_reason ?? null,
        );
        if (memPath) healMemoryPath.run(memPath, memId);
        if (m.deleted_at != null) {
          softDeleteMemory.run(m.deleted_at, m.deleted_reason ?? null, memId);
        }
      }

      db.prepare('INSERT OR REPLACE INTO index_state (jsonl_path, mtime, lines_processed, cursor) VALUES (?, ?, 0, ?)')
        .run(markerKey, now, signature);
      return count;
    });

    importedPeers++;
    importedSessions += sessionsAdded;
  }

  if (importedPeers > 0) {
    runTransaction('sync-fts', () => {
      ensureFtsReady(db, { force: true });
    });
  }
  return { importedPeers, importedSessions, skippedPeers };
}

/** 列出已发现或已导入的其他同步设备。 */
export function listSyncPeers(db: SqliteDb, syncDir: string | null | undefined, selfDeviceId: string): SyncPeerInfo[] {
  const byId = new Map<string, { deviceName: string; sessions: number; exportedAt: number | null; lastSyncedAt: number | null }>();
  const rows = db.prepare(`
    SELECT device_id, MAX(device_name) AS device_name, COUNT(*) AS sessions
    FROM sessions WHERE device_id IS NOT NULL GROUP BY device_id
  `).all();
  for (const row of rows) {
    const id = String(row.device_id);
    const marker = db.prepare('SELECT mtime FROM index_state WHERE jsonl_path = ?').get(`__sync_peer_${id}__`);
    byId.set(id, {
      deviceName: String(row.device_name || id),
      sessions: Number(row.sessions),
      exportedAt: null,
      lastSyncedAt: typeof marker?.mtime === 'number' ? marker.mtime : null,
    });
  }
  if (syncDir) {
    const devicesDir = join(syncDir, 'devices');
    let names: string[];
    try { names = readdirSync(devicesDir); } catch { names = []; }
    for (const name of names) {
      if (!name.endsWith('.sqlite') || name.startsWith('.')) continue;
      const peerId = name.slice(0, -'.sqlite'.length);
      if (!DEVICE_ID_RE.test(peerId) || peerId === selfDeviceId) continue;
      const meta = readPeerMeta(devicesDir, peerId);
      const current = byId.get(peerId);
      byId.set(peerId, {
        deviceName: meta.deviceName || current?.deviceName || peerId,
        sessions: current?.sessions ?? 0,
        exportedAt: meta.exportedAt,
        lastSyncedAt: current?.lastSyncedAt ?? null,
      });
    }
  }
  return [...byId.entries()]
    .map(([deviceId, info]) => ({ deviceId, ...info }))
    .sort((a, b) => a.deviceName.localeCompare(b.deviceName));
}

/** 执行一次完整的双向文件夹同步：先导出本机分片，再导入其他设备的分片。 */
export function syncWithFolder(
  db: SqliteDb,
  {
    syncDir,
    deviceId,
    deviceName,
    trajexDir,
    openDb,
    runTransaction,
    now = Date.now(),
  }: {
    syncDir: string;
    deviceId: string;
    deviceName: string;
    trajexDir: string;
    openDb: (path: string, options?: { readonly?: boolean }) => SqliteDb;
    runTransaction: <T>(label: string, work: () => T) => T;
    now?: number;
  },
): SyncFolderResult {
  const exported = exportDeviceShard(db, { syncDir, deviceId, deviceName, openDb, now });
  const imported = importPeerShards(db, { syncDir, deviceId, trajexDir, openDb, runTransaction, now });
  return {
    exportedSessions: exported.sessions,
    exportedMemories: exported.memories,
    importedPeers: imported.importedPeers,
    importedSessions: imported.importedSessions,
    skippedPeers: imported.skippedPeers,
    peers: listSyncPeers(db, syncDir, deviceId),
  };
}
