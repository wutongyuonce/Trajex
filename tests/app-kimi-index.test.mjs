import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildIndex } from '../app/src/main/indexer.ts';
import { createKimiProvider } from '../packages/core/src/providers/kimi.ts';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite');

class TestDatabase {
  constructor(dbPath) {
    this.db = new DatabaseSync(dbPath);
  }

  pragma(statement) { this.db.exec(`PRAGMA ${statement}`); }
  exec(sql) { return this.db.exec(sql); }
  prepare(sql) { return this.db.prepare(sql); }
  close() { return this.db.close(); }
}

function writeSession(kimiDir, { userSlash = false } = {}) {
  const sessionDir = join(kimiDir, 'sessions', 'workspace-1', 'session-index-1');
  const mainDir = join(sessionDir, 'agents', 'main');
  mkdirSync(mainDir, { recursive: true });
  writeFileSync(join(sessionDir, 'state.json'), JSON.stringify({
    title: 'Indexed Kimi session',
    workDir: '/tmp/indexed-kimi',
    createdAt: '2026-07-20T10:00:00.000Z',
    updatedAt: '2026-07-20T10:01:00.000Z',
    agents: { main: { type: 'main' } },
  }));
  const wirePath = join(mainDir, 'wire.jsonl');
  const records = [
    { type: 'metadata', protocol_version: '1.5', created_at: 1753005600000 },
    { type: 'context.append_message', time: 1753005601000, message: userSlash
      ? {
          role: 'user', content: 'Expanded skill instructions.', toolCalls: [],
          origin: {
            kind: 'skill_activation', trigger: 'user-slash', skillName: 'obelisk',
            skillArgs: 'find prior decisions',
          },
        }
      : { role: 'user', content: [{ type: 'text', text: 'kimi index needle' }], toolCalls: [], origin: { kind: 'user' } } },
  ];
  writeFileSync(wirePath, records.map((record) => JSON.stringify(record)).join('\n') + '\n');
  return { sessionDir, wirePath, records };
}

test('app build indexes Kimi sessions through the provider registry without changing schema', () => {
  const home = mkdtempSync(join(tmpdir(), 'obelisk-kimi-index-'));
  const claudeDir = join(home, '.claude');
  const codexDir = join(home, '.codex');
  const kimiDir = join(home, '.kimi-code');
  const dbPath = join(home, '.obelisk', 'obelisk.sqlite');
  writeSession(kimiDir);

  const first = buildIndex({
    claudeDir,
    codexDir,
    providerRoots: { kimi: kimiDir },
    dbPath,
    DatabaseImpl: TestDatabase,
  });
  assert.deepEqual(first.affectedSessionIds, ['kimi:session-index-1']);

  const db = new TestDatabase(dbPath);
  assert.deepEqual(
    db.prepare('SELECT id,title,source,message_count FROM sessions').all().map((row) => ({ ...row })),
    [{ id: 'kimi:session-index-1', title: 'Indexed Kimi session', source: 'kimi', message_count: 1 }],
  );
  assert.equal(db.prepare('SELECT text FROM messages').get().text, 'kimi index needle');
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM index_state WHERE jsonl_path = ?').get(
    join(kimiDir, 'sessions', 'workspace-1', 'session-index-1'),
  ).c, 1);
  const schema = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='messages'").get().sql;
  assert.doesNotMatch(schema, /kimi/i);
  db.close();

  const second = buildIndex({
    claudeDir,
    codexDir,
    providerRoots: { kimi: kimiDir },
    dbPath,
    DatabaseImpl: TestDatabase,
  });
  assert.deepEqual(second.affectedSessionIds, []);
});

test('Kimi undo and clear replace the indexed session instead of leaving stale rows', () => {
  const home = mkdtempSync(join(tmpdir(), 'obelisk-kimi-replay-'));
  const claudeDir = join(home, '.claude');
  const codexDir = join(home, '.codex');
  const kimiDir = join(home, '.kimi-code');
  const dbPath = join(home, '.obelisk', 'obelisk.sqlite');
  const { wirePath, records } = writeSession(kimiDir);
  const assistant = {
    type: 'context.append_loop_event',
    time: 1753005602000,
    event: { type: 'content.part', uuid: 'answer-1', stepUuid: 'step-1', part: { type: 'text', text: 'answer removed by undo' } },
  };
  writeFileSync(wirePath, [...records, assistant].map(record => JSON.stringify(record)).join('\n') + '\n');

  const options = {
    claudeDir,
    codexDir,
    providerRoots: { kimi: kimiDir },
    dbPath,
    DatabaseImpl: TestDatabase,
  };
  buildIndex(options);
  let db = new TestDatabase(dbPath);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM messages').get().c, 2);
  db.close();

  // Kimi undo shrinks the durable wire transcript.
  writeFileSync(wirePath, records.map(record => JSON.stringify(record)).join('\n') + '\n');
  buildIndex(options);
  db = new TestDatabase(dbPath);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM messages').get().c, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM messages WHERE text LIKE '%removed by undo%'").get().c, 0);
  db.close();

  // Clear retains the session container but removes all projected messages.
  writeFileSync(wirePath, JSON.stringify(records[0]) + '\n');
  buildIndex(options);
  db = new TestDatabase(dbPath);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM messages').get().c, 0);
  assert.equal(db.prepare('SELECT message_count FROM sessions WHERE id=?').get('kimi:session-index-1').message_count, 0);
  db.close();
});

test('Kimi canonical transcript marker replays unchanged sessions once', () => {
  const home = mkdtempSync(join(tmpdir(), 'obelisk-kimi-prompt-marker-'));
  const claudeDir = join(home, '.claude');
  const codexDir = join(home, '.codex');
  const kimiDir = join(home, '.kimi-code');
  const dbPath = join(home, '.obelisk', 'obelisk.sqlite');
  writeSession(kimiDir, { userSlash: true });
  const options = {
    claudeDir,
    codexDir,
    providerRoots: { kimi: kimiDir },
    dbPath,
    DatabaseImpl: TestDatabase,
  };

  buildIndex(options);
  let db = new TestDatabase(dbPath);
  const marker = createKimiProvider({ rootDir: kimiDir }).indexVersionMarker;
  assert.equal(marker, '__kimi_canonical_transcript_v3__');
  db.prepare("UPDATE messages SET text='stale expanded instructions', is_meta=1 WHERE source='kimi'").run();
  db.prepare('DELETE FROM index_state WHERE jsonl_path=?').run(marker);
  db.close();

  const replay = buildIndex(options);
  assert.deepEqual(replay.affectedSessionIds, ['kimi:session-index-1']);
  db = new TestDatabase(dbPath);
  assert.deepEqual(
    { ...db.prepare("SELECT text,is_meta FROM messages WHERE source='kimi'").get() },
    { text: '/obelisk find prior decisions', is_meta: 0 },
  );
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM index_state WHERE jsonl_path=?').get(marker).c, 1);
  db.close();
});
