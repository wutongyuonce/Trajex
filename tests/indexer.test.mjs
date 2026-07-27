import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

import { inferProjectPath, refreshSessionProjectPaths, shouldSkipBuild } from '../packages/core/src/indexer.ts';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite');

test('inferProjectPath preserves hyphens from observed cwd', () => {
  assert.equal(
    inferProjectPath('-Users-dev-Code-quiet-zero', ['/Users/dev/Code/quiet-zero']),
    '/Users/dev/Code/quiet-zero',
  );
  assert.equal(
    inferProjectPath('-Users-dev-Code-research-widget-svc', ['/Users/dev/Code/research/widget-svc']),
    '/Users/dev/Code/research/widget-svc',
  );
});

test('inferProjectPath falls back to legacy slug decoding without cwd evidence', () => {
  assert.equal(
    inferProjectPath('-Users-dev-Code-quiet-zero', []),
    '/Users/dev/Code/quiet/zero',
  );
});

test('refreshSessionProjectPaths repairs indexed sessions from message cwd', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY, project TEXT, project_path TEXT
    );
    CREATE TABLE messages (
      uuid TEXT PRIMARY KEY, session_id TEXT, timestamp TEXT, cwd TEXT
    );
  `);
  db.prepare('INSERT INTO sessions (id, project, project_path) VALUES (?, ?, ?)').run(
    'sid-1',
    '-Users-dev-Code-quiet-zero',
    '/Users/dev/Code/quiet/zero',
  );
  db.prepare('INSERT INTO messages (uuid, session_id, timestamp, cwd) VALUES (?, ?, ?, ?)').run(
    'msg-1',
    'sid-1',
    '2026-06-10T10:00:00Z',
    '/Users/dev/Code/quiet-zero',
  );

  refreshSessionProjectPaths(db);

  assert.equal(
    db.prepare('SELECT project_path FROM sessions WHERE id=?').get('sid-1').project_path,
    '/Users/dev/Code/quiet-zero',
  );
  db.close();
});

test('shouldSkipBuild treats a fresh heartbeat alone as daemon write ownership', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE index_state (
      jsonl_path TEXT PRIMARY KEY, mtime REAL, lines_processed INTEGER
    );
  `);
  db.prepare('INSERT INTO index_state (jsonl_path, mtime, lines_processed) VALUES (?, ?, 0)').run(
    '__app_heartbeat__',
    100000,
  );

  assert.deepEqual(
    shouldSkipBuild(db, { now: 110000 }),
    { skip: true, reason: 'daemon_active' },
  );

  db.prepare('DELETE FROM index_state').run();

  db.prepare('INSERT INTO index_state (jsonl_path, mtime, lines_processed) VALUES (?, ?, 0)').run(
    '__app_last_successful_build__',
    100000,
  );

  assert.equal(shouldSkipBuild(db, { now: 110000 }).skip, false);
  assert.equal(shouldSkipBuild(db, { now: 200000 }).skip, false);
  db.close();
});
