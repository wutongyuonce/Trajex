import { makeTempDir } from './temp-dirs.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { assembleSessionDetail } from '../app/src/shared/session-detail-assembly.mjs';
import { persist } from '../packages/core/src/persist.ts';
import { parse } from '../packages/core/src/providers/codex.ts';

const SCHEMA = readFileSync(new URL('../packages/core/src/schema.sql', import.meta.url), 'utf8');
const PARENT_ID = '019ed000-0000-7000-8000-000000000101';
const REPLAY_ID = '019ed000-0000-7000-8000-000000000102';

function writeRollout(path, meta, source) {
  writeFileSync(path, [
    { timestamp: '2026-06-15T10:00:00Z', type: 'session_meta', payload: meta },
    {
      timestamp: '2026-06-15T10:00:01Z',
      type: 'response_item',
      payload: { type: 'custom_tool_call', call_id: 'call_shared', name: 'exec', input: source },
    },
    {
      timestamp: '2026-06-15T10:00:02Z',
      type: 'response_item',
      payload: { type: 'custom_tool_call_output', call_id: 'call_shared', output: 'done' },
    },
  ].map(line => JSON.stringify(line)).join('\n') + '\n');
}

test('Codex root replay is indexed while fork rollout is ignored', () => {
  const dir = makeTempDir('trajex-codex-replay-');
  const parentPath = join(dir, 'parent.jsonl');
  const replayPath = join(dir, 'replay.jsonl');
  writeRollout(parentPath, {
    id: PARENT_ID,
    timestamp: '2026-06-15T10:00:00Z',
    cwd: '/proj',
  }, 'text("parent")');
  writeRollout(replayPath, {
    id: REPLAY_ID,
    forked_from_id: PARENT_ID,
    timestamp: '2026-06-15T10:00:00Z',
    cwd: '/proj',
  }, 'text("replay")');

  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  for (const path of [parentPath, replayPath]) {
    const unit = { key: path, sessionId: '', meta: { source: 'codex' } };
    persist(db, unit, parse(unit, null));
  }

  const sessionId = `codex:${PARENT_ID}`;
  const messages = db.prepare(
    'SELECT * FROM messages WHERE session_id=? AND agent_id IS NULL ORDER BY timestamp, uuid',
  ).all(sessionId);
  const toolCalls = db.prepare('SELECT * FROM tool_calls WHERE session_id=?').all(sessionId);
  const toolResults = db.prepare('SELECT * FROM tool_results WHERE session_id=?').all(sessionId);
  const replaySessionId = `codex:${REPLAY_ID}`;
  const replayMessages = db.prepare('SELECT * FROM messages WHERE session_id=?').all(replaySessionId);
  const replayToolCalls = db.prepare('SELECT * FROM tool_calls WHERE session_id=?').all(replaySessionId);
  const replayToolResults = db.prepare('SELECT * FROM tool_results WHERE session_id=?').all(replaySessionId);
  const assembled = assembleSessionDetail({ messages, toolCalls, toolResults, subagents: [], workflows: [] }).messages;

  assert.equal(messages.length, 2, 'the root includes the tool result message in its canonical timeline');
  assert.equal(toolCalls.length, 1);
  assert.equal(toolResults.length, 1);
  assert.equal(replayMessages.length, 0);
  assert.equal(replayToolCalls.length, 0);
  assert.equal(replayToolResults.length, 0);
  assert.deepEqual(assembled[0].tool_calls?.map(call => call.input_json), ['"text(\\"parent\\")"']);
  assert.equal(assembled[0].tool_calls?.[0].result?.content, 'done');
  db.close();
});
