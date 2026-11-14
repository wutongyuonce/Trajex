// Copyright (C) 2026 tommy0103 and contributors.
// Copyright (C) 2026 wutongyuonce and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

import { createProviderRegistry } from '../packages/core/src/providers/registry.ts';
import {
  createProviderIndexPlan,
  writeProviderIndexMarkers,
} from '../packages/core/src/provider-indexing.ts';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite');

function fakeProvider(id, { marker, units = [] } = {}) {
  return {
    name: id,
    descriptor: { id, name: id, vendor: id, defaultRoot: `/${id}`, color: '#000000' },
    indexVersionMarker: marker,
    watchTargets() { return []; },
    discover() { return units; },
    *parse() { yield* []; return '1:1:1:1:1'; },
    raw() { return null; },
  };
}

function memoryPlanDb({ sessions = [], markers = [], cursors = [] } = {}) {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE index_state (
      jsonl_path TEXT PRIMARY KEY,
      mtime REAL,
      lines_processed INTEGER,
      cursor TEXT
    );
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      jsonl_path TEXT,
      source TEXT,
      source_status TEXT DEFAULT 'present'
    );
    CREATE TABLE sources (
      id INTEGER PRIMARY KEY,
      provider TEXT NOT NULL,
      session_id TEXT NOT NULL,
      member TEXT NOT NULL,
      path TEXT,
      status TEXT NOT NULL DEFAULT 'present',
      first_seen_at INTEGER,
      last_seen_at INTEGER,
      missing_since INTEGER,
      device_id TEXT,
      device_name TEXT,
      UNIQUE (session_id, member)
    );
  `);
  const insertMarker = db.prepare(
    'INSERT INTO index_state (jsonl_path, mtime, lines_processed) VALUES (?, 1, 0)',
  );
  for (const marker of markers) insertMarker.run(marker);
  const insertCursor = db.prepare(
    'INSERT INTO index_state (jsonl_path, mtime, lines_processed, cursor) VALUES (?, ?, ?, ?)',
  );
  for (const row of cursors) insertCursor.run(row.path, row.mtime, row.lines, row.cursor);
  const insertSession = db.prepare(
    'INSERT INTO sessions (id, jsonl_path, source) VALUES (?, ?, ?)',
  );
  const insertSource = db.prepare(
    "INSERT INTO sources (provider, session_id, member, path, status) VALUES (?, ?, '', ?, 'present')",
  );
  for (const session of sessions) {
    insertSession.run(session.id, session.path, session.source);
    insertSource.run(session.source, session.id, session.path);
  }
  return db;
}

test('a missing version marker full-replays only that provider', () => {
  const db = memoryPlanDb({
    sessions: [
      { id: 'c1', path: '/claude/a.jsonl', source: 'claude' },
      { id: 'x1', path: '/codex/a.jsonl', source: 'codex' },
    ],
    markers: ['__codex_v1__'],
    cursors: [
      { path: '/claude/a.jsonl', mtime: 10, lines: 4, cursor: '10:4:1:1:1' },
      { path: '/codex/a.jsonl', mtime: 20, lines: 8, cursor: '20:8:1:1:1' },
    ],
  });
  const registry = createProviderRegistry([
    fakeProvider('claude', { marker: '__claude_v1__', units: [{ key: '/claude/a.jsonl', sessionId: 'c1' }] }),
    fakeProvider('codex', { marker: '__codex_v1__', units: [{ key: '/codex/a.jsonl', sessionId: 'x1' }] }),
  ]);

  const plan = createProviderIndexPlan(db, registry);
  assert.equal(plan.fullRebuild, false);
  assert.equal(plan.items.find(item => item.provider.name === 'claude')?.cursor, null);
  assert.equal(plan.items.find(item => item.provider.name === 'codex')?.cursor, '20:8:1:1:1');
  db.close();
});

test('force rebuild still full-replays every provider', () => {
  const db = memoryPlanDb({
    sessions: [{ id: 'c1', path: '/claude/a.jsonl', source: 'claude' }],
    markers: ['__claude_v1__'],
    cursors: [{ path: '/claude/a.jsonl', mtime: 10, lines: 4, cursor: '10:4:1:1:1' }],
  });
  const registry = createProviderRegistry([
    fakeProvider('claude', { marker: '__claude_v1__', units: [{ key: '/claude/a.jsonl', sessionId: 'c1' }] }),
  ]);
  const plan = createProviderIndexPlan(db, registry, { force: true });
  assert.equal(plan.fullRebuild, true);
  assert.equal(plan.items[0].cursor, null);
  db.close();
});

test('skipped units do not block version markers; stop and inventory issues do', () => {
  const db = memoryPlanDb();
  const plan = {
    items: [],
    pendingMarkers: new Map([
      ['claude', '__claude_v1__'],
      ['codex', '__codex_v1__'],
      ['pi', '__pi_v1__'],
    ]),
    replayKeys: new Map(),
    fullRebuild: false,
    inventoryIssues: [{ provider: 'pi', path: '/pi', error: 'missing' }],
  };

  writeProviderIndexMarkers(db, plan, {
    committed: [],
    failedItems: [],
  });
  const present = new Set(
    db.prepare('SELECT jsonl_path FROM index_state').all().map(row => row.jsonl_path),
  );
  assert.equal(present.has('__claude_v1__'), true);
  assert.equal(present.has('__codex_v1__'), true);
  assert.equal(present.has('__pi_v1__'), false);

  db.exec('DELETE FROM index_state');
  writeProviderIndexMarkers(db, plan, {
    committed: [],
    failedItems: [],
    stopped: { item: { provider: { name: 'claude' }, unit: { key: '/x' }, cursor: null }, error: new Error('busy') },
  });
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM index_state').get().c, 0);
  db.close();
});

test('missing units run after active units so a moved source is re-declared before its old path is checked', () => {
  const missing = { key: '/codex/sessions/r.jsonl', sessionId: 'codex:x', missing: true };
  const moved = { key: '/codex/archived_sessions/r.jsonl', sessionId: 'codex:x' };
  const gone = { key: '/codex/sessions/gone.jsonl', sessionId: 'codex:y', missing: true };
  const db = memoryPlanDb();
  const plan = createProviderIndexPlan(db, createProviderRegistry([
    fakeProvider('codex', { units: [missing, moved, gone] }),
  ]));
  assert.deepEqual(plan.items.map(item => [item.unit.key, Boolean(item.unit.missing)]), [
    [moved.key, false],
    [missing.key, true],
    [gone.key, true],
  ]);
  db.close();
});

test('a provider whose discovery throws keeps its snapshot without stopping other providers', () => {
  const db = memoryPlanDb({ sessions: [{ id: 'broken-1', path: '/broken/a.jsonl', source: 'broken' }] });
  const broken = { ...fakeProvider('broken'), discover() { throw new Error('EACCES: permission denied'); } };
  const healthy = fakeProvider('healthy', { units: [{ key: '/healthy/a.jsonl', sessionId: 'h1' }] });
  const plan = createProviderIndexPlan(db, createProviderRegistry([broken, healthy]));
  assert.deepEqual(plan.items.map(item => item.unit.key), ['/healthy/a.jsonl']);
  assert.deepEqual(plan.inventoryIssues, [{ provider: 'broken', path: '/broken', error: 'EACCES: permission denied' }]);
  db.close();
});
