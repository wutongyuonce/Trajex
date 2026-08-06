/**
 * 查询与记忆 attune 的 sandbox API 工厂。
 *
 * 模块定位：向用户 JS 脚本暴露高层检索函数和受控的记忆写入函数；它接收
 * 已打开的 SQLite 连接，不负责索引调度或 VM 执行。
 */
// Query and attune sandbox helpers for the Core package.
import { statSync } from 'node:fs';
import { isAbsolute, normalize, resolve, sep } from 'node:path';
import { createBuiltinProviderRegistry } from './providers/builtins.ts';
import type { ProviderRegistry } from './providers/registry.ts';
import type { SqliteDb, SqliteRow } from './sqlite-types.ts';

type DbRow = SqliteRow;

/**
 * 沙箱查询 API 的统一过滤/选项对象：search / sessions / subagents / memories 等方法
 * 都接收它，各自只读自己关心的字段；字段名即沙箱公开参数名。
 * extends Record<string, any> 保留宽松索引签名：脚本可能传入任意键，编译期不卡死。
 */
interface QueryOptions extends Record<string, any> {
  limit?: number;          // 返回条数上限
  sessionId?: string;      // 单会话过滤（=）
  sessions?: string[];     // 多会话过滤（IN）
  project?: string;        // 项目过滤（LIKE 模糊匹配）
  after?: string;          // 时间窗口下界（timestamp >）
  before?: string;         // 时间窗口上界（timestamp <）
  cwd?: string;            // 工作目录过滤
  branch?: string;         // git 分支过滤
  source?: string;         // Provider 来源过滤；'all' 表示不过滤
  includeMeta?: boolean;   // 是否包含 meta（System 卡片）消息；默认剔除
  includeInactive?: boolean; // 是否包含已被替代但保留的消息；默认剔除
  query?: string;          // FTS 检索词（memories() 用）
  projectLimit?: number;   // overview 专用：项目列表条数
  memoryLimit?: number;    // overview 专用：记忆列表条数
}

/**
 * buildWhere() 的白名单列名映射：过滤条件编译为 SQL 时，列名一律取这里的表别名
 * （如 s.id / sa.session_id），绝不使用用户输入——注入防护的关键。
 */
interface ColumnAliases {
  sessionId: string;
  project: string;
  timestamp: string;
  branch: string;
  source?: string;
}

/** remember() 的参数契约：一条记忆的必填/可选字段。 */
interface RememberInput {
  path: string;            // 必填：记忆指向的文件路径
  session_id?: string;     // 归属会话；用于推导 project_path 基准
  message_start?: string;  // 证据消息窗口起点
  message_end?: string;    // 证据消息窗口终点
  summary: string;         // 必填：记忆正文（必须英文）
  project?: string;        // 覆盖归属项目
}

/** forget() 的参数契约：id 与删除理由两者都必填。 */
interface ForgetInput {
  id: string;
  reason: string;
}

/** 统一 opts 重载：字符串 → sessionId，数字 → limit，null → 空对象。 */
function normalizeOpts(optsOrScalar: QueryOptions | string | number | null | undefined, scalarKey = 'sessionId'): QueryOptions {
  if (optsOrScalar == null) return {};
  if (typeof optsOrScalar === 'string') return { [scalarKey]: optsOrScalar };
  if (typeof optsOrScalar === 'number') return { limit: optsOrScalar };
  return optsOrScalar;
}

function normalizeLimit(value: unknown, fallback: number): number {
  if (value == null) return fallback;
  const limit = Number(value);
  if (!Number.isFinite(limit) || limit < 0) throw new Error('limit must be a non-negative finite number');
  return Math.floor(limit);
}

function normalizeOffset(value: unknown): number {
  if (value == null) return 0;
  const offset = Number(value);
  if (!Number.isFinite(offset) || offset < 0) throw new Error('offset must be a non-negative finite number');
  return Math.floor(offset);
}

/** 把结构化过滤条件编译为 SQL WHERE 片段与绑定参数（列名一律走白名单别名）。 */
function buildWhere(opts: QueryOptions, aliases: ColumnAliases) {
  const clauses: string[] = [];
  const params: any[] = [];
  if (opts.sessionId) { clauses.push(`${aliases.sessionId} = ?`); params.push(opts.sessionId); }
  if (Array.isArray(opts.sessions)) {
    if (!opts.sessions.length) clauses.push('0');
    else {
      clauses.push(`${aliases.sessionId} IN (${opts.sessions.map(() => '?').join(',')})`);
      params.push(...opts.sessions);
    }
  }
  if (opts.project) { clauses.push(`${aliases.project} LIKE ?`); params.push(opts.project); }
  if (opts.after) { clauses.push(`${aliases.timestamp} > ?`); params.push(opts.after); }
  if (opts.before) { clauses.push(`${aliases.timestamp} < ?`); params.push(opts.before); }
  if (opts.branch) { clauses.push(`${aliases.branch} = ?`); params.push(opts.branch); }
  if (opts.source && opts.source !== 'all' && aliases.source) {
    clauses.push(`COALESCE(${aliases.source}, 'claude') = ?`);
    params.push(opts.source);
  }
  return { where: clauses.length ? clauses.join(' AND ') : '1=1', params };
}

const BASH_EXIT_PAT = 'Exit code %';

/** 只允许 SELECT/WITH 开头的语句，禁止任何写/管理关键字，防止沙箱内 sql() 被用来改库。 */
function assertReadOnlySql(sql: unknown): void {
  const text = String(sql || '').trim();
  if (!/^(SELECT|WITH)\b/i.test(text)) {
    throw new Error('sql() only supports read-only SELECT/WITH queries');
  }
  if (/\b(INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER|PRAGMA|VACUUM|ATTACH|DETACH)\b/i.test(text)) {
    throw new Error('sql() only supports read-only SELECT/WITH queries');
  }
}

// 记忆层仅按英文索引，故拒绝中日韩（含假名/谚文）字符的正文。
const CJK_TEXT_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

/** 校验记忆文本必须为英文：含 CJK 字符即抛错，引导用户先翻译术语再写入记忆层。 */
function assertEnglishMemoryText(value: unknown, label: string): void {
  const text = String(value || '');
  if (!text.trim()) return;
  if (CJK_TEXT_RE.test(text)) {
    const requirement = label.includes('query') ? 'must use English terms' : 'must be written in English';
    throw new Error(`${label} ${requirement}; translate user-language terms before using the memory layer`);
  }
}

/** 把用户文本拆成最多 12 个 token 并逐个加引号，规避 FTS5 把连字符/标点误解析为运算符。 */
function buildSafeFtsQuery(text: unknown): string {
  const tokens = String(text || '').match(/[\p{Letter}\p{Number}]+/gu) || [];
  return tokens
    .slice(0, 12)
    .map(token => `"${token}"`)
    .join(' ');
}

/**
 * 创建只读历史检索 API。该对象会被 core.ts 注入 VM sandbox，因此每个函数既是
 * Agent 脚本的公共能力，也是必须保持稳定的安全接口。
 */
function createQueryApi(
  db: SqliteDb,
  { providerRegistry = createBuiltinProviderRegistry() }: { providerRegistry?: ProviderRegistry } = {},
) {
  /** 受控只读 SQL 入口：先校验只读，再执行并返回全部行。 */
  const q = (sql: string, ...p: any[]) => {
    assertReadOnlySql(sql);
    return db.prepare(sql).all(...p);
  };

  /** overview 专用重载：字符串 → project，数字 → limit。 */
  const normalizeOverviewOpts = (optsOrScalar: QueryOptions | string | number | null | undefined): QueryOptions => {
    if (optsOrScalar == null) return {};
    if (typeof optsOrScalar === 'string') return { project: optsOrScalar };
    if (typeof optsOrScalar === 'number') return { limit: optsOrScalar };
    return optsOrScalar;
  };

  /** 以 FTS5 检索消息，并附带命中点附近的会话上下文。 */
  const search = (text: string, opts: QueryOptions = {}) => {
    const { sessionId, project, after, before, cwd, source, includeMeta = false, includeInactive = false } = opts;
    const limit = normalizeLimit(opts.limit, 20);
    let where = 'WHERE mf.text MATCH ?';
    const filterParams: any[] = [];
    if (sessionId) { where += ' AND mf.session_id=?'; filterParams.push(sessionId); }
    if (project)   { where += ' AND s.project LIKE ?'; filterParams.push(project); }
    if (after)     { where += ' AND m.timestamp>?';    filterParams.push(after); }
    if (before)    { where += ' AND m.timestamp<?';    filterParams.push(before); }
    if (cwd)       { where += ' AND m.cwd LIKE ?';     filterParams.push(cwd); }
    if (source && source !== 'all') { where += " AND COALESCE(m.source, s.source, 'claude')=?"; filterParams.push(source); }
    if (!includeMeta) where += ' AND COALESCE(m.is_meta,0)=0';
    where += includeInactive ? " AND m.visibility != 'hidden'" : " AND m.visibility = 'visible'";
    const stmt = db.prepare(`
      SELECT m.uuid,m.session_id,m.text,m.content_type,m.is_meta,m.visibility,m.role,m.timestamp,m.model,m.cwd,m.source as m_source,
             s.id as s_id,s.title as s_title,s.project as s_project,s.started_at as s_started,
             s.source as s_source,
             rank
      FROM messages_fts mf JOIN messages m ON m.uuid=mf.uuid LEFT JOIN sessions s ON s.id=m.session_id
      ${where} ORDER BY rank LIMIT ?`);
    const runMatch = (matchText: string): DbRow[] => stmt.all(matchText, ...filterParams, limit);
    // 查询合法时保留原始 FTS5 语法以获得更高精度；但普通输入（连字符、标点）会被
    // FTS5 误解析为运算符，此时退回与 memories() 相同的逐 token 加引号安全写法。
    let rows;
    try {
      rows = runMatch(text);
    } catch {
      const safe = buildSafeFtsQuery(text);
      rows = safe ? runMatch(safe) : [];
    }
    return rows.map((r: DbRow) => {
      const metaClause = `${includeMeta ? '' : 'AND COALESCE(is_meta,0)=0'} ${includeInactive ? "AND visibility != 'hidden'" : "AND visibility = 'visible'"}`;
      const ctx = db.prepare(
        `SELECT uuid,text,content_type,is_meta,visibility,role,timestamp,model,COALESCE(source, 'claude') as source FROM messages WHERE session_id=? AND uuid!=? ${metaClause} ORDER BY ABS(JULIANDAY(timestamp)-JULIANDAY(?)) LIMIT 6`
      ).all(r.session_id, r.uuid, r.timestamp).sort((a: DbRow, b: DbRow) => a.timestamp < b.timestamp ? -1 : 1);
      const sourceValue = r.m_source || r.s_source || 'claude';
      return {
        message: { uuid: r.uuid, text: r.text, content_type: r.content_type, is_meta: r.is_meta || 0, visibility: r.visibility, role: r.role, timestamp: r.timestamp, model: r.model, cwd: r.cwd, source: sourceValue },
        session: { id: r.s_id, title: r.s_title, project: r.s_project, started_at: r.s_started, source: r.s_source || sourceValue },
        rank: r.rank,
        context: ctx,
      };
    });
  };

  /** 按 message UUID 回溯父消息链，并补齐所属 session/agent/workflow。 */
  const context = (uuid: string) => {
    const msg = db.prepare('SELECT * FROM messages WHERE uuid=?').get(uuid);
    if (!msg) return null;
    const session = db.prepare('SELECT * FROM sessions WHERE id=?').get(msg.session_id);
    const chain: DbRow[] = [];
    let cur: DbRow | undefined = msg;
    const seen = new Set<string>([msg.uuid]);
    while (cur?.parent_uuid) {
      const parent = db.prepare('SELECT * FROM messages WHERE uuid=?').get(cur.parent_uuid);
      if (!parent || seen.has(parent.uuid)) break;
      seen.add(parent.uuid);
      chain.unshift(parent);
      cur = parent;
    }
    const subagent = msg.agent_id ? db.prepare('SELECT * FROM subagents WHERE agent_id=?').get(msg.agent_id) : null;
    let workflow = null;
    if (msg.agent_id) {
      const wa = db.prepare('SELECT * FROM workflow_agents WHERE agent_id=?').get(msg.agent_id);
      if (wa) workflow = db.prepare('SELECT * FROM workflows WHERE run_id=?').get(wa.run_id);
    }
    return { message: msg, parentChain: chain, session, subagent, workflow };
  };

  /** 沿 parent_uuid 自底向上回溯完整父链（含起点本身）。 */
  const trace = (uuid: string) => {
    const chain: DbRow[] = [];
    let cur = db.prepare('SELECT * FROM messages WHERE uuid=?').get(uuid);
    const seen = new Set<string>();
    while (cur && !seen.has(cur.uuid)) {
      seen.add(cur.uuid);
      chain.unshift(cur);
      cur = cur.parent_uuid ? db.prepare('SELECT * FROM messages WHERE uuid=?').get(cur.parent_uuid) : undefined;
    }
    return chain;
  };

  /** 单个 session 内按时间排序的全部消息（默认剔除 meta）。 */
  const thread = (sid: string, opts: QueryOptions = {}) => {
    const includeMeta = opts?.includeMeta === true;
    const visibilityClause = opts?.includeInactive ? "AND visibility != 'hidden'" : "AND visibility = 'visible'";
    const metaClause = includeMeta ? '' : 'AND COALESCE(is_meta,0)=0';
    return db.prepare(`SELECT * FROM messages WHERE session_id=? ${metaClause} ${visibilityClause} ORDER BY timestamp`).all(sid);
  };

  /** 列出子代理，并附带各自的 messageCount。 */
  const subagents = (optsOrSid?: QueryOptions | string) => {
    const opts = normalizeOpts(optsOrSid);
    const limit = normalizeLimit(opts.limit, 100);
    const needsJoin = opts.project || opts.after || opts.before || opts.branch || opts.source;
    const { where, params } = buildWhere(opts, { sessionId: 'sa.session_id', project: 's.project', timestamp: 's.started_at', branch: 's.git_branch', source: 's.source' });
    params.push(limit);
    const join = needsJoin ? 'LEFT JOIN sessions s ON s.id=sa.session_id' : '';
    return db.prepare(`SELECT sa.* FROM subagents sa ${join} WHERE ${where} LIMIT ?`).all(...params).map((r: DbRow) => {
      const c = db.prepare('SELECT COUNT(*) as c FROM messages WHERE agent_id=?').get(r.agent_id);
      return { ...r, messageCount: c?.c || 0 };
    });
  };

  /** 列出 workflow 运行记录（可按 project/branch/source 过滤）。 */
  const workflows = (optsOrSid?: QueryOptions | string) => {
    const opts = normalizeOpts(optsOrSid);
    const limit = normalizeLimit(opts.limit, 100);
    const needsJoin = opts.project || opts.branch || opts.source;
    const { where, params } = buildWhere(opts, { sessionId: 'w.session_id', project: 's.project', timestamp: 'w.timestamp', branch: 's.git_branch', source: 's.source' });
    params.push(limit);
    const join = needsJoin ? 'LEFT JOIN sessions s ON s.id=w.session_id' : '';
    return db.prepare(`SELECT w.* FROM workflows w ${join} WHERE ${where} ORDER BY w.timestamp DESC LIMIT ?`).all(...params);
  };

  /** 单个 workflow 的完整树：含解析后的 result_json 与全部 agents（带消息数）。 */
  const workflowTree = (runId: string) => {
    const wf = db.prepare('SELECT * FROM workflows WHERE run_id=?').get(runId);
    if (!wf) return null;
    let result = null;
    try { result = JSON.parse(wf.result_json); } catch { /* keep the raw result nullable */ }
    const agents = db.prepare('SELECT * FROM workflow_agents WHERE run_id=?').all(runId).map((a: DbRow) => {
      const mc = db.prepare('SELECT COUNT(*) as c FROM messages WHERE agent_id=?').get(a.agent_id);
      return { ...a, messageCount: mc?.c || 0 };
    });
    return { ...wf, result, agents };
  };

  /** 按文件路径回查相关工具调用历史（含所属 session 与时间戳）。 */
  const fileHistory = (fp: string, opts: QueryOptions = {}) => {
    const { after, before, source } = opts;
    const limit = normalizeLimit(opts.limit, 200);
    let where = 'tc.file_path=?';
    const params: any[] = [fp];
    if (after)  { where += ' AND m.timestamp > ?'; params.push(after); }
    if (before) { where += ' AND m.timestamp < ?'; params.push(before); }
    if (source && source !== 'all') { where += " AND COALESCE(s.source, 'claude') = ?"; params.push(source); }
    params.push(limit);
    return db.prepare(
      `SELECT tc.*,s.title as s_title,s.project as s_project,m.timestamp as ts FROM tool_calls tc LEFT JOIN sessions s ON s.id=tc.session_id LEFT JOIN messages m ON m.uuid=tc.message_uuid WHERE ${where} ORDER BY m.timestamp LIMIT ?`
    ).all(...params).map((r: DbRow) => ({
      toolCall: { id: r.id, message_uuid: r.message_uuid, name: r.name, input_json: r.input_json },
      session: { id: r.session_id, title: r.s_title, project: r.s_project },
      timestamp: r.ts,
    }));
  };

  /** 列出失败的工具结果（is_error=1 或内容以 'Exit code' 开头），附后续消息。 */
  const failures = (optsOrSid?: QueryOptions | string) => {
    const opts = normalizeOpts(optsOrSid);
    const limit = normalizeLimit(opts.limit, 50);
    const needsJoin = opts.project || opts.branch || opts.source;
    const { where, params: filterParams } = buildWhere(opts, { sessionId: 'tr.session_id', project: 's.project', timestamp: 'rm.timestamp', branch: 's.git_branch', source: 's.source' });
    const join = needsJoin ? 'LEFT JOIN sessions s ON s.id=tr.session_id' : '';
    const errorCond = `(tr.is_error = 1 OR tr.content LIKE '${BASH_EXIT_PAT}')`;
    const allParams = [...filterParams, limit];
    const rows = db.prepare(`SELECT tr.* FROM tool_results tr ${join} LEFT JOIN messages rm ON rm.uuid=tr.message_uuid WHERE ${errorCond} AND ${where} ORDER BY rm.timestamp DESC LIMIT ?`).all(...allParams);
    return rows.map((r: DbRow) => {
      const tc = db.prepare('SELECT * FROM tool_calls WHERE id=?').get(r.tool_use_id);
      const session = db.prepare('SELECT * FROM sessions WHERE id=?').get(r.session_id);
      const rm = db.prepare('SELECT * FROM messages WHERE uuid=?').get(r.message_uuid);
      const next = rm?.timestamp ? db.prepare('SELECT * FROM messages WHERE session_id=? AND timestamp>? ORDER BY timestamp LIMIT 3').all(r.session_id, rm.timestamp) : [];
      return { toolCall: tc, result: r, session, nextMessages: next };
    });
  };

  /** 按过滤条件查 session 列表，默认按 ended_at 倒序取 50 条。 */
  const sessions = (optsOrN?: QueryOptions | number | string) => {
    const opts = normalizeOpts(optsOrN, 'sessionId');
    const limit = normalizeLimit(opts.limit, 50);
    const { where, params } = buildWhere(opts, { sessionId: 's.id', project: 's.project', timestamp: 's.started_at', branch: 's.git_branch', source: 's.source' });
    params.push(limit);
    return db.prepare(`SELECT * FROM sessions s WHERE ${where} ORDER BY ended_at DESC LIMIT ?`).all(...params);
  };

  /** sessions({ limit: n }) 的便捷包装。 */
  const recent = (n = 10) => sessions({ limit: n });

  /** 会话摘要列表（可附带 session 标题与 project）。 */
  const summaries = (optsOrSid?: QueryOptions | string) => {
    const opts = normalizeOpts(optsOrSid);
    const limit = normalizeLimit(opts.limit, 100);
    const { where, params } = buildWhere(opts, { sessionId: 'su.session_id', project: 's.project', timestamp: 'su.timestamp', branch: 's.git_branch', source: 's.source' });
    params.push(limit);
    return db.prepare(`SELECT su.*, s.title as session_title, s.project FROM summaries su LEFT JOIN sessions s ON s.id=su.session_id WHERE ${where} ORDER BY su.timestamp DESC LIMIT ?`).all(...params);
  };

  /** 概览：解析当前项目 + 全部项目的 session/记忆统计；是 overview 脚本的主要数据源。 */
  const overview = (optsOrScalar?: QueryOptions | string | number) => {
    const opts = normalizeOverviewOpts(optsOrScalar);
    const cwd = process.cwd();
    const sessionLimit = normalizeLimit(opts.limit, 8);
    const projectLimit = normalizeLimit(opts.projectLimit, 20);
    const memoryLimit = normalizeLimit(opts.memoryLimit, 100);

    const projectDescriptor = (row: DbRow | null, source: string, confidence: string) => row ? ({
      project: row.project,
      project_path: row.project_path || null,
      source,
      confidence,
    }) : null;

    const latestProjectByPattern = (pattern: string): DbRow | undefined => {
      const fromSessions = db.prepare(`
        SELECT project, project_path
        FROM sessions
        WHERE project LIKE ?
        ORDER BY COALESCE(ended_at, started_at) DESC
        LIMIT 1
      `).get(pattern);
      if (fromSessions) return fromSessions;
      return db.prepare(`
        SELECT project, NULL AS project_path
        FROM memories
        WHERE project LIKE ?
        ORDER BY created_at DESC
        LIMIT 1
      `).get(pattern);
    };

    const resolveCurrentProject = () => {
      if (opts.project) {
        const row = latestProjectByPattern(opts.project);
        const confidence = row ? (/[%_]/.test(opts.project) ? 'inferred' : 'exact') : 'unknown';
        return projectDescriptor(row || { project: opts.project, project_path: null }, 'opts', confidence);
      }

      // 第一优先：cwd 精确匹配或前缀匹配 sessions.project_path（最长匹配 + 最近活跃）。
      const paths = db.prepare(`
        SELECT project, project_path, MAX(COALESCE(ended_at, started_at)) AS last_seen
        FROM sessions
        WHERE project IS NOT NULL AND project_path IS NOT NULL AND project_path != ''
        GROUP BY project, project_path
      `).all();
      const byProjectPath = paths
        .filter((r: DbRow) => cwd === r.project_path || cwd.startsWith(r.project_path + sep))
        .sort((a: DbRow, b: DbRow) => b.project_path.length - a.project_path.length || String(b.last_seen || '').localeCompare(String(a.last_seen || '')))[0];
      if (byProjectPath) return projectDescriptor(byProjectPath, 'cwd_project_path', 'exact');

      // 第二优先：cwd 精确匹配 messages.cwd（老数据无 project_path 时的兼容路径）。
      const byMessageCwd = db.prepare(`
        SELECT s.project, s.project_path, MAX(m.timestamp) AS last_seen
        FROM messages m
        LEFT JOIN sessions s ON s.id=m.session_id
        WHERE m.cwd = ? AND s.project IS NOT NULL
        GROUP BY s.project, s.project_path
        ORDER BY last_seen DESC
        LIMIT 1
      `).get(cwd);
      if (byMessageCwd) return projectDescriptor(byMessageCwd, 'cwd_messages', 'inferred');

      return null;
    };

    // 聚合全部项目：session/记忆计数、最近活跃时间与最近分支（供列表展示）。
    const projects = db.prepare(`
      WITH names AS (
        SELECT project FROM sessions WHERE project IS NOT NULL GROUP BY project
        UNION
        SELECT project FROM memories WHERE project IS NOT NULL AND deleted_at IS NULL GROUP BY project
      ),
      session_stats AS (
        SELECT project, COUNT(*) AS session_count, MAX(COALESCE(ended_at, started_at)) AS last_session_at
        FROM sessions
        WHERE project IS NOT NULL
        GROUP BY project
      ),
      memory_stats AS (
        SELECT project, COUNT(*) AS memory_count, MAX(created_at) AS last_memory_at
        FROM memories
        WHERE project IS NOT NULL AND deleted_at IS NULL
        GROUP BY project
      )
      SELECT
        n.project,
        (
          SELECT s2.project_path
          FROM sessions s2
          WHERE s2.project = n.project AND s2.project_path IS NOT NULL
          ORDER BY COALESCE(s2.ended_at, s2.started_at) DESC
          LIMIT 1
        ) AS project_path,
        COALESCE(ss.session_count, 0) AS session_count,
        COALESCE(ms.memory_count, 0) AS memory_count,
        ss.last_session_at,
        ms.last_memory_at
      FROM names n
      LEFT JOIN session_stats ss ON ss.project = n.project
      LEFT JOIN memory_stats ms ON ms.project = n.project
      ORDER BY COALESCE(ss.last_session_at, ms.last_memory_at) DESC
      LIMIT ?
    `).all(projectLimit).map((row: DbRow) => {
      const branches = db.prepare(`
        SELECT git_branch
        FROM sessions
        WHERE project = ? AND git_branch IS NOT NULL AND git_branch != ''
        GROUP BY git_branch
        ORDER BY MAX(COALESCE(ended_at, started_at)) DESC
        LIMIT 5
      `).all(row.project).map((r: DbRow) => r.git_branch);
      return { ...row, recent_branches: branches };
    });

    const currentProject = resolveCurrentProject();
    let current_project = null;
    if (currentProject?.project) {
      const sessionTotal = db.prepare('SELECT COUNT(*) AS c FROM sessions WHERE project = ?').get(currentProject.project)?.c || 0;
      const sessionsForProject = db.prepare(`
        SELECT id, title, project, project_path, started_at, ended_at, git_branch, message_count, COALESCE(source, 'claude') AS source
        FROM sessions
        WHERE project = ?
        ORDER BY COALESCE(ended_at, started_at) DESC
        LIMIT ?
      `).all(currentProject.project, sessionLimit);
      const memoryTotal = db.prepare('SELECT COUNT(*) AS c FROM memories WHERE project = ? AND deleted_at IS NULL').get(currentProject.project)?.c || 0;
      const memoriesForProject = db.prepare(`
        SELECT id, path, summary, session_id, project, created_at
        FROM memories
        WHERE project = ? AND deleted_at IS NULL
        ORDER BY created_at DESC
        LIMIT ?
      `).all(currentProject.project, memoryLimit);
      current_project = {
        project: currentProject.project,
        project_path: currentProject.project_path,
        session_total: sessionTotal,
        sessions: sessionsForProject,
        memory_total: memoryTotal,
        memories: memoriesForProject,
      };
    }

    const totalProjects = db.prepare(`
      SELECT COUNT(*) AS c
      FROM (
        SELECT project FROM sessions WHERE project IS NOT NULL GROUP BY project
        UNION
        SELECT project FROM memories WHERE project IS NOT NULL AND deleted_at IS NULL GROUP BY project
      )
    `).get()?.c || 0;
    const totalSessions = db.prepare('SELECT COUNT(*) AS c FROM sessions').get()?.c || 0;
    const totalMemories = db.prepare('SELECT COUNT(*) AS c FROM memories WHERE deleted_at IS NULL').get()?.c || 0;
    const sources = db.prepare(`
      SELECT COALESCE(source, 'claude') AS source,
             COUNT(*) AS session_count,
             MAX(COALESCE(ended_at, started_at)) AS last_session_at
      FROM sessions
      GROUP BY COALESCE(source, 'claude')
      ORDER BY last_session_at DESC
    `).all();

    return {
      current: {
        cwd,
        project: currentProject,
      },
      current_project,
      projects,
      totals: {
        projects: totalProjects,
        sessions: totalSessions,
        memories: totalMemories,
        sources,
      },
    };
  };

  /** 调用对应 Provider 的 raw lookup，从 SQLite message 回到原始日志证据。 */
  const raw = (messageUuid: string, opts: { offset?: number; limit?: number } = {}) => {
    const offset = normalizeOffset(opts.offset);
    const limit = normalizeLimit(opts.limit, 10000);
    const message = db.prepare('SELECT * FROM messages WHERE uuid=?').get(messageUuid);
    if (!message) return null;
    const session = db.prepare('SELECT * FROM sessions WHERE id=?').get(message.session_id) ?? null;
    const subagent = message.agent_id
      ? db.prepare('SELECT * FROM subagents WHERE agent_id=?').get(message.agent_id) ?? null
      : null;
    const workflowAgent = message.agent_id
      ? db.prepare('SELECT * FROM workflow_agents WHERE agent_id=?').get(message.agent_id) ?? null
      : null;
    const source = message.source || session?.source || 'claude';
    const record = providerRegistry.raw({
      source,
      messageUuid,
      session,
      agentId: message.agent_id || null,
      subagent,
      workflowAgent,
    });
    if (record === null) return null;
    const totalLength = record.totalLength ?? record.text.length;
    return {
      text: record.text.slice(offset, offset + limit),
      totalLength,
      offset,
      limit,
      hasMore: offset + limit < totalLength,
    };
  };

  /** 记忆检索：带 query 时走 memories_fts 相关度排序，否则按创建时间倒序。 */
  const memories = (optsOrSid?: QueryOptions | string) => {
    const memoryColumns = 'mem.id, mem.session_id, mem.project, mem.message_start, mem.message_end, mem.path, mem.summary, mem.created_at, mem.deleted_at, mem.deleted_reason';
    const opts = normalizeOpts(optsOrSid);
    const { query } = opts;
    const limit = normalizeLimit(opts.limit, 50);
    assertEnglishMemoryText(query, 'memories() query');
    const needsJoin = opts.branch || opts.source;
    const { where: baseWhere, params } = buildWhere(opts, {
      sessionId: 'mem.session_id',
      project: 'mem.project',
      timestamp: 'mem.created_at',
      branch: 's.git_branch',
      source: 's.source',
    });
    const where = baseWhere + ' AND mem.deleted_at IS NULL';
    const join = needsJoin ? 'LEFT JOIN sessions s ON s.id=mem.session_id' : '';
    const hasQuery = String(query || '').trim().length > 0;
    const ftsQuery = buildSafeFtsQuery(query);
    if (!hasQuery) {
      params.push(limit);
      return db.prepare(`SELECT ${memoryColumns} FROM memories mem ${join} WHERE ${where} ORDER BY mem.created_at DESC LIMIT ?`).all(...params);
    }
    if (!ftsQuery) return [];
    params.unshift(ftsQuery);
    params.push(limit);
    return db.prepare(`
      SELECT ${memoryColumns}, mf.rank AS rank
      FROM memories_fts mf
      JOIN memories mem ON mem.rowid = mf.rowid
      ${join}
      WHERE memories_fts MATCH ? AND ${where}
      ORDER BY mf.rank, mem.created_at DESC
      LIMIT ?
    `).all(...params);
  };

  return { sql: q, search, context, trace, thread, subagents, workflows, workflowTree, fileHistory, failures, sessions, recent, summaries, raw, memories, overview };
}

/**
 * 创建记忆层的最小写 API。与查询 API 分开，确保 executeAttune() 才能获得写能力。
 */
function createAttuneApi(db: SqliteDb) {
  const resolveMemoryPath = (memoryPath: string, sessionId?: string): string => {
    let base = null;
    if (sessionId) {
      base = db.prepare('SELECT project_path FROM sessions WHERE id=?').get(sessionId)?.project_path || null;
    }
    const resolved = isAbsolute(memoryPath)
      ? normalize(memoryPath)
      : resolve(base || process.cwd(), memoryPath);
    let stat;
    try {
      stat = statSync(resolved);
    } catch {
      throw new Error(`remember() memory file does not exist: ${resolved}`);
    }
    if (!stat.isFile()) throw new Error(`remember() memory path is not a file: ${resolved}`);
    return resolved;
  };

  /** 写入一条记忆（INSERT OR REPLACE），返回新记录的关键字段。 */
  const remember = ({ path: memoryPath, session_id, message_start, message_end, summary, project }: RememberInput) => {
    if (!memoryPath || !summary) throw new Error('remember() requires path and summary');
    assertEnglishMemoryText(summary, 'remember() summary');
    const normalizedPath = resolveMemoryPath(memoryPath, session_id);
    const id = `mem-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const proj = project || (session_id
      ? db.prepare('SELECT project FROM sessions WHERE id=?').get(session_id)?.project || null
      : null);
    const created_at = new Date().toISOString();
    db.prepare('INSERT OR REPLACE INTO memories (id, session_id, project, message_start, message_end, path, summary, created_at) VALUES (?,?,?,?,?,?,?,?)').run(
      id, session_id || null, proj, message_start || null, message_end || null, normalizedPath, summary, created_at);
    return { id, path: normalizedPath, project: proj, created_at };
  };

  /** 软删除记忆：写 deleted_at/deleted_reason；对同一 id 重复调用返回 already_deleted。 */
  const forget = ({ id, reason }: ForgetInput) => {
    const deletionReason = String(reason || '').trim();
    if (!id || !deletionReason) throw new Error('forget() requires id and reason');
    const row = db.prepare('SELECT id, deleted_at, deleted_reason FROM memories WHERE id=?').get(id);
    if (!row) throw new Error(`forget() memory not found: ${id}`);
    if (row.deleted_at) {
      return { id, deleted_at: row.deleted_at, deleted_reason: row.deleted_reason, already_deleted: true };
    }
    const deleted_at = new Date().toISOString();
    db.prepare('UPDATE memories SET deleted_at=?, deleted_reason=? WHERE id=?').run(deleted_at, deletionReason, id);
    return { id, deleted_at, deleted_reason: deletionReason };
  };

  return { remember, forget };
}

export { createQueryApi, createAttuneApi };
