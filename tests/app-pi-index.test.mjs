import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildIndex } from '../app/src/main/indexer.ts';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite');

class TestDatabase {
  constructor(dbPath) { this.db = new DatabaseSync(dbPath); }
  pragma(statement) { this.db.exec(`PRAGMA ${statement}`); }
  exec(sql) { return this.db.exec(sql); }
  prepare(sql) { return this.db.prepare(sql); }
  close() { this.db.close(); }
}

test('app indexes configured Pi sessions through the provider registry', () => {
  const home = mkdtempSync(join(tmpdir(), 'trajex-app-pi-'));
  const piDir = join(home, '.pi', 'agent');
  const sessionDir = join(piDir, 'sessions', '--tmp-app-pi--');
  const dbPath = join(home, '.trajex', 'trajex.sqlite');
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(join(sessionDir, 'fixture.jsonl'), [
    { type: 'session', version: 3, id: 'app-pi-session', timestamp: '2026-07-20T10:00:00.000Z', cwd: '/tmp/app-pi' },
    { type: 'message', id: 'user1', parentId: null, timestamp: '2026-07-20T10:00:01.000Z', message: { role: 'user', content: 'app Pi index needle' } },
    { type: 'session_info', id: 'info1', parentId: 'user1', timestamp: '2026-07-20T10:00:02.000Z', name: 'App Pi fixture' },
  ].map(JSON.stringify).join('\n') + '\n');

  const options = {
    claudeDir: join(home, 'empty-claude'),
    codexDir: join(home, 'empty-codex'),
    providerRoots: { pi: join(piDir, 'sessions') },
    dbPath,
    DatabaseImpl: TestDatabase,
  };
  const sessionId = 'pi:app-pi-session:5b355add63649069dd69108f114465e7fd6e6949cd50bba6ceb122676cc0e2b1';
  assert.deepEqual(buildIndex(options).affectedSessionIds, [sessionId]);

  const db = new TestDatabase(dbPath);
  assert.deepEqual(
    db.prepare('SELECT id,title,source,message_count FROM sessions').all().map(row => ({ ...row })),
    [{ id: sessionId, title: 'App Pi fixture', source: 'pi', message_count: 1 }],
  );
  assert.equal(db.prepare('SELECT text FROM messages').get().text, 'app Pi index needle');
  assert.doesNotMatch(db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='messages'").get().sql, /\bpi\b/i);
  db.close();
  assert.deepEqual(buildIndex(options).affectedSessionIds, []);
});
