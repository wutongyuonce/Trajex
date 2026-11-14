// Copyright (C) 2026 tommy0103 and contributors.
// Copyright (C) 2026 wutongyuonce and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

import { makeTempDir } from './temp-dirs.mjs';
// Regression test for the message write semantics (formerly the indexJsonl
// INSERT-OR-REPLACE vs ON-CONFLICT drift; now enforced through the shared
// persist layer). Re-indexing a claude session must upsert messages (stable
// rowid, no FTS churn) and, because claude parses fresh from an empty cursor
// (countMode 'total'), must replace message_count rather than accumulate.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { parse } from '../packages/core/src/providers/claude.ts';
import { persist } from '../packages/core/src/persist.ts';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite');
const SCHEMA = readFileSync(new URL('../packages/core/src/schema.sql', import.meta.url), 'utf8');

function fixtureUnit() {
  const dir = makeTempDir('trajex-drift-');
  const jsonlPath = join(dir, 'sess.jsonl');
  const lines = [
    { uuid: 'u-1', type: 'user', timestamp: '2026-06-10T10:00:00Z', cwd: '/tmp/proj', message: { role: 'user', content: 'first question' } },
    { uuid: 'a-1', type: 'assistant', timestamp: '2026-06-10T10:00:05Z', message: { role: 'assistant', model: 'claude-opus', content: 'first answer' } },
    { uuid: 'u-2', type: 'user', timestamp: '2026-06-10T10:00:10Z', cwd: '/tmp/proj', message: { role: 'user', content: 'second question' } },
  ];
  writeFileSync(jsonlPath, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
  return { key: jsonlPath, sessionId: 'sid-drift', project: 'quiet-zero' };
}

test('re-indexing upserts messages (stable rowid) and replaces message_count', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  const unit = fixtureUnit();

  persist(db, unit, parse(unit, null));
  const countAfterFirst = db.prepare('SELECT message_count FROM sessions WHERE id=?').get('sid-drift').message_count;
  const rowidAfterFirst = db.prepare('SELECT rowid FROM messages WHERE uuid=?').get('u-1').rowid;
  assert.equal(countAfterFirst, 3);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM messages').get().c, 3);

  // Re-index the same session from scratch (fresh parse → countMode 'total').
  persist(db, unit, parse(unit, null));

  const countAfterSecond = db.prepare('SELECT message_count FROM sessions WHERE id=?').get('sid-drift').message_count;
  const rowidAfterSecond = db.prepare('SELECT rowid FROM messages WHERE uuid=?').get('u-1').rowid;
  assert.equal(countAfterSecond, 3, 'message_count is replaced, not accumulated (would be 6 under the old bug)');
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM messages').get().c, 3, 'no duplicate rows');
  assert.equal(rowidAfterSecond, rowidAfterFirst, 'upsert preserves rowid (INSERT OR REPLACE would churn it)');

  db.close();
});

test('source replace removes un-emitted transcript projection for that source but preserves memories', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  const unit = { key: 'delete-session.jsonl', sessionId: 'sid-delete' };
  persist(db, unit, (function* () {
    yield { kind: 'source', provider: 'codex', session_id: 'sid-delete', member: '', path: unit.key, replace: true };
    yield {
      kind: 'message', uuid: 'msg-delete', session_id: 'sid-delete', type: 'user', parent_uuid: null,
      timestamp: '2026-06-10T10:00:00Z', role: 'user', text: 'old', content_type: 'text', is_meta: 0,
      visibility: 'visible', model: null, agent_id: null, input_tokens: null, output_tokens: null,
      cwd: null, skill: null, source: 'codex',
    };
    yield {
      kind: 'session', id: 'sid-delete', title: null, project: null, started_at: null, ended_at: null,
      git_branch: null, version: null, message_count: 1, countMode: 'total', jsonl_path: unit.key, source: 'codex',
    };
    return '1:1';
  })());
  db.prepare("INSERT INTO memories (id, session_id, summary, created_at) VALUES ('mem-delete', 'sid-delete', 'keep', '2026-06-10T10:00:00Z')").run();

  persist(db, unit, (function* () {
    yield { kind: 'source', provider: 'codex', session_id: 'sid-delete', member: '', path: unit.key, replace: true };
    return '2:1';
  })());

  assert.equal(db.prepare("SELECT COUNT(*) c FROM sessions WHERE id='sid-delete'").get().c, 0);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM messages WHERE session_id='sid-delete'").get().c, 0);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM memories WHERE id='mem-delete'").get().c, 1);
  db.close();
});
