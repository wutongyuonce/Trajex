// Copyright (C) 2026 tommy0103 and contributors.
// Copyright (C) 2026 wutongyuonce and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

import { makeTempDir } from './temp-dirs.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
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
  const home = makeTempDir('trajex-app-pi-');
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

test('app Pi replay retracts a replaced identity and a deleted readable session file', () => {
  const home = makeTempDir('trajex-app-pi-retract-');
  const piDir = join(home, '.pi', 'agent');
  const sessionDir = join(piDir, 'sessions', '--tmp-app-pi--');
  const dbPath = join(home, '.trajex', 'trajex.sqlite');
  const sessionPath = join(sessionDir, 'fixture.jsonl');
  mkdirSync(sessionDir, { recursive: true });
  const writeSession = (id, text) => writeFileSync(sessionPath, [
    { type: 'session', version: 3, id, timestamp: '2026-07-20T10:00:00.000Z', cwd: '/tmp/app-pi' },
    { type: 'message', id: `${id}-message`, parentId: null, timestamp: '2026-07-20T10:00:01.000Z', message: { role: 'user', content: text } },
  ].map(JSON.stringify).join('\n') + '\n');
  writeSession('old-app-pi', 'old identity');

  const options = {
    claudeDir: join(home, 'empty-claude'),
    codexDir: join(home, 'empty-codex'),
    providerRoots: { pi: join(piDir, 'sessions') },
    dbPath,
    DatabaseImpl: TestDatabase,
  };
  const oldId = 'pi:old-app-pi:5b355add63649069dd69108f114465e7fd6e6949cd50bba6ceb122676cc0e2b1';
  const newId = 'pi:new-app-pi:5b355add63649069dd69108f114465e7fd6e6949cd50bba6ceb122676cc0e2b1';
  assert.deepEqual(buildIndex(options).affectedSessionIds, [oldId]);

  writeFileSync(sessionPath, [
    JSON.stringify({ type: 'session', version: 3, id: 'broken-replacement', cwd: '/tmp/app-pi' }),
    '{bad json}',
  ].join('\n') + '\n');
  const brokenId = 'pi:broken-replacement:5b355add63649069dd69108f114465e7fd6e6949cd50bba6ceb122676cc0e2b1';
  assert.deepEqual(buildIndex({ ...options, changedPaths: [sessionPath] }).affectedSessionIds, [brokenId, oldId]);
  let db = new TestDatabase(dbPath);
  assert.deepEqual(db.prepare("SELECT id FROM sessions WHERE source='pi' ORDER BY id").all().map(row => row.id), [brokenId]);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM messages WHERE session_id=?').get(brokenId).c, 0);
  db.close();

  writeSession('new-app-pi', 'new identity');
  assert.deepEqual(buildIndex({ ...options, changedPaths: [sessionPath] }).affectedSessionIds, [newId, brokenId]);
  db = new TestDatabase(dbPath);
  assert.deepEqual(db.prepare("SELECT id FROM sessions WHERE source='pi' ORDER BY id").all().map(row => row.id), [newId]);
  assert.equal(db.prepare('SELECT text FROM messages WHERE session_id=?').get(newId).text, 'new identity');
  db.close();

  rmSync(sessionPath);
  assert.deepEqual(buildIndex({ ...options, changedPaths: [sessionPath] }).affectedSessionIds, [newId]);
  db = new TestDatabase(dbPath);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM sessions WHERE source='pi'").get().c, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM messages').get().c, 0);
  db.close();
});

test('app Pi keeps the last snapshot when its configured root is missing', () => {
  const home = makeTempDir('trajex-app-pi-missing-root-');
  const piRoot = join(home, '.pi', 'agent', 'sessions');
  const sessionDir = join(piRoot, '--tmp-app-pi--');
  const dbPath = join(home, '.trajex', 'trajex.sqlite');
  mkdirSync(sessionDir, { recursive: true });
  const sessionPath = join(sessionDir, 'fixture.jsonl');
  writeFileSync(sessionPath, [
    { type: 'session', version: 3, id: 'kept-pi', cwd: '/tmp/app-pi' },
    { type: 'message', id: 'kept-message', parentId: null, message: { role: 'user', content: 'keep snapshot' } },
  ].map(JSON.stringify).join('\n') + '\n');
  const options = {
    claudeDir: join(home, 'empty-claude'),
    codexDir: join(home, 'empty-codex'),
    providerRoots: { pi: piRoot },
    dbPath,
    DatabaseImpl: TestDatabase,
  };
  assert.equal(buildIndex(options).files, 1);
  rmSync(piRoot, { recursive: true });
  assert.equal(buildIndex(options).files, 0);
  const db = new TestDatabase(dbPath);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM sessions WHERE source='pi'").get().c, 1);
  assert.equal(db.prepare('SELECT text FROM messages').get().text, 'keep snapshot');
  db.close();
});

test('app force rebuild aborts before cleanup when the indexed Pi session root is unavailable', () => {
  const home = makeTempDir('trajex-app-pi-force-root-');
  const piRoot = join(home, '.pi', 'agent', 'sessions');
  const sessionDir = join(piRoot, '--tmp-app-pi--');
  const dbPath = join(home, '.trajex', 'trajex.sqlite');
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(join(sessionDir, 'fixture.jsonl'), [
    { type: 'session', version: 3, id: 'force-kept-pi', cwd: '/tmp/app-pi' },
    { type: 'message', id: 'force-kept-message', parentId: null, message: { role: 'user', content: 'force keeps Pi snapshot' } },
  ].map(JSON.stringify).join('\n') + '\n');
  const options = {
    claudeDir: join(home, 'empty-claude'),
    codexDir: join(home, 'empty-codex'),
    providerRoots: { pi: piRoot },
    dbPath,
    DatabaseImpl: TestDatabase,
  };

  buildIndex(options);
  rmSync(piRoot, { recursive: true });

  assert.throws(
    () => buildIndex({ ...options, force: true }),
    /Pi.*root.*unavailable|root.*unavailable.*Pi/i,
  );
  const db = new TestDatabase(dbPath);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM sessions WHERE source='pi'").get().c, 1);
  db.close();
});

test('app Pi treats an unreadable descendant directory as an authoritative deletion', () => {
  const home = makeTempDir('trajex-app-pi-descendant-delete-');
  const piRoot = join(home, '.pi', 'agent', 'sessions');
  const sessionDir = join(piRoot, '--tmp-app-pi--');
  const dbPath = join(home, '.trajex', 'trajex.sqlite');
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(join(sessionDir, 'fixture.jsonl'), [
    { type: 'session', version: 3, id: 'descendant-pi', cwd: '/tmp/app-pi' },
    { type: 'message', id: 'descendant-message', parentId: null, message: { role: 'user', content: 'remove unreadable subtree' } },
  ].map(JSON.stringify).join('\n') + '\n');
  const options = {
    claudeDir: join(home, 'empty-claude'),
    codexDir: join(home, 'empty-codex'),
    providerRoots: { pi: piRoot },
    dbPath,
    DatabaseImpl: TestDatabase,
  };

  buildIndex(options);
  chmodSync(sessionDir, 0o000);
  try {
    buildIndex(options);
  } finally {
    chmodSync(sessionDir, 0o700);
  }

  const db = new TestDatabase(dbPath);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM sessions WHERE source='pi'").get().c, 0);
  db.close();
});
