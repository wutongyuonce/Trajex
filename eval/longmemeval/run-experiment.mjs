#!/usr/bin/env node

/** 用冻结的 LongMemEval 实验配方串联准备、四个 arm 与官方 judge。 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const ARMS = ['none', 'full', 'rag_raw', 'trajex_active'];
const TYPES = ['single-session-user', 'single-session-preference', 'single-session-assistant', 'multi-session', 'temporal-reasoning', 'knowledge-update'];
function fail(message) { throw new Error(message); }

function args(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]; const value = argv[index + 1];
    if (!key?.startsWith('--') || value === undefined) fail(`Invalid argument near ${key ?? '<end>'}`);
    values[key.slice(2)] = value;
  }
  if (!values.lock) fail('Required: --lock');
  return values;
}

function loadLock(path) {
  try {
    const lock = JSON.parse(readFileSync(path, 'utf8')).longmemeval;
    const judge = { ...lock?.judge, kind: lock?.judge?.kind || 'official' };
    if (!lock || !lock.input || !lock.manifest || !lock.work || !lock.runs || !lock.sample?.seed || !Number.isInteger(lock.sample?.size) || !lock.pi?.model || !['official', 'pi'].includes(judge.kind) || (judge.kind === 'official' && (!judge.evaluator_dir || !judge.model))) fail('Invalid longmemeval experiment lock');
    const arms = lock.arms || ARMS;
    if (!Array.isArray(arms) || !arms.length || arms.some(arm => !ARMS.includes(arm))) fail('lock.longmemeval.arms must contain supported arms');
    return { ...lock, arms, judge };
  } catch (error) { fail(error instanceof Error && error.message === 'Invalid longmemeval experiment lock' ? error.message : `Invalid lock JSON: ${path}`); }
}

function run(script, scriptArgs) {
  const result = spawnSync(process.execPath, [join(ROOT, script), ...scriptArgs], { stdio: 'inherit' });
  if (result.error || result.status !== 0) fail(`${script} failed: ${result.error?.message || result.status}`);
}

function jsonl(path) { return readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse); }
function average(values) { return values.length ? values.reduce((total, value) => total + value, 0) / values.length : null; }
function number(value) { return typeof value === 'number' && Number.isFinite(value) ? value : null; }
function cell(value, digits = 0) { return value === null ? '—' : digits ? `${value.toFixed(digits)}%` : String(value); }
function runId(value, lock) {
  if (value && !/^[A-Za-z0-9_-]+$/.test(value)) fail('--run-id must contain only letters, numbers, _ or -');
  return value || `${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')}-${createHash('sha256').update(lock).digest('hex').slice(0, 8)}`;
}
function inside(root, value, label) {
  if (typeof value !== 'string' || !value || value.startsWith('/') || value.split(/[\\/]/).includes('..')) fail(`${label} must be a non-empty path inside the run bundle`);
  return join(root, value);
}

/** 汇总已有产物，不重算 judge；因此表格和逐题 JSONL 始终能相互追溯。 */
function summary(runs, arms, judgeKind, judgeModel, references) {
  const byId = new Map(references.map(row => [row.question_id, row]));
  const rows = arms.map(arm => {
    const judgePath = join(runs, judgeKind === 'pi' ? `${arm}.pi-judge.jsonl` : `${arm}.jsonl.eval-results-${judgeModel}`);
    const judged = jsonl(judgePath); const telemetry = jsonl(join(runs, `${arm}.telemetry.jsonl`));
    const labels = judged.map(row => ({ label: row.autoeval_label?.label, task: byId.get(row.question_id) })).filter(row => typeof row.label === 'boolean' && row.task);
    const token = key => {
      const values = telemetry.map(row => number(row.usage?.[key])).filter(value => value !== null);
      return values.length ? values.reduce((total, value) => total + value, 0) : null;
    };
    return {
      arm, labels,
      accuracy: average(labels.map(row => Number(row.label))),
      abstention: average(labels.filter(row => row.task.question_id.endsWith('_abs')).map(row => Number(row.label))),
      input: token('input'), cacheRead: token('cacheRead'), output: token('output'), cacheWrite: token('cacheWrite'),
      wall: telemetry.reduce((total, row) => total + (number(row.wall_time_ms) || 0), 0),
    };
  });
  const lines = [
    '# LongMemEval experiment summary', '',
    `Judge: ${judgeKind === 'pi' ? 'Pi judge' : `official LongMemEval judge (${judgeModel})`}`, '',
    '## Arm comparison', '',
    '| Arm | QA accuracy | Abstention accuracy | Input tokens | Cache read | Output tokens | Cache write | Wall time |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
    ...rows.map(row => `| ${row.arm} | ${cell(row.accuracy === null ? null : row.accuracy * 100, 2)} | ${cell(row.abstention === null ? null : row.abstention * 100, 2)} | ${cell(row.input)} | ${cell(row.cacheRead)} | ${cell(row.output)} | ${cell(row.cacheWrite)} | ${(row.wall / 1000).toFixed(1)}s |`),
    '', '## Accuracy by question type', '',
    `| Question type | ${arms.join(' | ')} |`,
    `| --- | ${arms.map(() => '---:').join(' | ')} |`,
    ...TYPES.map(type => `| ${type} | ${rows.map(row => cell(average(row.labels.filter(label => label.task.question_type === type).map(label => Number(label.label))) === null ? null : average(row.labels.filter(label => label.task.question_type === type).map(label => Number(label.label))) * 100, 2)).join(' | ')} |`), '',
  ];
  mkdirSync(runs, { recursive: true }); writeFileSync(join(runs, 'summary.md'), `${lines.join('\n')}\n`);
}

function main() {
  const options = args(process.argv.slice(2)); const lockPath = resolve(options.lock); const lockBytes = readFileSync(lockPath); const base = dirname(lockPath); const lock = loadLock(lockPath);
  const path = value => resolve(base, value);
  const command = value => value.includes('/') ? path(value) : value;
  const id = runId(options['run-id'], lockBytes); const runs = join(path(lock.runs), id);
  if (existsSync(runs)) fail(`Run already exists: ${runs}`);
  mkdirSync(runs, { recursive: true }); writeFileSync(join(runs, 'experiment.lock.json'), lockBytes);
  const input = path(lock.input); const manifest = inside(runs, lock.manifest, 'lock.longmemeval.manifest'); const work = inside(runs, lock.work, 'lock.longmemeval.work');
  run('prepare/sample-longmemeval.mjs', ['--input', input, '--output', manifest, '--size', String(lock.sample.size), '--seed', lock.sample.seed]);
  run('prepare/prepare-longmemeval-sessions.mjs', ['--input', input, '--manifest', manifest, '--output', work]);
  for (const arm of lock.arms) {
    const hypotheses = join(runs, `${arm}.jsonl`); const telemetry = join(runs, `${arm}.telemetry.jsonl`);
    const runnerArgs = ['--work', work, '--arm', arm, '--output', hypotheses, '--pi-model', lock.pi.model, '--telemetry', telemetry];
    if (lock.pi.command) runnerArgs.push('--pi-command', command(lock.pi.command));
    if (arm === 'trajex_active' && lock.trajex_command) runnerArgs.push('--trajex-command', command(lock.trajex_command));
    if (arm === 'rag_raw') {
      if (!options['embedding-api-key'] || !lock.embedding?.base_url) fail('rag_raw requires --embedding-api-key and lock.longmemeval.embedding.base_url');
      runnerArgs.push('--embedding-api-key', options['embedding-api-key'], '--embedding-base-url', lock.embedding.base_url, '--embedding-model', lock.embedding.model || 'text-embedding-v4');
    }
    run('run-longmemeval.mjs', runnerArgs);
    if (lock.judge.kind === 'official') {
      const judgeArgs = ['--evaluator-dir', path(lock.judge.evaluator_dir), '--hypotheses', hypotheses, '--dataset', input, '--model', lock.judge.model, '--python', lock.judge.python ? command(lock.judge.python) : 'python'];
      if (options['judge-api-key']) judgeArgs.push('--api-key', options['judge-api-key']);
      run('judge-longmemeval.mjs', judgeArgs);
    }
    else {
      const judgeOutput = join(runs, `${arm}.pi-judge.jsonl`); const judgeArgs = ['--hypotheses', hypotheses, '--dataset', input, '--output', judgeOutput, '--pi-model', lock.pi.model];
      if (lock.pi.command) judgeArgs.push('--pi-command', command(lock.pi.command));
      run('judge-longmemeval-pi.mjs', judgeArgs);
    }
  }
  summary(runs, lock.arms, lock.judge.kind, lock.judge.model, JSON.parse(readFileSync(input, 'utf8')));
  process.stdout.write(`${JSON.stringify({ lock: lockPath, run_id: id, completed_arms: lock.arms, summary: join(runs, 'summary.md') })}\n`);
}

try { main(); } catch (error) { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; }
