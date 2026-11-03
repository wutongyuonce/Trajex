// Copyright (C) 2026 Trajex contributors.
// SPDX-License-Identifier: AGPL-3.0-only

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createDeepSeekProvider } from '../packages/core/src/providers/deepseek.ts';

const COMPRESSED = 'KLUv/SCJRQMAokYWG3Br2hCBJpFBbAwMP1KS6nUv2PMLDjyrPu4QAshDOSdWvcCk3IP4crRdl3M44/E3aCaKlZqkQTZlIACcl4Df84Vsxqt+qUVCPmPaArfOsJlJqXr1+aqxdgQEAFZdgSqQ4urpVZootS/9ILsNBACCSBoacGtz9SKaaHV3TX2tE6XWXzVJvu2ApgQARLCA5kxf6xi9CkcHwRj1tUPzlfxTIK96thaFjOdlfA3oTd+kkK9lShRHjFFIJj4rirlBnz3pQw7CAEF/SdZ3oBdXn584ql8E7MoY/dVYNwEIAKpR7KF8QKRoKBDBlBBer4gSAco=';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'trajex-deepseek-'));
  const sessionDir = join(root, '--work--', 'session');
  mkdirSync(sessionDir, { recursive: true });
  return { root, sessionDir, close: () => rmSync(root, { recursive: true, force: true }) };
}

function context(indexedSessions = [], changedPaths) {
  return { lastCursor: () => null, indexedSessions: () => indexedSessions, ...(changedPaths ? { changedPaths } : {}) };
}

function rows(path, entries) {
  writeFileSync(path, entries.map(entry => JSON.stringify(entry)).join('\n') + '\n');
}

test('DeepSeek v4 raw log projects messages, tools, compaction visibility, and token usage', () => {
  const { root, sessionDir, close } = fixture();
  try {
    const path = join(sessionDir, 'session.v4.jsonl');
    const header = { type: 'session', version: 4, id: 'sample', createdAt: 1780000000000, cwd: '/work/project', isSeeded: false, delegationDepth: 0 };
    rows(path, [
      header,
      { type: 'user/message', seq: 0, time: 1780000000001, data: { role: 'user', id: 'u', source: { kind: 'user' }, content: [{ type: 'text', text: 'first question' }] }, surfaceOp: 'append' },
      { type: 'assistant/message', seq: 1, time: 1780000000002, data: { message: { role: 'assistant', id: 'a', source: { kind: 'model', provider: 'deepseek', model: 'deepseek-chat' }, content: [{ type: 'text', text: 'I will read it' }, { type: 'tool-call', id: 'call-1', name: 'read', arguments: '{"path":"/work/project/a.txt"}' }] }, stream: [], usage: { inputTokens: 10, cacheReadTokens: 3, outputTokens: 5 } }, surfaceOp: 'append' },
      { type: 'tool/call', seq: 2, time: 1780000000003, data: { turn: 1, step: 1, callId: 'call-1', name: 'read', arguments: '{"path":"/work/project/a.txt"}' } },
      { type: 'tool/result', seq: 3, time: 1780000000004, data: { message: { role: 'tool', id: 't', source: { kind: 'tool', callId: 'call-1' }, toolCallId: 'call-1', content: [{ type: 'text', text: 'file contents' }] } }, surfaceOp: 'append' },
      { type: 'compaction/summary', seq: 4, time: 1780000000005, data: { summary: [{ type: 'text', text: 'Earlier work summarized' }], usage: { inputTokens: 2, outputTokens: 1 } } },
      { type: 'user/message', seq: 5, time: 1780000000006, data: { role: 'user', id: 'u2', source: { kind: 'plugin' }, content: [{ type: 'text', text: 'context after compaction' }] }, surfaceOp: { op: 'replace', startSeq: 0, endSeq: 3 } },
    ]);
    const provider = createDeepSeekProvider({ sessionDir: root });
    const [unit] = provider.discover(context());
    assert.ok(unit);
    const records = [...provider.parse(unit, null)];
    const messages = records.filter(record => record.kind === 'message');
    assert.equal(records.find(record => record.kind === 'session').title, 'first question');
    assert.equal(records.find(record => record.kind === 'session').message_count, 1);
    assert.deepEqual(messages.map(message => message.visibility), ['inactive', 'inactive', 'inactive', 'inactive', 'visible']);
    assert.equal(messages.find(message => message.text === null).input_tokens, 13);
    assert.equal(messages.find(message => message.text === null).output_tokens, 5);
    assert.equal(messages.at(-1).is_meta, 1);
    assert.equal(records.find(record => record.kind === 'tool_call').file_path, '/work/project/a.txt');
    assert.equal(records.find(record => record.kind === 'tool_result').content, 'file contents');
    assert.equal(records.find(record => record.kind === 'summary').content, 'Earlier work summarized');
    assert.match(provider.raw({ source: 'deepseek', messageUuid: messages[0].uuid, session: { id: unit.sessionId, jsonl_path: path }, agentId: null }).text, /first question/);
  } finally { close(); }
});

test('DeepSeek selects the newest generation and reads concatenated zstd frames', () => {
  const { root, sessionDir, close } = fixture();
  try {
    rows(join(sessionDir, 'session.jsonl'), [{ type: 'session', version: 0, id: 'old', createdAt: 1780000000000 }]);
    const path = join(sessionDir, 'session.v4.jsonl.zstd');
    writeFileSync(path, Buffer.from(COMPRESSED, 'base64'));
    const provider = createDeepSeekProvider({ sessionDir: root });
    const [unit] = provider.discover(context());
    assert.equal(unit.key, path);
    const records = [...provider.parse(unit, null)];
    assert.equal(records.find(record => record.kind === 'session').title, 'compressed needle');
    assert.equal(records.find(record => record.kind === 'session').message_count, 1);
  } finally { close(); }
});

test('DeepSeek retracts a deleted selected generation', () => {
  const { root, sessionDir, close } = fixture();
  try {
    const old = join(sessionDir, 'session.v3.jsonl');
    const provider = createDeepSeekProvider({ sessionDir: root });
    const [unit] = provider.discover(context([{ sessionId: 'deepseek:old', jsonlPath: old, source: 'deepseek' }]));
    assert.deepEqual(unit.retractSessionIds, ['deepseek:old']);
    assert.deepEqual([...provider.parse(unit, null)], []);
  } finally { close(); }
});

test('DeepSeek generation migration keeps the same indexed session', () => {
  const { root, sessionDir, close } = fixture();
  try {
    const oldPath = join(sessionDir, 'session.v3.jsonl');
    const newPath = join(sessionDir, 'session.v4.jsonl');
    const header = { type: 'session', id: 'same-session', createdAt: 1780000000000, cwd: '/work/project' };
    rows(oldPath, [{ ...header, version: 3 }]);
    const provider = createDeepSeekProvider({ sessionDir: root });
    const [oldUnit] = provider.discover(context());
    assert.equal(oldUnit.key, oldPath);
    rows(newPath, [{ ...header, version: 4 }, { type: 'user/message', seq: 0, time: 1780000000001, data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'migrated' }] }, surfaceOp: 'append' }]);
    const units = provider.discover(context([{ sessionId: oldUnit.sessionId, jsonlPath: oldPath, source: 'deepseek' }]));
    assert.deepEqual(units.map(unit => unit.key), [newPath]);
    assert.equal(units[0].sessionId, oldUnit.sessionId);
    assert.deepEqual(provider.discover(context([], [oldPath])).map(unit => unit.key), [newPath]);
  } finally { close(); }
});

test('DeepSeek v3 wrapped tool result links to its call', () => {
  const { root, sessionDir, close } = fixture();
  try {
    const path = join(sessionDir, 'session.v3.jsonl');
    rows(path, [
      { type: 'session', version: 3, id: 'wrapped', createdAt: 1780000000000, cwd: '/work/project' },
      { type: 'assistant/message', seq: 0, time: 1780000000001, data: { message: { role: 'assistant', content: [{ type: 'tool-call', id: 'call-1', name: 'read', arguments: '{"path":"a.txt"}' }] } }, surfaceOp: 'append' },
      { type: 'tool/call', seq: 1, time: 1780000000002, data: { callId: 'call-1', name: 'read', arguments: '{"path":"a.txt"}' } },
      { type: 'tool/result', seq: 2, time: 1780000000003, data: { message: { role: 'user', content: [{ type: 'tool-result', toolCallId: 'call-1', content: [{ type: 'text', text: 'wrapped output' }], isError: true }] } }, surfaceOp: 'append' },
    ]);
    const provider = createDeepSeekProvider({ sessionDir: root });
    const [unit] = provider.discover(context());
    const records = [...provider.parse(unit, null)];
    const call = records.find(record => record.kind === 'tool_call');
    const result = records.find(record => record.kind === 'tool_result');
    assert.equal(result.tool_use_id, call.id);
    assert.equal(result.content, 'wrapped output');
    assert.equal(result.is_error, 1);
  } finally { close(); }
});

test('DeepSeek isolates an unreadable generation from other sessions', () => {
  const { root, sessionDir, close } = fixture();
  try {
    writeFileSync(join(sessionDir, 'session.v4.jsonl'), '{broken}\n');
    const validDir = join(root, '--work--', 'valid');
    mkdirSync(validDir);
    rows(join(validDir, 'session.v4.jsonl'), [
      { type: 'session', version: 4, id: 'valid', createdAt: 1780000000000, cwd: '/work' },
    ]);
    const provider = createDeepSeekProvider({ sessionDir: root });
    const units = provider.discover(context());
    assert.equal(units.length, 2);
    assert.equal(units.some(unit => unit.sessionId.startsWith('deepseek:unreadable:')), true);
    assert.equal(units.some(unit => unit.sessionId.startsWith('deepseek:valid:')), true);
  } finally { close(); }
});

test('DeepSeek child session is not indexed as a top-level conversation', () => {
  const { root, sessionDir, close } = fixture();
  try {
    rows(join(sessionDir, 'session.v4.jsonl'), [
      { type: 'session', version: 4, id: 'child', createdAt: 1780000000000, cwd: '/work', origin: 'subagent' },
      { type: 'user/message', seq: 0, time: 1780000000001, data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'child work' }] }, surfaceOp: 'append' },
    ]);
    const provider = createDeepSeekProvider({ sessionDir: root });
    const [unit] = provider.discover(context());
    assert.deepEqual([...provider.parse(unit, null)], []);
    assert.equal(unit.meta.subagent, true);
  } finally { close(); }
});
