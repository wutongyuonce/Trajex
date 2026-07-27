import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildIndex } from '../app/src/main/indexer.ts';
import { createProviderRegistry } from '../packages/core/src/providers/registry.ts';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite');

class TestDatabase {
  constructor(dbPath) { this.db = new DatabaseSync(dbPath); }
  pragma(statement) { this.db.exec(`PRAGMA ${statement}`); }
  exec(sql) { return this.db.exec(sql); }
  prepare(sql) { return this.db.prepare(sql); }
  close() { return this.db.close(); }
}

test('app indexer persists every provider through one registry-driven loop', () => {
  const home = mkdtempSync(join(tmpdir(), 'obelisk-provider-indexer-'));
  const dbPath = join(home, '.obelisk', 'obelisk.sqlite');
  const registry = createProviderRegistry([{
    name: 'alpha',
    descriptor: { id: 'alpha', name: 'Alpha', vendor: 'Test', defaultRoot: '/alpha', color: '#123456' },
    watchRoots: () => [],
    discover(ctx) {
      return ctx.lastCursor('alpha:unit') === '10:1'
        ? []
        : [{ key: 'alpha:unit', sessionId: 'alpha:session', project: '-tmp-alpha' }];
    },
    *parse(unit) {
      yield {
        kind: 'session', id: unit.sessionId, title: 'Alpha session', project: unit.project,
        started_at: '2026-07-20T10:00:00.000Z', ended_at: '2026-07-20T10:01:00.000Z',
        git_branch: null, version: null, message_count: 1, countMode: 'total',
        jsonl_path: unit.key, source: 'alpha',
      };
      yield {
        kind: 'message', uuid: 'alpha:message', session_id: unit.sessionId, type: 'user',
        parent_uuid: null, timestamp: '2026-07-20T10:00:00.000Z', role: 'user',
        text: 'registry tracer bullet', content_type: 'text', is_meta: 0, visibility: 'visible', model: null,
        is_sidechain: 0, agent_id: null, input_tokens: null, output_tokens: null,
        cwd: '/tmp/alpha', skill: null, source: 'alpha',
      };
      return '10:1';
    },
    raw: () => null,
  }]);

  const first = buildIndex({
    providerRegistry: registry,
    providerRoots: { alpha: '/alpha' },
    claudeDir: join(home, 'empty-claude'),
    codexDir: join(home, 'empty-codex'),
    dbPath,
    DatabaseImpl: TestDatabase,
  });
  assert.deepEqual(first.affectedSessionIds, ['alpha:session']);
  assert.equal(first.files, 1);

  const db = new TestDatabase(dbPath);
  assert.deepEqual(
    { ...db.prepare('SELECT id,source,message_count FROM sessions').get() },
    { id: 'alpha:session', source: 'alpha', message_count: 1 },
  );
  db.close();

  const second = buildIndex({
    providerRegistry: registry,
    providerRoots: { alpha: '/alpha' },
    dbPath,
    DatabaseImpl: TestDatabase,
  });
  assert.deepEqual(second.affectedSessionIds, []);
  assert.equal(second.files, 0);
});
