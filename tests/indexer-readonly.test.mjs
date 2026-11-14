// Copyright (C) 2026 tommy0103 and contributors.
// Copyright (C) 2026 wutongyuonce and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, copyFileSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { runCli } from './cli-test-helpers.mjs';
import { makeTempDir } from './temp-dirs.mjs';

// Real provider output and a genuinely read-only index file: SQLite opens it
// read/write without complaint, so only an executed write reveals the problem.
function readOnlyIndexHome() {
  const home = makeTempDir('trajex-readonly-');
  mkdirSync(join(home, '.claude'), { recursive: true });
  const warm = runCli(['--build'], { home });
  assert.equal(warm.status, 0, warm.stderr || warm.stdout);
  const project = join(home, '.claude', 'projects', '-tmp-readonly');
  mkdirSync(project, { recursive: true });
  for (const name of ['first', 'second']) {
    copyFileSync(new URL('./fixtures/claude/custom-title-session.jsonl', import.meta.url), join(project, `${name}.jsonl`));
  }
  const dbPath = join(home, '.trajex', 'trajex.sqlite');
  const db = new DatabaseSync(dbPath);
  db.prepare("DELETE FROM index_state WHERE jsonl_path='__last_build__'").run();
  db.close();
  chmodSync(dbPath, 0o444);
  const query = join(home, 'query.mjs');
  writeFileSync(query, "throw new Error('QUERY_SCRIPT_RAN');\n");
  return { home, dbPath, query };
}

test('a read-only index fails once with the index path instead of blaming each transcript', { skip: process.getuid?.() === 0 }, () => {
  const { home, dbPath, query } = readOnlyIndexHome();
  try {
    for (const args of [['--build'], ['--search', 'ok'], ['--query', query]]) {
      const result = runCli(args, { home });
      assert.equal(result.status, 1, `${args[0]} must exit nonzero: ${result.stdout}`);
      const { error } = JSON.parse(result.stdout);
      assert.match(error, /Cannot refresh the Trajex index at /u);
      assert.ok(error.includes(join('.trajex', 'trajex.sqlite')), `${args[0]} names the index path`);
      assert.match(error, /host-approved permissions/u);
      assert.doesNotMatch(error, /QUERY_SCRIPT_RAN/u, 'the query script never runs');
      assert.doesNotMatch(result.stderr, /failed to index claude unit/u, 'no per-transcript retry warnings');
    }
  } finally {
    // SQLite creates -wal/-shm sidecars with the database file's mode.
    for (const name of readdirSync(dirname(dbPath))) chmodSync(join(dirname(dbPath), name), 0o644);
  }
  const recovered = runCli(['--build'], { home });
  assert.equal(recovered.status, 0, recovered.stderr || recovered.stdout);
});

test('a forced CLI rebuild keeps provider version markers, so the next build does not replay again', () => {
  const home = makeTempDir('trajex-force-markers-');
  const project = join(home, '.claude', 'projects', '-tmp-force');
  mkdirSync(project, { recursive: true });
  copyFileSync(new URL('./fixtures/claude/custom-title-session.jsonl', import.meta.url), join(project, 'a.jsonl'));
  // The first build writes pending markers after cleanup; the second forced build starts with them present.
  assert.equal(runCli(['--build'], { home }).status, 0);
  assert.equal(runCli(['--build'], { home }).status, 0);
  const db = new DatabaseSync(join(home, '.trajex', 'trajex.sqlite'));
  try {
    const markers = db.prepare("SELECT jsonl_path FROM index_state WHERE jsonl_path LIKE '\\_\\_%canonical%' ESCAPE '\\'").all()
      .map(row => row.jsonl_path).sort();
    assert.ok(markers.includes('__claude_canonical_transcript_v1.1__'), markers.join(','));
    assert.equal(markers.length, 4, 'every built-in provider marker survives the force cleanup');
  } finally {
    db.close();
  }
});
