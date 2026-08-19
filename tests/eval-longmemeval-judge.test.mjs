import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const JUDGE = fileURLToPath(new URL('../eval/longmemeval/judge-longmemeval.mjs', import.meta.url));

test('LongMemEval judge delegates evaluation and metrics to the official scripts', () => {
  const dir = mkdtempSync(join(tmpdir(), 'trajex-eval-judge-'));
  const evaluator = join(dir, 'evaluation'); const hypotheses = join(dir, 'answers.jsonl'); const dataset = join(dir, 'data.json'); const log = join(dir, 'calls.jsonl'); const python = join(dir, 'python.mjs');
  writeFileSync(hypotheses, '{"question_id":"q","hypothesis":"a"}\n'); writeFileSync(dataset, '[]');
  writeFileSync(python, `#!/usr/bin/env node\nimport { appendFileSync } from 'node:fs';\nappendFileSync(process.env.JUDGE_LOG, JSON.stringify({ args: process.argv.slice(2), apiKey: process.env.OPENAI_API_KEY }) + '\\n');\nprocess.stdout.write('official output\\n');\n`);
  chmodSync(python, 0o755);
  const result = spawnSync(process.execPath, [JUDGE, '--evaluator-dir', evaluator, '--hypotheses', hypotheses, '--dataset', dataset, '--model', 'gpt-4o', '--python', python, '--api-key', 'judge-key'], { encoding: 'utf8', env: { ...process.env, JUDGE_LOG: log } });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse), [
    { args: [join(evaluator, 'evaluate_qa.py'), 'gpt-4o', hypotheses, dataset], apiKey: 'judge-key' },
    { args: [join(evaluator, 'print_qa_metrics.py'), `${hypotheses}.eval-results-gpt-4o`, dataset], apiKey: 'judge-key' },
  ]);
});
