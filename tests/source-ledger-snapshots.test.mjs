// Copyright (C) 2026 tommy0103 and contributors.
// Copyright (C) 2026 wutongyuonce and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  buildIndex,
  getRetentionSummary,
  purgeMissing,
  removeSyncPeer,
  restoreSnapshot,
  syncFolder,
  takeSnapshot,
} from '../app/src/main/indexer.ts';
import { createQueryApi } from '../packages/core/src/query.ts';
import { installCoreSchema } from '../packages/core/src/schema-migrations.ts';
import { listSnapshots, snapshotDirFor } from '../packages/core/src/snapshots.ts';
import { makeTempDir } from './temp-dirs.mjs';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite');
const SCHEMA_SQL = readFileSync(new URL('../packages/core/src/schema.sql', import.meta.url), 'utf8');

class TestDatabase {
  constructor(dbPath, options = {}) {
    this.db = new DatabaseSync(dbPath, options.readonly ? { readOnly: true } : {});
  }
  pragma(statement) { this.db.exec(`PRAGMA ${statement}`); }
  exec(sql) { return this.db.exec(sql); }
  prepare(sql) { return this.db.prepare(sql); }
  close() { return this.db.close(); }
}

function claudeLine(uuid, role, text, ts = '2026-11-01T00:00:00.000Z') {
  return `${JSON.stringify({
    uuid,
    type: role,
    timestamp: ts,
    cwd: '/work/proj',
    message: { role, content: text },
  })}\n`;
}

function makeEnv(prefix) {
  const home = makeTempDir(prefix);
  const claudeDir = join(home, '.claude');
  const codexDir = join(home, '.codex');
  const dbPath = join(home, '.trajex', 'trajex.sqlite');
  mkdirSync(join(claudeDir, 'projects'), { recursive: true });
  mkdirSync(join(codexDir, 'sessions'), { recursive: true });
  return {
    home,
    claudeDir,
    codexDir,
    dbPath,
    snapshotDir: snapshotDirFor(dbPath),
    providerRoots: { pi: join(home, 'pi'), deepseek: join(home, 'dsh') },
  };
}

test('Claude main transcript deletion keeps the session and subagent growth stays attached without orphans', () => {
  const env = makeEnv('trajex-claude-subagent-keep-');
  const projectDir = join(env.claudeDir, 'projects', '-work-proj');
  const sid = '11111111-1111-4111-8111-111111111111';
  const mainPath = join(projectDir, `${sid}.jsonl`);
  const subDir = join(projectDir, sid, 'subagents');
  const subPath = join(subDir, 'agent-worker.jsonl');
  mkdirSync(subDir, { recursive: true });
  writeFileSync(mainPath, claudeLine('m1', 'user', 'main question') + claudeLine('m2', 'assistant', 'main answer', '2026-11-01T00:00:01.000Z'));
  writeFileSync(subPath, claudeLine('s1', 'user', 'subagent task', '2026-11-01T00:00:02.000Z'));
  writeFileSync(join(subDir, 'agent-worker.meta.json'), JSON.stringify({ agentType: 'Explore', description: 'worker' }));

  const run = (extra = {}) => buildIndex({ ...env, DatabaseImpl: TestDatabase, ...extra });
  run();

  // Delete the main transcript while the subagent file remains and keeps growing.
  rmSync(mainPath);
  run();
  appendFileSync(subPath, claudeLine('s2', 'assistant', 'subagent follow-up', '2026-11-01T00:00:03.000Z'));
  const future = new Date(Date.now() + 5000);
  utimesSync(subPath, future, future);
  run();

  const db = new DatabaseSync(env.dbPath);
  try {
    const session = db.prepare('SELECT id, source_status, message_count FROM sessions WHERE id = ?').get(sid);
    assert.equal(session.source_status, 'partial', 'session is partial when main source is missing and subagent is present');
    assert.equal(session.message_count, 2, 'main message_count is preserved');
    const messages = db.prepare('SELECT uuid, agent_id FROM messages WHERE session_id = ? ORDER BY uuid').all(sid);
    assert.deepEqual(messages.map(row => [row.uuid, row.agent_id]), [
      ['m1', null],
      ['m2', null],
      ['s1', 'agent-worker'],
      ['s2', 'agent-worker'],
    ]);
    const sources = db.prepare('SELECT member, status FROM sources WHERE session_id = ? ORDER BY member').all(sid);
    assert.deepEqual(sources.map(row => [row.member, row.status]), [
      ['', 'missing'],
      ['agent-worker', 'present'],
    ]);
  } finally {
    db.close();
  }
});

test('a subagent indexed before its main transcript creates a placeholder session that promotes to present', () => {
  const env = makeEnv('trajex-claude-placeholder-');
  const projectDir = join(env.claudeDir, 'projects', '-work-proj');
  const sid = '22222222-2222-4222-8222-222222222222';
  const mainPath = join(projectDir, `${sid}.jsonl`);
  const subDir = join(projectDir, sid, 'subagents');
  const subPath = join(subDir, 'agent-solo.jsonl');
  mkdirSync(subDir, { recursive: true });
  writeFileSync(subPath, claudeLine('s1', 'user', 'subagent arrived first', '2026-11-01T00:00:02.000Z'));

  const run = (extra = {}) => buildIndex({ ...env, DatabaseImpl: TestDatabase, ...extra });
  run();

  let db = new DatabaseSync(env.dbPath);
  try {
    const placeholder = db.prepare('SELECT id, source_status, jsonl_path FROM sessions WHERE id = ?').get(sid);
    assert.equal(placeholder.source_status, 'partial');
    assert.equal(placeholder.jsonl_path, null);
  } finally {
    db.close();
  }

  writeFileSync(mainPath, claudeLine('m1', 'user', 'main arrived later', '2026-11-01T00:00:01.000Z'));
  run();

  db = new DatabaseSync(env.dbPath);
  try {
    const promoted = db.prepare('SELECT id, source_status, jsonl_path, message_count FROM sessions WHERE id = ?').get(sid);
    assert.equal(promoted.source_status, 'present');
    assert.equal(promoted.jsonl_path, mainPath);
    assert.equal(promoted.message_count, 1);
  } finally {
    db.close();
  }
});

test('purgeMissing respects age filters, preserves memories, and takes a pre-purge snapshot', () => {
  const env = makeEnv('trajex-purge-age-');
  const projectDir = join(env.claudeDir, 'projects', '-work-proj');
  mkdirSync(projectDir, { recursive: true });
  const oldPath = join(projectDir, 'old-sess.jsonl');
  const recentPath = join(projectDir, 'recent-sess.jsonl');
  writeFileSync(oldPath, claudeLine('o1', 'user', 'old missing content'));
  writeFileSync(recentPath, claudeLine('r1', 'user', 'recent missing content'));

  const run = (extra = {}) => buildIndex({ ...env, DatabaseImpl: TestDatabase, autoSnapshot: false, ...extra });
  run();

  const seed = new DatabaseSync(env.dbPath);
  seed.prepare("INSERT INTO memories (id, session_id, path, summary, created_at) VALUES ('mem-1', 'old-sess', '/tmp/m.md', 'keep me', '2026-11-01T00:00:00Z')").run();
  seed.close();

  rmSync(oldPath);
  rmSync(recentPath);
  run();

  const fortyDaysAgo = Date.now() - 40 * 24 * 60 * 60 * 1000;
  const adjust = new DatabaseSync(env.dbPath);
  adjust.prepare("UPDATE sources SET missing_since = ? WHERE session_id = 'old-sess'").run(fortyDaysAgo);
  adjust.close();

  const thirtyDaysCutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const summaryBefore = getRetentionSummary({
    dbPath: env.dbPath,
    snapshotDir: env.snapshotDir,
    DatabaseImpl: TestDatabase,
    missingBefore: thirtyDaysCutoff,
  });
  assert.equal(summaryBefore.missingSources, 1);
  assert.equal(summaryBefore.missingSessions, 2);

  const purged = purgeMissing({
    dbPath: env.dbPath,
    snapshotDir: env.snapshotDir,
    DatabaseImpl: TestDatabase,
    missingBefore: thirtyDaysCutoff,
  });
  assert.equal(purged.ok, true);
  assert.equal(purged.sources, 1);
  assert.equal(purged.sessions, 1);
  assert.equal(purged.snapshot?.reason, 'pre-purge');

  const db = new DatabaseSync(env.dbPath);
  try {
    assert.deepEqual(
      db.prepare('SELECT id FROM sessions ORDER BY id').all().map(r => r.id),
      ['recent-sess'],
    );
    assert.equal(db.prepare("SELECT COUNT(*) AS c FROM memories WHERE id = 'mem-1'").get().c, 1);
  } finally {
    db.close();
  }
});

test('snapshots prune to snapshotKeep, restore preserves newer memories, and incremental sync keeps restored history', () => {
  const env = makeEnv('trajex-snapshot-restore-');
  const projectDir = join(env.claudeDir, 'projects', '-work-proj');
  mkdirSync(projectDir, { recursive: true });
  const deletedLater = join(projectDir, 'deleted-later.jsonl');
  const staysPresent = join(projectDir, 'stays-present.jsonl');
  writeFileSync(deletedLater, claudeLine('d1', 'user', 'restorable needle'));
  writeFileSync(staysPresent, claudeLine('p1', 'user', 'initial present'));

  const run = (extra = {}) => buildIndex({
    ...env,
    DatabaseImpl: TestDatabase,
    snapshotDir: env.snapshotDir,
    snapshotKeep: 2,
    autoSnapshot: false,
    ...extra,
  });
  run();

  const snap1 = takeSnapshot({ dbPath: env.dbPath, snapshotDir: env.snapshotDir, snapshotKeep: 2, DatabaseImpl: TestDatabase });
  assert.equal(snap1.ok, true);

  // Delete a session file and purge it, then add a new durable memory and a new message on the surviving file.
  rmSync(deletedLater);
  run();
  purgeMissing({ dbPath: env.dbPath, snapshotDir: env.snapshotDir, snapshotKeep: 2, DatabaseImpl: TestDatabase });

  const dbAfterPurge = new DatabaseSync(env.dbPath);
  assert.equal(dbAfterPurge.prepare("SELECT COUNT(*) AS c FROM sessions WHERE id = 'deleted-later'").get().c, 0);
  dbAfterPurge.prepare("INSERT INTO memories (id, session_id, path, summary, created_at) VALUES ('mem-after-snap', 'stays-present', '/tmp/m2.md', 'approved after snapshot', '2026-11-02T00:00:00Z')").run();
  dbAfterPurge.close();

  // Taking two more manual snapshots prunes the list to snapshotKeep = 2, so let's keep 3 before restoring snap1.
  takeSnapshot({ dbPath: env.dbPath, snapshotDir: env.snapshotDir, snapshotKeep: 3, DatabaseImpl: TestDatabase });
  assert.ok(listSnapshots(env.snapshotDir).length <= 3);

  appendFileSync(staysPresent, claudeLine('p2', 'assistant', 'added after snapshot', '2026-11-01T00:01:00.000Z'));
  const future = new Date(Date.now() + 5000);
  utimesSync(staysPresent, future, future);

  const restored = restoreSnapshot({
    dbPath: env.dbPath,
    snapshotDir: env.snapshotDir,
    snapshotKeep: 3,
    DatabaseImpl: TestDatabase,
    snapshotPath: snap1.snapshot.path,
  });
  assert.equal(restored.ok, true);
  assert.equal(restored.safety?.reason, 'pre-restore');

  // Next incremental build catches up with stays-present AND marks deleted-later missing without deleting it!
  run();

  const verify = new DatabaseSync(env.dbPath);
  try {
    const api = createQueryApi(verify);
    assert.equal(api.search('restorable needle').length, 1, 'restored session remains searchable even though its file is gone');
    assert.equal(api.search('"added after snapshot"').length, 1, 'incremental sync caught up with the surviving file');
    assert.equal(
      verify.prepare("SELECT source_status FROM sessions WHERE id = 'deleted-later'").get().source_status,
      'missing',
    );
    assert.equal(
      verify.prepare("SELECT summary FROM memories WHERE id = 'mem-after-snap'").get()?.summary,
      'approved after snapshot',
      'memories created after the snapshot are preserved across restore',
    );
  } finally {
    verify.close();
  }
});

test('restore rejects a snapshot from a newer schema version without modifying the current index', () => {
  const env = makeEnv('trajex-snapshot-future-');
  const projectDir = join(env.claudeDir, 'projects', '-work-proj');
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(join(projectDir, 's1.jsonl'), claudeLine('u1', 'user', 'current data'));
  buildIndex({ ...env, DatabaseImpl: TestDatabase, snapshotDir: env.snapshotDir, autoSnapshot: false });

  const snap = takeSnapshot({ dbPath: env.dbPath, snapshotDir: env.snapshotDir, DatabaseImpl: TestDatabase });
  const futureDb = new DatabaseSync(snap.snapshot.path);
  futureDb.exec('PRAGMA user_version = 99');
  futureDb.close();

  assert.throws(
    () => restoreSnapshot({
      dbPath: env.dbPath,
      snapshotDir: env.snapshotDir,
      DatabaseImpl: TestDatabase,
      snapshotPath: snap.snapshot.path,
    }),
    /newer Trajex/i,
  );
  const verify = new DatabaseSync(env.dbPath);
  assert.equal(verify.prepare('SELECT text FROM messages WHERE uuid = ?').get('u1').text, 'current data');
  verify.close();
});

test('upgrading a 0.3.x database takes a pre-upgrade snapshot and backfills the source ledger including orphan messages', () => {
  const home = makeTempDir('trajex-upgrade-030-');
  const dbPath = join(home, '.trajex', 'trajex.sqlite');
  const snapshotDir = snapshotDirFor(dbPath);
  mkdirSync(join(home, '.trajex'), { recursive: true });

  const legacy = new DatabaseSync(dbPath);
  legacy.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY, title TEXT, project TEXT, project_path TEXT,
      started_at TEXT, ended_at TEXT, git_branch TEXT, version TEXT,
      message_count INTEGER DEFAULT 0, jsonl_path TEXT, source TEXT DEFAULT 'claude'
    );
    CREATE TABLE messages (
      uuid TEXT PRIMARY KEY, session_id TEXT, type TEXT, parent_uuid TEXT,
      timestamp TEXT, role TEXT, text TEXT, content_type TEXT,
      is_meta INTEGER DEFAULT 0, visibility TEXT DEFAULT 'visible',
      is_sidechain INTEGER DEFAULT 0, model TEXT, agent_id TEXT,
      input_tokens INTEGER, output_tokens INTEGER, cwd TEXT, skill TEXT,
      turn_duration_ms INTEGER, source TEXT DEFAULT 'claude'
    );
    CREATE TABLE memories (
      id TEXT PRIMARY KEY, session_id TEXT, project TEXT, message_start TEXT,
      message_end TEXT, path TEXT NOT NULL, anchors TEXT, summary TEXT NOT NULL,
      created_at TEXT NOT NULL, deleted_at TEXT, deleted_reason TEXT
    );
  `);
  legacy.prepare("INSERT INTO sessions (id, title, jsonl_path, source, message_count) VALUES ('s-existing', 'Old Session', '/gone/s-existing.jsonl', 'claude', 1)").run();
  legacy.prepare("INSERT INTO messages (uuid, session_id, text, source) VALUES ('m-existing', 's-existing', 'from 0.3', 'claude')").run();
  legacy.prepare("INSERT INTO messages (uuid, session_id, agent_id, text, source) VALUES ('m-orphan', 's-orphan', 'agent-x', 'orphan subagent', 'claude')").run();
  legacy.close();

  const upgraded = new DatabaseSync(dbPath);
  installCoreSchema(upgraded, SCHEMA_SQL, { snapshotDir, snapshotKeep: 3 });
  try {
    const snaps = listSnapshots(snapshotDir);
    assert.equal(snaps.length, 1);
    assert.equal(snaps[0].reason, 'pre-upgrade');
    assert.equal(upgraded.prepare('SELECT COUNT(*) AS c FROM messages WHERE source_id IS NULL').get().c, 0);
    const orphanSession = upgraded.prepare("SELECT id, source_status FROM sessions WHERE id = 's-orphan'").get();
    assert.equal(orphanSession.source_status, 'missing');
  } finally {
    upgraded.close();
  }
});

test('workflow source replacement preserves workflow_agents metadata merged from subagent meta.json', () => {
  const env = makeEnv('trajex-workflow-merge-');
  const projectDir = join(env.claudeDir, 'projects', '-work-proj');
  const sid = '33333333-3333-4333-8333-333333333333';
  const mainPath = join(projectDir, `${sid}.jsonl`);
  const subDir = join(projectDir, sid, 'subagents');
  const wfDir = join(projectDir, sid, 'workflows');
  const wfSubDir = join(subDir, 'workflows', 'run-1');
  mkdirSync(wfSubDir, { recursive: true });
  mkdirSync(wfDir, { recursive: true });
  writeFileSync(mainPath, claudeLine('m1', 'user', 'start workflow'));
  writeFileSync(join(wfSubDir, 'agent-wf1.jsonl'), claudeLine('s1', 'user', 'sub work'));
  writeFileSync(join(wfSubDir, 'agent-wf1.meta.json'), JSON.stringify({ agentType: 'Explore', description: 'meta desc' }));
  writeFileSync(join(wfDir, 'run-1.json'), JSON.stringify({
    runId: 'run-1',
    workflowName: 'Review',
    status: 'complete',
    workflowProgress: [{ type: 'workflow_agent', agentId: 'wf1', phaseTitle: 'review', label: 'Reviewer', state: 'complete', tokens: 42 }],
  }));

  const run = (extra = {}) => buildIndex({ ...env, DatabaseImpl: TestDatabase, autoSnapshot: false, ...extra });
  run();

  // Append to main transcript so workflow unit re-parses (relationshipChanged = true) while subagent unit is unchanged.
  appendFileSync(mainPath, claudeLine('m2', 'assistant', 'done', '2026-11-01T00:00:05.000Z'));
  const future = new Date(Date.now() + 5000);
  utimesSync(mainPath, future, future);
  run({ changedPaths: [mainPath] });

  const db = new DatabaseSync(env.dbPath);
  try {
    const wa = db.prepare("SELECT agent_type, description, phase, label FROM workflow_agents WHERE agent_id = 'agent-wf1'").get();
    assert.equal(wa.agent_type, 'Explore', 'subagent meta.json agent_type survives workflow replace');
    assert.equal(wa.description, 'meta desc', 'subagent meta.json description survives workflow replace');
    assert.equal(wa.phase, 'review');
  } finally {
    db.close();
  }
});

test('restoring the oldest snapshot succeeds even when snapshotKeep was lowered below the current snapshot count', () => {
  const env = makeEnv('trajex-restore-oldest-');
  const projectDir = join(env.claudeDir, 'projects', '-work-proj');
  mkdirSync(projectDir, { recursive: true });
  const mainPath = join(projectDir, 's1.jsonl');
  writeFileSync(mainPath, claudeLine('u1', 'user', 'v1'));

  const run = (extra = {}) => buildIndex({ ...env, DatabaseImpl: TestDatabase, snapshotDir: env.snapshotDir, autoSnapshot: false, ...extra });
  run();
  const oldest = takeSnapshot({ dbPath: env.dbPath, snapshotDir: env.snapshotDir, snapshotKeep: 5, DatabaseImpl: TestDatabase });
  takeSnapshot({ dbPath: env.dbPath, snapshotDir: env.snapshotDir, snapshotKeep: 5, DatabaseImpl: TestDatabase });
  takeSnapshot({ dbPath: env.dbPath, snapshotDir: env.snapshotDir, snapshotKeep: 5, DatabaseImpl: TestDatabase });
  assert.equal(listSnapshots(env.snapshotDir).length, 3);

  // Restore the oldest snapshot with snapshotKeep = 1; pre-restore must not prune the target before copying it.
  const restored = restoreSnapshot({
    dbPath: env.dbPath,
    snapshotDir: env.snapshotDir,
    snapshotKeep: 1,
    DatabaseImpl: TestDatabase,
    snapshotPath: oldest.snapshot.path,
  });
  assert.equal(restored.ok, true);
  assert.equal(listSnapshots(env.snapshotDir).length, 1, 'pruned to snapshotKeep after restore');
});

test('multi-device folder sync exchanges per-device shards and memory files without lock conflicts or local purge interference', () => {
  const syncDir = makeTempDir('trajex-sync-folder-');
  const envA = makeEnv('trajex-device-a-');
  const envB = makeEnv('trajex-device-b-');

  const projA = join(envA.claudeDir, 'projects', '-work-a');
  const projB = join(envB.claudeDir, 'projects', '-work-b');
  mkdirSync(projA, { recursive: true });
  mkdirSync(projB, { recursive: true });

  writeFileSync(join(projA, 'sess-a.jsonl'), claudeLine('ma-1', 'user', 'studio exclusive needle'));
  writeFileSync(join(projB, 'sess-b.jsonl'), claudeLine('mb-1', 'user', 'macbook exclusive needle'));

  buildIndex({ ...envA, DatabaseImpl: TestDatabase, autoSnapshot: false });
  buildIndex({ ...envB, DatabaseImpl: TestDatabase, autoSnapshot: false });

  // Device B creates a durable memory with a local Markdown file that does not exist on Device A's original path.
  const memMdB = join(envB.home, 'memory-b.md');
  writeFileSync(memMdB, '# Memory from MacBook\nFull body text.\n');
  const dbB = new DatabaseSync(envB.dbPath);
  dbB.prepare("INSERT INTO memories (id, session_id, project, path, summary, created_at) VALUES ('mem-b1', 'sess-b', '-work-b', ?, 'macbook memory summary', '2026-11-01T00:00:00Z')")
    .run(memMdB);
  dbB.close();

  // Both devices sync with the shared folder; also place a corrupt peer file to simulate an incomplete cloud download.
  mkdirSync(join(syncDir, 'devices'), { recursive: true });
  writeFileSync(join(syncDir, 'devices', 'dev-corrupt.sqlite'), 'partial icloud download');

  const syncB1 = syncFolder({
    dbPath: envB.dbPath,
    DatabaseImpl: TestDatabase,
    syncDir,
    deviceId: 'dev-macbook',
    deviceName: 'MacBook-Air',
  });
  assert.equal(syncB1.ok, true);
  assert.equal(syncB1.exportedSessions, 1);
  assert.equal(syncB1.exportedMemories, 1);
  assert.equal(syncB1.skippedPeers.length, 1, 'corrupt/incomplete peer shard is skipped without failing');

  const syncA1 = syncFolder({
    dbPath: envA.dbPath,
    DatabaseImpl: TestDatabase,
    syncDir,
    deviceId: 'dev-studio',
    deviceName: 'Mac-Studio',
  });
  assert.equal(syncA1.ok, true);
  assert.equal(syncA1.importedPeers, 1);
  assert.equal(syncA1.importedSessions, 1);

  // Re-syncing without changes skips unchanged peer shards.
  const syncA2 = syncFolder({
    dbPath: envA.dbPath,
    DatabaseImpl: TestDatabase,
    syncDir,
    deviceId: 'dev-studio',
    deviceName: 'Mac-Studio',
  });
  assert.equal(syncA2.importedPeers, 0);

  // Local build and local purge on Device A never mark or delete Device B's imported sessions,
  // even though Device B's source paths do not exist on Device A!
  buildIndex({ ...envA, DatabaseImpl: TestDatabase, autoSnapshot: false });
  purgeMissing({ dbPath: envA.dbPath, DatabaseImpl: TestDatabase });

  const checkA = new DatabaseSync(envA.dbPath);
  try {
    const api = createQueryApi(checkA);
    assert.equal(api.search('"macbook exclusive needle"').length, 1, 'peer messages are searchable via FTS on Device A');
    const peerSession = checkA.prepare("SELECT device_id, device_name, source_status FROM sessions WHERE id = 'sess-b'").get();
    assert.equal(peerSession.device_id, 'dev-macbook');
    assert.equal(peerSession.device_name, 'MacBook-Air');
    assert.equal(peerSession.source_status, 'present');

    const memRow = checkA.prepare("SELECT summary, path FROM memories WHERE id = 'mem-b1'").get();
    assert.equal(memRow.summary, 'macbook memory summary');
    assert.ok(memRow.path.includes('synced-memories') && existsSync(memRow.path), 'peer memory file is materialized in synced-memories');
    assert.match(readFileSync(memRow.path, 'utf8'), /Full body text/);
  } finally {
    checkA.close();
  }

  // Removing the peer device cleans up only that peer's sessions and messages.
  removeSyncPeer({ dbPath: envA.dbPath, DatabaseImpl: TestDatabase, peerDeviceId: 'dev-macbook' });
  const afterRemove = new DatabaseSync(envA.dbPath);
  try {
    assert.deepEqual(
      afterRemove.prepare('SELECT id FROM sessions ORDER BY id').all().map(r => r.id),
      ['sess-a'],
    );
  } finally {
    afterRemove.close();
  }
});
