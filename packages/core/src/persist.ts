// Copyright (C) 2026 tommy0103 and contributors.
// Copyright (C) 2026 wutongyuonce and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * 统一 TranscriptRecord 持久化层。
 *
 * 模块定位：唯一直接认识 SQLite schema 的写库代码。Provider adapter 只产出规范
 * 记录流；本模块完成 upsert、session 合并、工具关联、撤回删除和 cursor 持久化。
 */
// Shared Core persist layer (see docs/adr/0001).
//
// Provider-agnostic and binding-agnostic: it consumes the TranscriptRecord stream
// from any adapter's parse() and writes rows into the injected database handle
// (node:sqlite for the CLI, better-sqlite3 for the app — they share the
// prepare/run/get API). It is the ONLY layer that touches the database and the
// only place that knows the schema. Adapters stay pure.
//
// Write semantics are the canonical ones reconciled from the drift: messages
// upsert via ON CONFLICT; sessions merge with any existing row (started_at MIN,
// ended_at MAX, message_count reset-or-accumulate, fill-if-null for the rest);
// turn-duration is a targeted UPDATE; delete-session replaces transcript-derived
// rows but preserves durable memories. The generator's
// return value is the new cursor, persisted verbatim into index_state.

import type { Cursor, TranscriptRecord, IndexUnit } from './providers/types.ts';
import type { SqliteDb } from './sqlite-types.ts';

// session 合并时时间字段取 MIN/MAX：started_at 取更早、ended_at 取更晚（单边为 null 时取对方）。
const minStr = (a: string | null, b: string | null) => (a == null ? b : b == null ? a : a < b ? a : b);
const maxStr = (a: string | null, b: string | null) => (a == null ? b : b == null ? a : a > b ? a : b);

/**
 * 为一次 persist 预编译 SQL。语句名与 TranscriptRecord.kind 对应，使 write()
 * 只做语义分发，不散落 SQL 字符串。
 */
function statements(db: SqliteDb) {
  return {
    msg: db.prepare(`
      INSERT INTO messages (uuid,session_id,type,parent_uuid,timestamp,role,text,content_type,is_meta,visibility,model,agent_id,input_tokens,output_tokens,cwd,skill,source)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(uuid) DO UPDATE SET
        session_id=excluded.session_id, type=excluded.type, parent_uuid=excluded.parent_uuid,
        timestamp=excluded.timestamp, role=excluded.role, text=excluded.text,
        content_type=excluded.content_type, is_meta=excluded.is_meta,
        visibility=excluded.visibility, model=excluded.model,
        agent_id=excluded.agent_id,
        input_tokens=excluded.input_tokens, output_tokens=excluded.output_tokens,
        cwd=excluded.cwd, skill=excluded.skill, source=excluded.source`),
    tc: db.prepare('INSERT OR REPLACE INTO tool_calls (id,message_uuid,session_id,name,input_json,file_path) VALUES (?,?,?,?,?,?)'),
    tr: db.prepare('INSERT OR REPLACE INTO tool_results (tool_use_id,message_uuid,session_id,content,file_path,is_error) VALUES (?,?,?,?,?,?)'),
    sum: db.prepare('INSERT OR REPLACE INTO summaries (id,session_id,agent_id,timestamp,source,content,visibility,input_tokens,output_tokens) VALUES (?,?,?,?,?,?,?,?,?)'),
    ses: db.prepare('INSERT OR REPLACE INTO sessions (id,title,project,project_path,started_at,ended_at,git_branch,version,message_count,jsonl_path,source) VALUES (?,?,?,?,?,?,?,?,?,?,?)'),
    sub: db.prepare(`
      INSERT INTO subagents (agent_id,session_id,parent_tool_use_id,agent_type,description,duration_ms,total_tokens)
      VALUES (?,?,?,?,?,?,?)
      ON CONFLICT(agent_id) DO UPDATE SET
        session_id=excluded.session_id,
        parent_tool_use_id=COALESCE(excluded.parent_tool_use_id, subagents.parent_tool_use_id),
        agent_type=COALESCE(excluded.agent_type, subagents.agent_type),
        description=COALESCE(excluded.description, subagents.description),
        duration_ms=COALESCE(excluded.duration_ms, subagents.duration_ms),
        total_tokens=COALESCE(excluded.total_tokens, subagents.total_tokens)`),
    wf: db.prepare(`
      INSERT OR REPLACE INTO workflows
        (run_id,session_id,parent_tool_use_id,task_id,script,result_json,timestamp,agent_count,duration_ms,total_tokens,status,workflow_name)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`),
    wa: db.prepare(`
      INSERT INTO workflow_agents
        (agent_id,run_id,session_id,agent_type,description,phase,label,model,state,duration_ms,tokens,tool_calls)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(agent_id) DO UPDATE SET
        run_id=excluded.run_id, session_id=excluded.session_id,
        agent_type=COALESCE(excluded.agent_type, workflow_agents.agent_type),
        description=COALESCE(excluded.description, workflow_agents.description),
        phase=COALESCE(excluded.phase, workflow_agents.phase),
        label=COALESCE(excluded.label, workflow_agents.label),
        model=COALESCE(excluded.model, workflow_agents.model),
        state=COALESCE(excluded.state, workflow_agents.state),
        duration_ms=COALESCE(excluded.duration_ms, workflow_agents.duration_ms),
        tokens=COALESCE(excluded.tokens, workflow_agents.tokens),
        tool_calls=COALESCE(excluded.tool_calls, workflow_agents.tool_calls)`),
    turn: db.prepare('UPDATE messages SET turn_duration_ms=? WHERE uuid=?'),
    idx: db.prepare('INSERT OR REPLACE INTO index_state (jsonl_path,mtime,lines_processed,cursor) VALUES (?,?,?,?)'),
    getSession: db.prepare('SELECT * FROM sessions WHERE id=?'),
  };
}

// Replace every transcript-derived row belonging to a session/thread.
/**
 * 删除 session 的 transcript 派生行，为全量重放腾出干净投影；人工确认的
 * memories 是 durable 层，不随 session replacement 删除。
 */
function deleteSession(db: SqliteDb, sessionId: string) {
  db.prepare('DELETE FROM tool_results WHERE session_id=? OR message_uuid IN (SELECT uuid FROM messages WHERE session_id=? OR agent_id=?)').run(sessionId, sessionId, sessionId);
  db.prepare('DELETE FROM tool_calls WHERE session_id=? OR message_uuid IN (SELECT uuid FROM messages WHERE session_id=? OR agent_id=?)').run(sessionId, sessionId, sessionId);
  db.prepare('DELETE FROM messages WHERE session_id=? OR agent_id=?').run(sessionId, sessionId);
  db.prepare('DELETE FROM subagents WHERE agent_id=? OR session_id=?').run(sessionId, sessionId);
  db.prepare('DELETE FROM workflow_agents WHERE session_id=?').run(sessionId);
  db.prepare('DELETE FROM workflows WHERE session_id=?').run(sessionId);
  db.prepare('DELETE FROM summaries WHERE session_id=?').run(sessionId);
  db.prepare('DELETE FROM sessions WHERE id=?').run(sessionId);
}

// Consume one unit's record stream into the database and return the new cursor
// (also written to index_state). `db` is any SQLite handle sharing prepare/run.
/**
 * 消费一个 IndexUnit 的规范记录 generator，并返回 adapter 生成的新 cursor。
 *
 * 被谁调用：indexProviderPlan() 的每 unit 事务。cursor 的内容属于 Provider 协议，
 * persist 只将其原样写进 index_state，供下一轮发现和增量恢复。
 */
export function persist(db: SqliteDb, unit: IndexUnit, gen: Generator<TranscriptRecord, Cursor>): Cursor {
  const st = statements(db);

  // Provider discovery can prove that an older identity is no longer present
  // even when the replacement unit emits no transcript records. Retract those
  // projections before consuming the generator so the whole replacement unit
  // remains atomic with its subsequent writes.
  for (const sessionId of unit.retractSessionIds ?? []) deleteSession(db, sessionId);

  // 未处理的 kind 立即抛错，避免新增规范记录后静默丢失。
  const write = (r: TranscriptRecord) => {
    switch (r.kind) {
      case 'message':
        st.msg.run(r.uuid, r.session_id, r.type, r.parent_uuid, r.timestamp, r.role, r.text, r.content_type, r.is_meta, r.visibility, r.model, r.agent_id, r.input_tokens, r.output_tokens, r.cwd, r.skill, r.source);
        break;
      case 'tool_call':
        st.tc.run(r.id, r.message_uuid, r.session_id, r.name, r.input_json, r.file_path);
        break;
      case 'tool_result':
        st.tr.run(r.tool_use_id, r.message_uuid, r.session_id, r.content, r.file_path, r.is_error);
        break;
      case 'summary':
        st.sum.run(r.id, r.session_id, r.agent_id ?? null, r.timestamp, r.source, r.content, r.visibility ?? 'visible', r.input_tokens ?? null, r.output_tokens ?? null);
        break;
      case 'subagent':
        st.sub.run(r.agent_id, r.session_id, r.parent_tool_use_id ?? null, r.agent_type ?? null, r.description ?? null, r.duration_ms ?? null, r.total_tokens ?? null);
        break;
      case 'workflow':
        st.wf.run(r.run_id, r.session_id, r.parent_tool_use_id ?? null, r.task_id, r.script, r.result_json, r.timestamp, r.agent_count, r.duration_ms, r.total_tokens, r.status, r.workflow_name);
        break;
      case 'workflow_agent':
        st.wa.run(r.agent_id, r.run_id, r.session_id, r.agent_type ?? null, r.description ?? null, r.phase ?? null, r.label ?? null, r.model ?? null, r.state ?? null, r.duration_ms ?? null, r.tokens ?? null, r.tool_calls ?? null);
        break;
      case 'message-turn-duration':
        st.turn.run(r.turn_duration_ms, r.uuid);
        break;
      case 'session': {
        const prev = st.getSession.get(r.id);
        // Claude 的增量解析贡献新增条数，故累加；Codex 全量重放，故用本次数覆盖。
        const message_count = r.countMode === 'delta' ? (prev?.message_count || 0) + r.message_count : r.message_count;
        st.ses.run(
          r.id,
          r.title ?? prev?.title ?? null,
          r.project ?? prev?.project ?? null,
          prev?.project_path ?? null, // authoritative project_path is set by refreshSessionProjectPaths
          minStr(prev?.started_at ?? null, r.started_at),
          maxStr(prev?.ended_at ?? null, r.ended_at),
          r.git_branch ?? prev?.git_branch ?? null,
          r.version ?? prev?.version ?? null,
          message_count,
          r.jsonl_path,
          r.source,
        );
        break;
      }
      case 'delete-session':
        deleteSession(db, r.sessionId);
        break;
      default:
        throw new Error(`persist: unhandled record kind ${(r as { kind: string }).kind}`);
    }
  };

  // 逐个拉取 generator 的产出并写入：adapter 的 parse() 是惰性生成器，
  // 每调用一次 next() 才产出一条记录，写完后才取返回值（即新 cursor）。
  let step = gen.next();
  while (!step.done) { write(step.value); step = gen.next(); }
  const cursor = step.value;

  // 保留前两段数值列供 marker/排序使用，同时原样保存 Provider cursor。
  if (cursor != null) {
    const [mtime, lines] = cursor.split(':');
    st.idx.run(unit.key, Number(mtime), Number(lines), cursor);
  }
  return cursor;
}
