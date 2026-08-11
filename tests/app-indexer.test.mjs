import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { appendFileSync, mkdtempSync, mkdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
import { buildIndex } from '../app/src/main/indexer.ts';
import { CLAUDE_CANONICAL_TRANSCRIPT_MARKER } from '../packages/core/src/providers/claude.ts';
import { CODEX_CANONICAL_TRANSCRIPT_MARKER } from '../packages/core/src/providers/codex.ts';
const { DatabaseSync } = require('node:sqlite');

class TestDatabase {
  constructor(dbPath) {
    this.db = new DatabaseSync(dbPath);
  }

  pragma(statement) {
    this.db.exec(`PRAGMA ${statement}`);
  }

  exec(sql) {
    return this.db.exec(sql);
  }

  prepare(sql) {
    return this.db.prepare(sql);
  }

  close() {
    return this.db.close();
  }
}

test('app indexer records build success without claiming daemon ownership', () => {
  const home = mkdtempSync(join(tmpdir(), 'trajex-app-indexer-'));
  const claudeDir = join(home, '.claude');
  const projectDir = join(claudeDir, 'projects', '-tmp-trajex-app');
  mkdirSync(projectDir, { recursive: true });
  const sessionId = 'session-app-1';
  const jsonlPath = join(projectDir, `${sessionId}.jsonl`);
  writeFileSync(jsonlPath, [
    JSON.stringify({
      uuid: 'msg-app-1',
      type: 'user',
      timestamp: '2026-06-13T10:00:00Z',
      cwd: '/tmp/trajex-app',
      message: { role: 'user', content: [{ type: 'text', text: 'hello from app indexer' }] },
    }),
    '',
  ].join('\n'));

  const dbPath = join(claudeDir, 'trajex.sqlite');
  const firstBuild = buildIndex({ claudeDir, dbPath, DatabaseImpl: TestDatabase });

  const db = new TestDatabase(dbPath);
  assert.equal(db.prepare('SELECT text FROM messages WHERE uuid=?').get('msg-app-1').text, 'hello from app indexer');
  assert.deepEqual(firstBuild.affectedSessionIds, [sessionId]);
  assert.equal(firstBuild.ftsRebuilt, true);
  assert.equal(db.prepare("SELECT uuid FROM messages_fts WHERE messages_fts MATCH 'hello'").get().uuid, 'msg-app-1');
  assert.equal(db.prepare("SELECT jsonl_path FROM index_state WHERE jsonl_path='__app_heartbeat__'").get(), undefined);
  assert.equal(db.prepare("SELECT jsonl_path FROM index_state WHERE jsonl_path='__app_last_successful_build__'").get().jsonl_path, '__app_last_successful_build__');
  assert.equal(db.prepare('SELECT project_path FROM sessions WHERE id=?').get(sessionId).project_path, '/tmp/trajex-app');
  db.close();

  appendFileSync(jsonlPath, [
    JSON.stringify({
      uuid: 'msg-app-2',
      type: 'assistant',
      timestamp: '2026-06-13T10:01:00Z',
      message: { role: 'assistant', content: [{ type: 'text', text: 'companion view updated quickly' }] },
    }),
    '',
  ].join('\n'));
  const nextMtime = new Date(Date.now() + 2000);
  utimesSync(jsonlPath, nextMtime, nextMtime);

  const secondBuild = buildIndex({
    claudeDir,
    dbPath,
    DatabaseImpl: TestDatabase,
    changedPaths: [`-tmp-trajex-app/${sessionId}.jsonl`],
  });
  assert.deepEqual(secondBuild.affectedSessionIds, [sessionId]);
  assert.equal(secondBuild.ftsRebuilt, false);

  const db2 = new TestDatabase(dbPath);
  assert.equal(db2.prepare("SELECT uuid FROM messages_fts WHERE messages_fts MATCH 'companion'").get().uuid, 'msg-app-2');
  assert.equal(db2.prepare('SELECT message_count FROM sessions WHERE id=?').get(sessionId).message_count, 2);
  db2.close();
});

test('app indexer refreshes unchanged Claude usage when input token semantics change', () => {
  const home = mkdtempSync(join(tmpdir(), 'trajex-app-indexer-token-semantics-'));
  const claudeDir = join(home, '.claude');
  const projectDir = join(claudeDir, 'projects', '-tmp-trajex-app');
  mkdirSync(projectDir, { recursive: true });
  const sessionId = 'session-token-semantics-1';
  const jsonlPath = join(projectDir, `${sessionId}.jsonl`);
  writeFileSync(jsonlPath, [
    JSON.stringify({
      uuid: 'msg-token-semantics-1',
      type: 'assistant',
      timestamp: '2026-06-13T10:00:00Z',
      cwd: '/tmp/trajex-app',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'cached response' }],
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          cache_creation_input_tokens: 20,
          cache_read_input_tokens: 30,
        },
      },
    }),
    '',
  ].join('\n'));

  const dbPath = join(claudeDir, 'trajex.sqlite');
  buildIndex({ claudeDir, dbPath, DatabaseImpl: TestDatabase });

  const stale = new TestDatabase(dbPath);
  stale.prepare('UPDATE messages SET input_tokens = 10 WHERE uuid = ?').run('msg-token-semantics-1');
  stale.prepare('DELETE FROM index_state WHERE jsonl_path = ?')
    .run(CLAUDE_CANONICAL_TRANSCRIPT_MARKER);
  stale.close();

  buildIndex({
    claudeDir,
    dbPath,
    DatabaseImpl: TestDatabase,
    changedPaths: [`-tmp-trajex-app/${sessionId}.jsonl`],
  });

  const refreshed = new TestDatabase(dbPath);
  assert.equal(
    refreshed.prepare('SELECT input_tokens FROM messages WHERE uuid = ?').get('msg-token-semantics-1').input_tokens,
    60,
  );
  assert.ok(
    refreshed.prepare('SELECT jsonl_path FROM index_state WHERE jsonl_path = ?')
      .get(CLAUDE_CANONICAL_TRANSCRIPT_MARKER),
  );
  refreshed.close();
});

test('force rebuild ignores stale JSONL index_state rows after session tables were cleared', () => {
  const home = mkdtempSync(join(tmpdir(), 'trajex-app-indexer-force-'));
  const claudeDir = join(home, '.claude');
  const projectDir = join(claudeDir, 'projects', '-tmp-trajex-app');
  mkdirSync(projectDir, { recursive: true });
  const sessionId = 'session-force-1';
  const jsonlPath = join(projectDir, `${sessionId}.jsonl`);
  writeFileSync(jsonlPath, [
    JSON.stringify({
      uuid: 'msg-force-1',
      type: 'user',
      timestamp: '2026-06-13T10:00:00Z',
      cwd: '/tmp/trajex-app',
      message: { role: 'user', content: [{ type: 'text', text: 'force rebuild should not trust stale state' }] },
    }),
    '',
  ].join('\n'));

  const dbPath = join(claudeDir, 'trajex.sqlite');
  buildIndex({ claudeDir, dbPath, DatabaseImpl: TestDatabase });

  const broken = new TestDatabase(dbPath);
  assert.equal(broken.prepare('SELECT COUNT(*) AS c FROM index_state WHERE jsonl_path = ?').get(jsonlPath).c, 1);
  broken.prepare('DELETE FROM messages').run();
  broken.prepare('DELETE FROM sessions').run();
  broken.close();

  buildIndex({ claudeDir, dbPath, DatabaseImpl: TestDatabase, force: true });

  const db = new TestDatabase(dbPath);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM sessions').get().c, 1);
  assert.equal(db.prepare('SELECT text FROM messages WHERE uuid=?').get('msg-force-1').text, 'force rebuild should not trust stale state');
  db.close();
});

test('force rebuild bypasses stale message FTS delete triggers', () => {
  const home = mkdtempSync(join(tmpdir(), 'trajex-app-indexer-force-fts-'));
  const claudeDir = join(home, '.claude');
  const projectDir = join(claudeDir, 'projects', '-tmp-trajex-app');
  mkdirSync(projectDir, { recursive: true });
  const sessionId = 'session-force-fts-1';
  const jsonlPath = join(projectDir, `${sessionId}.jsonl`);
  writeFileSync(jsonlPath, [
    JSON.stringify({
      uuid: 'msg-force-fts-1',
      type: 'user',
      timestamp: '2026-06-13T10:00:00Z',
      cwd: '/tmp/trajex-app',
      message: { role: 'user', content: [{ type: 'text', text: 'force rebuild should bulk clear without old fts deletes' }] },
    }),
    '',
  ].join('\n'));

  const dbPath = join(claudeDir, 'trajex.sqlite');
  buildIndex({ claudeDir, dbPath, DatabaseImpl: TestDatabase });

  const trapped = new TestDatabase(dbPath);
  trapped.exec('DROP TRIGGER messages_fts_ad');
  trapped.exec(`
    CREATE TRIGGER messages_fts_ad AFTER DELETE ON messages BEGIN
      SELECT RAISE(FAIL, 'message FTS delete trigger fired during force rebuild');
    END;
  `);
  trapped.close();

  assert.doesNotThrow(() => {
    buildIndex({ claudeDir, dbPath, DatabaseImpl: TestDatabase, force: true });
  });

  const db = new TestDatabase(dbPath);
  assert.equal(db.prepare('SELECT text FROM messages WHERE uuid=?').get('msg-force-fts-1').text, 'force rebuild should bulk clear without old fts deletes');
  assert.equal(db.prepare("SELECT uuid FROM messages_fts WHERE messages_fts MATCH 'bulk'").get().uuid, 'msg-force-fts-1');
  const trigger = db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='messages_fts_ad'").get();
  assert.match(trigger.sql, /INSERT INTO messages_fts/);
  db.close();
});

test('force rebuild into a new database preserves existing memories', () => {
  const home = mkdtempSync(join(tmpdir(), 'trajex-app-indexer-force-preserve-'));
  const claudeDir = join(home, '.claude');
  const projectDir = join(claudeDir, 'projects', '-tmp-trajex-app');
  mkdirSync(projectDir, { recursive: true });
  const sessionId = 'session-force-preserve-1';
  writeFileSync(join(projectDir, `${sessionId}.jsonl`), [
    JSON.stringify({
      uuid: 'msg-force-preserve-1',
      type: 'user',
      timestamp: '2026-06-13T10:00:00Z',
      cwd: '/tmp/trajex-app',
      message: { role: 'user', content: [{ type: 'text', text: 'force rebuild should preserve memories' }] },
    }),
    '',
  ].join('\n'));

  const dbPath = join(home, '.trajex', 'trajex.sqlite');
  const tempDbPath = join(home, '.trajex', 'trajex.rebuild.tmp');
  buildIndex({ claudeDir, dbPath, DatabaseImpl: TestDatabase });

  const sourceDb = new TestDatabase(dbPath);
  sourceDb.prepare(`
    INSERT INTO memories (id,session_id,project,message_start,message_end,path,anchors,summary,created_at,deleted_at,deleted_reason)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    'mem-preserve-1',
    sessionId,
    '-tmp-trajex-app',
    'msg-force-preserve-1',
    'msg-force-preserve-1',
    '/tmp/trajex-app/notes.md',
    '[]',
    'Decision: preserve memories when rebuilding the session index.',
    '2026-06-13T10:05:00Z',
    null,
    null,
  );
  sourceDb.close();

  buildIndex({
    claudeDir,
    dbPath: tempDbPath,
    DatabaseImpl: TestDatabase,
    force: true,
    preserveDbPath: dbPath,
  });

  const db = new TestDatabase(tempDbPath);
  const memory = db.prepare('SELECT id, summary FROM memories WHERE id=?').get('mem-preserve-1');
  assert.equal(memory.summary, 'Decision: preserve memories when rebuilding the session index.');
  assert.equal(db.prepare("SELECT id FROM memories_fts WHERE memories_fts MATCH 'preserve'").get().id, 'mem-preserve-1');
  assert.equal(db.prepare('SELECT text FROM messages WHERE uuid=?').get('msg-force-preserve-1').text, 'force rebuild should preserve memories');
  db.close();
});

test('app indexer reports changed workflow JSON as an affected session', () => {
  const home = mkdtempSync(join(tmpdir(), 'trajex-app-indexer-workflow-'));
  const claudeDir = join(home, '.claude');
  const project = '-tmp-trajex-app';
  const sessionId = 'session-workflow-1';
  const projectDir = join(claudeDir, 'projects', project);
  const workflowDir = join(projectDir, sessionId, 'workflows');
  mkdirSync(workflowDir, { recursive: true });
  const jsonlPath = join(projectDir, `${sessionId}.jsonl`);
  writeFileSync(jsonlPath, [
    JSON.stringify({
      uuid: 'msg-workflow-1',
      type: 'user',
      timestamp: '2026-06-13T10:00:00Z',
      cwd: '/tmp/trajex-app',
      message: { role: 'user', content: [{ type: 'text', text: 'start workflow' }] },
    }),
    '',
  ].join('\n'));

  const dbPath = join(claudeDir, 'trajex.sqlite');
  buildIndex({ claudeDir, dbPath, DatabaseImpl: TestDatabase });

  const workflowPath = join(workflowDir, 'run-1.json');
  writeFileSync(workflowPath, JSON.stringify({
    runId: 'run-1',
    timestamp: '2026-06-13T10:01:00Z',
    workflowName: 'review',
  }));

  const result = buildIndex({
    claudeDir,
    dbPath,
    DatabaseImpl: TestDatabase,
    changedPaths: [`${project}/${sessionId}/workflows/run-1.json`],
  });

  assert.deepEqual(result.affectedSessionIds, [sessionId]);
});

test('app indexer marks UI-fallback control messages as meta at ingest time', () => {
  const home = mkdtempSync(join(tmpdir(), 'trajex-app-indexer-meta-'));
  const claudeDir = join(home, '.claude');
  const projectDir = join(claudeDir, 'projects', '-tmp-trajex-app');
  mkdirSync(projectDir, { recursive: true });
  const sessionId = 'session-meta-1';
  const jsonlPath = join(projectDir, `${sessionId}.jsonl`);
  writeFileSync(jsonlPath, [
    JSON.stringify({
      uuid: 'msg-meta-system-reminder',
      type: 'user',
      timestamp: '2026-06-13T10:00:00Z',
      message: { role: 'user', content: [{ type: 'text', text: '<system-reminder>Keep answers concise</system-reminder>' }] },
    }),
    JSON.stringify({
      uuid: 'msg-meta-local-command',
      type: 'user',
      timestamp: '2026-06-13T10:01:00Z',
      message: { role: 'user', content: [{ type: 'text', text: '<local-command>git status</local-command>' }] },
    }),
    JSON.stringify({
      uuid: 'msg-meta-normal',
      type: 'user',
      timestamp: '2026-06-13T10:02:00Z',
      message: { role: 'user', content: [{ type: 'text', text: 'normal user request' }] },
    }),
    '',
  ].join('\n'));

  const dbPath = join(claudeDir, 'trajex.sqlite');
  buildIndex({ claudeDir, dbPath, DatabaseImpl: TestDatabase });

  const db = new TestDatabase(dbPath);
  assert.equal(db.prepare('SELECT is_meta FROM messages WHERE uuid=?').get('msg-meta-system-reminder').is_meta, 1);
  assert.equal(db.prepare('SELECT is_meta FROM messages WHERE uuid=?').get('msg-meta-local-command').is_meta, 1);
  assert.equal(db.prepare('SELECT is_meta FROM messages WHERE uuid=?').get('msg-meta-normal').is_meta, 0);
  db.close();
});

test('app indexer loads Codex root sessions into the shared schema', () => {
  const home = mkdtempSync(join(tmpdir(), 'trajex-app-indexer-codex-'));
  const claudeDir = join(home, '.claude');
  const codexDir = join(home, '.codex');
  const codexSessionDir = join(codexDir, 'sessions', '2026', '06', '15');
  mkdirSync(join(claudeDir, 'projects'), { recursive: true });
  mkdirSync(codexSessionDir, { recursive: true });

  const codexId = '019ec6ee-cebd-7431-9c93-ceec89a98a5f';
  const jsonlPath = join(codexSessionDir, `rollout-2026-06-15T00-19-59-${codexId}.jsonl`);
  writeFileSync(jsonlPath, [
    JSON.stringify({
      timestamp: '2026-06-14T16:19:59.842Z',
      type: 'session_meta',
      payload: {
        id: codexId,
        timestamp: '2026-06-14T16:19:59.842Z',
        cwd: '/tmp/trajex-app',
        cli_version: '0.135.0-alpha.1',
        originator: 'Codex Desktop',
        source: 'vscode',
        thread_source: 'user',
        git: { branch: 'feat/codex' },
      },
    }),
    JSON.stringify({
      timestamp: '2026-06-14T16:20:00.000Z',
      type: 'event_msg',
      payload: { type: 'user_message', message: 'codex user asks for indexing', images: [], local_images: [], text_elements: [] },
    }),
    JSON.stringify({
      timestamp: '2026-06-14T16:20:01.000Z',
      type: 'event_msg',
      payload: { type: 'agent_message', phase: 'final_answer', message: 'codex assistant replies' },
    }),
    JSON.stringify({
      timestamp: '2026-06-14T16:20:02.000Z',
      type: 'response_item',
      payload: { type: 'function_call', call_id: 'call_codex_1', name: 'exec_command', arguments: '{"cmd":"pwd"}' },
    }),
    JSON.stringify({
      timestamp: '2026-06-14T16:20:03.000Z',
      type: 'response_item',
      payload: { type: 'function_call_output', call_id: 'call_codex_1', output: '/tmp/trajex-app' },
    }),
    JSON.stringify({
      timestamp: '2026-06-14T16:20:04.000Z',
      type: 'event_msg',
      payload: {
        type: 'task_complete',
        completed_at: 1781454004,
        duration_ms: 4321,
        turn_id: 'turn-1',
        last_agent_message: 'codex assistant replies',
      },
    }),
    '',
  ].join('\n'));

  const dbPath = join(home, '.trajex', 'trajex.sqlite');
  const result = buildIndex({ claudeDir, codexDir, dbPath, DatabaseImpl: TestDatabase });

  const db = new TestDatabase(dbPath);
  const session = db.prepare('SELECT * FROM sessions WHERE id=?').get(`codex:${codexId}`);
  assert.equal(session.source, 'codex');
  assert.equal(session.project, '-tmp-trajex-app');
  assert.equal(session.project_path, '/tmp/trajex-app');
  assert.equal(session.git_branch, 'feat/codex');
  assert.equal(session.version, '0.135.0-alpha.1');
  assert.equal(session.message_count, 4);
  assert.deepEqual(result.affectedSessionIds, [`codex:${codexId}`]);

  const messages = db.prepare('SELECT role, text, source, content_type, turn_duration_ms FROM messages WHERE session_id=? ORDER BY timestamp, uuid').all(`codex:${codexId}`);
  assert.deepEqual(messages.map(m => [m.role, m.text, m.source, m.content_type]), [
    ['user', 'codex user asks for indexing', 'codex', 'text'],
    ['assistant', 'codex assistant replies', 'codex', 'text'],
    ['assistant', null, 'codex', 'tool_use'],
    ['user', '/tmp/trajex-app', 'codex', 'tool_result'],
  ]);
  assert.equal(messages[1].turn_duration_ms, 4321);

  const toolId = `codex:${codexId}:call_codex_1`;
  const tool = db.prepare('SELECT * FROM tool_calls WHERE id=?').get(toolId);
  assert.equal(tool.session_id, `codex:${codexId}`);
  assert.equal(tool.name, 'exec_command');
  assert.equal(tool.message_uuid, `codex:${codexId}:000004`);
  const toolResult = db.prepare('SELECT message_uuid, content FROM tool_results WHERE tool_use_id=?').get(toolId);
  assert.equal(toolResult.message_uuid, `codex:${codexId}:000005`);
  assert.equal(toolResult.content, '/tmp/trajex-app');
  db.close();
});

test('app indexer accepts Codex changed paths relative to the sessions directory', () => {
  const home = mkdtempSync(join(tmpdir(), 'trajex-app-indexer-codex-sessions-change-'));
  const claudeDir = join(home, '.claude');
  const codexDir = join(home, '.codex');
  const codexSessionDir = join(codexDir, 'sessions', '2026', '06', '15');
  mkdirSync(join(claudeDir, 'projects'), { recursive: true });
  mkdirSync(codexSessionDir, { recursive: true });

  const codexId = '019ec6ee-cebd-7431-9c93-ceec89a98a5f';
  const filename = `rollout-2026-06-15T00-19-59-${codexId}.jsonl`;
  writeFileSync(join(codexSessionDir, filename), [
    JSON.stringify({
      timestamp: '2026-06-14T16:19:59.842Z',
      type: 'session_meta',
      payload: {
        id: codexId,
        timestamp: '2026-06-14T16:19:59.842Z',
        cwd: '/tmp/trajex-app',
        cli_version: '0.135.0-alpha.1',
        thread_source: 'user',
      },
    }),
    JSON.stringify({
      timestamp: '2026-06-14T16:20:00.000Z',
      type: 'event_msg',
      payload: { type: 'user_message', message: 'sessions-relative codex change', images: [], local_images: [], text_elements: [] },
    }),
    '',
  ].join('\n'));

  const dbPath = join(home, '.trajex', 'trajex.sqlite');
  const result = buildIndex({
    claudeDir,
    codexDir,
    dbPath,
    DatabaseImpl: TestDatabase,
    changedPaths: [join('2026', '06', '15', filename)],
  });

  const db = new TestDatabase(dbPath);
  assert.deepEqual(result.affectedSessionIds, [`codex:${codexId}`]);
  assert.equal(
    db.prepare('SELECT text FROM messages WHERE session_id=?').get(`codex:${codexId}`).text,
    'sessions-relative codex change',
  );
  db.close();
});

test('app indexer uses Codex response_item messages only when no visible event message exists', () => {
  const home = mkdtempSync(join(tmpdir(), 'trajex-app-indexer-codex-response-message-'));
  const claudeDir = join(home, '.claude');
  const codexDir = join(home, '.codex');
  const codexSessionDir = join(codexDir, 'sessions', '2026', '06', '15');
  mkdirSync(join(claudeDir, 'projects'), { recursive: true });
  mkdirSync(codexSessionDir, { recursive: true });

  const codexId = '019ec6ee-cebd-7431-9c93-ceec89a98a5f';
  writeFileSync(join(codexSessionDir, `rollout-2026-06-15T00-19-59-${codexId}.jsonl`), [
    JSON.stringify({
      timestamp: '2026-06-14T16:19:59.842Z',
      type: 'session_meta',
      payload: {
        id: codexId,
        timestamp: '2026-06-14T16:19:59.842Z',
        cwd: '/tmp/trajex-app',
        cli_version: '0.135.0-alpha.1',
        source: 'vscode',
      },
    }),
    JSON.stringify({
      timestamp: '2026-06-14T16:20:00.000Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'developer',
        content: [{ type: 'input_text', text: 'developer context should not be indexed' }],
      },
    }),
    JSON.stringify({
      timestamp: '2026-06-14T16:20:01.000Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        phase: 'final_answer',
        content: [{ type: 'output_text', text: 'assistant fallback message' }],
      },
    }),
    JSON.stringify({
      timestamp: '2026-06-14T16:20:02.000Z',
      type: 'event_msg',
      payload: { type: 'agent_message', phase: 'final_answer', message: 'assistant event message' },
    }),
    JSON.stringify({
      timestamp: '2026-06-14T16:20:03.000Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        phase: 'final_answer',
        content: [{ type: 'output_text', text: 'assistant event message' }],
      },
    }),
    '',
  ].join('\n'));

  const dbPath = join(home, '.trajex', 'trajex.sqlite');
  buildIndex({ claudeDir, codexDir, dbPath, DatabaseImpl: TestDatabase });

  const db = new TestDatabase(dbPath);
  const rows = db.prepare('SELECT text FROM messages WHERE session_id=? ORDER BY timestamp, uuid').all(`codex:${codexId}`);
  assert.deepEqual(rows.map(row => row.text), [
    'assistant fallback message',
    'assistant event message',
  ]);
  db.close();
});

test('app indexer skips Codex guardian review threads', () => {
  const home = mkdtempSync(join(tmpdir(), 'trajex-app-indexer-codex-guardian-'));
  const claudeDir = join(home, '.claude');
  const codexDir = join(home, '.codex');
  const codexSessionDir = join(codexDir, 'sessions', '2026', '06', '15');
  mkdirSync(join(claudeDir, 'projects'), { recursive: true });
  mkdirSync(codexSessionDir, { recursive: true });

  const guardianId = '019ed5c4-8d52-7bc0-91f3-447a15e987d1';
  writeFileSync(join(codexSessionDir, `rollout-2026-06-15T02-12-00-${guardianId}.jsonl`), [
    JSON.stringify({
      timestamp: '2026-06-14T18:12:00.000Z',
      type: 'session_meta',
      payload: {
        id: guardianId,
        timestamp: '2026-06-14T18:12:00.000Z',
        cwd: '/tmp/trajex-app',
        cli_version: '0.135.0-alpha.1',
        thread_source: 'subagent',
        source: { subagent: { other: 'guardian' } },
      },
    }),
    JSON.stringify({
      timestamp: '2026-06-14T18:12:01.000Z',
      type: 'turn_context',
      payload: { cwd: '/tmp/trajex-app', model: 'codex-auto-review' },
    }),
    JSON.stringify({
      timestamp: '2026-06-14T18:12:02.000Z',
      type: 'event_msg',
      payload: { type: 'user_message', message: 'approval guardian prompt', images: [], local_images: [], text_elements: [] },
    }),
    JSON.stringify({
      timestamp: '2026-06-14T18:12:03.000Z',
      type: 'event_msg',
      payload: { type: 'agent_message', phase: 'final_answer', message: '{"outcome":"allow"}' },
    }),
    '',
  ].join('\n'));

  const dbPath = join(home, '.trajex', 'trajex.sqlite');
  const result = buildIndex({ claudeDir, codexDir, dbPath, DatabaseImpl: TestDatabase });

  const db = new TestDatabase(dbPath);
  assert.deepEqual(result.affectedSessionIds, []);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM sessions WHERE id=?').get(`codex:${guardianId}`).c, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM messages WHERE session_id=?').get(`codex:${guardianId}`).c, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM subagents WHERE agent_id=?').get(`codex:${guardianId}`).c, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM messages_fts WHERE messages_fts MATCH 'approval'").get().c, 0);
  db.close();
});

test('app indexer ignores Codex guardian rows without emitting cleanup', () => {
  const home = mkdtempSync(join(tmpdir(), 'trajex-app-indexer-codex-guardian-stale-'));
  const claudeDir = join(home, '.claude');
  const codexDir = join(home, '.codex');
  const codexSessionDir = join(codexDir, 'sessions', '2026', '06', '15');
  mkdirSync(join(claudeDir, 'projects'), { recursive: true });
  mkdirSync(codexSessionDir, { recursive: true });

  const guardianId = '019ed5c4-8d52-7bc0-91f3-447a15e987d1';
  const guardianSessionId = `codex:${guardianId}`;
  const jsonlPath = join(codexSessionDir, `rollout-2026-06-15T02-12-00-${guardianId}.jsonl`);
  writeFileSync(jsonlPath, [
    JSON.stringify({
      timestamp: '2026-06-14T18:12:00.000Z',
      type: 'session_meta',
      payload: {
        id: guardianId,
        timestamp: '2026-06-14T18:12:00.000Z',
        cwd: '/tmp/trajex-app',
        cli_version: '0.135.0-alpha.1',
        thread_source: 'subagent',
        source: { subagent: { other: 'guardian' } },
      },
    }),
    JSON.stringify({
      timestamp: '2026-06-14T18:12:01.000Z',
      type: 'event_msg',
      payload: { type: 'user_message', message: 'stale approval guardian prompt', images: [], local_images: [], text_elements: [] },
    }),
    '',
  ].join('\n'));

  const dbPath = join(home, '.trajex', 'trajex.sqlite');
  buildIndex({ claudeDir, codexDir: join(home, 'empty-codex'), dbPath, DatabaseImpl: TestDatabase });

  const db = new TestDatabase(dbPath);
  db.prepare('INSERT INTO sessions (id,jsonl_path,source,message_count) VALUES (?,?,?,?)').run(guardianSessionId, jsonlPath, 'codex', 1);
  db.prepare('INSERT INTO messages (uuid,session_id,type,timestamp,role,text,content_type,source) VALUES (?,?,?,?,?,?,?,?)')
    .run(`${guardianSessionId}:000002`, guardianSessionId, 'user', '2026-06-14T18:12:01.000Z', 'user', 'stale approval guardian prompt', 'text', 'codex');
  db.prepare('INSERT INTO tool_calls (id,message_uuid,session_id,name,input_json,file_path) VALUES (?,?,?,?,?,?)')
    .run('codex:call_guardian', `${guardianSessionId}:000002`, guardianSessionId, 'exec_command', '{}', null);
  db.prepare('INSERT INTO tool_results (tool_use_id,message_uuid,session_id,content,file_path,is_error) VALUES (?,?,?,?,?,?)')
    .run('codex:call_guardian', `${guardianSessionId}:000002`, guardianSessionId, 'ok', null, 0);
  db.prepare('INSERT INTO subagents (agent_id,session_id) VALUES (?,?)').run(guardianSessionId, guardianSessionId);
  db.prepare('INSERT OR REPLACE INTO index_state (jsonl_path,mtime,lines_processed) VALUES (?,?,?)')
    .run(jsonlPath, statSync(jsonlPath).mtimeMs, 2);
  db.close();

  buildIndex({ claudeDir, codexDir, dbPath, DatabaseImpl: TestDatabase });

  const cleanedDb = new TestDatabase(dbPath);
  assert.equal(cleanedDb.prepare('SELECT COUNT(*) AS c FROM sessions WHERE id=?').get(guardianSessionId).c, 1);
  assert.equal(cleanedDb.prepare('SELECT COUNT(*) AS c FROM messages WHERE session_id=?').get(guardianSessionId).c, 1);
  assert.equal(cleanedDb.prepare('SELECT COUNT(*) AS c FROM tool_calls WHERE session_id=?').get(guardianSessionId).c, 1);
  assert.equal(cleanedDb.prepare('SELECT COUNT(*) AS c FROM tool_results WHERE session_id=?').get(guardianSessionId).c, 1);
  assert.equal(cleanedDb.prepare('SELECT COUNT(*) AS c FROM subagents WHERE agent_id=?').get(guardianSessionId).c, 1);
  assert.equal(cleanedDb.prepare("SELECT COUNT(*) AS c FROM messages_fts WHERE messages_fts MATCH 'stale'").get().c, 1);
  cleanedDb.close();
});

test('app indexer skips Codex child threads and synthetic spawn calls', () => {
  const home = mkdtempSync(join(tmpdir(), 'trajex-app-indexer-codex-subagent-'));
  const claudeDir = join(home, '.claude');
  const codexDir = join(home, '.codex');
  const codexSessionDir = join(codexDir, 'sessions', '2026', '06', '15');
  mkdirSync(join(claudeDir, 'projects'), { recursive: true });
  mkdirSync(codexSessionDir, { recursive: true });

  const parentId = '019ec6ee-cebd-7431-9c93-ceec89a98a5f';
  const childId = '019ec739-9f75-7a02-ba2a-371986e23823';
  writeFileSync(join(codexSessionDir, `rollout-2026-06-15T00-19-59-${parentId}.jsonl`), [
    JSON.stringify({
      timestamp: '2026-06-14T16:19:59.842Z',
      type: 'session_meta',
      payload: {
        id: parentId,
        timestamp: '2026-06-14T16:19:59.842Z',
        cwd: '/tmp/trajex-app',
        cli_version: '0.135.0-alpha.1',
        source: 'vscode',
        git: { branch: 'feat/codex' },
      },
    }),
    JSON.stringify({
      timestamp: '2026-06-14T16:20:00.000Z',
      type: 'event_msg',
      payload: {
        type: 'collab_agent_spawn_end',
        call_id: 'call_spawn_1',
        sender_thread_id: parentId,
        new_thread_id: childId,
        new_agent_nickname: 'Plato',
        new_agent_role: 'worker',
        model: 'gpt-5.5',
        reasoning_effort: 'xhigh',
        prompt: 'inspect app-side codex indexing',
        status: 'pending_init',
      },
    }),
    '',
  ].join('\n'));
  writeFileSync(join(codexSessionDir, `rollout-2026-06-15T01-41-42-${childId}.jsonl`), [
    JSON.stringify({
      timestamp: '2026-06-14T17:41:42.924Z',
      type: 'session_meta',
      payload: {
        id: childId,
        timestamp: '2026-06-14T17:41:42.924Z',
        cwd: '/tmp/trajex-app',
        cli_version: '0.135.0-alpha.1',
        source: {
          subagent: {
            thread_spawn: {
              parent_thread_id: parentId,
              depth: 1,
              agent_nickname: 'Plato',
              agent_role: 'worker',
            },
          },
        },
        agent_nickname: 'Plato',
        agent_role: 'worker',
      },
    }),
    JSON.stringify({
      timestamp: '2026-06-14T17:41:43.000Z',
      type: 'event_msg',
      payload: { type: 'user_message', message: 'subagent prompt', images: [], local_images: [], text_elements: [] },
    }),
    JSON.stringify({
      timestamp: '2026-06-14T17:41:44.000Z',
      type: 'event_msg',
      payload: { type: 'agent_message', phase: 'final_answer', message: 'subagent answer' },
    }),
    JSON.stringify({
      timestamp: '2026-06-14T17:41:45.000Z',
      type: 'response_item',
      payload: { type: 'function_call', call_id: 'call_child_1', name: 'exec_command', arguments: '{"cmd":"pwd"}' },
    }),
    JSON.stringify({
      timestamp: '2026-06-14T17:41:46.000Z',
      type: 'response_item',
      payload: { type: 'function_call_output', call_id: 'call_child_1', output: '/tmp/trajex-app' },
    }),
    '',
  ].join('\n'));

  const dbPath = join(home, '.trajex', 'trajex.sqlite');
  buildIndex({ claudeDir, codexDir, dbPath, DatabaseImpl: TestDatabase });

  const db = new TestDatabase(dbPath);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM sessions WHERE id=?').get(`codex:${childId}`).c, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM subagents WHERE agent_id=?').get(`codex:${childId}`).c, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM messages WHERE session_id=?').get(`codex:${parentId}`).c, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM tool_calls WHERE session_id=?').get(`codex:${parentId}`).c, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM tool_results WHERE session_id=?').get(`codex:${parentId}`).c, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM messages WHERE agent_id=?').get(`codex:${childId}`).c, 0);
  db.close();
});

test('app Claude incrementally removes deleted transcripts but preserves the snapshot while projects is missing', () => {
  const home = mkdtempSync(join(tmpdir(), 'trajex-app-claude-delete-'));
  const claudeDir = join(home, '.claude');
  const projectDir = join(claudeDir, 'projects', '-tmp-claude-delete');
  const jsonlPath = join(projectDir, 'session-delete.jsonl');
  const dbPath = join(home, '.trajex', 'trajex.sqlite');
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(jsonlPath, `${JSON.stringify({ uuid: 'claude-delete-message', type: 'user', message: { role: 'user', content: 'delete me' } })}\n`);
  const options = { claudeDir, codexDir: join(home, 'empty-codex'), dbPath, DatabaseImpl: TestDatabase };

  assert.deepEqual(buildIndex(options).affectedSessionIds, ['session-delete']);
  rmSync(join(claudeDir, 'projects'), { recursive: true });
  const incomplete = buildIndex({ ...options, changedPaths: [jsonlPath] });
  assert.deepEqual(incomplete.affectedSessionIds, []);
  assert.equal(incomplete.inventoryIssues.length, 1);
  assert.equal(incomplete.inventoryIssues[0].provider, 'claude');
  assert.equal(incomplete.inventoryIssues[0].path, join(claudeDir, 'projects'));
  let db = new TestDatabase(dbPath);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM sessions WHERE id=?').get('session-delete').c, 1);
  db.close();

  mkdirSync(projectDir, { recursive: true });
  assert.deepEqual(buildIndex({ ...options, changedPaths: [jsonlPath] }).affectedSessionIds, ['session-delete']);
  db = new TestDatabase(dbPath);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM sessions WHERE id=?').get('session-delete').c, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM messages WHERE session_id=?').get('session-delete').c, 0);
  db.close();
});

test('app Codex incrementally removes deleted rollouts but preserves the snapshot while sessions is missing', () => {
  const home = mkdtempSync(join(tmpdir(), 'trajex-app-codex-delete-'));
  const codexDir = join(home, '.codex');
  const sessionDir = join(codexDir, 'sessions', '2026', '06', '15');
  const jsonlPath = join(sessionDir, 'rollout-delete.jsonl');
  const dbPath = join(home, '.trajex', 'trajex.sqlite');
  const rawId = '019e8951-3e7d-7343-a3e3-05bff48a317d';
  const sessionId = `codex:${rawId}`;
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(jsonlPath, [
    { type: 'session_meta', payload: { id: rawId, cwd: '/tmp/codex-delete', timestamp: '2026-06-15T10:00:00Z' } },
    { type: 'event_msg', payload: { type: 'user_message', message: 'delete me' } },
  ].map(JSON.stringify).join('\n') + '\n');
  const options = { claudeDir: join(home, 'empty-claude'), codexDir, dbPath, DatabaseImpl: TestDatabase };

  assert.deepEqual(buildIndex(options).affectedSessionIds, [sessionId]);
  rmSync(join(codexDir, 'sessions'), { recursive: true });
  assert.deepEqual(buildIndex({ ...options, changedPaths: [jsonlPath] }).affectedSessionIds, []);
  let db = new TestDatabase(dbPath);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM sessions WHERE id=?').get(sessionId).c, 1);
  db.close();

  mkdirSync(sessionDir, { recursive: true });
  assert.deepEqual(buildIndex({ ...options, changedPaths: [jsonlPath] }).affectedSessionIds, [sessionId]);
  db = new TestDatabase(dbPath);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM sessions WHERE id=?').get(sessionId).c, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM messages WHERE session_id=?').get(sessionId).c, 0);
  db.close();
});

test('app reports an unavailable Provider root and force rebuild aborts before cleanup', () => {
  const home = mkdtempSync(join(tmpdir(), 'trajex-app-force-root-preflight-'));
  const codexDir = join(home, '.codex');
  const sessionsDir = join(codexDir, 'sessions');
  const rolloutDir = join(sessionsDir, '2026', '06', '15');
  const rolloutPath = join(rolloutDir, 'rollout-preserved.jsonl');
  const dbPath = join(home, '.trajex', 'trajex.sqlite');
  const rawId = '019e8951-3e7d-7343-a3e3-05bff48a4000';
  const sessionId = `codex:${rawId}`;
  mkdirSync(rolloutDir, { recursive: true });
  writeFileSync(rolloutPath, [
    { type: 'session_meta', payload: { id: rawId, cwd: '/tmp/codex-preserved', timestamp: '2026-06-15T10:00:00Z' } },
    { type: 'event_msg', payload: { type: 'user_message', message: 'preserve this snapshot' } },
  ].map(JSON.stringify).join('\n') + '\n');
  const options = {
    claudeDir: join(home, 'empty-claude'),
    codexDir,
    dbPath,
    DatabaseImpl: TestDatabase,
  };

  buildIndex(options);
  rmSync(sessionsDir, { recursive: true });
  let db = new TestDatabase(dbPath);
  db.prepare('DELETE FROM index_state WHERE jsonl_path=?').run(CODEX_CANONICAL_TRANSCRIPT_MARKER);
  db.close();

  const backgroundRetry = buildIndex(options);
  assert.equal(backgroundRetry.inventoryIssues.length, 1);
  assert.equal(backgroundRetry.inventoryIssues[0].provider, 'codex');

  assert.throws(
    () => buildIndex({ ...options, force: true }),
    /Codex.*root.*unavailable|root.*unavailable.*Codex/i,
  );
  db = new TestDatabase(dbPath);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM sessions WHERE id=?').get(sessionId).c, 1);
  assert.equal(db.prepare('SELECT text FROM messages WHERE session_id=?').get(sessionId).text, 'preserve this snapshot');
  db.close();
});

test('app temp rebuild preflights Provider roots against provenance from the current database', () => {
  const home = mkdtempSync(join(tmpdir(), 'trajex-app-temp-root-preflight-'));
  const codexDir = join(home, '.codex');
  const sessionsDir = join(codexDir, 'sessions');
  const rolloutDir = join(sessionsDir, '2026', '06', '15');
  const rolloutPath = join(rolloutDir, 'rollout-current.jsonl');
  const dbPath = join(home, '.trajex', 'trajex.sqlite');
  const tempDbPath = join(home, '.trajex', 'trajex.rebuild.sqlite');
  const rawId = '019e8951-3e7d-7343-a3e3-05bff48a4001';
  const sessionId = `codex:${rawId}`;
  mkdirSync(rolloutDir, { recursive: true });
  writeFileSync(rolloutPath, [
    { type: 'session_meta', payload: { id: rawId, cwd: '/tmp/codex-current', timestamp: '2026-06-15T10:00:00Z' } },
    { type: 'event_msg', payload: { type: 'user_message', message: 'current database survives' } },
  ].map(JSON.stringify).join('\n') + '\n');
  const options = {
    claudeDir: join(home, 'empty-claude'),
    codexDir,
    dbPath,
    DatabaseImpl: TestDatabase,
  };

  buildIndex(options);
  rmSync(sessionsDir, { recursive: true });

  assert.throws(
    () => buildIndex({
      ...options,
      dbPath: tempDbPath,
      preserveDbPath: dbPath,
      force: true,
    }),
    /Codex.*root.*unavailable|root.*unavailable.*Codex/i,
  );
  const db = new TestDatabase(dbPath);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM sessions WHERE id=?').get(sessionId).c, 1);
  db.close();
});

test('app force rebuild aborts before cleanup when the indexed Claude projects root is unavailable', () => {
  const home = mkdtempSync(join(tmpdir(), 'trajex-app-claude-root-preflight-'));
  const claudeDir = join(home, '.claude');
  const projectsDir = join(claudeDir, 'projects');
  const projectDir = join(projectsDir, '-tmp-claude-force');
  const jsonlPath = join(projectDir, 'claude-force-session.jsonl');
  const dbPath = join(home, '.trajex', 'trajex.sqlite');
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(jsonlPath, `${JSON.stringify({
    uuid: 'claude-force-message',
    type: 'user',
    timestamp: '2026-06-15T10:00:00Z',
    message: { role: 'user', content: 'keep the Claude snapshot' },
  })}\n`);
  const options = {
    claudeDir,
    codexDir: join(home, 'empty-codex'),
    dbPath,
    DatabaseImpl: TestDatabase,
  };

  buildIndex(options);
  rmSync(projectsDir, { recursive: true });

  assert.throws(
    () => buildIndex({ ...options, force: true }),
    /Claude.*root.*unavailable|root.*unavailable.*Claude/i,
  );
  const db = new TestDatabase(dbPath);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM sessions WHERE id=?').get('claude-force-session').c, 1);
  db.close();
});

test('app Codex treats a missing descendant directory as an authoritative deletion', () => {
  const home = mkdtempSync(join(tmpdir(), 'trajex-app-codex-descendant-delete-'));
  const codexDir = join(home, '.codex');
  const sessionsDir = join(codexDir, 'sessions');
  const rolloutDir = join(sessionsDir, '2026', '06', '15');
  const rawId = '019e8951-3e7d-7343-a3e3-05bff48a4002';
  const sessionId = `codex:${rawId}`;
  const dbPath = join(home, '.trajex', 'trajex.sqlite');
  mkdirSync(rolloutDir, { recursive: true });
  writeFileSync(join(rolloutDir, 'rollout-descendant.jsonl'), [
    { type: 'session_meta', payload: { id: rawId, cwd: '/tmp/codex-descendant', timestamp: '2026-06-15T10:00:00Z' } },
    { type: 'event_msg', payload: { type: 'user_message', message: 'delete with descendant' } },
  ].map(JSON.stringify).join('\n') + '\n');
  const options = {
    claudeDir: join(home, 'empty-claude'),
    codexDir,
    dbPath,
    DatabaseImpl: TestDatabase,
  };

  buildIndex(options);
  rmSync(join(sessionsDir, '2026'), { recursive: true });
  buildIndex(options);

  const db = new TestDatabase(dbPath);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM sessions WHERE id=?').get(sessionId).c, 0);
  db.close();
});
