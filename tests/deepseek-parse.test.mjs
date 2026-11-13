// Copyright (C) 2026 tommy0103 and contributors.
// Copyright (C) 2026 wutongyuonce and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createDeepseekProvider, deepseekSessionId, deepseekSessionsRoot, DEEPSEEK_CANONICAL_TRANSCRIPT_MARKER,
} from '../packages/core/src/providers/deepseek.ts';
import { zstdDecoder } from '../packages/core/src/vendor/dsh-zstd.ts';
import { makeTempDir } from './temp-dirs.mjs';

const FIXTURES = fileURLToPath(new URL('./fixtures/deepseek/sessions/', import.meta.url));
const skipWithoutZstd = { skip: zstdDecoder() === null ? 'node:zlib zstd needs Node.js 22.15+' : false };
const CWD = '/dsh-fixtures';

function drain(gen) {
  const values = [];
  let step = gen.next();
  while (!step.done) { values.push(step.value); step = gen.next(); }
  return { values, cursor: step.value };
}

function root(...entries) {
  const dir = makeTempDir('trajex-dsh-');
  for (const entry of entries) cpSync(join(FIXTURES, entry), join(dir, entry), { recursive: true });
  return dir;
}

function writeSession(rootDir, sessionDir, fileName, header, events, { trailer = '' } = {}) {
  const dir = join(rootDir, '--work--', sessionDir);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, fileName);
  writeFileSync(path, [header, ...events].map(row => JSON.stringify(row)).join('\n') + '\n' + trailer);
  return path;
}

const header = (id, extra = {}) => ({ type: 'session', version: 4, id, createdAt: 1000, cwd: CWD, isSeeded: false, delegationDepth: 0, ...extra });
const user = (seq, id, text, extra = {}) => ({
  type: 'user/message', seq, time: 1000 + seq,
  data: { id, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } }, surfaceOp: 'append', ...extra,
});
const assistant = (seq, id, content, extra = {}) => ({
  type: 'assistant/message', seq, time: 1000 + seq,
  data: { turn: 1, step: seq, message: { id, role: 'assistant', content, source: { kind: 'model', provider: 'deepseek', model: 'deepseek-chat' } }, usage: { inputTokens: 10, cacheReadTokens: 4, outputTokens: 3 } },
  surfaceOp: 'append', ...extra,
});

function discover(rootDir, ctx = {}) {
  const provider = createDeepseekProvider({ rootDir });
  return { provider, units: provider.discover({ lastCursor: () => null, indexedSessions: () => [], ...ctx }) };
}

function parseAll(rootDir) {
  const { provider, units } = discover(rootDir);
  return units.map(unit => ({ unit, ...drain(provider.parse(unit, null)) }));
}

const byKind = (values, kind) => values.filter(value => value.kind === kind);

test('discovery reads only the highest supported canonical generation of each session directory', () => {
  const dir = root('--dsh-v3--', '--dsh-v4--');
  const keys = discover(dir).units.map(unit => unit.key.slice(dir.length + 1)).sort();
  assert.deepEqual(keys, [
    '--dsh-v3--/v3-basic/session.v3.jsonl.zstd',
    '--dsh-v3--/v3-compacted/session.v3.jsonl',
    '--dsh-v3--/v3-migrated/session.v3.jsonl',
    '--dsh-v3--/v3-ptc/session.v3.jsonl',
    '--dsh-v3--/v3-seeded-parent/session.v3.jsonl',
    '--dsh-v4--/v4-basic/session.v4.jsonl',
    '--dsh-v4--/v4-failed-tool/session.v4.jsonl',
    '--dsh-v4--/v4-retry-resume/session.v4.jsonl',
    '--dsh-v4--/v4-success-extensions/session.v4.jsonl',
  ], 'lock and tmp siblings are never generations; a migrated v2 source stays unread');
});

test('a newer unsupported generation does not hide the readable one, and an unsupported-only session is skipped', () => {
  const dir = makeTempDir('trajex-dsh-');
  writeSession(dir, 'a', 'session.v4.jsonl', header('a'), [user(0, 'u1', 'still readable')]);
  writeSession(dir, 'a', 'session.v5.jsonl', { ...header('a'), version: 5 }, []);
  writeSession(dir, 'b', 'session.v5.jsonl', { ...header('b'), version: 5 }, []);
  writeSession(dir, 'c', 'session.v4.jsonl', { ...header('c'), version: 3 }, []);
  const { units } = discover(dir);
  assert.deepEqual(units.map(unit => unit.sessionId), [deepseekSessionId('a', CWD)]);
});

test('v3 compressed sessions project messages, tool calls, results and usage once per step', skipWithoutZstd, () => {
  const [{ values }] = parseAll(root('--dsh-v3--/v3-basic'));
  const session = byKind(values, 'session')[0];
  assert.equal(session.source, 'deepseek');
  assert.equal(session.title, 'v3 basic session');
  assert.equal(session.version, '3');
  assert.equal(session.project, '-dsh-fixtures');
  assert.equal(session.countMode, 'total');
  assert.equal(values[0].kind, 'delete-session', 'full replay retracts before re-emitting');
  const messages = byKind(values, 'message');
  assert.ok(messages.every(message => message.session_id === session.id && message.agent_id === null));
  const usage = messages.filter(message => message.input_tokens !== null);
  assert.ok(usage.length >= 1 && usage.every(message => message.output_tokens !== null));
  const [call] = byKind(values, 'tool_call');
  const [result] = byKind(values, 'tool_result');
  assert.equal(result.tool_use_id, call.id);
  assert.equal(result.message_uuid, call.message_uuid);
  assert.ok(messages.some(message => message.uuid === call.message_uuid && message.content_type === 'tool_use'));
});

test('compaction keeps replaced history as inactive evidence and the summary as a summary record', () => {
  const [{ values }] = parseAll(root('--dsh-v3--/v3-compacted'));
  const messages = byKind(values, 'message');
  const inactive = messages.filter(message => message.visibility === 'inactive').map(message => message.text);
  assert.deepEqual(inactive, ['first question', 'first answer', 'second question', 'second answer']);
  const checkpoint = messages.find(message => message.text?.startsWith('[compacted summary]'));
  assert.equal(checkpoint.visibility, 'visible');
  assert.equal(checkpoint.is_meta, 1, 'the replacement checkpoint is control-plane context');
  const [summary] = byKind(values, 'summary');
  assert.equal(summary.content, 'summary of the first two exchanges');
  assert.equal(summary.visibility, 'visible');
  const session = byKind(values, 'session')[0];
  assert.equal(session.title, 'first question', 'compaction does not rename the session');
  assert.equal(session.message_count, 3);
  assert.equal(new Set(messages.map(message => message.uuid)).size, messages.length);
});

test('a seeded subagent belongs to its parent tree without duplicating the inherited prefix', () => {
  const dir = root('--dsh-v3--/v3-seeded-parent', '--dsh-v3--/v3-seeded-child');
  const units = discover(dir).units;
  assert.equal(units.length, 1, 'parent and child form one tree unit');
  const [{ values }] = parseAll(dir);
  const parentId = deepseekSessionId('v3-seeded-parent', CWD);
  const childId = deepseekSessionId('v3-seeded-child', CWD);
  const child = byKind(values, 'message').filter(message => message.agent_id === childId);
  assert.deepEqual(child.map(message => message.text), ['child task', 'child answer']);
  assert.ok(child.every(message => message.session_id === parentId));
  const [subagent] = byKind(values, 'subagent');
  assert.equal(subagent.agent_id, childId);
  assert.equal(subagent.description, 'seeded child');
  assert.equal(byKind(values, 'session')[0].message_count, 2, 'only root messages count toward the session');
});

test('a seeded fork without its parent keeps the inherited prefix as inactive evidence', () => {
  const [{ values }] = parseAll(root('--dsh-v3--/v3-seeded-child'));
  const messages = byKind(values, 'message');
  assert.deepEqual(messages.filter(message => message.visibility === 'inactive').map(message => message.text),
    ['parent question', 'parent answer']);
  assert.equal(byKind(values, 'session')[0].title, 'child task');
});

test('a seeded child whose end-seed marker is not durable yet contributes no body', () => {
  const dir = makeTempDir('trajex-dsh-');
  writeSession(dir, 'parent', 'session.v4.jsonl', header('parent'), [user(0, 'p1', 'parent ask')]);
  writeSession(dir, 'child', 'session.v4.jsonl', header('child', { parentSession: 'parent', isSeeded: true, origin: 'subagent' }), [
    user(0, 'p1', 'parent ask'),
  ]);
  const [{ values }] = parseAll(dir);
  assert.deepEqual(byKind(values, 'message').map(message => message.text), ['parent ask']);
  assert.equal(byKind(values, 'subagent').length, 1);
});

test('v4 tool-role results keep their error status and match the v3 wrapper projection', () => {
  const projectTool = (generation) => {
    const dir = makeTempDir('trajex-dsh-');
    cpSync(join(FIXTURES, '--dsh-v4--/v4-failed-tool', generation), join(dir, '--dsh-v4--/v4-failed-tool', generation), { recursive: true });
    const [{ values }] = parseAll(dir);
    return byKind(values, 'tool_result').map(({ content, is_error, file_path }) => ({ content, is_error, file_path }));
  };
  const v4 = projectTool('session.v4.jsonl');
  assert.deepEqual(v4, [{ content: 'Error: file not found', is_error: 1, file_path: '/dsh-fixtures/a.ts' }]);
  assert.deepEqual(projectTool('session.v3.jsonl'), v4);
  const [{ values }] = parseAll(root('--dsh-v4--/v4-success-extensions'));
  assert.equal(byKind(values, 'tool_result')[0].is_error, 0);
});

test('non-user producer messages are meta and PTC sub-calls hang off the outer call anchor', () => {
  const [{ values }] = parseAll(root('--dsh-v4--/v4-failed-tool'));
  const reminder = byKind(values, 'message').find(message => message.text?.startsWith('<system-reminder>'));
  assert.equal(reminder.is_meta, 1);
  const [{ values: ptc }] = parseAll(root('--dsh-v3--/v3-ptc'));
  const calls = byKind(ptc, 'tool_call');
  assert.deepEqual(calls.map(call => call.name), ['run_code', 'read', 'write']);
  assert.equal(new Set(calls.map(call => call.message_uuid)).size, 1);
  assert.deepEqual(byKind(ptc, 'tool_result').map(result => result.file_path), ['/dsh-fixtures/a.ts', '/dsh-fixtures/b.ts', null]);
});

test('real v0 captures group a subagent under its parent session', skipWithoutZstd, () => {
  const [{ values }] = parseAll(root('--home-dev-project--'));
  const session = byKind(values, 'session')[0];
  assert.equal(session.id, deepseekSessionId('session-5f3c68cc-064b-4981-8c2b-8fbbce0451b3', '/home/dev/project'));
  assert.equal(session.version, '0');
  const [subagent] = byKind(values, 'subagent');
  assert.equal(subagent.agent_type, 'deepseek-official');
  assert.equal(subagent.description, 'sanitized helper');
  assert.equal(byKind(values, 'tool_call').length, byKind(values, 'tool_result').length);
});

test('a subagent spawn result links the child to the parent tool call', () => {
  const dir = makeTempDir('trajex-dsh-');
  writeSession(dir, 'parent', 'session.v4.jsonl', header('parent'), [
    user(0, 'p1', 'delegate it'),
    assistant(1, 'a1', [{ type: 'tool-call', id: 'spawn-1', name: 'spawn', arguments: '{}' }]),
    { type: 'tool/call', seq: 2, time: 1002, data: { turn: 1, step: 1, callId: 'spawn-1', name: 'spawn', arguments: '{}' } },
    { type: 'tool/result', seq: 3, time: 1003, data: { turn: 1, step: 1, message: { id: 'r1', role: 'tool', toolCallId: 'spawn-1', source: { kind: 'tool', callId: 'spawn-1' }, content: [{ type: 'text', text: 'started subagent kid' }] } }, surfaceOp: 'append' },
  ]);
  writeSession(dir, 'kid', 'session.v4.jsonl', header('kid', { parentSession: 'parent', origin: 'subagent' }), [user(0, 'k1', 'child work')]);
  const [{ values }] = parseAll(dir);
  const [subagent] = byKind(values, 'subagent');
  const [call] = byKind(values, 'tool_call');
  assert.equal(subagent.parent_tool_use_id, call.id);
  const anchor = byKind(values, 'message').find(message => message.uuid === call.message_uuid);
  assert.equal(anchor.input_tokens, 14, 'cache-read tokens count toward input');
});

test('malformed complete lines are skipped, CRLF is tolerated and a torn raw tail waits', () => {
  const dir = makeTempDir('trajex-dsh-');
  const path = writeSession(dir, 's', 'session.v4.jsonl', header('s'), [user(0, 'u1', 'before')],
    { trailer: '{not json}\r\n' + JSON.stringify(user(2, 'u2', 'after')) + '\r\n' + '{"type":"user/message","seq":3' });
  const [{ values }] = parseAll(dir);
  assert.deepEqual(byKind(values, 'message').map(message => message.text), ['before', 'after']);
  appendFileSync(path, ',"time":1003,"data":{"id":"u3","content":[{"type":"text","text":"completed"}],"source":{"kind":"user"}}}\n');
  assert.deepEqual(byKind(parseAll(dir)[0].values, 'message').map(message => message.text), ['before', 'after', 'completed']);
});

test('a header line still being written is skipped without inventing a session', () => {
  const dir = makeTempDir('trajex-dsh-');
  mkdirSync(join(dir, '--work--', 'new'), { recursive: true });
  writeFileSync(join(dir, '--work--', 'new', 'session.v4.jsonl'), '{"type":"session","version":4,"id":"new"');
  assert.deepEqual(discover(dir).units, []);
});

test('an unchanged tree is skipped and a child change replays the whole root unit', () => {
  const dir = root('--dsh-v3--/v3-seeded-parent', '--dsh-v3--/v3-seeded-child');
  const { provider, units } = discover(dir);
  const { cursor } = drain(provider.parse(units[0], null));
  const cursors = new Map([[units[0].key, cursor]]);
  const ctx = { lastCursor: key => cursors.get(key) ?? null, indexedSessions: () => [] };
  assert.deepEqual(provider.discover(ctx), []);
  appendFileSync(join(dir, '--dsh-v3--/v3-seeded-child/session.v3.jsonl'),
    JSON.stringify({ type: 'user/message', seq: 99, time: 2000, data: { id: 'late', content: [{ type: 'text', text: 'late child' }], source: { kind: 'user' } } }) + '\n');
  const replay = provider.discover(ctx);
  assert.deepEqual(replay.map(unit => unit.key), [units[0].key]);
  assert.ok(byKind(drain(provider.parse(replay[0], cursor)).values, 'message').some(message => message.text === 'late child'));
});

test('a child indexed as its own root is retracted by the tree that adopts it, never tombstoned', () => {
  const dir = makeTempDir('trajex-dsh-');
  const childPath = writeSession(dir, 'kid', 'session.v4.jsonl', header('kid', { parentSession: 'parent', origin: 'subagent' }), [user(0, 'k1', 'child')]);
  const kidId = deepseekSessionId('kid', CWD);
  writeSession(dir, 'parent', 'session.v4.jsonl', header('parent'), [user(0, 'p1', 'parent')]);
  const units = discover(dir, { indexedSessions: () => [{ sessionId: kidId, jsonlPath: childPath, source: 'deepseek' }] }).units;
  assert.equal(units.length, 1);
  assert.deepEqual(units[0].retractSessionIds, [kidId]);
  assert.equal(units[0].sessionId, deepseekSessionId('parent', CWD));
});

test('deleted sessions are tombstoned only from an authoritative inventory and unreadable ones are protected', () => {
  const dir = makeTempDir('trajex-dsh-');
  const gone = join(dir, '--work--', 'gone', 'session.v4.jsonl');
  const frozen = writeSession(dir, 'frozen', 'session.v5.jsonl', { ...header('frozen'), version: 5 }, []);
  const indexed = [
    { sessionId: deepseekSessionId('gone', CWD), jsonlPath: gone, source: 'deepseek' },
    { sessionId: deepseekSessionId('frozen', CWD), jsonlPath: frozen.replace('v5', 'v4'), source: 'deepseek' },
  ];
  const full = discover(dir, { indexedSessions: () => indexed }).units;
  assert.deepEqual(full.map(unit => [unit.sessionId, unit.retractSessionIds]), [[indexed[0].sessionId, [indexed[0].sessionId]]]);
  assert.deepEqual(discover(dir, { indexedSessions: () => indexed, changedPaths: [join(dir, '--work--', 'other')] }).units, [],
    'a watcher hint for another session does not authorize deletion');
  assert.equal(drain(createDeepseekProvider({ rootDir: dir }).parse(full[0], null)).cursor, '0:0');

  const issues = [];
  const missing = createDeepseekProvider({ rootDir: join(dir, 'absent') })
    .discover({ lastCursor: () => null, indexedSessions: () => indexed, reportUnavailableRoot: issue => issues.push(issue) });
  assert.deepEqual(missing, []);
  assert.equal(issues.length, 1);
});

test('identity replacement inside one session directory retracts the old identity', () => {
  const dir = makeTempDir('trajex-dsh-');
  const path = writeSession(dir, 'slot', 'session.v4.jsonl', header('new-id'), [user(0, 'u1', 'replacement')]);
  const oldId = deepseekSessionId('old-id', CWD);
  const [unit] = discover(dir, { indexedSessions: () => [{ sessionId: oldId, jsonlPath: path, source: 'deepseek' }] }).units;
  assert.deepEqual(unit.retractSessionIds, [oldId]);
});

test('raw lookup returns the source event for user and assistant messages', () => {
  const dir = root('--dsh-v4--/v4-failed-tool');
  const { provider } = discover(dir);
  const [{ unit, values }] = parseAll(dir);
  const session = { id: unit.sessionId, jsonl_path: unit.key };
  for (const message of byKind(values, 'message').filter(row => row.content_type !== 'tool_use')) {
    const raw = provider.raw({ source: 'deepseek', messageUuid: message.uuid, session, agentId: null });
    assert.ok(raw, message.uuid);
    assert.equal(JSON.parse(raw.text).type, message.role === 'user' ? 'user/message' : 'assistant/message');
    assert.equal(raw.messageText, message.text);
  }
  assert.equal(provider.raw({ source: 'deepseek', messageUuid: 'deepseek:x:y', session, agentId: null }), null);
});

test('DSH_HOME resolution follows the harness and the registry exposes the source', () => {
  assert.equal(deepseekSessionsRoot({}), join(homedir(), '.dsh', 'sessions'));
  assert.equal(deepseekSessionsRoot({ DSH_HOME: '  ' }), join(homedir(), '.dsh', 'sessions'));
  assert.equal(deepseekSessionsRoot({ DSH_HOME: '~' }), join(homedir(), 'sessions'));
  assert.equal(deepseekSessionsRoot({ DSH_HOME: '~/dsh' }), join(homedir(), 'dsh', 'sessions'));
  assert.equal(deepseekSessionsRoot({ DSH_HOME: '~other' }), join(resolve('~other'), 'sessions'));
  assert.equal(deepseekSessionsRoot({ DSH_HOME: '/opt/dsh' }), join('/opt/dsh', 'sessions'));
  const provider = createDeepseekProvider({ rootDir: '/configured/sessions' });
  assert.deepEqual(provider.watchTargets(), [{ kind: 'tree', path: '/configured/sessions' }]);
  assert.equal(provider.descriptor.name, 'DeepSeek Harness');
  assert.equal(provider.indexVersionMarker, DEEPSEEK_CANONICAL_TRANSCRIPT_MARKER);
});

test('the fixtures are read in place and never modified', () => {
  const before = readFileSync(join(FIXTURES, '--dsh-v3--/v3-compacted/session.v3.jsonl'));
  parseAll(root('--dsh-v3--/v3-compacted'));
  assert.deepEqual(readFileSync(join(FIXTURES, '--dsh-v3--/v3-compacted/session.v3.jsonl')), before);
  rmSync(makeTempDir('trajex-dsh-'), { recursive: true, force: true });
});
