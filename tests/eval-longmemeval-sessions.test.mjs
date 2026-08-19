import { makeTempDir } from './temp-dirs.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../eval/longmemeval/prepare/prepare-longmemeval-sessions.mjs', import.meta.url));

test('LongMemEval session CLI creates isolated Pi history and gold-free Agent input', () => {
  const dir = makeTempDir('trajex-longmemeval-sessions-');
  const input = join(dir, 'input.json');
  const manifest = join(dir, 'manifest.jsonl');
  const output = join(dir, 'work');
  writeFileSync(input, JSON.stringify([{
    question_id: 'temporal-1', question_type: 'temporal-reasoning', question: 'When did I start?',
    question_date: '2025-03-24', answer: 'Two weeks later', answer_session_ids: ['trip', 'lesson'],
    haystack_session_ids: ['trip', 'lesson'], haystack_dates: ['2025-03-09', '2025-03-24'],
    haystack_sessions: [
      [{ role: 'user', content: 'I came home from Shanghai today.', has_answer: true }, { role: 'assistant', content: 'Welcome back.' }],
      [{ role: 'user', content: 'I started photography today.', has_answer: true }],
    ],
  }]));
  writeFileSync(manifest, `${JSON.stringify({ question_id: 'temporal-1', question_type: 'temporal-reasoning', is_abstention: false, source_sha256: 'fixture' })}\n`);

  const result = spawnSync(process.execPath, [CLI, '--input', input, '--manifest', manifest, '--output', output], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);

  const taskDir = join(output, 'temporal-1');
  const task = JSON.parse(readFileSync(join(taskDir, 'agent-input.json'), 'utf8'));
  assert.deepEqual(task, {
    question_id: 'temporal-1', question_type: 'temporal-reasoning', question: 'When did I start?', question_date: '2025-03-24',
  });
  assert.doesNotMatch(JSON.stringify(task), /answer|has_answer/i);

  const sessionDir = join(taskDir, 'sessions');
  assert.deepEqual(readdirSync(sessionDir).sort(), ['lesson.jsonl', 'trip.jsonl']);
  const trip = readFileSync(join(sessionDir, 'trip.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(trip.map(entry => entry.type), ['session', 'message', 'message', 'leaf']);
  assert.equal(trip[0].version, 3);
  assert.equal(trip[0].id, 'trip');
  assert.equal(trip[0].timestamp, '2025-03-09T00:00:00.000Z');
  assert.equal(trip[1].message.content, 'I came home from Shanghai today.');
  assert.doesNotMatch(JSON.stringify(trip), /has_answer|Two weeks later/);
});
