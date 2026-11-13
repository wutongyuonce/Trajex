// Copyright (C) 2026 tommy0103 and contributors.
// Copyright (C) 2026 wutongyuonce and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { appendFileSync, cpSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildIndex } from '../app/src/main/indexer.ts';
import { createQueryApi } from '../packages/core/src/query.ts';
import { deepseekSessionId } from '../packages/core/src/providers/deepseek.ts';
import { zstdDecoder } from '../packages/core/src/vendor/dsh-zstd.ts';
import { makeTempDir } from './temp-dirs.mjs';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
const FIXTURES = fileURLToPath(new URL('./fixtures/deepseek/sessions/', import.meta.url));

class TestDatabase {
  constructor(path) { this.db = new DatabaseSync(path); }
  pragma(statement) { this.db.exec(`PRAGMA ${statement}`); }
  exec(sql) { return this.db.exec(sql); }
  prepare(sql) { return this.db.prepare(sql); }
  close() { return this.db.close(); }
}

function home() {
  const dir = makeTempDir('trajex-dsh-app-');
  const claudeDir = join(dir, '.claude');
  mkdirSync(join(claudeDir, 'projects'), { recursive: true });
  mkdirSync(join(dir, '.codex', 'sessions'), { recursive: true });
  mkdirSync(join(dir, '.pi'), { recursive: true });
  const sessions = join(dir, '.dsh', 'sessions');
  for (const entry of ['--dsh-v3--', '--dsh-v4--', ...(zstdDecoder() ? ['--home-dev-project--'] : [])]) {
    cpSync(join(FIXTURES, entry), join(sessions, entry), { recursive: true });
  }
  if (!zstdDecoder()) rmSync(join(sessions, '--dsh-v3--', 'v3-basic'), { recursive: true, force: true });
  return { claudeDir, codexDir: join(dir, '.codex'), sessions, dbPath: join(dir, 'trajex.sqlite') };
}

const build = (env, extra = {}) => buildIndex({
  claudeDir: env.claudeDir, codexDir: env.codexDir, dbPath: env.dbPath, DatabaseImpl: TestDatabase,
  providerRoots: { deepseek: env.sessions, pi: join(env.claudeDir, '..', '.pi') }, ...extra,
});

test('DeepSeek Harness trees index into sessions, subagents, FTS and the query API', () => {
  const env = home();
  const first = build(env);
  assert.equal(first.deferred, false);
  assert.equal(first.skipped, 0, JSON.stringify(first.skippedFiles));

  const db = new TestDatabase(env.dbPath);
  try {
    const sessions = db.prepare("SELECT id, title, message_count FROM sessions WHERE source='deepseek' ORDER BY id").all();
    assert.equal(sessions.length, zstdDecoder() ? 10 : 8);
    const parentId = deepseekSessionId('v3-seeded-parent', '/dsh-fixtures');
    const childId = deepseekSessionId('v3-seeded-child', '/dsh-fixtures');
    assert.ok(sessions.some(session => session.id === parentId));
    assert.ok(!sessions.some(session => session.id === childId), 'an adopted child is not a separate session');
    assert.deepEqual({ ...db.prepare('SELECT agent_id, session_id FROM subagents WHERE agent_id=?').get(childId) },
      { agent_id: childId, session_id: parentId });

    const api = createQueryApi(db.db);
    const childHit = api.search('child answer', { source: 'deepseek' });
    assert.equal(childHit[0]?.message.uuid.startsWith(childId), true);
    assert.deepEqual(api.search('"first answer"', { source: 'deepseek' }), [], 'compacted history is inactive by default');
    assert.equal(api.search('"first answer"', { source: 'deepseek', includeInactive: true }).length, 1);
    assert.ok(api.summaries({ source: 'deepseek' }).some(summary => summary.content === 'summary of the first two exchanges'));
    const failed = api.failures({ source: 'deepseek' });
    assert.ok(failed.some(row => row.result.content === 'Error: file not found'));
  } finally {
    db.close();
  }

  const unchanged = build(env, { force: false });
  assert.equal(unchanged.files, 0, 'unchanged trees are not replayed');

  appendFileSync(join(env.sessions, '--dsh-v4--/v4-basic/session.v4.jsonl'),
    JSON.stringify({ type: 'user/message', seq: 500, time: 9_000, data: { id: 'late', content: [{ type: 'text', text: 'appended after build' }], source: { kind: 'user' } } }) + '\n');
  rmSync(join(env.sessions, '--dsh-v4--/v4-retry-resume'), { recursive: true, force: true });
  const changed = build(env, { changedPaths: [join(env.sessions, '--dsh-v4--')] });
  assert.equal(changed.skipped, 0);
  const after = new TestDatabase(env.dbPath);
  try {
    const api = createQueryApi(after.db);
    assert.equal(api.search('"appended after build"', { source: 'deepseek' }).length, 1);
    assert.equal(after.prepare('SELECT COUNT(*) AS c FROM sessions WHERE id=?')
      .get(deepseekSessionId('v4-retry-resume', '/dsh-fixtures')).c, 0, 'a deleted session is retracted');
  } finally {
    after.close();
  }
});
