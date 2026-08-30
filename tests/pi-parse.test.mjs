// Copyright (C) 2026 tommy0103 and contributors.
// Copyright (C) 2026 wutongyuonce and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

import { makeTempDir } from './temp-dirs.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createPiProvider, PI_CANONICAL_TRANSCRIPT_MARKER } from '../packages/core/src/providers/pi.ts';
import { assembleSessionDetail } from '../packages/core/src/session-detail.ts';

function drain(generator) { const records = []; for (let step = generator.next(); !step.done; step = generator.next()) records.push(step.value); return records; }

const SESSION_ID = 'pi:session-1:96f38458f1d537ded0d6d3e46cc3c4f72f5b27817b3eca46e0142a3868e90aee';

test('Pi indexes every tree branch and projects current context through visibility', () => {
  assert.equal(PI_CANONICAL_TRANSCRIPT_MARKER, '__pi_canonical_transcript_v8__');
  const root = makeTempDir('trajex-pi-');
  const dir = join(root, 'sessions', '--tmp-project--');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'session.jsonl');
  const entries = [
    { type: 'session', version: 3, id: 'session-1', timestamp: '2026-07-30T10:00:00.000Z', cwd: '/tmp/project' },
    { type: 'message', id: 'u1', parentId: null, timestamp: '2026-07-30T10:00:01.000Z', message: { role: 'user', content: 'keep prompt' } },
    { type: 'message', id: 'a1', parentId: 'u1', timestamp: '2026-07-30T10:00:02.000Z', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'reason' }, { type: 'toolCall', id: 'call-1', name: 'Read', arguments: { file_path: '/tmp/a' } }] } },
    { type: 'message', id: 'r1', parentId: 'a1', timestamp: '2026-07-30T10:00:03.000Z', message: { role: 'toolResult', toolCallId: 'call-1', toolName: 'Read', content: [{ type: 'text', text: 'file body' }], isError: false } },
    { type: 'compaction', id: 'c1', parentId: 'r1', timestamp: '2026-07-30T10:00:04.000Z', summary: 'earlier work', usage: { input: 10, cacheRead: 3, cacheWrite: 2, output: 4 } },
    { type: 'branch_summary', id: 'b1', parentId: 'c1', timestamp: '2026-07-30T10:00:04.500Z', summary: 'abandoned branch summary', usage: { input: 7, output: 1 } },
    { type: 'session_info', id: 'n1', parentId: 'c1', timestamp: '2026-07-30T10:00:05.000Z', name: 'Pi fixture' },
    { type: 'message', id: 'old', parentId: 'u1', timestamp: '2026-07-30T10:00:06.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'abandoned branch' }] } },
    { type: 'message', id: 'current', parentId: 'n1', timestamp: '2026-07-30T10:00:07.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'kept answer' }], usage: { input: 4, output: 2 } } },
  ];
  writeFileSync(path, entries.map(JSON.stringify).join('\n') + '\n');
  const provider = createPiProvider({ sessionDir: join(root, 'sessions') });
  const unit = provider.discover({ lastCursor: () => null })[0];
  assert.equal(unit.sessionId, SESSION_ID);
  const records = drain(provider.parse(unit, null));
  const messages = records.filter(record => record.kind === 'message');
  assert.deepEqual(messages.map(record => record.text), ['keep prompt', 'reason', null, 'file body', 'abandoned branch', 'kept answer']);
  assert.deepEqual(messages.at(-1).input_tokens, 4);
  assert.deepEqual(messages.at(-1).output_tokens, 2);
  assert.equal(messages.find(record => record.text === 'abandoned branch').visibility, 'inactive');
  assert.equal(messages.find(record => record.text === 'kept answer').visibility, 'visible');
  assert.deepEqual(records.filter(record => record.kind === 'tool_call').map(record => record.id), [`${SESSION_ID}:a1:1:tool`]);
  assert.deepEqual(records.filter(record => record.kind === 'tool_result').map(record => record.tool_use_id), [`${SESSION_ID}:a1:1:tool`]);
  assert.deepEqual(records.filter(record => record.kind === 'summary').map(record => ({ source: record.source, content: record.content, visibility: record.visibility, input_tokens: record.input_tokens, output_tokens: record.output_tokens })), [
    { source: 'compaction', content: 'earlier work', visibility: 'visible', input_tokens: 15, output_tokens: 4 },
    { source: 'branch_summary', content: 'abandoned branch summary', visibility: 'inactive', input_tokens: 7, output_tokens: 1 },
  ]);
  assert.deepEqual(records.find(record => record.kind === 'session' && record.id === SESSION_ID), { kind: 'session', id: SESSION_ID, title: 'Pi fixture', project: '-tmp-project', started_at: '2026-07-30T10:00:00.000Z', ended_at: '2026-07-30T10:00:07.000Z', git_branch: null, version: '3', message_count: 1, countMode: 'total', jsonl_path: path, source: 'pi' });
});

test('Pi keeps a small head-tail message preview and a bounded head-tail tool result', () => {
  const root = makeTempDir('trajex-pi-tool-result-');
  const dir = join(root, 'sessions');
  const path = join(dir, 'session.jsonl');
  const output = `${'head '.repeat(3000)}middle ${'tail '.repeat(3000)}`;
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, [
    { type: 'session', version: 3, id: 'long-result', timestamp: '2026-07-30T10:00:00.000Z', cwd: '/tmp/project' },
    { type: 'message', id: 'a1', parentId: null, timestamp: '2026-07-30T10:00:01.000Z', message: { role: 'assistant', content: [{ type: 'toolCall', id: 'call-1', name: 'read', arguments: { path: 'large.txt' } }] } },
    { type: 'message', id: 'r1', parentId: 'a1', timestamp: '2026-07-30T10:00:02.000Z', message: { role: 'toolResult', toolCallId: 'call-1', content: [{ type: 'text', text: output }] } },
  ].map(JSON.stringify).join('\n') + '\n');

  const provider = createPiProvider({ sessionDir: dir });
  const records = drain(provider.parse(provider.discover({ lastCursor: () => null })[0], null));
  const message = records.find(record => record.kind === 'message' && record.content_type === 'tool_result');
  const result = records.find(record => record.kind === 'tool_result');

  assert.ok(message.text.length <= 1000);
  assert.match(message.text, /^\[tool result: 30007 chars; showing head and tail\]/);
  assert.match(message.text, /tail tail tail $/);
  assert.equal(result.content.length, 10000);
  assert.match(result.content, /\.\.\.\[truncated middle\]\.\.\./);
  assert.match(result.content, /tail tail tail $/);
});

test('Pi discovers standard top-level v3 sessions and ignores a torn final line', () => {
  const root = makeTempDir('trajex-pi-discover-');
  const projectDir = join(root, 'sessions', '--tmp-project--');
  const path = join(projectDir, 'fixture.jsonl');
  mkdirSync(join(projectDir, 'nested', 'subagents'), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ type: 'session', version: 3, id: 'top-level', cwd: '/tmp/project' })}\n`);
  writeFileSync(join(projectDir, 'nested', 'subagents', 'ignored.jsonl'), `${JSON.stringify({ type: 'session', version: 3, id: 'nested' })}\n`);
  appendFileSync(path, '{"type":"message"');

  const provider = createPiProvider({ sessionDir: join(root, 'sessions') });
  const [unit] = provider.discover({ lastCursor: () => null });
  assert.equal(unit.key, path);
  const stats = statSync(path);
  const cursor = `${stats.mtimeMs}:1:${stats.size}:${stats.ctimeMs}:${stats.ino}`;
  assert.equal(provider.discover({ lastCursor: () => cursor, changedPaths: [path] }).length, 0);
  assert.equal(provider.discover({ lastCursor: () => `${stats.mtimeMs}:1`, changedPaths: [path] }).length, 1, 'legacy cursors replay once');
  assert.equal(drain(provider.parse(unit, null)).filter(record => record.kind === 'session').length, 1);
});

test('Pi discovery notices a same-mtime rewrite', () => {
  const root = makeTempDir('trajex-pi-snapshot-');
  const dir = join(root, 'sessions');
  const path = join(dir, 'session.jsonl');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, [
    { type: 'session', version: 3, id: 'same-mtime', cwd: '/tmp/project' },
    { type: 'message', id: 'm1', parentId: null, message: { role: 'user', content: 'one' } },
  ].map(JSON.stringify).join('\n') + '\n');
  const provider = createPiProvider({ sessionDir: dir });
  const [unit] = provider.discover({ lastCursor: () => null });
  const parsed = provider.parse(unit, null);
  let step = parsed.next();
  while (!step.done) step = parsed.next();
  const cursor = step.value;
  const before = statSync(path);

  writeFileSync(path, [
    { type: 'session', version: 3, id: 'same-mtime', cwd: '/tmp/project' },
    { type: 'message', id: 'm1', parentId: null, message: { role: 'user', content: 'two' } },
  ].map(JSON.stringify).join('\n') + '\n');
  utimesSync(path, before.atime, before.mtime);

  assert.deepEqual(provider.discover({ lastCursor: () => cursor }).map(found => found.key), [path]);
});

test('Pi discovery retracts a prior identity when a session file is reused', () => {
  const root = makeTempDir('trajex-pi-retract-');
  const dir = join(root, 'sessions', '--tmp-project--');
  const path = join(dir, 'fixture.jsonl');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, `${JSON.stringify({ type: 'session', version: 3, id: 'old-identity', cwd: '/tmp/project' })}\n`);

  const provider = createPiProvider({ sessionDir: join(root, 'sessions') });
  const oldUnit = provider.discover({ lastCursor: () => null })[0];
  writeFileSync(path, `${JSON.stringify({ type: 'session', version: 3, id: 'new-identity', cwd: '/tmp/project' })}\n`);

  const [replacement] = provider.discover({
    lastCursor: () => null,
    changedPaths: [path],
    indexedSessions: () => [{ sessionId: oldUnit.sessionId, jsonlPath: path, source: 'pi' }],
  });

  assert.equal(replacement.sessionId, oldUnit.sessionId.replace('old-identity', 'new-identity'));
  assert.deepEqual(replacement.retractSessionIds, [oldUnit.sessionId]);
});

test('Pi stops at a malformed line and returns the valid prefix', () => {
  const root = makeTempDir('trajex-pi-malformed-');
  const dir = join(root, 'sessions', '--project--');
  const path = join(dir, 'fixture.jsonl');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, [
    JSON.stringify({ type: 'session', version: 3, id: 'malformed' }),
    JSON.stringify({ type: 'message', id: 'before', parentId: null, message: { role: 'user', content: 'must index' } }),
    '{bad json}',
    JSON.stringify({ type: 'message', id: 'after', parentId: null, message: { role: 'user', content: 'must not index' } }),
  ].join('\n') + '\n');

  const provider = createPiProvider({ sessionDir: join(root, 'sessions') });
  const unit = provider.discover({ lastCursor: () => null })[0];
  const generator = provider.parse(unit, null);
  const records = [];
  let step = generator.next();
  while (!step.done) { records.push(step.value); step = generator.next(); }
  assert.deepEqual(records.filter(record => record.kind === 'message').map(record => record.text), ['must index']);
  assert.equal(step.value.split(':')[1], '2');
});

test('Pi treats a cyclic model parent chain as an unknown model', () => {
  const root = makeTempDir('trajex-pi-model-cycle-');
  const dir = join(root, 'sessions', '--project--');
  const path = join(dir, 'fixture.jsonl');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, [
    JSON.stringify({ type: 'session', version: 3, id: 'model-cycle' }),
    JSON.stringify({ type: 'message', id: 'a', parentId: 'b', message: { role: 'user', content: 'first' } }),
    JSON.stringify({ type: 'message', id: 'b', parentId: 'a', message: { role: 'user', content: 'second' } }),
  ].join('\n') + '\n');

  const provider = createPiProvider({ sessionDir: join(root, 'sessions') });
  const unit = provider.discover({ lastCursor: () => null })[0];
  const messages = drain(provider.parse(unit, null)).filter(record => record.kind === 'message');
  assert.deepEqual(messages.map(record => record.model), [null, null]);
});

test('Pi durable leaf selects the target branch instead of the last physical entry', () => {
  const root = makeTempDir('trajex-pi-leaf-');
  const dir = join(root, 'sessions', '--project--');
  const path = join(dir, 'fixture.jsonl');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, [
    { type: 'session', version: 3, id: 'leaf-session', cwd: '/tmp/project' },
    { type: 'message', id: 'root', parentId: null, message: { role: 'user', content: 'root' } },
    { type: 'message', id: 'active', parentId: 'root', message: { role: 'assistant', content: [{ type: 'text', text: 'active answer' }] } },
    { type: 'message', id: 'abandoned', parentId: 'root', message: { role: 'assistant', content: [{ type: 'text', text: 'abandoned answer' }] } },
    { type: 'leaf', id: 'leaf', parentId: 'abandoned', targetId: 'active' },
  ].map(JSON.stringify).join('\n') + '\n');

  const provider = createPiProvider({ sessionDir: join(root, 'sessions') });
  const unit = provider.discover({ lastCursor: () => null })[0];
  const messages = drain(provider.parse(unit, null)).filter(record => record.kind === 'message');
  assert.equal(messages.find(record => record.text === 'active answer').visibility, 'visible');
  assert.equal(messages.find(record => record.text === 'abandoned answer').visibility, 'inactive');
});

test('Pi active compaction projects retainedTail and keeps compacted ancestors inactive', () => {
  const root = makeTempDir('trajex-pi-retained-tail-');
  const dir = join(root, 'sessions', '--project--');
  const path = join(dir, 'fixture.jsonl');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, [
    { type: 'session', version: 3, id: 'tail-session', cwd: '/tmp/project' },
    { type: 'message', id: 'old', parentId: null, message: { role: 'user', content: 'old context' } },
    { type: 'message', id: 'old-answer', parentId: 'old', message: { role: 'assistant', content: [{ type: 'text', text: 'old answer' }] } },
    { type: 'compaction', id: 'compact', parentId: 'old-answer', summary: 'compacted context', retainedTail: [
      { role: 'user', content: 'retained user' },
      { role: 'assistant', content: [{ type: 'text', text: 'retained answer' }] },
    ] },
    { type: 'message', id: 'after', parentId: 'compact', message: { role: 'user', content: 'after compaction' } },
    { type: 'leaf', id: 'leaf', parentId: 'after', targetId: 'after' },
  ].map(JSON.stringify).join('\n') + '\n');

  const provider = createPiProvider({ sessionDir: join(root, 'sessions') });
  const unit = provider.discover({ lastCursor: () => null })[0];
  const messages = drain(provider.parse(unit, null)).filter(record => record.kind === 'message');
  assert.deepEqual(messages.map(record => record.text), [
    'old context',
    'old answer',
    'retained user',
    'retained answer',
    'after compaction',
  ]);
  assert.deepEqual(
    messages.filter(record => record.visibility === 'visible').map(record => record.text),
    ['retained user', 'retained answer', 'after compaction'],
  );
  assert.deepEqual(
    messages.filter(record => record.visibility === 'inactive').map(record => record.text),
    ['old context', 'old answer'],
  );
});

test('Pi legacy compaction keeps the firstKeptEntryId boundary', () => {
  const root = makeTempDir('trajex-pi-first-kept-');
  const dir = join(root, 'sessions', '--project--');
  const path = join(dir, 'fixture.jsonl');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, [
    { type: 'session', version: 3, id: 'first-kept-session', cwd: '/tmp/project' },
    { type: 'message', id: 'old', parentId: null, message: { role: 'user', content: 'discarded context' } },
    { type: 'message', id: 'kept', parentId: 'old', message: { role: 'assistant', content: [{ type: 'text', text: 'kept context' }] } },
    { type: 'compaction', id: 'compact', parentId: 'kept', firstKeptEntryId: 'kept', summary: 'compacted context' },
    { type: 'message', id: 'after', parentId: 'compact', message: { role: 'user', content: 'after compaction' } },
    { type: 'leaf', id: 'leaf', parentId: 'after', targetId: 'after' },
  ].map(JSON.stringify).join('\n') + '\n');

  const provider = createPiProvider({ sessionDir: join(root, 'sessions') });
  const unit = provider.discover({ lastCursor: () => null })[0];
  const messages = drain(provider.parse(unit, null)).filter(record => record.kind === 'message');
  assert.deepEqual(messages.map(record => record.text), ['discarded context', 'kept context', 'after compaction']);
  assert.deepEqual(
    messages.filter(record => record.visibility === 'visible').map(record => record.text),
    ['kept context', 'after compaction'],
  );
  assert.deepEqual(
    messages.filter(record => record.visibility === 'inactive').map(record => record.text),
    ['discarded context'],
  );
});

test('Pi retainedTail checkpoint bounds a later legacy compaction', () => {
  const root = makeTempDir('trajex-pi-checkpoint-chain-');
  const dir = join(root, 'sessions', '--project--');
  const path = join(dir, 'fixture.jsonl');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, [
    { type: 'session', version: 3, id: 'checkpoint-chain', cwd: '/tmp/project' },
    { type: 'message', id: 'root', parentId: null, message: { role: 'user', content: 'discarded root' } },
    { type: 'compaction', id: 'checkpoint', parentId: 'root', summary: 'checkpoint summary', firstKeptEntryId: 'root', retainedTail: [
      { role: 'user', content: 'checkpoint tail' },
    ] },
    { type: 'message', id: 'after-checkpoint', parentId: 'checkpoint', message: { role: 'user', content: 'discarded after checkpoint' } },
    { type: 'compaction', id: 'later-legacy', parentId: 'after-checkpoint', summary: 'later legacy summary', firstKeptEntryId: 'root' },
    { type: 'message', id: 'head', parentId: 'later-legacy', message: { role: 'user', content: 'active head' } },
  ].map(JSON.stringify).join('\n') + '\n');

  const provider = createPiProvider({ sessionDir: join(root, 'sessions') });
  const unit = provider.discover({ lastCursor: () => null })[0];
  const records = drain(provider.parse(unit, null));
  assert.deepEqual(
    records.filter(record => record.kind === 'message' && record.visibility === 'visible').map(record => record.text),
    ['active head'],
  );
  assert.deepEqual(
    records.filter(record => record.kind === 'summary' && record.visibility === 'visible').map(record => record.content),
    ['later legacy summary'],
  );
  const detail = assembleSessionDetail(records);
  assert.deepEqual(
    detail.messages.filter(message => message.visibility === 'visible').map(message => message.text),
    ['active head'],
  );
  assert.deepEqual(
    detail.messages.filter(message => message.visibility === 'inactive').map(message => message.text).sort(),
    ['discarded after checkpoint', 'discarded root'],
  );
});

test('Pi later legacy compaction can retain context across an earlier compaction', () => {
  const root = makeTempDir('trajex-pi-nested-legacy-');
  const dir = join(root, 'sessions');
  const path = join(dir, 'fixture.jsonl');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, [
    { type: 'session', version: 3, id: 'nested-legacy', cwd: '/tmp/project' },
    { type: 'message', id: 'root', parentId: null, message: { role: 'user', content: 'root' } },
    { type: 'message', id: 'near-first', parentId: 'root', message: { role: 'user', content: 'near first' } },
    { type: 'compaction', id: 'first', parentId: 'near-first', summary: 'first summary', firstKeptEntryId: 'near-first' },
    { type: 'message', id: 'after-first', parentId: 'first', message: { role: 'user', content: 'after first' } },
    { type: 'compaction', id: 'second', parentId: 'after-first', summary: 'second summary', firstKeptEntryId: 'root' },
    { type: 'message', id: 'after-second', parentId: 'second', message: { role: 'user', content: 'after second' } },
  ].map(JSON.stringify).join('\n') + '\n');

  const provider = createPiProvider({ sessionDir: dir });
  const records = drain(provider.parse(provider.discover({ lastCursor: () => null })[0], null));
  assert.deepEqual(
    records.filter(record => record.kind === 'message' && record.visibility === 'visible').map(record => record.text),
    ['root', 'near first', 'after first', 'after second'],
  );
  assert.deepEqual(
    records.filter(record => record.kind === 'summary' && record.visibility === 'visible').map(record => record.content),
    ['first summary', 'second summary'],
  );
});

test('Pi checkpoint fork materializes retainedTail once and reconnects later messages', () => {
  const root = makeTempDir('trajex-pi-checkpoint-fork-');
  const dir = join(root, 'sessions');
  const path = join(dir, 'fixture.jsonl');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, [
    { type: 'session', version: 3, id: 'checkpoint-fork', cwd: '/tmp/project' },
    { type: 'compaction', id: 'checkpoint', parentId: 'omitted-parent', summary: 'checkpoint summary', retainedTail: [
      { role: 'user', content: 'retained user' },
      { role: 'assistant', content: [{ type: 'text', text: 'retained answer' }] },
    ] },
    { type: 'message', id: 'after', parentId: 'checkpoint', message: { role: 'user', content: 'after checkpoint' } },
  ].map(JSON.stringify).join('\n') + '\n');

  const provider = createPiProvider({ sessionDir: dir });
  const records = drain(provider.parse(provider.discover({ lastCursor: () => null })[0], null));
  const messages = records.filter(record => record.kind === 'message');
  assert.deepEqual(messages.map(record => record.text), [
    'retained user',
    'retained answer',
    'after checkpoint',
  ]);
  assert.equal(messages[2].parent_uuid, messages[1].uuid);
  assert.equal(records.filter(record => record.kind === 'summary').length, 1);
});

test('Pi keeps reused native tool ids branch-local', () => {
  const root = makeTempDir('trajex-pi-branch-tools-');
  const dir = join(root, 'sessions');
  const path = join(dir, 'fixture.jsonl');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, [
    { type: 'session', version: 3, id: 'branch-tools', cwd: '/tmp/project' },
    { type: 'message', id: 'root', parentId: null, message: { role: 'user', content: 'inspect both branches' } },
    { type: 'message', id: 'active-call', parentId: 'root', message: { role: 'assistant', content: [
      { type: 'toolCall', id: 'reused-call', name: 'read', arguments: { path: 'active.txt' } },
    ] } },
    { type: 'message', id: 'active-result', parentId: 'active-call', message: {
      role: 'toolResult', toolCallId: 'reused-call', content: [{ type: 'text', text: 'active result' }],
    } },
    { type: 'message', id: 'abandoned-call', parentId: 'root', message: { role: 'assistant', content: [
      { type: 'toolCall', id: 'reused-call', name: 'read', arguments: { path: 'abandoned.txt' } },
    ] } },
    { type: 'message', id: 'abandoned-result', parentId: 'abandoned-call', message: {
      role: 'toolResult', toolCallId: 'reused-call', content: [{ type: 'text', text: 'abandoned result' }],
    } },
    { type: 'leaf', id: 'active-leaf', parentId: 'abandoned-result', targetId: 'active-result' },
  ].map(JSON.stringify).join('\n') + '\n');

  const provider = createPiProvider({ sessionDir: dir });
  const records = drain(provider.parse(provider.discover({ lastCursor: () => null })[0], null));
  const calls = records.filter(record => record.kind === 'tool_call');
  const results = records.filter(record => record.kind === 'tool_result');
  assert.equal(new Set(calls.map(call => call.id)).size, 2);
  assert.deepEqual(
    calls.map(call => [JSON.parse(call.input_json).path, results.find(result => result.tool_use_id === call.id)?.content]).sort(),
    [['abandoned.txt', 'abandoned result'], ['active.txt', 'active result']],
  );

  const detailCalls = assembleSessionDetail(records).messages.flatMap(message => message.tool_calls ?? []);
  assert.deepEqual(
    detailCalls.map(call => [JSON.parse(call.input_json).path, call.result?.content]).sort(),
    [['abandoned.txt', 'abandoned result'], ['active.txt', 'active result']],
  );
});

test('Pi checkpoint clears discarded tool scope before a later result', () => {
  const root = makeTempDir('trajex-pi-checkpoint-tools-');
  const dir = join(root, 'sessions');
  const path = join(dir, 'fixture.jsonl');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, [
    { type: 'session', version: 3, id: 'checkpoint-tools', cwd: '/tmp/project' },
    { type: 'message', id: 'discarded-call', parentId: null, message: { role: 'assistant', content: [
      { type: 'toolCall', id: 'discarded-native-id', name: 'read', arguments: { path: 'discarded.txt' } },
    ] } },
    { type: 'compaction', id: 'checkpoint', parentId: 'discarded-call', summary: 'clear old context', retainedTail: [] },
    { type: 'message', id: 'unresolved-result', parentId: 'checkpoint', message: {
      role: 'toolResult', toolCallId: 'discarded-native-id', content: [{ type: 'text', text: 'standalone result' }],
    } },
    { type: 'message', id: 'active-head', parentId: 'checkpoint', message: { role: 'user', content: 'current branch' } },
  ].map(JSON.stringify).join('\n') + '\n');

  const provider = createPiProvider({ sessionDir: dir });
  const records = drain(provider.parse(provider.discover({ lastCursor: () => null })[0], null));
  assert.equal(records.filter(record => record.kind === 'tool_result').length, 0);
  assert.equal(
    records.find(record => record.kind === 'message' && record.text === 'standalone result').visibility,
    'inactive',
  );
});
