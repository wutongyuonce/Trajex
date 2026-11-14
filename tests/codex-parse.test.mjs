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
import { appendFileSync, mkdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

import { createCodexProvider, parse } from '../packages/core/src/providers/codex.ts';
import { createProviderRegistry } from '../packages/core/src/providers/registry.ts';
import { createProviderIndexPlan } from '../packages/core/src/provider-indexing.ts';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, renameSync } from 'node:fs';
import zlib from 'node:zlib';

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

test('codex full replay skips a newline-terminated malformed line', () => {
  const path = writeFixture([
    { type: 'session_meta', timestamp: '2026-06-10T10:00:00Z', payload: META },
    { type: 'event_msg', timestamp: '2026-06-10T10:00:01Z', payload: { type: 'user_message', message: 'before corruption' } },
  ]);
  appendFileSync(path, [
    '{bad json}',
    JSON.stringify({ type: 'event_msg', timestamp: '2026-06-10T10:00:02Z', payload: { type: 'user_message', message: 'after corruption' } }),
  ].join('\n') + '\n');

  const { values, ret } = drain(parse({ key: path, sessionId: '' }, null));
  assert.deepEqual(values.filter(record => record.kind === 'message').map(record => record.text), [
    'before corruption',
    'after corruption',
  ]);
  assert.equal(ret.split(':')[1], '4');
  assert.equal(ret.split(':').length, 5);
});

test('codex full replay leaves an unterminated malformed tail unconsumed', () => {
  const path = writeFixture([
    { type: 'session_meta', timestamp: '2026-06-10T10:00:00Z', payload: META },
  ]);
  appendFileSync(path, [
    JSON.stringify({ type: 'event_msg', timestamp: '2026-06-10T10:00:01Z', payload: { type: 'user_message', message: 'before torn tail' } }),
    '{"type":"event_msg"',
  ].join('\n'));

  const { values, ret } = drain(parse({ key: path, sessionId: '' }, null));
  assert.deepEqual(values.filter(record => record.kind === 'message').map(record => record.text), [
    'before torn tail',
  ]);
  assert.equal(ret.split(':')[1], '2');
  assert.equal(ret.split(':').length, 5);
});

test('codex discovery notices a same-mtime rewrite and upgrades a legacy cursor', () => {
  const root = makeTempDir('trajex-codex-snapshot-');
  const dir = join(root, 'sessions', '2026', '06', '10');
  const path = join(dir, `rollout-${META.id}.jsonl`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, [
    { type: 'session_meta', timestamp: META.timestamp, payload: META },
    { type: 'event_msg', payload: { type: 'user_message', message: 'one' } },
  ].map(JSON.stringify).join('\n') + '\n');
  const provider = createCodexProvider({ rootDir: root });
  const [unit] = provider.discover({ lastCursor: () => null });
  const { ret: cursor } = drain(provider.parse(unit, null));
  const before = statSync(path);

  assert.equal(provider.discover({ lastCursor: () => cursor }).length, 0);
  assert.equal(provider.discover({ lastCursor: () => `${before.mtimeMs}:2` }).length, 1, 'legacy cursors replay once');

  writeFileSync(path, [
    { type: 'session_meta', timestamp: META.timestamp, payload: META },
    { type: 'event_msg', payload: { type: 'user_message', message: 'two' } },
  ].map(JSON.stringify).join('\n') + '\n');
  utimesSync(path, before.atime, before.mtime);

  assert.deepEqual(provider.discover({ lastCursor: () => cursor }).map(found => found.key), [path]);
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
  assert.equal(session.ended_at, '2026-06-10T11:00:00.000Z');
});

test('codex parse() normalizes zone-carrying timestamps and keeps zone-less ones verbatim', () => {
  const path = writeFixture([
    { type: 'session_meta', timestamp: '2026-06-10T18:00:00+08:00', payload: { ...META, timestamp: '2026-06-10T18:00:00+08:00' } },
    { type: 'event_msg', timestamp: '2026-06-10T10:00:01Z', payload: { type: 'user_message', message: 'no millis' } },
    { type: 'event_msg', timestamp: '2026-06-10T10:00:02.123456Z', payload: { type: 'agent_message', message: 'micros' } },
    { type: 'event_msg', timestamp: '2026-06-10T10:00:03', payload: { type: 'agent_message', message: 'zone-less' } },
  ]);

  const { values } = drain(parse({ key: path, sessionId: '' }, null));
  const messages = values.filter(r => r.kind === 'message');

  // Zone-carrying values become canonical .sssZ; a zone-less value is stored
  // verbatim rather than silently shifted.
  assert.deepEqual(messages.map(m => [m.timestamp, m.text]), [
    ['2026-06-10T10:00:01.000Z', 'no millis'],
    ['2026-06-10T10:00:02.123Z', 'micros'],
    ['2026-06-10T10:00:03', 'zone-less'],
  ]);

  const session = values.find(r => r.kind === 'session');
  assert.equal(session.started_at, '2026-06-10T10:00:00.000Z');
  assert.equal(session.ended_at, '2026-06-10T10:00:03');
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
  assert.deepEqual(provider.watchTargets(), [
    { kind: 'tree', path: join(root, 'sessions') },
    { kind: 'tree', path: archiveDir },
    { kind: 'file', path: join(root, 'session_index.jsonl') },
  ]);
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

test('codex full replay consumes non-object JSON lines', () => {
  const path = writeFixture([{ type: 'session_meta', timestamp: '2026-06-10T10:00:00Z', payload: META }]);
  appendFileSync(path, ['null', '7', JSON.stringify({ type: 'event_msg', timestamp: '2026-06-10T10:00:02Z', payload: { type: 'user_message', message: 'after non-object' } })].join('\n') + '\n');
  const { values, ret } = drain(parse({ key: path, sessionId: '' }, null));
  assert.deepEqual(values.filter(record => record.kind === 'message').map(record => record.text), ['after non-object']);
  assert.equal(ret.split(':')[1], '4');
});

test('archiving a rollout moves its session instead of tombstoning the new projection', () => {
  const root = makeTempDir('trajex-codex-archive-move-');
  const sessionsDir = join(root, 'sessions', '2026', '06', '10');
  mkdirSync(sessionsDir, { recursive: true });
  mkdirSync(join(root, 'archived_sessions'));
  const live = join(sessionsDir, `rollout-${META.id}.jsonl`);
  writeFileSync(live, `${JSON.stringify({ type: 'session_meta', payload: META })}\n`);
  const provider = createCodexProvider({ rootDir: root });
  const [indexed] = provider.discover({ lastCursor: () => null });
  const archived = join(root, 'archived_sessions', `rollout-${META.id}.jsonl`);
  renameSync(live, archived);

  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(new URL('../packages/core/src/schema.sql', import.meta.url), 'utf8'));
  db.prepare("INSERT INTO sessions (id, jsonl_path, source) VALUES (?, ?, 'codex')").run(indexed.sessionId, live);
  const plan = createProviderIndexPlan(db, createProviderRegistry([provider]), { changedPaths: [live, archived] });
  assert.deepEqual(plan.items.map(item => item.unit.key), [archived]);
  db.close();
});

test('codex keeps archived snapshots when an indexed archived_sessions root disappears', () => {
  const root = makeTempDir('trajex-codex-archive-missing-');
  mkdirSync(join(root, 'sessions'));
  const archived = join(root, 'archived_sessions', 'rollout-a.jsonl');
  mkdirSync(join(root, 'archived_sessions'));
  writeFileSync(archived, `${JSON.stringify({ type: 'session_meta', payload: META })}\n`);
  const provider = createCodexProvider({ rootDir: root });
  const [indexed] = provider.discover({ lastCursor: () => null });
  rmSync(join(root, 'archived_sessions'), { recursive: true });
  const issues = [];
  assert.deepEqual(provider.discover({
    lastCursor: () => null,
    indexedSessions: () => [{ sessionId: indexed.sessionId, jsonlPath: archived, source: 'codex' }],
    reportUnavailableRoot: issue => issues.push(issue),
  }), []);
  assert.equal(issues.length, 1);
  assert.deepEqual(createCodexProvider({ rootDir: makeTempDir('trajex-codex-no-archive-') })
    .discover({ lastCursor: () => null, reportUnavailableRoot: issue => issues.push(issue) }), []);
  assert.equal(issues.length, 2, 'a never-indexed missing archive dir is not an issue; only sessions/ is reported');
});

const skipWithoutZstd = { skip: typeof zlib.zstdCompressSync !== 'function' ? 'node:zlib zstd needs Node.js 22.15+' : false };
const ROLLOUT = [
  { type: 'session_meta', timestamp: '2026-06-10T10:00:00Z', payload: META },
  { type: 'event_msg', timestamp: '2026-06-10T10:00:01Z', payload: { type: 'user_message', message: 'compressed question' } },
  { type: 'event_msg', timestamp: '2026-06-10T10:00:02Z', payload: { type: 'agent_message', message: 'compressed answer' } },
];
const rolloutText = () => ROLLOUT.map(line => JSON.stringify(line)).join('\n') + '\n';

/** 把一个已有的 `.jsonl` 按 Codex 的方式压缩成 `.jsonl.zst` 并删除原文件。 */
function compressRollout(path) {
  writeFileSync(`${path}.zst`, zlib.zstdCompressSync(readFileSync(path)));
  rmSync(path);
  return `${path}.zst`;
}

function codexHome() {
  const root = makeTempDir('trajex-codex-zst-');
  const dir = join(root, 'sessions', '2026', '06', '10');
  mkdirSync(dir, { recursive: true });
  const plain = join(dir, `rollout-2026-06-10T10-00-00-${META.id}.jsonl`);
  writeFileSync(plain, rolloutText());
  return { root, plain };
}

function planKeys(provider, indexed, changedPaths) {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(new URL('../packages/core/src/schema.sql', import.meta.url), 'utf8'));
  db.prepare("INSERT INTO sessions (id, jsonl_path, source) VALUES (?, ?, 'codex')").run(indexed.sessionId, indexed.key);
  const plan = createProviderIndexPlan(db, createProviderRegistry([provider]), changedPaths ? { changedPaths } : {});
  db.close();
  return plan.items.map(item => [item.unit.key, item.unit.meta?.kind ?? 'rollout']);
}

test('compressed rollouts are discovered, parsed and raw-read like plain ones', skipWithoutZstd, () => {
  const { root, plain } = codexHome();
  const provider = createCodexProvider({ rootDir: root });
  const expected = drain(parse({ key: plain, sessionId: '' }, null)).values;
  const zst = compressRollout(plain);
  const [unit] = provider.discover({ lastCursor: () => null });
  assert.equal(unit.key, zst);
  const { values, ret } = drain(parse(unit, null));
  const project = records => records.map(record => (record.kind === 'session' ? { ...record, jsonl_path: null } : record));
  assert.deepEqual(project(values), project(expected), 'the compressed rollout projects exactly like the plain one');
  assert.deepEqual(provider.discover({ lastCursor: () => ret }), [], 'an unchanged compressed rollout is skipped by its cursor');
  const answer = values.find(record => record.kind === 'message' && record.text === 'compressed answer');
  const raw = provider.raw({ messageUuid: answer.uuid, agentId: null, session: { jsonl_path: plain }, source: 'codex' });
  assert.equal(raw.messageText, 'compressed answer', 'raw lookup follows an indexed .jsonl path to its .zst sibling');
});

test('compressing an indexed rollout republishes it instead of deleting it', skipWithoutZstd, () => {
  const { root, plain } = codexHome();
  const provider = createCodexProvider({ rootDir: root });
  const [indexed] = provider.discover({ lastCursor: () => null });
  const zst = compressRollout(plain);
  for (const changedPaths of [undefined, [plain], [zst], [plain, zst]]) {
    assert.deepEqual(planKeys(provider, indexed, changedPaths), [[zst, 'rollout']], `changedPaths=${JSON.stringify(changedPaths)}`);
  }
});

test('while both forms exist only the plain rollout is indexed', skipWithoutZstd, () => {
  const { root, plain } = codexHome();
  writeFileSync(`${plain}.zst`, zlib.zstdCompressSync(readFileSync(plain)));
  const keys = createCodexProvider({ rootDir: root }).discover({ lastCursor: () => null }).map(unit => unit.key);
  assert.deepEqual(keys, [plain]);
});

test('an incomplete compressed rollout is skipped without being treated as deleted', skipWithoutZstd, () => {
  const { root, plain } = codexHome();
  const provider = createCodexProvider({ rootDir: root });
  const [indexed] = provider.discover({ lastCursor: () => null });
  const zst = compressRollout(plain);
  const full = readFileSync(zst);
  writeFileSync(zst, full.subarray(0, full.length - 5));
  assert.deepEqual(provider.discover({
    lastCursor: () => null,
    indexedSessions: () => [{ sessionId: indexed.sessionId, jsonlPath: zst, source: 'codex' }],
  }), []);
  assert.throws(() => drain(parse({ key: zst, sessionId: indexed.sessionId }, null)), /incomplete/);
});

test('a long thread split into segments indexes as one session in segment order', skipWithoutZstd, () => {
  const { root, plain } = codexHome();
  const segment = plain.replace('.jsonl', '_99999999-9999-4999-8999-999999999999.jsonl');
  writeFileSync(segment, [
    { type: 'session_meta', timestamp: '2026-06-10T11:00:00Z', payload: { ...META, timestamp: '2026-06-10T11:00:00Z' } },
    { type: 'event_msg', timestamp: '2026-06-10T11:00:01Z', payload: { type: 'user_message', message: 'second segment question' } },
  ].map(line => JSON.stringify(line)).join('\n') + '\n');
  const first = compressRollout(plain);
  // An identical copy left in archived_sessions must not be read twice.
  mkdirSync(join(root, 'archived_sessions'), { recursive: true });
  writeFileSync(join(root, 'archived_sessions', basename(first)), readFileSync(first));
  const provider = createCodexProvider({ rootDir: root });
  const units = provider.discover({ lastCursor: () => null });
  assert.equal(units.length, 1, 'every segment of one thread forms one unit');
  assert.equal(basename(units[0].key), basename(first), 'the thread is keyed by its first segment');
  const { values, ret } = drain(parse(units[0], null));
  const texts = values.filter(record => record.kind === 'message').map(record => record.text);
  assert.deepEqual(texts, ['compressed question', 'compressed answer', 'second segment question']);
  assert.equal(new Set(values.filter(record => record.kind === 'message').map(record => record.uuid)).size, texts.length);
  assert.equal(values.filter(record => record.kind === 'session').length, 1);
  assert.deepEqual(provider.discover({ lastCursor: () => ret }), [], 'an unchanged segmented thread is skipped');
  appendFileSync(segment, `${JSON.stringify({ type: 'event_msg', timestamp: '2026-06-10T11:00:02Z', payload: { type: 'agent_message', message: 'late answer' } })}\n`);
  assert.equal(provider.discover({ lastCursor: () => ret }).length, 1, 'a change to any segment replays the thread');
  const later = values.find(record => record.text === 'second segment question');
  const raw = provider.raw({ messageUuid: later.uuid, agentId: null, session: { jsonl_path: units[0].key }, source: 'codex' });
  assert.equal(raw.messageText, 'second segment question', 'raw lookup continues line numbers across segments');
});

test('codex raw lookup returns text_elements event text like the index does', () => {
  const path = writeFixture([
    { type: 'session_meta', timestamp: '2026-06-10T10:00:00Z', payload: META },
    { type: 'event_msg', timestamp: '2026-06-10T10:00:01Z', payload: { type: 'user_message', text_elements: [{ text: 'element text' }] } },
  ]);
  const raw = createCodexProvider({ rootDir: makeTempDir('trajex-codex-raw-') }).raw({
    messageUuid: `codex:${META.id}:000002`, agentId: null, session: { jsonl_path: path }, source: 'codex',
  });
  assert.equal(raw.messageText, 'element text');
});
