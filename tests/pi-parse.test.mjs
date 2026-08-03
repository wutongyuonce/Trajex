import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPiProvider, PI_CANONICAL_TRANSCRIPT_MARKER } from '../packages/core/src/providers/pi.ts';

function drain(generator) { const records = []; for (let step = generator.next(); !step.done; step = generator.next()) records.push(step.value); return records; }

test('Pi indexes every tree branch and marks non-current messages as sidechain', () => {
  assert.equal(PI_CANONICAL_TRANSCRIPT_MARKER, '__pi_canonical_transcript_v2__');
  const root = mkdtempSync(join(tmpdir(), 'trajex-pi-'));
  const dir = join(root, 'sessions', '--tmp-project--');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'session.jsonl');
  const entries = [
    { type: 'session', version: 3, id: 'session-1', timestamp: '2026-07-30T10:00:00.000Z', cwd: '/tmp/project' },
    { type: 'message', id: 'u1', parentId: null, timestamp: '2026-07-30T10:00:01.000Z', message: { role: 'user', content: 'keep prompt' } },
    { type: 'message', id: 'a1', parentId: 'u1', timestamp: '2026-07-30T10:00:02.000Z', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'reason' }, { type: 'toolCall', id: 'call-1', name: 'Read', arguments: { file_path: '/tmp/a' } }] } },
    { type: 'message', id: 'r1', parentId: 'a1', timestamp: '2026-07-30T10:00:03.000Z', message: { role: 'toolResult', toolCallId: 'call-1', toolName: 'Read', content: [{ type: 'text', text: 'file body' }], isError: false } },
    { type: 'compaction', id: 'c1', parentId: 'r1', timestamp: '2026-07-30T10:00:04.000Z', summary: 'earlier work' },
    { type: 'branch_summary', id: 'b1', parentId: 'c1', timestamp: '2026-07-30T10:00:04.500Z', summary: 'abandoned branch summary' },
    { type: 'session_info', id: 'n1', parentId: 'c1', timestamp: '2026-07-30T10:00:05.000Z', name: 'Pi fixture' },
    { type: 'message', id: 'old', parentId: 'u1', timestamp: '2026-07-30T10:00:06.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'abandoned branch' }] } },
    { type: 'message', id: 'current', parentId: 'n1', timestamp: '2026-07-30T10:00:07.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'kept answer' }], usage: { input: 4, output: 2 } } },
  ];
  writeFileSync(path, entries.map(JSON.stringify).join('\n') + '\n');
  const provider = createPiProvider({ rootDir: root });
  const unit = provider.discover({ lastCursor: () => null })[0];
  assert.equal(unit.sessionId, 'pi:session-1');
  const records = drain(provider.parse(unit, null));
  const messages = records.filter(record => record.kind === 'message');
  assert.deepEqual(messages.map(record => record.text), ['keep prompt', 'reason', null, 'file body', 'abandoned branch', 'kept answer']);
  assert.deepEqual(messages.at(-1).input_tokens, 4);
  assert.deepEqual(messages.at(-1).output_tokens, 2);
  assert.equal(messages.find(record => record.text === 'abandoned branch').is_sidechain, 1);
  assert.equal(messages.find(record => record.text === 'kept answer').is_sidechain, 0);
  assert.deepEqual(records.filter(record => record.kind === 'tool_call').map(record => record.id), ['pi:session-1:call-1']);
  assert.deepEqual(records.filter(record => record.kind === 'tool_result').map(record => record.tool_use_id), ['pi:session-1:call-1']);
  assert.deepEqual(records.filter(record => record.kind === 'summary').map(record => ({ source: record.source, content: record.content })), [
    { source: 'compaction', content: 'earlier work' },
    { source: 'branch_summary', content: 'abandoned branch summary' },
  ]);
  assert.deepEqual(records.find(record => record.kind === 'session' && record.id === 'pi:session-1'), { kind: 'session', id: 'pi:session-1', title: 'Pi fixture', project: '-tmp-project', started_at: '2026-07-30T10:00:00.000Z', ended_at: '2026-07-30T10:00:07.000Z', git_branch: null, version: '3', message_count: 6, countMode: 'total', jsonl_path: path, source: 'pi' });
});

test('Pi discovers standard top-level v3 sessions and ignores a torn final line', () => {
  const root = mkdtempSync(join(tmpdir(), 'trajex-pi-discover-'));
  const projectDir = join(root, 'sessions', '--tmp-project--');
  const path = join(projectDir, 'fixture.jsonl');
  mkdirSync(join(projectDir, 'nested', 'subagents'), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ type: 'session', version: 3, id: 'top-level', cwd: '/tmp/project' })}\n`);
  writeFileSync(join(projectDir, 'nested', 'subagents', 'ignored.jsonl'), `${JSON.stringify({ type: 'session', version: 3, id: 'nested' })}\n`);
  appendFileSync(path, '{"type":"message"');

  const provider = createPiProvider({ rootDir: root });
  const [unit] = provider.discover({ lastCursor: () => null });
  assert.equal(unit.key, path);
  assert.equal(provider.discover({ lastCursor: () => '9999999999999:1' }).length, 0);
  assert.equal(drain(provider.parse(unit, null)).filter(record => record.kind === 'session').length, 1);
});

test('Pi rejects a malformed complete JSONL line instead of deleting valid history', () => {
  const root = mkdtempSync(join(tmpdir(), 'trajex-pi-malformed-'));
  const dir = join(root, 'sessions', '--project--');
  const path = join(dir, 'fixture.jsonl');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, [
    JSON.stringify({ type: 'session', version: 3, id: 'malformed' }),
    '{bad json}',
    JSON.stringify({ type: 'message', id: 'after', parentId: null, message: { role: 'user', content: 'must not index' } }),
  ].join('\n') + '\n');

  const provider = createPiProvider({ rootDir: root });
  const unit = provider.discover({ lastCursor: () => null })[0];
  assert.throws(() => drain(provider.parse(unit, null)), /Pi session: corrupted line 2/);
});
