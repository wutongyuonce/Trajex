import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeTempDir } from './temp-dirs.mjs';

const JUDGE = fileURLToPath(new URL('../eval/longmemeval/judge-longmemeval-pi.mjs', import.meta.url));

test('Pi judge labels LongMemEval hypotheses and writes separate aggregate results', () => {
  const dir = makeTempDir('trajex-eval-pi-judge-'); const pi = join(dir, 'pi.mjs'); const hypotheses = join(dir, 'answers.jsonl'); const dataset = join(dir, 'data.json'); const output = join(dir, 'pi-judge.jsonl');
  writeFileSync(hypotheses, '{"question_id":"q1","hypothesis":"A red bicycle"}\n{"question_id":"q2_abs","hypothesis":"I do not have enough information."}\n');
  writeFileSync(dataset, JSON.stringify([
    { question_id: 'q1', question_type: 'single-session-user', question: 'What did I buy?', answer: 'A red bicycle' },
    { question_id: 'q2_abs', question_type: 'single-session-user', question: 'What is my shoe size?', answer: 'No information about shoe size is available.' },
  ]));
  writeFileSync(pi, '#!/usr/bin/env node\nprocess.stdout.write("yes\\n");\n'); chmodSync(pi, 0o755);

  const result = spawnSync(process.execPath, [JUDGE, '--hypotheses', hypotheses, '--dataset', dataset, '--output', output, '--pi-model', 'judge-model', '--pi-command', pi], { encoding: 'utf8' });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(readFileSync(output, 'utf8').trim().split('\n').map(JSON.parse), [
    { question_id: 'q1', hypothesis: 'A red bicycle', autoeval_label: { model: 'judge-model', label: true, judge: 'pi' } },
    { question_id: 'q2_abs', hypothesis: 'I do not have enough information.', autoeval_label: { model: 'judge-model', label: true, judge: 'pi' } },
  ]);
  assert.match(result.stdout, /"overall_accuracy":1/);
  assert.match(result.stdout, /"abstention_accuracy":1/);
});
