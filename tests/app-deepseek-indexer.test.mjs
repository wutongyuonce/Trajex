// Copyright (C) 2026 Trajex contributors.
// SPDX-License-Identifier: AGPL-3.0-only

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildIndex } from '../app/src/main/indexer.ts';
import { createDeepSeekProvider } from '../packages/core/src/providers/deepseek.ts';
import { createProviderRegistry } from '../packages/core/src/providers/registry.ts';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');

class TestDatabase {
  constructor(path) { this.db = new DatabaseSync(path); }
  pragma(statement) { this.db.exec(`PRAGMA ${statement}`); }
  exec(sql) { return this.db.exec(sql); }
  prepare(sql) { return this.db.prepare(sql); }
  close() { this.db.close(); }
}

test('DeepSeek session indexes into the shared database and FTS', () => {
  const root = mkdtempSync(join(tmpdir(), 'trajex-deepseek-index-'));
  try {
    const sessionDir = join(root, 'sessions', '--work--', 'session');
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, 'session.v4.jsonl'), [
      { type: 'session', version: 4, id: 'indexed', createdAt: 1780000000000, cwd: '/work/project' },
      { type: 'user/message', seq: 0, time: 1780000000001, data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'deepseek integration needle' }] }, surfaceOp: 'append' },
    ].map(row => JSON.stringify(row)).join('\n') + '\n');
    const dbPath = join(root, 'trajex.sqlite');
    const registry = createProviderRegistry([createDeepSeekProvider({ sessionDir: join(root, 'sessions') })]);
    const build = buildIndex({ dbPath, providerRegistry: registry, DatabaseImpl: TestDatabase });
    assert.equal(build.skipped, 0);
    const db = new TestDatabase(dbPath);
    try {
      assert.equal(db.prepare("SELECT source FROM sessions WHERE source='deepseek'").get().source, 'deepseek');
      assert.equal(db.prepare("SELECT text FROM messages_fts WHERE messages_fts MATCH 'needle'").get().text, 'deepseek integration needle');
    } finally { db.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
