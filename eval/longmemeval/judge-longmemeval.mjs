#!/usr/bin/env node

/** 调用 LongMemEval 官方评分脚本，避免在 Trajex 内复制 judge 逻辑。 */
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';

function fail(message) { throw new Error(message); }

function args(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]; const value = argv[index + 1];
    if (!key?.startsWith('--') || value === undefined) fail(`Invalid argument near ${key ?? '<end>'}`);
    values[key.slice(2)] = value;
  }
  if (!values['evaluator-dir'] || !values.hypotheses || !values.dataset || !values.model) fail('Required: --evaluator-dir, --hypotheses, --dataset, --model');
  return values;
}

function main() {
  const opts = args(process.argv.slice(2));
  const evaluator = resolve(opts['evaluator-dir']); const hypotheses = resolve(opts.hypotheses); const dataset = resolve(opts.dataset); const python = opts.python || 'python';
  const env = opts['api-key'] ? { ...process.env, OPENAI_API_KEY: opts['api-key'] } : process.env;
  for (const script of [
    [join(evaluator, 'evaluate_qa.py'), opts.model, hypotheses, dataset],
    [join(evaluator, 'print_qa_metrics.py'), `${hypotheses}.eval-results-${opts.model}`, dataset],
  ]) {
    const result = spawnSync(python, script, { encoding: 'utf8', env });
    process.stdout.write(result.stdout || '');
    if (result.error || result.status !== 0) fail(`Official judge failed: ${result.error?.message || result.stderr}`);
  }
}

try { main(); } catch (error) { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; }
