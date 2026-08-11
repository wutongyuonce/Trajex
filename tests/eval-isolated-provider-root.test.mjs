import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../packages/cli/src/trajex.ts', import.meta.url));

test('trajex build honors isolated Pi session and database environment roots', () => {
  const root = mkdtempSync(join(tmpdir(), 'trajex-eval-root-'));
  const sessions = join(root, 'history');
  const database = join(root, 'isolated-db');
  mkdirSync(sessions, { recursive: true });
  writeFileSync(join(sessions, 'history.jsonl'), `${JSON.stringify({ type: 'session', version: 3, id: 'fixture', cwd: '/eval' })}\n${JSON.stringify({ type: 'message', id: 'message', parentId: null, message: { role: 'user', content: 'isolated history' } })}\n`);

  const result = spawnSync(process.execPath, [CLI, '--build'], {
    encoding: 'utf8',
    env: { ...process.env, HOME: join(root, 'unused-home'), PI_CODING_AGENT_SESSION_DIR: sessions, TRAJEX_DIR: database },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).db, join(database, 'trajex.sqlite'));
  assert.equal(existsSync(join(database, 'trajex.sqlite')), true);
  assert.equal(existsSync(join(root, 'unused-home', '.trajex', 'trajex.sqlite')), false);
});
