import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeTempDir } from './temp-dirs.mjs';

const EXPERIMENT = fileURLToPath(new URL('../eval/longmemeval/run-experiment.mjs', import.meta.url));

test('LongMemEval experiment lock prepares, runs an arm, and judges its hypotheses', () => {
  const dir = makeTempDir('trajex-eval-experiment-');
  const pi = join(dir, 'pi.mjs'); const python = join(dir, 'python.mjs'); const judgeLog = join(dir, 'judge.jsonl');
  const input = join(dir, 'longmemeval.json'); const lock = join(dir, 'experiment.lock.json');
  mkdirSync(join(dir, 'evaluation'), { recursive: true });
  writeFileSync(input, JSON.stringify([{
    question_id: 'question_1', question_type: 'single-session-user', question: 'What did I buy?', question_date: '2026-01-01',
    haystack_session_ids: ['session_1'], haystack_dates: ['2025-01-01'], haystack_sessions: [[{ role: 'user', content: 'I bought a red bicycle.' }]], answer: 'A red bicycle',
  }]));
  writeFileSync(pi, '#!/usr/bin/env node\nprocess.stdout.write("A red bicycle\\n");\n');
  writeFileSync(python, '#!/usr/bin/env node\nimport { appendFileSync, readFileSync, writeFileSync } from "node:fs";\nconst args = process.argv.slice(2);\nappendFileSync(process.env.JUDGE_LOG, JSON.stringify({ args, apiKey: process.env.OPENAI_API_KEY }) + "\\n");\nif (args[0].endsWith("evaluate_qa.py")) { const rows = readFileSync(args[2], "utf8").trim().split("\\n").map(JSON.parse).map(row => ({ ...row, autoeval_label: { model: args[1], label: true } })); writeFileSync(`${args[2]}.eval-results-${args[1]}`, rows.map(JSON.stringify).join("\\n") + "\\n"); }\n');
  chmodSync(pi, 0o755); chmodSync(python, 0o755);
  writeFileSync(lock, JSON.stringify({
    longmemeval: {
      input: 'longmemeval.json', manifest: 'manifests/tasks.jsonl', work: 'work', runs: 'runs', sample: { size: 1, seed: 'test' },
      pi: { model: 'test-model', command: pi }, arms: ['none'],
      judge: { evaluator_dir: 'evaluation', model: 'judge-model', python },
    },
  }, null, 2));

  const result = spawnSync(process.execPath, [EXPERIMENT, '--lock', lock, '--run-id', 'official', '--judge-api-key', 'judge-key'], { encoding: 'utf8', env: { ...process.env, JUDGE_LOG: judgeLog } });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(readFileSync(join(dir, 'runs', 'official', 'none.jsonl'), 'utf8').trim().split('\n').map(JSON.parse), [{ question_id: 'question_1', hypothesis: 'A red bicycle' }]);
  assert.deepEqual(readFileSync(judgeLog, 'utf8').trim().split('\n').map(JSON.parse), [
    { args: [join(dir, 'evaluation', 'evaluate_qa.py'), 'judge-model', join(dir, 'runs', 'official', 'none.jsonl'), input], apiKey: 'judge-key' },
    { args: [join(dir, 'evaluation', 'print_qa_metrics.py'), `${join(dir, 'runs', 'official', 'none.jsonl')}.eval-results-judge-model`, input], apiKey: 'judge-key' },
  ]);
  assert.equal(readFileSync(join(dir, 'runs', 'official', 'experiment.lock.json'), 'utf8'), readFileSync(lock, 'utf8'));
});

test('LongMemEval experiment can reuse its Pi model as a Pi judge', () => {
  const dir = makeTempDir('trajex-eval-pi-experiment-'); const pi = join(dir, 'pi.mjs'); const input = join(dir, 'data.json'); const lock = join(dir, 'experiment.lock.json');
  writeFileSync(input, JSON.stringify([{ question_id: 'question_1', question_type: 'single-session-user', question: 'What did I buy?', question_date: '2026-01-01', haystack_session_ids: [], haystack_dates: [], haystack_sessions: [], answer: 'A red bicycle' }]));
  writeFileSync(pi, '#!/usr/bin/env node\nprocess.stdout.write(process.argv.at(-1).includes("Correct Answer:") ? "yes\\n" : "A red bicycle\\n");\n'); chmodSync(pi, 0o755);
  writeFileSync(lock, JSON.stringify({ longmemeval: { input: 'data.json', manifest: 'manifest.jsonl', work: 'work', runs: 'runs', sample: { size: 1, seed: 'test' }, pi: { model: 'shared-model', command: pi }, arms: ['none'], judge: { kind: 'pi' } } }));

  const result = spawnSync(process.execPath, [EXPERIMENT, '--lock', lock, '--run-id', 'pi'], { encoding: 'utf8' });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(readFileSync(join(dir, 'runs', 'pi', 'none.pi-judge.jsonl'), 'utf8').trim().split('\n').map(JSON.parse), [{ question_id: 'question_1', hypothesis: 'A red bicycle', autoeval_label: { model: 'shared-model', label: true, judge: 'pi' } }]);
});

test('LongMemEval experiment writes a per-arm score and telemetry summary table', () => {
  const dir = makeTempDir('trajex-eval-summary-'); const pi = join(dir, 'pi.mjs'); const input = join(dir, 'data.json'); const lock = join(dir, 'experiment.lock.json');
  writeFileSync(input, JSON.stringify([{ question_id: 'question_1', question_type: 'single-session-user', question: 'What did I buy?', question_date: '2026-01-01', haystack_session_ids: [], haystack_dates: [], haystack_sessions: [], answer: 'A red bicycle' }]));
  writeFileSync(pi, '#!/usr/bin/env node\nif (process.argv.includes("--mode")) process.stdout.write(JSON.stringify({ role: "assistant", content: [{ type: "text", text: "A red bicycle" }], usage: { input: 12, output: 4, cacheRead: 3, cacheWrite: 1 } }) + "\\n"); else process.stdout.write("yes\\n");\n'); chmodSync(pi, 0o755);
  writeFileSync(lock, JSON.stringify({ longmemeval: { input: 'data.json', manifest: 'manifest.jsonl', work: 'work', runs: 'runs', sample: { size: 1, seed: 'test' }, pi: { model: 'shared-model', command: pi }, arms: ['none'], judge: { kind: 'pi' } } }));

  const result = spawnSync(process.execPath, [EXPERIMENT, '--lock', lock, '--run-id', 'summary'], { encoding: 'utf8' });

  assert.equal(result.status, 0, result.stderr);
  assert.match(readFileSync(join(dir, 'runs', 'summary', 'summary.md'), 'utf8'), /\| none \| 100\.00% \| — \| 12 \| 3 \| 4 \| 1 \|/);
  const duplicate = spawnSync(process.execPath, [EXPERIMENT, '--lock', lock, '--run-id', 'summary'], { encoding: 'utf8' });
  assert.notEqual(duplicate.status, 0);
  assert.match(duplicate.stderr, /Run already exists/);
});
