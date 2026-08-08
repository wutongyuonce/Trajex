/**
 * Claude Code Provider adapter。
 *
 * 模块定位：发现 ~/.claude 下的主会话、subagent 与 workflow 文件，并把 Claude
 * 私有 JSONL/JSON 语义投影为 TranscriptRecord。它不访问 Trajex SQLite。
 */
// Claude Code provider adapter in Core (see docs/adr/0001).
//
// Pure: discovers Claude transcript files and parses one into a record stream.
// It never touches the Trajex database. The per-line logic mirrors the original
// indexJsonl exactly, but yields canonical TranscriptRecords instead of writing rows; the shared
// persist layer consumes them. Session aggregates here reflect only THIS chunk
// (started_at/ended_at/message_count); persist merges them with any existing row.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, normalize, relative } from 'node:path';

import {
  extractText, extractContentType, extractMessageIsMeta, isSkillInstructions,
  filePath, trunc, truncJson, readLines, discoverJsonlFiles, isDir,
} from '../parsing.ts';

import type {
  Cursor,
  DiscoverContext,
  TranscriptRecord,
  IndexUnit,
  ProviderAdapter,
  RawLookup,
  RawRecord,
} from './types.ts';

// Claude cursor encodes the file mtime and the number of lines already indexed:
// "<mtimeMs>:<linesProcessed>". mtime lets discovery detect change; lines lets
// parse resume without reprocessing.
function cursorToSkip(cursor: Cursor): number {
  if (!cursor) return 0;
  const n = Number(cursor.split(':')[1]);
  return Number.isFinite(n) ? n : 0;
}

export const name = 'claude';
export const CLAUDE_CANONICAL_TRANSCRIPT_MARKER = '__claude_canonical_transcript_v3__';

interface ClaudeWorkflowUnitMeta {
  readonly kind: 'workflow';
  readonly mainTranscriptPath: string;
}

function totalInputTokens(usage: Record<string, unknown>): number | null {
  const fields = [
    'input_tokens',
    'cache_creation_input_tokens',
    'cache_read_input_tokens',
  ];
  let seen = false;
  let total = 0;
  for (const field of fields) {
    const value = usage[field];
    if (typeof value !== 'number' || !Number.isFinite(value)) continue;
    seen = true;
    total += value;
  }
  return seen ? total : null;
}

function readableDirectory(path: string): boolean {
  try { readdirSync(path); return true; } catch { return false; }
}

function pathWithin(root: string, candidate: string): boolean {
  const inside = relative(root, candidate);
  return inside === '' || (!inside.startsWith('..') && !isAbsolute(inside));
}

function changedPathCovers(changedPaths: readonly string[], target: string): boolean {
  return changedPaths.some((changed) => changed === target || pathWithin(changed, target));
}

function discoverAt(rootDir: string, ctx: DiscoverContext): IndexUnit[] {
  const projectsDir = join(rootDir, 'projects');
  const changedTranscriptPaths = new Set<string>();
  const changedWorkflowPaths = new Set<string>();
  const forcedPaths = new Set<string>();
  const changedScopes: string[] = [];
  for (const changedPath of ctx.changedPaths ?? []) {
    const absolute = isAbsolute(changedPath)
      ? normalize(changedPath)
      : normalize(join(projectsDir, changedPath));
    const inside = relative(projectsDir, absolute);
    if (!inside || inside.startsWith('..') || isAbsolute(inside)) continue;
    changedScopes.push(absolute);
    if (absolute.toLowerCase().endsWith('.meta.json')) {
      const transcript = absolute.slice(0, -'.meta.json'.length) + '.jsonl';
      changedTranscriptPaths.add(transcript);
      forcedPaths.add(transcript);
    } else if (absolute.toLowerCase().endsWith('.jsonl')) {
      changedTranscriptPaths.add(absolute);
    } else if (absolute.toLowerCase().endsWith('.json')) {
      changedWorkflowPaths.add(absolute);
    }
  }
  // An absent/unreadable projects directory is not a complete inventory. In
  // that state, an empty discovery result must not be interpreted as deletion.
  const inventoryComplete = readableDirectory(projectsDir);
  const transcriptFiles = inventoryComplete ? discoverJsonlFiles(projectsDir) : [];
  const currentTranscriptPaths = new Set(transcriptFiles.map(file => normalize(file.path)));
  const transcriptUnits = transcriptFiles.filter((file) => {
    const normalizedPath = normalize(file.path);
    if (ctx.changedPaths !== undefined && !changedTranscriptPaths.has(normalizedPath)) return false;
    const cursor = ctx.lastCursor(file.path);
    return forcedPaths.has(normalizedPath)
      || cursor === null
      || Number(cursor.split(':')[0]) < statSync(file.path).mtimeMs;
  }).map((f: any) => ({
    key: f.path,
    sessionId: f.sessionId,
    project: f.project,
    isSubagent: f.isSubagent,
    agentId: f.agentId,
    meta: {
      ...(f.workflowRunId ? { workflowRunId: f.workflowRunId } : {}),
    },
  }));

  const workflowUnits: IndexUnit[] = [];
  if (!inventoryComplete) return transcriptUnits;
  let projects: string[];
  try { projects = readdirSync(projectsDir); } catch { return transcriptUnits; }
  for (const project of projects) {
    const projectPath = join(projectsDir, project);
    if (!isDir(projectPath)) continue;
    let sessionIds: string[];
    try { sessionIds = readdirSync(projectPath); } catch { continue; }
    for (const sessionId of sessionIds) {
      const workflowDir = join(projectPath, sessionId, 'workflows');
      if (!isDir(workflowDir)) continue;
      const mainTranscriptPath = join(projectPath, `${sessionId}.jsonl`);
      let files: string[];
      try { files = readdirSync(workflowDir); } catch { continue; }
      for (const file of files) {
        if (!file.endsWith('.json')) continue;
        const workflowPath = join(workflowDir, file);
        const normalizedPath = normalize(workflowPath);
        const relationshipChanged = changedTranscriptPaths.has(normalize(mainTranscriptPath));
        if (
          ctx.changedPaths !== undefined
          && !changedWorkflowPaths.has(normalizedPath)
          && !relationshipChanged
        ) continue;
        const mtime = statSync(workflowPath).mtimeMs;
        const cursor = ctx.lastCursor(workflowPath);
        if (!relationshipChanged && cursor !== null && Number(cursor.split(':')[0]) >= mtime) continue;
        workflowUnits.push({
          key: workflowPath,
          sessionId,
          project,
          meta: { kind: 'workflow', mainTranscriptPath } satisfies ClaudeWorkflowUnitMeta,
        });
      }
    }
  }
  const tombstones = (ctx.indexedSessions?.() ?? [])
    .filter(session => {
      const path = normalize(session.jsonlPath);
      if (!pathWithin(normalize(projectsDir), path) || currentTranscriptPaths.has(path)) return false;
      return ctx.changedPaths === undefined || changedPathCovers(changedScopes, path);
    })
    .map(session => ({
      key: normalize(session.jsonlPath),
      sessionId: session.sessionId,
      retractSessionIds: [session.sessionId],
      meta: { kind: 'claude-tombstone' as const },
    }));

  return [...transcriptUnits, ...workflowUnits, ...tombstones];
}

/**
 * 发现 Claude 主会话、subagent transcript 与 workflow JSON。cursor 采用
 * `mtime:lines`，因此普通会话可按已处理行增量恢复。
 */
export function discover(ctx: DiscoverContext): IndexUnit[] {
  return discoverAt(join(homedir(), '.claude'), ctx);
}

function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((part) => typeof part?.text === 'string' ? part.text : '').join('\n');
}

function workflowParentToolUseId(
  transcriptPath: string,
  runId: string,
): string | null {
  if (!existsSync(transcriptPath)) return null;
  const workflowToolIds = new Set<string>();
  let parentToolUseId: string | null = null;
  readLines(transcriptPath, (line: string) => {
    let record: any;
    try { record = JSON.parse(line); } catch { return; }
    const content = record?.message?.content;
    if (!Array.isArray(content)) return;
    if (record.type === 'assistant') {
      for (const block of content) {
        if (block?.type === 'tool_use' && block?.name === 'Workflow' && typeof block.id === 'string') {
          workflowToolIds.add(block.id);
        }
      }
      return;
    }
    if (record.type !== 'user') return;
    for (const block of content) {
      if (block?.type !== 'tool_result' || !workflowToolIds.has(block.tool_use_id)) continue;
      const text = toolResultText(block.content);
      if (!text.includes(runId)) continue;
      parentToolUseId = block.tool_use_id;
      return false;
    }
  });
  return parentToolUseId;
}

/**
 * 将单个 Claude workflow JSON 投影为 workflow 与 workflow_agent 记录，并扫描主
 * transcript 以恢复它对应的 Workflow tool call ID。
 */
function* parseWorkflow(unit: IndexUnit): Generator<TranscriptRecord, Cursor> {
  const mtime = statSync(unit.key).mtimeMs;
  const outCursor = `${mtime}:1`;
  let workflow: any;
  try { workflow = JSON.parse(readFileSync(unit.key, 'utf8')); } catch { return outCursor; }
  if (!workflow?.runId) return outCursor;
  const meta = unit.meta as ClaudeWorkflowUnitMeta;
  const progress = Array.isArray(workflow.workflowProgress) ? workflow.workflowProgress : [];
  const agents = progress.filter((item: any) => item?.type === 'workflow_agent' && item.agentId);
  yield {
    kind: 'workflow',
    run_id: workflow.runId,
    session_id: unit.sessionId,
    parent_tool_use_id: workflowParentToolUseId(
      meta.mainTranscriptPath,
      workflow.runId,
    ),
    task_id: workflow.taskId || null,
    script: workflow.script || null,
    result_json: workflow.result ? JSON.stringify(workflow.result) : null,
    timestamp: workflow.timestamp || null,
    agent_count: agents.length,
    duration_ms: workflow.durationMs || null,
    total_tokens: workflow.totalTokens || null,
    status: workflow.status || null,
    workflow_name: workflow.workflowName || null,
  };
  for (const item of agents) {
    yield {
      kind: 'workflow_agent',
      agent_id: `agent-${item.agentId}`,
      run_id: workflow.runId,
      session_id: unit.sessionId,
      phase: item.phaseTitle || null,
      label: item.label || null,
      model: item.model || null,
      state: item.state || null,
      duration_ms: item.durationMs || null,
      tokens: item.tokens || null,
      tool_calls: item.toolCalls || null,
    };
  }
  return outCursor;
}

/**
 * 增量解析 Claude JSONL。先跳过 cursor 已消费的行，再提取消息、tool、
 * duration 及 subagent 元数据；主会话末尾才产出 session 聚合记录。
 */
export function* parse(unit: IndexUnit, cursor: Cursor): Generator<TranscriptRecord, Cursor> {
  const kind = (unit.meta as { kind?: string } | undefined)?.kind;
  if (kind === 'claude-tombstone') return '0:0';
  if (kind === 'workflow') {
    return yield* parseWorkflow(unit);
  }
  const skip = cursorToSkip(cursor);
  const mtime = statSync(unit.key).mtimeMs;
  const isSubagent = unit.isSubagent === true;
  const records: TranscriptRecord[] = [];
  const sm = {
    started_at: null as string | null,
    ended_at: null as string | null,
    git_branch: null as string | null,
    version: null as string | null,
    title: null,
    n: 0,
  };
  const subagentStats = {
    startedAt: null as string | null,
    endedAt: null as string | null,
    totalTokens: 0,
  };

  let lineNum = 0;
  let processedLineCount = 0;
  readLines(unit.key, (line: string) => {
    lineNum++;
    let obj: any;
    try { obj = JSON.parse(line); } catch {
      // Historical lines before the cursor have already been accepted. A new
      // malformed line is the boundary of this incremental batch: stop here,
      // keep the cursor before it, and let the next file change retry it.
      if (lineNum <= skip) { processedLineCount = lineNum; return; }
      return false;
    }
    processedLineCount = lineNum;
    const sid = unit.sessionId;
    const ts = obj.timestamp || null;
    const msg = obj.message || {};
    const usage = msg.usage || {};

    if (isSubagent && (obj.type === 'user' || obj.type === 'assistant')) {
      if (ts && (!subagentStats.startedAt || ts < subagentStats.startedAt)) subagentStats.startedAt = ts;
      if (ts && (!subagentStats.endedAt || ts > subagentStats.endedAt)) subagentStats.endedAt = ts;
      subagentStats.totalTokens += (totalInputTokens(usage) ?? 0) + (usage.output_tokens ?? 0);
    }
    if (lineNum <= skip) return;

    if (obj.type === 'ai-title' && obj.aiTitle) { sm.title = obj.aiTitle; return; }
    if (obj.type === 'user' && (obj.isCompactSummary === true || msg.isCompactSummary === true)) {
      const content = extractText(msg.content);
      if (content !== null && content !== '') {
        records.push({ kind: 'summary', id: obj.uuid || `${sid}:compact:${lineNum}`, session_id: sid, agent_id: isSubagent ? (unit.agentId ?? null) : null, timestamp: ts, source: 'claude', content });
      }
      return;
    }
    if (obj.type === 'system' && obj.subtype === 'turn_duration' && obj.parentUuid && obj.durationMs) {
      records.push({ kind: 'message-turn-duration', uuid: obj.parentUuid, turn_duration_ms: obj.durationMs });
      return;
    }
    if (obj.type !== 'user' && obj.type !== 'assistant') return;

    if (ts && (!sm.started_at || ts < sm.started_at)) sm.started_at = ts;
    if (ts && (!sm.ended_at || ts > sm.ended_at)) sm.ended_at = ts;
    if (obj.gitBranch) sm.git_branch = obj.gitBranch;
    if (obj.version) sm.version = obj.version;
    sm.n++;

    const text = extractText(msg.content);
    const rawContentType = extractContentType(msg.content);
    const isMeta = extractMessageIsMeta(obj, text);
    const contentType = isMeta && isSkillInstructions(text) ? 'skill_instructions' : rawContentType;
    const aid = isSubagent ? (unit.agentId ?? null) : (obj.agentId || null);

    if (obj.uuid) {
      records.push({
        kind: 'message', uuid: obj.uuid, session_id: sid, type: obj.type,
        parent_uuid: obj.parentUuid || null, timestamp: ts, role: msg.role || obj.type,
        text, content_type: contentType, is_meta: (isMeta ? 1 : 0), visibility: 'visible',
        model: msg.model || null,
        agent_id: aid,
        input_tokens: totalInputTokens(usage), output_tokens: usage.output_tokens || null,
        cwd: obj.cwd || null, skill: obj.attributionSkill || null, source: 'claude',
      });
    }

    if (obj.type === 'assistant' && Array.isArray(msg.content)) {
      for (const b of msg.content) {
        if (b.type === 'tool_use' && b.id)
          records.push({ kind: 'tool_call', id: b.id, message_uuid: obj.uuid, session_id: sid, name: b.name, input_json: truncJson(b.input || {}) as string, file_path: filePath(b.name, b.input) });
      }
    }

    if (obj.type === 'user' && Array.isArray(msg.content)) {
      for (const b of msg.content) {
        if (b.type !== 'tool_result' || !b.tool_use_id) continue;
        const rt = typeof b.content === 'string' ? b.content
          : Array.isArray(b.content) ? b.content.map((c: any) => c.text || '').join('\n') : '';
        records.push({ kind: 'tool_result', tool_use_id: b.tool_use_id, message_uuid: obj.uuid, session_id: sid, content: trunc(rt), file_path: obj.toolUseResult?.filePath || null, is_error: b.is_error ? 1 : 0 });
      }
    }
  });

  // A rewrite/truncation can leave the stored incremental cursor beyond the
  // current file. Rewind once so a replacement transcript is not silently
  // treated as an empty append.
  if (skip > 0 && lineNum < skip) return yield* parse(unit, null);

  if (isSubagent && unit.agentId) {
    const metaPath = unit.key.replace(/\.jsonl$/, '.meta.json');
    if (existsSync(metaPath)) {
      try {
        const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
        const workflowRunId = (unit.meta as { workflowRunId?: string } | undefined)?.workflowRunId;
        if (workflowRunId) {
          records.push({
            kind: 'workflow_agent',
            agent_id: unit.agentId,
            run_id: workflowRunId,
            session_id: unit.sessionId,
            agent_type: meta.agentType || null,
            description: meta.description || null,
          });
        } else {
          const started = subagentStats.startedAt ? new Date(subagentStats.startedAt).getTime() : null;
          const ended = subagentStats.endedAt ? new Date(subagentStats.endedAt).getTime() : null;
          records.push({
            kind: 'subagent',
            agent_id: unit.agentId,
            session_id: unit.sessionId,
            parent_tool_use_id: meta.toolUseId || null,
            agent_type: meta.agentType || null,
            description: meta.description || null,
            duration_ms: started !== null && ended !== null ? ended - started : null,
            total_tokens: subagentStats.totalTokens,
          });
        }
      } catch { /* malformed optional subagent metadata */ }
    }
  }

  // Subagent transcripts do not own a session row (matches indexJsonl).
  if (!isSubagent) {
    records.push({
      kind: 'session', id: unit.sessionId, title: sm.title, project: unit.project || null,
      started_at: sm.started_at, ended_at: sm.ended_at, git_branch: sm.git_branch,
      version: sm.version, message_count: sm.n, countMode: skip > 0 ? 'delta' : 'total',
      jsonl_path: unit.key, source: 'claude',
    });
  }

  yield* records;
  return `${mtime}:${processedLineCount}`;
}

/** 按原生 message UUID 在主会话、subagent 或 workflow-agent 文件中回查原始行。 */
function rawClaude(input: RawLookup): RawRecord | null {
  const mainPath = typeof input.session?.jsonl_path === 'string' ? input.session.jsonl_path : null;
  if (mainPath === null) return null;
  let sourcePath = mainPath;
  if (input.agentId !== null) {
    const runId = input.workflowAgent?.['run_id'];
    sourcePath = typeof runId === 'string'
      ? join(dirname(mainPath), String(input.session?.id ?? ''), 'subagents', 'workflows', runId, `${input.agentId}.jsonl`)
      : join(dirname(mainPath), String(input.session?.id ?? ''), 'subagents', `${input.agentId}.jsonl`);
  }
  if (!existsSync(sourcePath)) return null;
  let found: string | null = null;
  readLines(sourcePath, (line: string) => {
    if (!line.includes(input.messageUuid)) return;
    try {
      if (JSON.parse(line)?.uuid === input.messageUuid) {
        found = line;
        return false;
      }
    } catch { /* malformed source line */ }
  });
  const raw = found as string | null;
  let messageText: string | null = null;
  if (raw !== null) {
    try {
      const content = JSON.parse(raw)?.message?.content;
      if (typeof content === 'string') messageText = content;
      else if (Array.isArray(content)) {
        const parts = content.map((part) => part?.text ?? part?.thinking).filter((part) => typeof part === 'string');
        messageText = parts.length > 0 ? parts.join('\n') : null;
      }
    } catch { /* malformed source line */ }
  }
  return raw === null
    ? null
    : { text: raw, totalLength: raw.length, offset: 0, limit: raw.length, hasMore: false, messageText };
}

/** 将 Claude 根路径与专有 adapter 行为封装为可注册 ProviderAdapter。 */
export function createClaudeProvider({ rootDir = join(homedir(), '.claude') }: { rootDir?: string } = {}): ProviderAdapter {
  return {
    name,
    descriptor: { id: name, name: 'Claude Code', vendor: 'Anthropic', defaultRoot: rootDir, color: '#d97757' },
    indexVersionMarker: CLAUDE_CANONICAL_TRANSCRIPT_MARKER,
    watchRoots: (configuredRoot) => [
      join(configuredRoot, 'projects'),
    ],
    discover: (ctx) => discoverAt(rootDir, ctx),
    parse,
    raw: rawClaude,
  };
}

export const claudeProvider = createClaudeProvider();
