import { makeTempDir } from './temp-dirs.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../eval/longmemeval/prepare/sample-longmemeval.mjs', import.meta.url));

function question(questionId, questionType) {
  return {
    question_id: questionId,
    question_type: questionType,
    question: `Question ${questionId}`,
    answer: `Secret ${questionId}`,
    question_date: '2026-01-01',
    haystack_session_ids: [`session-${questionId}`],
    haystack_dates: ['2025-01-01'],
    haystack_sessions: [[{ role: 'user', content: 'private history', has_answer: true }]],
    answer_session_ids: [`session-${questionId}`],
  };
}

function runCli(input, output) {
  return spawnSync(process.execPath, [
    CLI,
    '--input', input,
    '--output', output,
    '--size', '4',
    '--seed', 'trajex-v1',
  ], { encoding: 'utf8' });
}

test('LongMemEval manifest CLI creates a deterministic stratified gold-free task list', () => {
  const dir = makeTempDir('trajex-longmemeval-');
  const inputA = join(dir, 'input-a.json');
  const outputA = join(dir, 'manifest-a.jsonl');
  const outputB = join(dir, 'manifest-b.jsonl');
  const rows = [
    question('user-1', 'single-session-user'),
    question('user-2', 'single-session-user'),
    question('user-abs-1_abs', 'single-session-user'),
    question('user-abs-2_abs', 'single-session-user'),
    question('time-1', 'temporal-reasoning'),
    question('time-2', 'temporal-reasoning'),
    question('multi-1', 'multi-session'),
    question('multi-2', 'multi-session'),
  ];
  writeFileSync(inputA, JSON.stringify(rows));

  const first = runCli(inputA, outputA);
  const second = runCli(inputA, outputB);

  assert.equal(first.status, 0, first.stderr);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(readFileSync(outputA, 'utf8'), readFileSync(outputB, 'utf8'));

  const manifest = readFileSync(outputA, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(manifest.length, 4);
  assert.deepEqual(
    manifest.map(row => `${row.question_type}:${row.is_abstention}`).sort(),
    [
      'multi-session:false',
      'single-session-user:false',
      'single-session-user:true',
      'temporal-reasoning:false',
    ],
  );
  assert.ok(manifest.every(row => typeof row.source_sha256 === 'string' && row.source_sha256.length === 64));
  assert.ok(manifest.every(row => !('answer' in row)));
  assert.ok(manifest.every(row => !('answer_session_ids' in row)));
  assert.ok(manifest.every(row => !('haystack_sessions' in row)));
});
