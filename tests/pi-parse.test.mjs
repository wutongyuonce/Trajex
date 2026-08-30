// Copyright (C) 2026 tommy0103 and contributors.
// Copyright (C) 2026 wutongyuonce and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

import { makeTempDir } from './temp-dirs.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createPiProvider, PI_CANONICAL_TRANSCRIPT_MARKER } from '../packages/core/src/providers/pi.ts';

function drain(generator) { const records = []; for (let step = generator.next(); !step.done; step = generator.next()) records.push(step.value); return records; }

const SESSION_ID = 'pi:session-1:96f38458f1d537ded0d6d3e46cc3c4f72f5b27817b3eca46e0142a3868e90aee';

test('Pi indexes every tree branch and projects current context through visibility', () => {
  assert.equal(PI_CANONICAL_TRANSCRIPT_MARKER, '__pi_canonical_transcript_v6__');
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
  assert.deepEqual(records.filter(record => record.kind === 'tool_call').map(record => record.id), [`${SESSION_ID}:call-1`]);
  assert.deepEqual(records.filter(record => record.kind === 'tool_result').map(record => record.tool_use_id), [`${SESSION_ID}:call-1`]);
  assert.deepEqual(records.filter(record => record.kind === 'summary').map(record => ({ source: record.source, content: record.content, visibility: record.visibility, input_tokens: record.input_tokens, output_tokens: record.output_tokens })), [
    { source: 'compaction', content: 'earlier work', visibility: 'visible', input_tokens: 15, output_tokens: 4 },
    { source: 'branch_summary', content: 'abandoned branch summary', visibility: 'inactive', input_tokens: 7, output_tokens: 1 },
  ]);
  assert.deepEqual(records.find(record => record.kind === 'session' && record.id === SESSION_ID), { kind: 'session', id: SESSION_ID, title: 'Pi fixture', project: '-tmp-project', started_at: '2026-07-30T10:00:00.000Z', ended_at: '2026-07-30T10:00:07.000Z', git_branch: null, version: '3', message_count: 5, countMode: 'total', jsonl_path: path, source: 'pi' });
});

test('Pi keeps a small head-tail message preview and a bounded head-tail tool result', () => {
  const root = makeTempDir('trajex-pi-tool-result-');
  const dir = join(root, 'sessions');
  const path = join(dir, 'session.jsonl');
  const output = `${'head '.repeat(3000)}middle ${'tail '.repeat(3000)}`;
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, [
    { type: 'session', version: 3, id: 'long-result', timestamp: '2026-07-30T10:00:00.000Z', cwd: '/tmp/project' },
    { type: 'message', id: 'r1', parentId: null, timestamp: '2026-07-30T10:00:01.000Z', message: { role: 'toolResult', toolCallId: 'call-1', content: [{ type: 'text', text: output }] } },
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

test('Pi active compaction projects retainedTail messages and discards compacted ancestors', () => {
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
  assert.deepEqual(messages.map(record => record.text), ['retained user', 'retained answer', 'after compaction']);
  assert.equal(messages.every(record => record.visibility === 'visible'), true);
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
  assert.deepEqual(messages.map(record => record.text), ['kept context', 'after compaction']);
  assert.equal(messages[0].parent_uuid, null);
});
