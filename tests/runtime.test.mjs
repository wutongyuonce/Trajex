// Copyright (C) 2026 tommy0103 and contributors.
// Copyright (C) 2026 wutongyuonce and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

import { makeTempDir } from './temp-dirs.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, normalize } from 'node:path';

import { runCli as runRuntime } from './cli-test-helpers.mjs';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite');

function tempHome() {
  const home = makeTempDir('trajex-runtime-home-');
  mkdirSync(join(home, '.claude'), { recursive: true });
  return home;
}

test('runtime query scripts cannot call attune helpers', () => {
  const home = tempHome();
  const scriptPath = join(home, 'query.mjs');
  writeFileSync(scriptPath, 'return { rememberType: typeof remember, forgetType: typeof forget, overviewType: typeof overview };');

  const result = runRuntime(['--query', scriptPath], { home });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.deepEqual(JSON.parse(result.stdout), {
    rememberType: 'undefined',
    forgetType: 'undefined',
    overviewType: 'function',
  });
});

test('runtime attune scripts expose only memory mutation helpers', () => {
  const home = tempHome();
  const memoryPath = join(home, 'memory.md');
  const scriptPath = join(home, 'attune.mjs');
  writeFileSync(memoryPath, '# Memory\n');
  writeFileSync(scriptPath, `
    return {
      rememberType: typeof remember,
      forgetType: typeof forget,
      searchType: typeof search,
      sqlType: typeof sql,
      overviewType: typeof overview,
      result: remember({
        path: ${JSON.stringify(memoryPath)},
        summary: 'Decision: runtime remember exposes only memory registration.'
      })
    };
  `);

  const result = runRuntime(['--attune', scriptPath], { home });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.rememberType, 'function');
  assert.equal(payload.forgetType, 'function');
  assert.equal(payload.searchType, 'undefined');
  assert.equal(payload.sqlType, 'undefined');
  assert.equal(payload.overviewType, 'undefined');
  assert.equal(payload.result.path, memoryPath);
  assert.equal(payload.result.project, null);
});

test('runtime upgrades a recently built legacy schema before querying it', () => {
  const home = tempHome();
  const trajexDir = join(home, '.trajex');
  const dbPath = join(trajexDir, 'trajex.sqlite');
  mkdirSync(trajexDir, { recursive: true });
  const schema = readFileSync(
    new URL('../packages/core/src/schema.sql', import.meta.url),
    'utf8',
  ).replace("  visibility TEXT DEFAULT 'visible', -- visible / inactive / hidden\n", '');
  const db = new DatabaseSync(dbPath);
  db.exec(schema);
  db.prepare('INSERT INTO sessions (id,title,jsonl_path,source) VALUES (?,?,?,?)')
    .run('legacy-session', 'Legacy session', '/missing/session.jsonl', 'claude');
  db.prepare(`
    INSERT INTO messages (uuid,session_id,type,role,text,content_type,source)
    VALUES (?,?,?,?,?,?,?)
  `).run('legacy-message', 'legacy-session', 'user', 'user', 'legacy evidence', 'text', 'claude');
  db.prepare(`
    INSERT INTO index_state (jsonl_path,mtime,lines_processed)
    VALUES ('__last_build__',?,0)
  `).run(Date.now());
  db.close();

  const scriptPath = join(home, 'legacy-query.mjs');
  writeFileSync(scriptPath, "return thread('legacy-session').map(message => message.uuid);");
  const result = runRuntime(['--query', scriptPath], { home });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.deepEqual(JSON.parse(result.stdout), ['legacy-message']);
  const migrated = new DatabaseSync(dbPath, { readOnly: true });
  assert.ok(migrated.prepare('PRAGMA table_info(messages)').all().some(row => row.name === 'visibility'));
  migrated.close();
});

test('runtime rejects removed remember mode', () => {
  const home = tempHome();
  const scriptPath = join(home, 'remember.mjs');
  writeFileSync(scriptPath, 'return { ok: true };');

  const result = runRuntime(['--remember', scriptPath], { home });

  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /--attune <file\.js>/);
});

test('runtime indexes Codex root sessions into the shared query helpers', () => {
  const home = tempHome();
  const codexSessionDir = join(home, '.codex', 'sessions', '2026', '06', '15');
  mkdirSync(codexSessionDir, { recursive: true });

  const codexId = '019ec6ee-cebd-7431-9c93-ceec89a98a5f';
  writeFileSync(join(codexSessionDir, `rollout-2026-06-15T00-19-59-${codexId}.jsonl`), [
    JSON.stringify({
      timestamp: '2026-06-14T16:19:59.842Z',
      type: 'session_meta',
      payload: {
        id: codexId,
        timestamp: '2026-06-14T16:19:59.842Z',
        cwd: '/tmp/trajex-runtime',
        cli_version: '0.135.0-alpha.1',
        source: 'vscode',
        git: { branch: 'feat/codex' },
      },
    }),
    JSON.stringify({
      timestamp: '2026-06-14T16:20:00.000Z',
      type: 'event_msg',
      payload: { type: 'user_message', message: 'codex user asks for runtime indexing', images: [], local_images: [], text_elements: [] },
    }),
    JSON.stringify({
      timestamp: '2026-06-14T16:20:01.000Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'developer',
        content: [{ type: 'input_text', text: 'developer replay should stay out of visible search' }],
      },
    }),
    JSON.stringify({
      timestamp: '2026-06-14T16:20:02.000Z',
      type: 'event_msg',
      payload: { type: 'agent_message', phase: 'final_answer', message: 'codex assistant replies from runtime' },
    }),
    JSON.stringify({
      timestamp: '2026-06-14T16:20:03.000Z',
      type: 'response_item',
      payload: { type: 'function_call', call_id: 'call_codex_1', name: 'exec_command', arguments: '{"cmd":"pwd"}' },
    }),
    JSON.stringify({
      timestamp: '2026-06-14T16:20:04.000Z',
      type: 'response_item',
      payload: { type: 'function_call_output', call_id: 'call_codex_1', output: '/tmp/trajex-runtime' },
    }),
    '',
  ].join('\n'));

  const scriptPath = join(home, 'query.mjs');
  writeFileSync(scriptPath, `
    const sid = ${JSON.stringify(`codex:${codexId}`)};
    return {
      sessions: sessions({ source: 'codex', limit: 5 }).map(s => ({
        id: s.id,
        source: s.source,
        project: s.project,
        project_path: s.project_path,
        git_branch: s.git_branch,
        version: s.version,
        message_count: s.message_count
      })),
      messages: thread(sid).map(m => ({ role: m.role, text: m.text, source: m.source, content_type: m.content_type })),
      search: search('runtime indexing', { source: 'codex', limit: 5 }).map(h => ({
        uuid: h.message.uuid,
        message_source: h.message.source,
        session_source: h.session.source
      })),
      developerReplay: search('developer replay', { source: 'codex', limit: 5 }).length,
      rawHasEventLine: raw(${JSON.stringify(`codex:${codexId}:000002`)}, { limit: 1000 })?.text.includes('codex user asks for runtime indexing') || false,
      tool: sql('SELECT id, message_uuid, session_id, name FROM tool_calls WHERE id=?', ${JSON.stringify(`codex:${codexId}:call_codex_1`)})[0],
      toolResult: sql('SELECT tool_use_id, message_uuid, session_id, content FROM tool_results WHERE tool_use_id=?', ${JSON.stringify(`codex:${codexId}:call_codex_1`)})[0],
      overviewSources: overview({ limit: 5 }).totals.sources
    };
  `);

  const result = runRuntime(['--query', scriptPath], { home });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.deepEqual(payload.sessions, [{
    id: `codex:${codexId}`,
    source: 'codex',
    project: '-tmp-trajex-runtime',
    project_path: normalize('/tmp/trajex-runtime'),
    git_branch: 'feat/codex',
    version: '0.135.0-alpha.1',
    message_count: 4,
  }]);
  assert.deepEqual(payload.messages.map(m => [m.role, m.text, m.source, m.content_type]), [
    ['user', 'codex user asks for runtime indexing', 'codex', 'text'],
    ['assistant', 'codex assistant replies from runtime', 'codex', 'text'],
    ['assistant', null, 'codex', 'tool_use'],
    ['user', '/tmp/trajex-runtime', 'codex', 'tool_result'],
  ]);
  assert.equal(payload.search[0].message_source, 'codex');
  assert.equal(payload.search[0].session_source, 'codex');
  assert.equal(payload.developerReplay, 0);
  assert.equal(payload.rawHasEventLine, true);
  assert.equal(payload.tool.session_id, `codex:${codexId}`);
  assert.equal(payload.tool.message_uuid, `codex:${codexId}:000005`);
  assert.equal(payload.toolResult.message_uuid, `codex:${codexId}:000006`);
  assert.equal(payload.toolResult.content, '/tmp/trajex-runtime');
  assert.ok(payload.overviewSources.some(s => s.source === 'codex' && s.session_count === 1));
});

test('runtime force build aborts before cleanup when an indexed Provider root is unavailable', () => {
  const home = tempHome();
  const sessionsDir = join(home, '.codex', 'sessions');
  const rolloutDir = join(sessionsDir, '2026', '06', '15');
  const rawId = '019ec6ee-cebd-7431-9c93-ceec89a98b00';
  mkdirSync(rolloutDir, { recursive: true });
  writeFileSync(join(rolloutDir, `rollout-${rawId}.jsonl`), [
    JSON.stringify({
      timestamp: '2026-06-15T10:00:00.000Z',
      type: 'session_meta',
      payload: { id: rawId, cwd: '/tmp/runtime-force-preserve' },
    }),
    JSON.stringify({
      timestamp: '2026-06-15T10:00:01.000Z',
      type: 'event_msg',
      payload: { type: 'user_message', message: 'runtime force must preserve this' },
    }),
    '',
  ].join('\n'));

  const first = runRuntime(['--build'], { home });
  assert.equal(first.status, 0, first.stderr || first.stdout);
  rmSync(sessionsDir, { recursive: true });

  const rebuild = runRuntime(['--build'], { home });
  assert.notEqual(rebuild.status, 0);
  assert.match(rebuild.stdout, /Provider root unavailable.*rebuild aborted before cleanup/i);
  const db = new DatabaseSync(join(home, '.trajex', 'trajex.sqlite'), { readOnly: true });
  assert.equal(
    db.prepare('SELECT COUNT(*) AS c FROM sessions WHERE id=?').get(`codex:${rawId}`).c,
    1,
  );
  db.close();
});

test('runtime skips Codex guardian review threads', () => {
  const home = tempHome();
  const codexSessionDir = join(home, '.codex', 'sessions', '2026', '06', '15');
  mkdirSync(codexSessionDir, { recursive: true });

  const guardianId = '019ed5c4-8d52-7bc0-91f3-447a15e987d1';
  writeFileSync(join(codexSessionDir, `rollout-2026-06-15T02-12-00-${guardianId}.jsonl`), [
    JSON.stringify({
      timestamp: '2026-06-14T18:12:00.000Z',
      type: 'session_meta',
      payload: {
        id: guardianId,
        timestamp: '2026-06-14T18:12:00.000Z',
        cwd: '/tmp/trajex-runtime',
        cli_version: '0.135.0-alpha.1',
        thread_source: 'subagent',
        source: { subagent: { other: 'guardian' } },
      },
    }),
    JSON.stringify({
      timestamp: '2026-06-14T18:12:01.000Z',
      type: 'turn_context',
      payload: { cwd: '/tmp/trajex-runtime', model: 'codex-auto-review' },
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

  const scriptPath = join(home, 'query.mjs');
  writeFileSync(scriptPath, `
    const sid = ${JSON.stringify(`codex:${guardianId}`)};
    return {
      sessions: sessions({ source: 'codex', limit: 5 }).map(s => s.id),
      searchCount: search('approval', { source: 'codex', limit: 5 }).length,
      sessionRows: sql('SELECT COUNT(*) AS c FROM sessions WHERE id=?', sid)[0].c,
      messageRows: sql('SELECT COUNT(*) AS c FROM messages WHERE session_id=?', sid)[0].c,
      subagentRows: sql('SELECT COUNT(*) AS c FROM subagents WHERE agent_id=?', sid)[0].c
    };
  `);

  const result = runRuntime(['--query', scriptPath], { home });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.deepEqual(JSON.parse(result.stdout), {
    sessions: [],
    searchCount: 0,
    sessionRows: 0,
    messageRows: 0,
    subagentRows: 0,
  });
});

test('runtime ignores Codex guardian rows without removing stale projections', () => {
  const home = tempHome();
  const codexSessionDir = join(home, '.codex', 'sessions', '2026', '06', '15');
  mkdirSync(codexSessionDir, { recursive: true });

  const initScriptPath = join(home, 'init.mjs');
  writeFileSync(initScriptPath, 'return sessions({ source: "codex", limit: 5 }).length;');
  assert.equal(runRuntime(['--query', initScriptPath], { home }).status, 0);

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
        cwd: '/tmp/trajex-runtime',
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

  const db = new DatabaseSync(join(home, '.trajex', 'trajex.sqlite'));
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
  db.prepare("UPDATE index_state SET mtime=? WHERE jsonl_path='__last_build__'").run(Date.now() - 31000);
  db.close();

  const scriptPath = join(home, 'query.mjs');
  writeFileSync(scriptPath, `
    const sid = ${JSON.stringify(guardianSessionId)};
    return {
      sessions: sessions({ source: 'codex', limit: 5 }).map(s => s.id),
      searchCount: search('stale', { source: 'codex', limit: 5 }).length,
      sessionRows: sql('SELECT COUNT(*) AS c FROM sessions WHERE id=?', sid)[0].c,
      messageRows: sql('SELECT COUNT(*) AS c FROM messages WHERE session_id=?', sid)[0].c,
      toolRows: sql('SELECT COUNT(*) AS c FROM tool_calls WHERE session_id=?', sid)[0].c,
      resultRows: sql('SELECT COUNT(*) AS c FROM tool_results WHERE session_id=?', sid)[0].c,
      subagentRows: sql('SELECT COUNT(*) AS c FROM subagents WHERE agent_id=?', sid)[0].c
    };
  `);

  const result = runRuntime(['--query', scriptPath], { home });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.deepEqual(JSON.parse(result.stdout), {
    sessions: [guardianSessionId],
    searchCount: 1,
    sessionRows: 1,
    messageRows: 1,
    toolRows: 1,
    resultRows: 1,
    subagentRows: 1,
  });
});

test('runtime skips Codex child threads', () => {
  const home = tempHome();
  const codexSessionDir = join(home, '.codex', 'sessions', '2026', '06', '15');
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
        cwd: '/tmp/trajex-runtime',
        cli_version: '0.135.0-alpha.1',
        source: 'vscode',
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
        prompt: 'inspect skill-side codex indexing',
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
        cwd: '/tmp/trajex-runtime',
        cli_version: '0.135.0-alpha.1',
        source: {
          subagent: {
            thread_spawn: {
              parent_thread_id: parentId,
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
    '',
  ].join('\n'));

  const scriptPath = join(home, 'query.mjs');
  writeFileSync(scriptPath, `
    return {
      parentSessions: sessions({ source: 'codex', limit: 5 }).map(s => s.id),
      subagents: subagents({ source: 'codex', limit: 5 }).map(sa => ({
        agent_id: sa.agent_id,
        session_id: sa.session_id,
        parent_tool_use_id: sa.parent_tool_use_id,
        agent_type: sa.agent_type,
        description: sa.description,
        messageCount: sa.messageCount
      })),
      childMessages: sql(
        'SELECT session_id, agent_id, visibility, source, text FROM messages WHERE agent_id=? ORDER BY timestamp, uuid',
        ${JSON.stringify(`codex:${childId}`)}
      )
    };
  `);

  const result = runRuntime(['--query', scriptPath], { home });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.deepEqual(payload.parentSessions, [`codex:${parentId}`]);
  assert.deepEqual(payload.subagents, []);
  assert.deepEqual(payload.childMessages, []);
});
