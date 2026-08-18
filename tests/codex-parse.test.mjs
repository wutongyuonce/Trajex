// Copyright (C) 2026 tommy0103 and contributors.
// Copyright (C) 2026 wutongyuonce and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

import { makeTempDir } from './temp-dirs.mjs';
// Phase 5c-2 golden test: pins the codex adapter's parse() record stream.
// Binding-independent (no database). Covers the event_msg↔response_item dedup,
// tool call/result, token patching, turn-duration, the 'total' session count,
// root-thread replacement and child/guardian filtering.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { createCodexProvider, parse } from '../packages/core/src/providers/codex.ts';

function writeFixture(lines) {
  const dir = makeTempDir('trajex-codex-parse-');
  const path = join(dir, 'rollout.jsonl');
  writeFileSync(path, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
  return path;
}

function drain(gen) {
  const values = [];
  let step = gen.next();
  while (!step.done) { values.push(step.value); step = gen.next(); }
  return { values, ret: step.value };
}

const META = { id: '019e8951-3e7d-7343-a3e3-05bff48a317d', cwd: '/proj', git: { branch: 'main' }, cli_version: '1.2', timestamp: '2026-06-10T10:00:00Z' };

test('codex parse() yields a deduped, tool-aware record stream with a total session', () => {
  const path = writeFixture([
    { type: 'session_meta', timestamp: '2026-06-10T10:00:00Z', payload: META },
    { type: 'event_msg', timestamp: '2026-06-10T10:00:01Z', payload: { type: 'user_message', message: 'hello codex' } },
    { type: 'event_msg', timestamp: '2026-06-10T10:00:02Z', payload: { type: 'agent_message', message: 'hi there' } },
    // Duplicate of the agent_message above — must be deduped (dropped).
    { type: 'response_item', timestamp: '2026-06-10T10:00:02Z', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hi there' }] } },
    { type: 'response_item', timestamp: '2026-06-10T10:00:03Z', payload: { type: 'function_call', call_id: 'call_1', name: 'shell', arguments: '{"cmd":"ls"}' } },
    { type: 'response_item', timestamp: '2026-06-10T10:00:04Z', payload: { type: 'function_call_output', call_id: 'call_1', output: 'file listing' } },
    { type: 'event_msg', timestamp: '2026-06-10T10:00:04.500Z', payload: { type: 'context_compacted' } },
    { type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 100, output_tokens: 50 } } } },
    { type: 'event_msg', timestamp: '2026-06-10T10:00:05Z', payload: { type: 'task_complete', duration_ms: 1500 } },
  ]);

  const { values } = drain(parse({ key: path, sessionId: '' }, null));
  const byKind = k => values.filter(r => r.kind === k);

  assert.equal(values[0].kind, 'delete-session', 'root full replay starts by clearing its old projection');
  assert.equal(values[0].sessionId, `codex:${META.id}`);

  // Four messages: user, assistant text, assistant tool_use, tool result user.
  // The duplicate
  // response_item 'hi there' was deduped.
  const msgs = byKind('message');
  assert.equal(msgs.length, 4);
  assert.equal(msgs.filter(m => m.text === 'hi there').length, 1, 'agent_message deduped against response_item');
  assert.equal(msgs.every(m => m.source === 'codex'), true);

  // token_count patched the last text-assistant message's tokens.
  const textAssistant = msgs.find(m => m.role === 'assistant' && m.content_type === 'text');
  assert.equal(textAssistant.input_tokens, 100);
  assert.equal(textAssistant.output_tokens, 50);

  // Tool call + result.
  assert.deepEqual(byKind('tool_call').map(t => ({ id: t.id, name: t.name })), [{ id: `codex:${META.id}:call_1`, name: 'shell' }]);
  assert.equal(byKind('tool_result').length, 1);
  assert.equal(byKind('tool_result')[0].tool_use_id, `codex:${META.id}:call_1`);
  const toolResultMessage = msgs.find(m => m.content_type === 'tool_result');
  assert.equal(toolResultMessage.role, 'user');
  assert.equal(toolResultMessage.text, 'file listing');
  assert.equal(byKind('tool_result')[0].message_uuid, toolResultMessage.uuid);

  assert.deepEqual(byKind('summary').map(s => ({ source: s.source, content: s.content })), [{ source: 'codex', content: '已 compact' }]);

  // task_complete → turn duration on the text-assistant message.
  assert.deepEqual(byKind('message-turn-duration').map(d => d.turn_duration_ms), [1500]);

  // One session record, full-reparse semantics.
  const sessions = byKind('session');
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].source, 'codex');
  assert.equal(sessions[0].countMode, 'total');
  assert.equal(sessions[0].message_count, 4);
  assert.equal(sessions[0].git_branch, 'main');
});

test('codex keeps a small head-tail message preview and a bounded head-tail tool result', () => {
  const output = `${'head '.repeat(3000)}middle ${'tail '.repeat(3000)}`;
  const path = writeFixture([
    { type: 'session_meta', timestamp: '2026-06-10T10:00:00Z', payload: META },
    { type: 'response_item', timestamp: '2026-06-10T10:00:01Z', payload: { type: 'function_call_output', call_id: 'call_1', output } },
  ]);

  const { values } = drain(parse({ key: path, sessionId: '' }, null));
  const message = values.find(record => record.kind === 'message' && record.content_type === 'tool_result');
  const result = values.find(record => record.kind === 'tool_result');

  assert.ok(message.text.length <= 1000);
  assert.match(message.text, /^\[tool result: 30007 chars; showing head and tail\]/);
  assert.match(message.text, /head head head/);
  assert.match(message.text, /tail tail tail $/);
  assert.equal(result.content.length, 10000);
  assert.match(result.content, /^head head head/);
  assert.match(result.content, /\.\.\.\[truncated middle\]\.\.\./);
  assert.match(result.content, /tail tail tail $/);
});

test('codex full replay stops at a malformed line and returns the valid prefix', () => {
  const path = writeFixture([
    { type: 'session_meta', timestamp: '2026-06-10T10:00:00Z', payload: META },
    { type: 'event_msg', timestamp: '2026-06-10T10:00:01Z', payload: { type: 'user_message', message: 'before corruption' } },
  ]);
  appendFileSync(path, [
    '{bad json}',
    JSON.stringify({ type: 'event_msg', timestamp: '2026-06-10T10:00:02Z', payload: { type: 'user_message', message: 'after corruption' } }),
  ].join('\n') + '\n');

  const { values, ret } = drain(parse({ key: path, sessionId: '' }, null));
  assert.deepEqual(values.filter(record => record.kind === 'message').map(record => record.text), ['before corruption']);
  assert.equal(ret.split(':')[1], '2');
});

test('codex parse() ignores a guardian thread and emits nothing', () => {
  const path = writeFixture([
    { type: 'session_meta', timestamp: '2026-06-10T10:00:00Z', payload: { ...META, source: { subagent: { other: 'guardian' } } } },
    { type: 'event_msg', timestamp: '2026-06-10T10:00:01Z', payload: { type: 'user_message', message: 'ignored' } },
  ]);

  const { values } = drain(parse({ key: path, sessionId: '' }, null));

  assert.deepEqual(values, []);
});

test('codex parse() ignores child and fork threads regardless of parent metadata shape', () => {
  for (const relation of [
    { parent_thread_id: 'parent-1' },
    { forked_from_id: 'parent-2' },
    { source: { subagent: { thread_spawn: { parent_thread_id: 'parent-3' } } } },
    { thread_source: 'subagent' },
  ]) {
    const path = writeFixture([
      { type: 'session_meta', timestamp: '2026-06-10T10:00:00Z', payload: { ...META, ...relation } },
      { type: 'event_msg', payload: { type: 'user_message', message: 'ignored' } },
    ]);
    const { values } = drain(parse({ key: path, sessionId: '' }, null));
    assert.deepEqual(values, [], JSON.stringify(relation));
  }
});

test('codex discover() returns only root rollout units', () => {
  const root = makeTempDir('trajex-codex-discover-');
  const dir = join(root, 'sessions', '2026', '06', '10');
  mkdirSync(dir, { recursive: true });
  const write = (name, payload) => writeFileSync(join(dir, name), `${JSON.stringify({ type: 'session_meta', payload })}\n`);

  write('rollout-root.jsonl', { ...META, thread_source: 'user' });
  write('rollout-child.jsonl', { ...META, id: 'child-1', parent_thread_id: META.id });
  write('rollout-guardian.jsonl', { ...META, id: 'guardian-1', source: { subagent: { other: 'guardian' } }, thread_source: 'subagent' });

  const provider = createCodexProvider({ rootDir: root });
  const units = provider.discover({ lastCursor: () => null });
  assert.deepEqual(units.map(unit => unit.key), [join(dir, 'rollout-root.jsonl')]);
});

test('codex provider folds session_index metadata into its canonical session record', () => {
  const root = makeTempDir('trajex-codex-index-meta-');
  const sessionsDir = join(root, 'sessions', '2026', '06', '10');
  mkdirSync(sessionsDir, { recursive: true });
  const path = join(sessionsDir, `rollout-${META.id}.jsonl`);
  writeFileSync(path, `${JSON.stringify({
    type: 'session_meta', timestamp: '2026-06-10T10:00:00Z', payload: META,
  })}\n`);
  const indexPath = join(root, 'session_index.jsonl');
  writeFileSync(indexPath, `${JSON.stringify({
    id: META.id, thread_name: 'Indexed title', updated_at: '2026-06-10T11:00:00Z',
  })}\n`);
  const provider = createCodexProvider({ rootDir: root });
  const units = provider.discover({ lastCursor: () => '9999999999999:1', changedPaths: [indexPath] });

  assert.equal(units.length, 1);
  const { values } = drain(provider.parse(units[0], null));
  const session = values.find(record => record.kind === 'session');
  assert.equal(session.title, 'Indexed title');
  assert.equal(session.ended_at, '2026-06-10T11:00:00Z');
});

test('codex provider discovers, watches, and reads archived sessions', () => {
  const root = makeTempDir('trajex-codex-archive-');
  const archiveDir = join(root, 'archived_sessions');
  mkdirSync(archiveDir, { recursive: true });
  const path = join(archiveDir, `rollout-${META.id}.jsonl`);
  writeFileSync(path, [
    JSON.stringify({ type: 'session_meta', timestamp: META.timestamp, payload: META }),
    JSON.stringify({ type: 'event_msg', timestamp: '2026-06-10T10:00:01Z', payload: { type: 'user_message', message: 'archived Codex sentinel' } }),
    '',
  ].join('\n'));

  const provider = createCodexProvider({ rootDir: root });
  const units = provider.discover({ lastCursor: () => '9999999999999:1', changedPaths: [path] });
  assert.deepEqual(units.map(unit => unit.key), [path]);
  assert.deepEqual(provider.watchRoots(root), [join(root, 'sessions'), archiveDir, join(root, 'session_index.jsonl')]);
  const raw = provider.raw({ messageUuid: `codex:${META.id}:000002`, agentId: 'codex:archive-agent', session: null, source: 'codex' });
  assert.match(raw.text, /archived Codex sentinel/);
});

test('codex discovery emits a tombstone for a deleted indexed rollout', () => {
  const root = makeTempDir('trajex-codex-retract-');
  const sessionsDir = join(root, 'sessions', '2026', '06', '10');
  const path = join(sessionsDir, 'rollout-deleted.jsonl');
  mkdirSync(sessionsDir, { recursive: true });
  writeFileSync(path, `${JSON.stringify({ type: 'session_meta', payload: META })}\n`);
  const provider = createCodexProvider({ rootDir: root });
  const [indexed] = provider.discover({ lastCursor: () => null });
  rmSync(path);

  const [tombstone] = provider.discover({
    lastCursor: () => null,
    changedPaths: [path],
    indexedSessions: () => [{ sessionId: indexed.sessionId, jsonlPath: path, source: 'codex' }],
  });
  assert.equal(tombstone.meta.kind, 'codex-tombstone');
  assert.equal(tombstone.sessionId, indexed.sessionId);
  assert.deepEqual(tombstone.retractSessionIds, [indexed.sessionId]);
});

test('codex discovery keeps the last snapshot when its sessions root is missing', () => {
  const root = makeTempDir('trajex-codex-missing-root-');
  const sessionsDir = join(root, 'sessions', '2026', '06', '10');
  const path = join(sessionsDir, 'rollout-kept.jsonl');
  mkdirSync(sessionsDir, { recursive: true });
  writeFileSync(path, `${JSON.stringify({ type: 'session_meta', payload: META })}\n`);
  const provider = createCodexProvider({ rootDir: root });
  const [indexed] = provider.discover({ lastCursor: () => null });
  rmSync(join(root, 'sessions'), { recursive: true });

  assert.deepEqual(provider.discover({
    lastCursor: () => null,
    changedPaths: [path],
    indexedSessions: () => [{ sessionId: indexed.sessionId, jsonlPath: path, source: 'codex' }],
  }), []);
});
