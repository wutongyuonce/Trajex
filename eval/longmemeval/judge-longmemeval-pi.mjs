#!/usr/bin/env node

/** 用 Pi 复刻 LongMemEval 的逐题 yes/no rubric；结果不冒充官方 OpenAI judge。 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const TYPES = ['single-session-user', 'single-session-preference', 'single-session-assistant', 'multi-session', 'temporal-reasoning', 'knowledge-update'];
function fail(message) { throw new Error(message); }

function args(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]; const value = argv[index + 1];
    if (!key?.startsWith('--') || value === undefined) fail(`Invalid argument near ${key ?? '<end>'}`);
    values[key.slice(2)] = value;
  }
  if (!values.hypotheses || !values.dataset || !values.output || !values['pi-model']) fail('Required: --hypotheses, --dataset, --output, --pi-model');
  return values;
}

function readJson(path) { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { fail(`Invalid JSON: ${path}`); } }
function readJsonl(path) { return readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map((line, index) => { try { return JSON.parse(line); } catch { fail(`Invalid JSONL line ${index + 1}: ${path}`); } }); }

function prompt(task, hypothesis) {
  if (task.question_id.endsWith('_abs')) return `Decide whether the response correctly identifies an unanswerable question. It may say information is incomplete or that different information is available. Answer yes or no only.\n\nQuestion: ${task.question}\n\nExplanation: ${task.answer}\n\nModel Response: ${hypothesis}`;
  if (task.question_type === 'single-session-preference') return `Decide whether the response satisfies the desired personalized response. It need not reflect every rubric point, but must correctly recall and use personal information. Answer yes or no only.\n\nQuestion: ${task.question}\n\nRubric: ${task.answer}\n\nModel Response: ${hypothesis}`;
  if (task.question_type === 'knowledge-update') return `Decide whether the response contains the correct answer. If it includes previous information together with the required updated answer, count it as correct. Answer yes or no only.\n\nQuestion: ${task.question}\n\nCorrect Answer: ${task.answer}\n\nModel Response: ${hypothesis}`;
  const temporal = task.question_type === 'temporal-reasoning' ? ' Do not penalize off-by-one errors for numbers of days, weeks, or months.' : '';
  return `Decide whether the response contains the complete correct answer or equivalent intermediate steps. A partial answer is incorrect.${temporal} Answer yes or no only.\n\nQuestion: ${task.question}\n\nCorrect Answer: ${task.answer}\n\nModel Response: ${hypothesis}`;
}

function judge(command, model, question) {
  const result = spawnSync(command, ['--model', model, '--no-session', '--no-context-files', '--no-extensions', '--no-skills', '--no-tools', '--print', question], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  if (result.error || result.status !== 0) fail(`Pi judge failed: ${result.error?.message || result.stderr}`);
  return result.stdout.toLowerCase().includes('yes');
}

function metrics(rows) {
  const byType = Object.fromEntries(TYPES.map(type => [type, []])); const abstention = [];
  for (const row of rows) { byType[row.question_type].push(row.label); if (row.is_abstention) abstention.push(row.label); }
  const average = values => values.reduce((total, value) => total + Number(value), 0) / values.length;
  const present = TYPES.filter(type => byType[type].length);
  return {
    total: rows.length,
    overall_accuracy: average(rows.map(row => row.label)),
    task_averaged_accuracy: average(present.map(type => average(byType[type]))),
    abstention_accuracy: abstention.length ? average(abstention) : null,
    question_type_accuracy: Object.fromEntries(present.map(type => [type, average(byType[type])])),
  };
}

function main() {
  const options = args(process.argv.slice(2)); const references = readJson(resolve(options.dataset));
  if (!Array.isArray(references)) fail('Dataset must be a JSON array');
  const referenceById = new Map(references.map(row => [row.question_id, row])); const output = resolve(options.output); const rows = [];
  for (const hypothesis of readJsonl(resolve(options.hypotheses))) {
    const task = referenceById.get(hypothesis.question_id);
    if (!task || typeof task.question !== 'string' || typeof task.answer !== 'string' || !TYPES.includes(task.question_type) || typeof hypothesis.hypothesis !== 'string') fail(`Invalid task or hypothesis: ${hypothesis.question_id}`);
    const label = judge(options['pi-command'] || 'pi', options['pi-model'], prompt(task, hypothesis.hypothesis));
    rows.push({ ...hypothesis, autoeval_label: { model: options['pi-model'], label, judge: 'pi' } });
  }
  mkdirSync(dirname(output), { recursive: true }); writeFileSync(output, `${rows.map(JSON.stringify).join('\n')}\n`);
  const summaryRows = rows.map(row => ({ question_type: referenceById.get(row.question_id).question_type, is_abstention: row.question_id.endsWith('_abs'), label: row.autoeval_label.label }));
  process.stdout.write(`${JSON.stringify({ output, judge: 'pi', pi_model: options['pi-model'], ...metrics(summaryRows) })}\n`);
}

try { main(); } catch (error) { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; }
