#!/usr/bin/env node

/** LongMemEval runner：逐题启动 Pi，并写出官方 evaluator 使用的 hypotheses JSONL。 */
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

function fail(message) { throw new Error(message); }

function assistantResult(stdout) {
  let answer = ''; let usage = null;
  const visit = value => {
    if (!value || typeof value !== 'object') return;
    if (value.usage && typeof value.usage === 'object') usage = value.usage;
    if (Array.isArray(value.content) && value.role === 'assistant') answer = value.content.filter(part => part.type === 'text').map(part => part.text).join('');
    for (const child of Object.values(value)) visit(child);
  };
  for (const line of stdout.trim().split('\n').filter(Boolean)) { try { visit(JSON.parse(line)); } catch { /* ignore non-event output */ } }
  return { answer, usage };
}

/** 解析固定的 CLI 键值参数。 */
function args(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith('--') || value === undefined) fail(`Invalid argument near ${key ?? '<end>'}`);
    values[key.slice(2)] = value;
  }
  if (!values.work || !values.arm || !values.output || !values['pi-model']) fail('Required: --work, --arm, --output, --pi-model');
  if (!['none', 'full', 'rag_raw', 'trajex_active'].includes(values.arm)) fail(`Not implemented yet: ${values.arm}`);
  if (values.arm === 'rag_raw' && (!values['embedding-api-key'] || !values['embedding-base-url'])) fail('rag_raw requires --embedding-api-key and --embedding-base-url');
  return values;
}

/** 不读取原始数据，只读取转换阶段专门交给 Agent 的 gold-free 输入。 */
function taskInput(taskDir) {
  try { return JSON.parse(readFileSync(join(taskDir, 'agent-input.json'), 'utf8')); } catch { fail(`Invalid agent input: ${taskDir}`); }
}

/** none arm 只给问题；Pi 也禁用工具，确保不存在隐式检索路径。 */
function nonePrompt(task) {
  return `Answer this LongMemEval question as accurately as possible.\nQuestion date: ${task.question_date}\nQuestion: ${task.question}`;
}

function activePrompt(task) {
  return `Answer this LongMemEval question. Use bash to query Trajex for evidence before answering. Do not inspect files directly.\nQuestion date: ${task.question_date}\nQuestion: ${task.question}`;
}

/** 读取转换器生成的 Pi JSONL，只保留原始 user/assistant 消息并按 session 日期排列。 */
function historyMessages(taskDir) {
  const sessions = readdirSync(join(taskDir, 'sessions')).filter(name => name.endsWith('.jsonl')).map(name => {
    const entries = readFileSync(join(taskDir, 'sessions', name), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
    const timestamp = entries.find(entry => entry.type === 'session')?.timestamp || '';
    const messages = entries.filter(entry => entry.type === 'message' && ['user', 'assistant'].includes(entry.message?.role) && typeof entry.message?.content === 'string')
      .map(entry => ({ role: entry.message.role, content: entry.message.content }));
    return { timestamp, messages };
  }).sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  return sessions.flatMap(session => session.messages);
}

function fullPrompt(task, taskDir) {
  const messages = historyMessages(taskDir).map(message => `${message.role}: ${message.content}`).join('\n');
  return `Answer this LongMemEval question using the past conversations below.\nQuestion date: ${task.question_date}\nQuestion: ${task.question}\n\nPast conversations:\n${messages}`;
}

function words(text) { return String(text).toLowerCase().match(/[\p{Letter}\p{Number}]+/gu) || []; }

/** BM25 提供词面匹配排序；不引入额外依赖。 */
function bm25(query, documents) {
  const tokenized = documents.map(words);
  const queryWords = [...new Set(words(query))];
  const averageLength = tokenized.reduce((total, terms) => total + terms.length, 0) / tokenized.length || 1;
  const documentFrequency = new Map(queryWords.map(term => [term, tokenized.filter(terms => terms.includes(term)).length]));
  return tokenized.map(terms => queryWords.reduce((score, term) => {
    const frequency = terms.filter(value => value === term).length;
    if (!frequency) return score;
    const idf = Math.log(1 + (documents.length - documentFrequency.get(term) + 0.5) / (documentFrequency.get(term) + 0.5));
    return score + idf * (frequency * 2.2) / (frequency + 1.2 * (1 - 0.75 + 0.75 * terms.length / averageLength));
  }, 0));
}

function cosine(left, right) {
  const dot = left.reduce((total, value, index) => total + value * right[index], 0);
  const length = vector => Math.sqrt(vector.reduce((total, value) => total + value * value, 0));
  return dot / (length(left) * length(right) || 1);
}

/** 调用百炼的 OpenAI-compatible /embeddings；v4 每次最多传十段文本。 */
async function embeddings(baseUrl, apiKey, model, input) {
  const output = [];
  for (let start = 0; start < input.length; start += 10) {
    const response = await fetch(`${baseUrl.replace(/\/+$/, '')}/embeddings`, {
      method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, input: input.slice(start, start + 10), encoding_format: 'float' }),
    });
    const body = await response.json();
    if (!response.ok || !Array.isArray(body.data)) fail(`Embedding request failed: ${body.error?.message || response.status}`);
    output.push(...body.data.sort((a, b) => a.index - b.index).map(item => item.embedding));
  }
  return output;
}

/** RRF 合并 BM25 与向量排序，避免两个分数尺度不可直接相加。 */
async function ragPrompt(task, taskDir, opts) {
  const messages = historyMessages(taskDir);
  const documents = messages.map(message => `${message.role}: ${message.content}`);
  const [queryVector, ...documentVectors] = await embeddings(opts['embedding-base-url'], opts['embedding-api-key'], opts['embedding-model'] || 'text-embedding-v4', [task.question, ...documents]);
  const lexical = bm25(task.question, documents);
  const semantic = documentVectors.map(vector => cosine(queryVector, vector));
  const ranks = scores => [...scores.keys()].sort((a, b) => scores[b] - scores[a] || a - b);
  const rrf = new Map();
  for (const ranking of [ranks(lexical), ranks(semantic)]) ranking.forEach((index, rank) => rrf.set(index, (rrf.get(index) || 0) + 1 / (60 + rank + 1)));
  const count = Math.min(messages.length, Math.max(5, Math.ceil(Math.sqrt(messages.length))));
  const selected = [...rrf.keys()].sort((a, b) => rrf.get(b) - rrf.get(a) || a - b).slice(0, count).map(index => documents[index]).join('\n');
  return `Answer this LongMemEval question using the retrieved conversations below.\nQuestion date: ${task.question_date}\nQuestion: ${task.question}\n\nRetrieved conversations:\n${selected}`;
}

async function main() {
  const opts = args(process.argv.slice(2));
  const work = resolve(opts.work);
  const output = resolve(opts.output);
  const command = opts['pi-command'] || 'pi';
  const taskDirs = readdirSync(work).map(name => join(work, name)).filter(path => statSync(path).isDirectory()).sort();
  const rows = [];
  const telemetry = [];

  for (const taskDir of taskDirs) {
    const task = taskInput(taskDir);
    const env = { ...process.env, PI_CODING_AGENT_SESSION_DIR: join(taskDir, 'sessions'), TRAJEX_DIR: join(taskDir, '.trajex') };
    if (opts.arm === 'trajex_active') {
      const build = spawnSync(opts['trajex-command'] || 'trajex', ['--build'], { encoding: 'utf8', env });
      if (build.error || build.status !== 0) fail(`Trajex build failed for ${task.question_id}: ${build.error?.message || build.stderr}`);
    }
    const prompt = opts.arm === 'none' ? nonePrompt(task) : opts.arm === 'full' ? fullPrompt(task, taskDir) : opts.arm === 'rag_raw' ? await ragPrompt(task, taskDir, opts) : activePrompt(task);
    const piArgs = ['--model', opts['pi-model'], '--no-session', '--no-context-files', '--no-extensions', '--no-skills'];
    piArgs.push(...(opts.arm === 'trajex_active' ? ['--tools', 'bash'] : ['--no-tools']), ...(opts.telemetry ? ['--mode', 'json'] : []), '--print', prompt);
    const startedAt = Date.now();
    const result = spawnSync(command, piArgs, { encoding: 'utf8', env, maxBuffer: 32 * 1024 * 1024 });
    if (result.error || result.status !== 0) fail(`Pi failed for ${task.question_id}: ${result.error?.message || result.stderr}`);
    const parsed = opts.telemetry ? assistantResult(result.stdout) : null;
    const hypothesis = parsed?.answer || result.stdout.trim();
    rows.push({ question_id: task.question_id, hypothesis });
    if (opts.telemetry) telemetry.push({ question_id: task.question_id, arm: opts.arm, wall_time_ms: Date.now() - startedAt, usage: parsed?.usage });
    process.stdout.write(`${JSON.stringify({ event: 'task_completed', arm: opts.arm, question_id: task.question_id, completed: rows.length, total: taskDirs.length })}\n`);
  }

  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${rows.map(row => JSON.stringify(row)).join('\n')}\n`);
  if (opts.telemetry) writeFileSync(resolve(opts.telemetry), `${telemetry.map(row => JSON.stringify(row)).join('\n')}\n`);
  process.stdout.write(`${JSON.stringify({ output, completed: rows.length, arm: opts.arm })}\n`);
}

main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
