// Copyright (C) 2026 tommy0103 and contributors.
// Copyright (C) 2026 wutongyuonce and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * 统一 TranscriptRecord 持久化层（见 docs/adr/0001、0014）。
 *
 * 模块定位：唯一把规范记录写进投影表的代码。Provider 只产出记录流；本模块按来源
 * 声明归属每一行（source_id）、合并 session、补占位会话并写回 cursor。来源清单的
 * 状态迁移在 sources.ts。
 *
 * 写入语义：
 * - `source` 记录切换“当前来源”；replace 时先删除该来源的非消息派生行，messages
 *   则原地 upsert 以保持 rowid 稳定，流结束后只删掉本次未再产出的旧 message。
 * - messages / subagents / workflow_agents 按主键 upsert；合并行归最后写入者。
 * - sessions 与已有行合并：started_at 取早、ended_at 取晚、message_count 按 countMode
 *   累加或替换，其余字段新值优先、为空时保留旧值。
 * - 写入了行却没有 sessions 行的会话（例如主 transcript 尚未出现）补一个占位行。
 */
import type { Cursor, TranscriptRecord, IndexUnit } from './providers/types.ts';
import type { SqliteDb } from './sqlite-types.ts';
import { normalizeTranscriptTimestamp } from './parsing.ts';
import { OWNED_TABLES, SESSION_MEMBER, declareSource, refreshSessionSourceStatus } from './sources.ts';

// session 合并时时间字段取 MIN/MAX：started_at 取更早、ended_at 取更晚（单边为 null 时取对方）。
const minStr = (a: string | null, b: string | null) => (a == null ? b : b == null ? a : a < b ? a : b);
const maxStr = (a: string | null, b: string | null) => (a == null ? b : b == null ? a : a > b ? a : b);
// 新值已是规范 UTC 毫秒形态时，先把旧值规范化再比较；否则重放得到的 UTC 边界会
// 输给旧的带偏移/无毫秒字符串，留下半迁移的 session。
const CANONICAL_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const priorTimestampForMerge = (prior: string | null | undefined, incoming: string | null) => (
  incoming !== null && CANONICAL_TIMESTAMP.test(incoming)
    ? normalizeTranscriptTimestamp(prior)
    : prior ?? null
);

// messages 保 rowid 稳定，subagents / workflow_agents 跨多个来源 COALESCE 合并，因此
// replace 时不在流开始前整表删除，而是原地 upsert，流结束后只删掉本次未再产出的主键。
const UPFRONT_REPLACE_TABLES = ['tool_calls', 'tool_results', 'summaries', 'workflows'] as const;
const KEPT_REPLACE_TABLES = [
  ['messages', 'uuid'],
  ['subagents', 'agent_id'],
  ['workflow_agents', 'agent_id'],
] as const;

type KeptKeys = Record<(typeof KEPT_REPLACE_TABLES)[number][0], Set<string>>;

/** 为一次 persist 预编译 SQL。语句名与 TranscriptRecord.kind 对应。 */
function statements(db: SqliteDb) {
  return {
    msg: db.prepare(`
      INSERT INTO messages (uuid,session_id,type,parent_uuid,timestamp,role,text,content_type,is_meta,visibility,model,agent_id,input_tokens,output_tokens,cwd,skill,source,source_id)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(uuid) DO UPDATE SET
        session_id=excluded.session_id, type=excluded.type, parent_uuid=excluded.parent_uuid,
        timestamp=excluded.timestamp, role=excluded.role, text=excluded.text,
        content_type=excluded.content_type, is_meta=excluded.is_meta,
        visibility=excluded.visibility, model=excluded.model,
        agent_id=excluded.agent_id,
        input_tokens=excluded.input_tokens, output_tokens=excluded.output_tokens,
        cwd=excluded.cwd, skill=excluded.skill, source=excluded.source, source_id=excluded.source_id`),
    tc: db.prepare('INSERT OR REPLACE INTO tool_calls (id,message_uuid,session_id,name,input_json,file_path,source_id) VALUES (?,?,?,?,?,?,?)'),
    tr: db.prepare('INSERT OR REPLACE INTO tool_results (tool_use_id,message_uuid,session_id,content,file_path,is_error,source_id) VALUES (?,?,?,?,?,?,?)'),
    sum: db.prepare('INSERT OR REPLACE INTO summaries (id,session_id,agent_id,timestamp,source,content,visibility,input_tokens,output_tokens,source_id) VALUES (?,?,?,?,?,?,?,?,?,?)'),
    ses: db.prepare('INSERT OR REPLACE INTO sessions (id,title,project,project_path,started_at,ended_at,git_branch,version,message_count,jsonl_path,source) VALUES (?,?,?,?,?,?,?,?,?,?,?)'),
    sub: db.prepare(`
      INSERT INTO subagents (agent_id,session_id,parent_tool_use_id,agent_type,description,duration_ms,total_tokens,source_id)
      VALUES (?,?,?,?,?,?,?,?)
      ON CONFLICT(agent_id) DO UPDATE SET
        session_id=excluded.session_id,
        parent_tool_use_id=COALESCE(excluded.parent_tool_use_id, subagents.parent_tool_use_id),
        agent_type=COALESCE(excluded.agent_type, subagents.agent_type),
        description=COALESCE(excluded.description, subagents.description),
        duration_ms=COALESCE(excluded.duration_ms, subagents.duration_ms),
        total_tokens=COALESCE(excluded.total_tokens, subagents.total_tokens),
        source_id=excluded.source_id`),
    wf: db.prepare(`
      INSERT OR REPLACE INTO workflows
        (run_id,session_id,parent_tool_use_id,task_id,script,result_json,timestamp,agent_count,duration_ms,total_tokens,status,workflow_name,source_id)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`),
    wa: db.prepare(`
      INSERT INTO workflow_agents
        (agent_id,run_id,session_id,agent_type,description,phase,label,model,state,duration_ms,tokens,tool_calls,source_id)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
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
        tool_calls=COALESCE(excluded.tool_calls, workflow_agents.tool_calls),
        source_id=excluded.source_id`),
    turn: db.prepare('UPDATE messages SET turn_duration_ms=? WHERE uuid=?'),
    idx: db.prepare('INSERT OR REPLACE INTO index_state (jsonl_path,mtime,lines_processed,cursor) VALUES (?,?,?,?)'),
    getSession: db.prepare('SELECT * FROM sessions WHERE id=?'),
    placeholder: db.prepare(`
      INSERT OR IGNORE INTO sessions (id,project,started_at,ended_at,message_count,jsonl_path,source)
      SELECT ?, ?, MIN(timestamp), MAX(timestamp), 0, NULL, ? FROM messages WHERE session_id = ?`),
  };
}

export interface PersistOptions {
  provider?: string;
  now?: number;
  onSessionIds?: (sessionIds: ReadonlySet<string>) => void;
}

/**
 * 消费一个 IndexUnit 的规范记录 generator，并返回 adapter 生成的新 cursor。
 *
 * 被谁调用：indexProviderPlan() 的每 unit 事务。cursor 的内容属于 Provider 协议，
 * persist 只将其原样写进 index_state，供下一轮发现和增量恢复。
 */
export function persist(
  db: SqliteDb,
  unit: IndexUnit,
  gen: Generator<TranscriptRecord, Cursor>,
  options: PersistOptions = {},
): Cursor {
  const defaultProvider = options.provider ?? 'claude';
  const now = options.now ?? Date.now();
  const st = statements(db);
  const sessionIds = new Set<string>();
  const emittedSessions = new Set<string>();
  const replacedMainSessions = new Set<string>();
  const replacedKeys = new Map<number, KeptKeys>();
  let current: { id: number; sessionId: string } | null = null;
  let lastProvider = defaultProvider;

  const ensureOwner = (sessionId: string, recordProvider?: string): number => {
    if (current === null) {
      const provider = recordProvider || defaultProvider;
      const declared = declareSource(db, {
        provider,
        sessionId: sessionId || unit.sessionId,
        member: unit.isSubagent ? unit.agentId ?? '' : SESSION_MEMBER,
        path: unit.key,
        now,
      });
      current = { id: declared.id, sessionId: sessionId || unit.sessionId };
      lastProvider = provider;
      sessionIds.add(current.sessionId);
      for (const id of declared.supersededSessionIds) sessionIds.add(id);
    }
    if (sessionId) sessionIds.add(sessionId);
    return current.id;
  };

  // 未处理的 kind 立即抛错，避免新增规范记录后静默丢失。
  const write = (r: TranscriptRecord) => {
    switch (r.kind) {
      case 'source': {
        const provider = r.provider || defaultProvider;
        const declared = declareSource(db, { provider, sessionId: r.session_id, member: r.member, path: r.path, now });
        current = { id: declared.id, sessionId: r.session_id };
        lastProvider = provider;
        sessionIds.add(r.session_id);
        for (const id of declared.supersededSessionIds) sessionIds.add(id);
        if (r.replace) {
          for (const table of UPFRONT_REPLACE_TABLES) {
            db.prepare(`DELETE FROM ${table} WHERE source_id = ?`).run(declared.id);
          }
          if (!replacedKeys.has(declared.id)) {
            replacedKeys.set(declared.id, {
              messages: new Set(),
              subagents: new Set(),
              workflow_agents: new Set(),
            });
          }
          if (r.member === SESSION_MEMBER) replacedMainSessions.add(r.session_id);
        }
        break;
      }
      case 'message': {
        const sourceId = ensureOwner(r.session_id, r.source);
        replacedKeys.get(sourceId)?.messages.add(r.uuid);
        st.msg.run(r.uuid, r.session_id, r.type, r.parent_uuid, r.timestamp, r.role, r.text, r.content_type, r.is_meta, r.visibility, r.model, r.agent_id, r.input_tokens, r.output_tokens, r.cwd, r.skill, r.source, sourceId);
        break;
      }
      case 'tool_call':
        st.tc.run(r.id, r.message_uuid, r.session_id, r.name, r.input_json, r.file_path, ensureOwner(r.session_id));
        break;
      case 'tool_result':
        st.tr.run(r.tool_use_id, r.message_uuid, r.session_id, r.content, r.file_path, r.is_error, ensureOwner(r.session_id));
        break;
      case 'summary':
        st.sum.run(r.id, r.session_id, r.agent_id ?? null, r.timestamp, r.source, r.content, r.visibility ?? 'visible', r.input_tokens ?? null, r.output_tokens ?? null, ensureOwner(r.session_id));
        break;
      case 'subagent': {
        const sourceId = ensureOwner(r.session_id);
        replacedKeys.get(sourceId)?.subagents.add(r.agent_id);
        st.sub.run(r.agent_id, r.session_id, r.parent_tool_use_id ?? null, r.agent_type ?? null, r.description ?? null, r.duration_ms ?? null, r.total_tokens ?? null, sourceId);
        break;
      }
      case 'workflow':
        st.wf.run(r.run_id, r.session_id, r.parent_tool_use_id ?? null, r.task_id, r.script, r.result_json, r.timestamp, r.agent_count, r.duration_ms, r.total_tokens, r.status, r.workflow_name, ensureOwner(r.session_id));
        break;
      case 'workflow_agent': {
        const sourceId = ensureOwner(r.session_id);
        replacedKeys.get(sourceId)?.workflow_agents.add(r.agent_id);
        st.wa.run(r.agent_id, r.run_id, r.session_id, r.agent_type ?? null, r.description ?? null, r.phase ?? null, r.label ?? null, r.model ?? null, r.state ?? null, r.duration_ms ?? null, r.tokens ?? null, r.tool_calls ?? null, sourceId);
        break;
      }
      case 'message-turn-duration':
        st.turn.run(r.turn_duration_ms, r.uuid);
        break;
      case 'session': {
        ensureOwner(r.id, r.source);
        emittedSessions.add(r.id);
        const prev = st.getSession.get(r.id);
        // Claude 的增量解析贡献新增条数，故累加；全量重放用本次数覆盖。
        const message_count = r.countMode === 'delta' ? (prev?.message_count || 0) + r.message_count : r.message_count;
        st.ses.run(
          r.id,
          r.title ?? prev?.title ?? null,
          r.project ?? prev?.project ?? null,
          prev?.project_path ?? null,
          minStr(priorTimestampForMerge(prev?.started_at, r.started_at), r.started_at),
          maxStr(priorTimestampForMerge(prev?.ended_at, r.ended_at), r.ended_at),
          r.git_branch ?? prev?.git_branch ?? null,
          r.version ?? prev?.version ?? null,
          message_count,
          r.jsonl_path,
          r.source,
        );
        break;
      }
      default:
        throw new Error(`persist: unhandled record kind ${(r as { kind: string }).kind}`);
    }
  };

  // 逐个拉取 generator 的产出并写入：adapter 的 parse() 是惰性生成器，
  // 每调用一次 next() 才产出一条记录，写完后才取返回值（即新 cursor）。
  let step = gen.next();
  while (!step.done) { write(step.value); step = gen.next(); }
  const cursor = step.value;

  // replace 的来源只删掉本次未再产出的旧主键，保留其余行的 rowid 与跨来源 COALESCE 字段。
  for (const [sourceId, kept] of replacedKeys) {
    for (const [table, keyCol] of KEPT_REPLACE_TABLES) {
      const keys = kept[table];
      if (keys.size === 0) {
        db.prepare(`DELETE FROM ${table} WHERE source_id = ?`).run(sourceId);
        continue;
      }
      const del = db.prepare(`DELETE FROM ${table} WHERE ${keyCol} = ?`);
      for (const row of db.prepare(`SELECT ${keyCol} FROM ${table} WHERE source_id = ?`).all(sourceId)) {
        const key = String(row[keyCol]);
        if (!keys.has(key)) del.run(key);
      }
    }
  }
  for (const sessionId of replacedMainSessions) {
    if (emittedSessions.has(sessionId)) continue;
    const hasRows = OWNED_TABLES.some(table => Boolean(db.prepare(`SELECT 1 FROM ${table} WHERE session_id = ? LIMIT 1`).get(sessionId)));
    if (!hasRows) {
      db.prepare("DELETE FROM sources WHERE session_id = ? AND member = '' AND device_id IS NULL").run(sessionId);
      if (!db.prepare('SELECT 1 FROM sources WHERE session_id = ? LIMIT 1').get(sessionId)) {
        db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
      }
    }
  }
  for (const sessionId of sessionIds) {
    if (emittedSessions.has(sessionId)) continue;
    if (!db.prepare('SELECT 1 FROM sources WHERE session_id = ? LIMIT 1').get(sessionId)) continue;
    st.placeholder.run(sessionId, unit.project ?? null, lastProvider, sessionId);
  }
  refreshSessionSourceStatus(db, sessionIds);
  options.onSessionIds?.(sessionIds);

  // 保留前两段数值列供 marker/排序使用，同时原样保存 Provider cursor。
  if (cursor != null) {
    const [mtime, lines] = cursor.split(':');
    st.idx.run(unit.key, Number(mtime), Number(lines), cursor);
  }
  return cursor;
}
