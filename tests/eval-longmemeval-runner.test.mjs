import { makeTempDir } from './temp-dirs.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';

const RUNNER = fileURLToPath(new URL('../eval/longmemeval/run-longmemeval.mjs', import.meta.url));

test('LongMemEval runner calls Pi without history for the none arm and writes hypotheses JSONL', () => {
  const dir = makeTempDir('trajex-eval-runner-');
  const work = join(dir, 'work');
  const task = join(work, 'question-1');
  const output = join(dir, 'runs', 'none.jsonl');
  const promptLog = join(dir, 'prompt.txt');
  const pi = join(dir, 'fake-pi.mjs');
  mkdirSync(task, { recursive: true });
  writeFileSync(join(task, 'agent-input.json'), JSON.stringify({ question_id: 'question-1', question: 'What is the answer?', question_date: '2026-01-01', question_type: 'single-session-user' }));
  writeFileSync(pi, `#!/usr/bin/env node\nimport { writeFileSync } from 'node:fs';\nwriteFileSync(process.env.PROMPT_LOG, process.argv.at(-1));\nprocess.stdout.write('The answer is 42\\n');\n`);
  chmodSync(pi, 0o755);

  const result = spawnSync(process.execPath, [RUNNER, '--work', work, '--arm', 'none', '--output', output, '--pi-command', pi, '--pi-model', 'test-model'], {
    encoding: 'utf8', env: { ...process.env, PROMPT_LOG: promptLog },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(readFileSync(output, 'utf8').trim().split('\n').map(JSON.parse), [{ question_id: 'question-1', hypothesis: 'The answer is 42' }]);
  assert.match(readFileSync(promptLog, 'utf8'), /What is the answer\?/);
  assert.doesNotMatch(readFileSync(promptLog, 'utf8'), /history|session/i);
});

test('LongMemEval runner gives Pi every converted message for the full arm', () => {
  const dir = makeTempDir('trajex-eval-full-');
  const work = join(dir, 'work');
  const task = join(work, 'question-2');
  const output = join(dir, 'runs', 'full.jsonl');
  const promptLog = join(dir, 'prompt.txt');
  const pi = join(dir, 'fake-pi.mjs');
  mkdirSync(join(task, 'sessions'), { recursive: true });
  writeFileSync(join(task, 'agent-input.json'), JSON.stringify({ question_id: 'question-2', question: 'What did I buy?', question_date: '2026-01-01', question_type: 'single-session-user' }));
  writeFileSync(join(task, 'sessions', 'old.jsonl'), [
    { type: 'session', version: 3, id: 'old', timestamp: '2025-01-01T00:00:00.000Z' },
    { type: 'message', id: 'one', parentId: null, message: { role: 'user', content: 'I bought a red bicycle.' } },
    { type: 'message', id: 'two', parentId: 'one', message: { role: 'assistant', content: 'Great choice.' } },
  ].map(JSON.stringify).join('\n'));
  writeFileSync(pi, `#!/usr/bin/env node\nimport { writeFileSync } from 'node:fs';\nwriteFileSync(process.env.PROMPT_LOG, process.argv.at(-1));\nprocess.stdout.write('A red bicycle\\n');\n`);
  chmodSync(pi, 0o755);

  const result = spawnSync(process.execPath, [RUNNER, '--work', work, '--arm', 'full', '--output', output, '--pi-command', pi, '--pi-model', 'test-model'], {
    encoding: 'utf8', env: { ...process.env, PROMPT_LOG: promptLog },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(readFileSync(promptLog, 'utf8'), /I bought a red bicycle\./);
  assert.match(readFileSync(promptLog, 'utf8'), /Great choice\./);
  assert.deepEqual(readFileSync(output, 'utf8').trim().split('\n').map(JSON.parse), [{ question_id: 'question-2', hypothesis: 'A red bicycle' }]);
});

test('LongMemEval runner uses hybrid retrieval and dynamically injects sqrt(message count) entries', async () => {
  const dir = makeTempDir('trajex-eval-rag-');
  const work = join(dir, 'work');
  const task = join(work, 'question-3');
  const output = join(dir, 'runs', 'rag.jsonl');
  const promptLog = join(dir, 'prompt.txt');
  const pi = join(dir, 'fake-pi.mjs');
  mkdirSync(join(task, 'sessions'), { recursive: true });
  writeFileSync(join(task, 'agent-input.json'), JSON.stringify({ question_id: 'question-3', question: 'Which bicycle did I buy?', question_date: '2026-01-01', question_type: 'single-session-user' }));
  const messages = Array.from({ length: 36 }, (_, index) => ({ type: 'message', id: `m${index}`, parentId: index ? `m${index - 1}` : null, message: { role: 'user', content: index === 17 ? 'I bought a red bicycle.' : `Unrelated note ${index}.` } }));
  writeFileSync(join(task, 'sessions', 'history.jsonl'), [{ type: 'session', version: 3, id: 'history', timestamp: '2025-01-01T00:00:00.000Z' }, ...messages].map(JSON.stringify).join('\n'));
  writeFileSync(pi, `#!/usr/bin/env node\nimport { writeFileSync } from 'node:fs';\nwriteFileSync(process.env.PROMPT_LOG, process.argv.at(-1));\nprocess.stdout.write('A red bicycle\\n');\n`);
  chmodSync(pi, 0o755);
  let embeddingModel = '';
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      const requestBody = JSON.parse(body); const input = requestBody.input; embeddingModel = requestBody.model;
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ data: input.map((text, index) => ({ index, embedding: /bicycle|buy/i.test(text) ? [1, 0] : [0, 1] })) }));
    });
  });
  await new Promise(resolve => server.listen(0, resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const result = await new Promise(resolve => {
    const child = spawn(process.execPath, [RUNNER, '--work', work, '--arm', 'rag_raw', '--output', output, '--pi-command', pi, '--pi-model', 'test-model', '--embedding-api-key', 'test-key', '--embedding-base-url', baseUrl, '--embedding-model', 'text-embedding-3-small'], { env: { ...process.env, PROMPT_LOG: promptLog }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('close', status => resolve({ status, stdout, stderr }));
  });
  await new Promise(resolve => server.close(resolve));

  assert.equal(result.status, 0, result.stderr);
  assert.equal(embeddingModel, 'text-embedding-3-small');
  const prompt = readFileSync(promptLog, 'utf8');
  assert.match(prompt, /I bought a red bicycle\./);
  assert.equal((prompt.match(/^user: /gm) || []).length, 6);
});

test('LongMemEval runner builds an isolated Trajex index before the active arm', () => {
  const dir = makeTempDir('trajex-eval-active-');
  const work = join(dir, 'work'); const task = join(work, 'question-4'); const output = join(dir, 'active.jsonl');
  const pi = join(dir, 'pi.mjs'); const trajex = join(dir, 'trajex.mjs'); const buildLog = join(dir, 'build.json');
  mkdirSync(join(task, 'sessions'), { recursive: true });
  writeFileSync(join(task, 'agent-input.json'), JSON.stringify({ question_id: 'question-4', question: 'Find my purchase.', question_date: '2026-01-01' }));
  writeFileSync(pi, `#!/usr/bin/env node\nprocess.stdout.write('Found it\\n');\n`);
  writeFileSync(trajex, `#!/usr/bin/env node\nimport { writeFileSync } from 'node:fs';\nwriteFileSync(process.env.BUILD_LOG, JSON.stringify({ args: process.argv.slice(2), sessions: process.env.PI_CODING_AGENT_SESSION_DIR, db: process.env.TRAJEX_DIR }));\n`);
  chmodSync(pi, 0o755); chmodSync(trajex, 0o755);
  const result = spawnSync(process.execPath, [RUNNER, '--work', work, '--arm', 'trajex_active', '--output', output, '--pi-command', pi, '--pi-model', 'test-model', '--trajex-command', trajex], { encoding: 'utf8', env: { ...process.env, BUILD_LOG: buildLog } });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(readFileSync(buildLog, 'utf8')).args, ['--build']);
  assert.deepEqual(readFileSync(output, 'utf8').trim().split('\n').map(JSON.parse), [{ question_id: 'question-4', hypothesis: 'Found it' }]);
});
