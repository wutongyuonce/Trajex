// Copyright (C) 2026 tommy0103 and contributors.
// Copyright (C) 2026 wutongyuonce and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Codex Provider adapter。
 *
 * 模块定位：发现 ~/.codex session rollout 文件，执行全量重放和 event_msg/
 * response_item 去重，再输出规范 TranscriptRecord；它不访问 Trajex SQLite。
 */
// Codex provider adapter in Core (see docs/adr/0001).
//
// Pure: discovers Codex rollout files and parses one into a record stream. It
// never touches the Trajex database. Unlike claude, codex is a FULL-REPARSE
// adapter: it buffers every line and re-emits every record on each run, because
// the event_msg ↔ response_item dedup needs whole-file (bidirectional) knowledge
// (the matching pair sits ±1 line apart but in either order). Hence the session
// record uses countMode 'total' (persist replaces the count, never accumulates).
// The per-line logic mirrors the original indexCodexJsonl.

import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, normalize, relative } from 'node:path';

import {
  trunc, truncJson, truncToolResult, toolResultPreview, readLines,
  discoverCodexJsonlFiles, normalizeObservedCwd, projectSlugFromPath,
  codexRawId, codexDbId, codexCallId, codexLineUuid, codexIsChildThread,
  codexIsGuardianThread, codexUsage,
  codexEventText, codexMessagePayloadText, codexVisibleMessageKey,
  codexToolInput, codexToolOutput,
  extractMessageIsMeta, isSkillInstructions,
} from '../parsing.ts';

import type {
  Cursor,
  DiscoverContext,
  TranscriptRecord,
  IndexUnit,
  MessageRecord,
  ProviderAdapter,
  RawLookup,
  RawRecord,
} from './types.ts';

export const name = 'codex';
export const CODEX_CANONICAL_TRANSCRIPT_MARKER = '__codex_canonical_transcript_v4__';

const HIDDEN_CONTEXT_ENVELOPE_RE = /^\s*<(environment_context|codex_internal_context)\b[^>]*>[\s\S]*<\/\1>\s*$/;

function pathWithin(root: string, candidate: string): boolean {
  const inside = relative(root, candidate);
  return inside === '' || (!inside.startsWith('..') && !isAbsolute(inside));
}

function changedPathCovers(changedPaths: readonly string[], target: string): boolean {
  return changedPaths.some((changed) => changed === target || pathWithin(changed, target));
}

function messageVisibility(role: string, text: string | null): 'visible' | 'hidden' {
  return role === 'user' && typeof text === 'string' && HIDDEN_CONTEXT_ENVELOPE_RE.test(text)
    ? 'hidden'
    : 'visible';
}

function discoverAt(rootDir: string, ctx: DiscoverContext): IndexUnit[] {
  const sessionsDir = join(rootDir, 'sessions');
  const sessionIndexPath = normalize(join(rootDir, 'session_index.jsonl'));
  const sessionIndex = new Map<string, { title: string; updatedAt: string | null }>();
  if (existsSync(sessionIndexPath)) {
    readLines(sessionIndexPath, (line: string) => {
      try {
        const item = JSON.parse(line);
        if (item?.id && item?.thread_name) {
          sessionIndex.set(codexRawId(item.id) as string, {
            title: item.thread_name,
            updatedAt: item.updated_at || null,
          });
        }
      } catch { /* malformed session-index entry */ }
    });
  }
  const changedFiles = new Set<string>();
  const changedScopes: string[] = [];
  let sessionIndexChanged = false;
  for (const changedPath of ctx.changedPaths ?? []) {
    const rootRelative = isAbsolute(changedPath)
      ? normalize(changedPath)
      : normalize(join(rootDir, changedPath));
    if (rootRelative === sessionIndexPath) sessionIndexChanged = true;
    const absolute = isAbsolute(changedPath)
      ? normalize(changedPath)
      : normalize(join(sessionsDir, changedPath));
    const inside = relative(sessionsDir, absolute);
    if (!inside || inside.startsWith('..') || isAbsolute(inside)) continue;
    changedScopes.push(absolute);
    if (absolute.toLowerCase().endsWith('.jsonl')) changedFiles.add(absolute);
  }
  // A missing/unreadable sessions directory is not a complete inventory. Do
  // not turn an empty scan into deletion until the directory is readable.
  let inventoryComplete = true;
  const discoveredFiles = discoverCodexJsonlFiles(sessionsDir, (issue) => {
    inventoryComplete = false;
    ctx.reportUnavailableRoot?.(issue);
  });
  const currentFiles = new Set(discoveredFiles.map(file => normalize(file.path)));
  const units = discoveredFiles.flatMap((file) => {
    if (ctx.changedPaths !== undefined && !sessionIndexChanged && !changedFiles.has(normalize(file.path))) return [];
    const cursor = ctx.lastCursor(file.path);
    if (!sessionIndexChanged && cursor !== null && Number(cursor.split(':')[0]) >= statSync(file.path).mtimeMs) {
      return [];
    }
    let meta: any = null;
    readLines(file.path, (line: string) => {
      try {
        const record = JSON.parse(line);
        if (record?.type === 'session_meta' && record.payload?.id) {
          meta = record.payload;
          return false;
        }
      } catch { /* malformed source line */ }
    });
    const rawId = meta ? codexRawId(meta.id) : null;
    const indexed = rawId ? sessionIndex.get(rawId) : undefined;
    if (meta && codexIsChildThread(meta)) return [];
    return [{
      key: file.path,
      sessionId: codexDbId(rawId) ?? '',
      meta: {
        source: 'codex',
        indexedTitle: indexed?.title,
        indexedUpdatedAt: indexed?.updatedAt,
      },
    }];
  });
  if (!inventoryComplete) return units;
  const tombstones = (ctx.indexedSessions?.() ?? [])
    .filter(session => {
      const path = normalize(session.jsonlPath);
      if (!pathWithin(normalize(sessionsDir), path) || currentFiles.has(path)) return false;
      return ctx.changedPaths === undefined || changedPathCovers(changedScopes, path);
    })
    .map(session => ({
      key: normalize(session.jsonlPath),
      sessionId: session.sessionId,
      retractSessionIds: [session.sessionId],
      meta: { kind: 'codex-tombstone' as const },
    }));

  return [...units, ...tombstones];
}

/**
 * 用 Codex 的文件 mtime 与存储 cursor 找出需要重放的 session。changedPaths 存在时
 * 只检查 watcher 指出的路径，避免 daemon 每次事件递归扫描全部历史。
 */
export function discover(ctx: DiscoverContext): IndexUnit[] {
  return discoverAt(join(homedir(), '.codex'), ctx);
}

/**
 * 全量读取一个 Codex rollout，并产出完整 session 事实。必须先收集所有可见
 * event_msg，再处理 response_item，才能双向去重这两种可能乱序的消息镜像。
 */
export function* parse(unit: IndexUnit, _cursor: Cursor): Generator<TranscriptRecord, Cursor> {
  if ((unit.meta as { kind?: string } | undefined)?.kind === 'codex-tombstone') return '0:0';
  const mtime = statSync(unit.key).mtimeMs;
  const records: { lineNum: number; obj: any }[] = [];
  let lineNum = 0;
  let processedLineCount = 0;
  readLines(unit.key, (line: string) => {
    lineNum++;
    try { records.push({ lineNum, obj: JSON.parse(line) }); } catch {
      // A malformed line is a hard boundary for this full replay. Commit only
      // the valid prefix and retry from this line after the source is fixed.
      return false;
    }
    processedLineCount = lineNum;
  });
  const outCursor = `${mtime}:${processedLineCount}`;

  const metaRecord = records.find(r => r.obj?.type === 'session_meta' && r.obj.payload?.id);
  if (!metaRecord) return outCursor;

  const meta = metaRecord.obj.payload;
  const threadRawId = codexRawId(meta.id) as string;
  if (codexIsChildThread(meta) || codexIsGuardianThread(meta, records)) return outCursor;

  const sessionId = codexDbId(threadRawId) as string;
  const project = projectSlugFromPath(normalizeObservedCwd(meta.cwd));
  const lineUuid = (n: number): string => codexLineUuid(threadRawId, n) as string;

  const out: TranscriptRecord[] = [{ kind: 'delete-session', sessionId }];
  const msgByUuid = new Map<string, MessageRecord>();
  const indexedMeta = unit.meta as { indexedTitle?: string; indexedUpdatedAt?: string | null } | undefined;
  const initialTimestamp = (meta.timestamp || metaRecord.obj.timestamp || null) as string | null;
  const indexedUpdatedAt = indexedMeta?.indexedUpdatedAt ?? null;
  const sm = {
    started_at: initialTimestamp,
    ended_at: indexedUpdatedAt && (!initialTimestamp || indexedUpdatedAt > initialTimestamp)
      ? indexedUpdatedAt
      : initialTimestamp,
    git_branch: (meta.git?.branch || null) as string | null,
    version: (meta.cli_version || null) as string | null,
    title: indexedMeta?.indexedTitle ?? null,
    n: 0,
    lastMessageUuid: null as string | null,
    lastTextAssistantUuid: null as string | null,
    totalInputTokens: 0,
    totalOutputTokens: 0,
  };

  let currentCwd = normalizeObservedCwd(meta.cwd);
  let currentModel: string | null = null;
  const eventMessageKeys = new Set<string>();

  const updateBounds = (ts: string | null) => {
    if (!ts) return;
    if (!sm.started_at || ts < sm.started_at) sm.started_at = ts;
    if (!sm.ended_at || ts > sm.ended_at) sm.ended_at = ts;
  };

  const insertMessage = ({ uuid, type, role, text = null, contentType = 'text', timestamp, isMeta = 0 }: {
    uuid: string; type: string; role: string; text?: string | null; contentType?: string; timestamp: string | null; isMeta?: 0 | 1;
  }) => {
    const visibility = messageVisibility(role, text);
    const skillInstructions = role === 'user' && isSkillInstructions(text);
    const rec: MessageRecord = {
      kind: 'message', uuid, session_id: sessionId, type, parent_uuid: sm.lastMessageUuid,
      timestamp: timestamp || null, role, text: trunc(text),
      content_type: skillInstructions ? 'skill_instructions' : contentType,
      is_meta: visibility === 'hidden' || skillInstructions ? 1 : (isMeta || extractMessageIsMeta({}, text)), visibility,
      model: currentModel, agent_id: null,
      input_tokens: null, output_tokens: null, cwd: currentCwd, skill: null, source: 'codex',
    };
    out.push(rec);
    msgByUuid.set(uuid, rec);
    sm.lastMessageUuid = uuid;
    sm.n++;
    if (type === 'assistant' && contentType === 'text') sm.lastTextAssistantUuid = uuid;
    updateBounds(timestamp);
    return uuid;
  };

  // First pass: collect visible event_msg keys so duplicate response_items drop.
  for (const { obj } of records) {
    if (obj?.type !== 'event_msg') continue;
    const payload = obj.payload || {};
    if (payload.type !== 'user_message' && payload.type !== 'agent_message') continue;
    const text = codexEventText(payload);
    if (text === null) continue;
    eventMessageKeys.add(codexVisibleMessageKey(payload.type === 'user_message' ? 'user' : 'assistant', text));
  }

  for (const { lineNum: currentLine, obj } of records) {
    const ts = obj.timestamp || null;
    if (obj.type === 'session_meta') {
      if (obj.payload?.cwd) currentCwd = normalizeObservedCwd(obj.payload.cwd) || currentCwd;
      if (obj.payload?.git?.branch) sm.git_branch = obj.payload.git.branch;
      if (obj.payload?.cli_version) sm.version = obj.payload.cli_version;
      updateBounds(obj.payload?.timestamp || ts);
      continue;
    }
    if (obj.type === 'turn_context') {
      currentCwd = normalizeObservedCwd(obj.payload?.cwd) || currentCwd;
      currentModel = obj.payload?.model || currentModel;
      updateBounds(ts);
      continue;
    }
    if (obj.type === 'event_msg') {
      const payload = obj.payload || {};
      if (payload.type === 'context_compacted') {
        out.push({ kind: 'summary', id: lineUuid(currentLine), session_id: sessionId, timestamp: ts, source: 'codex', content: '已 compact' });
        updateBounds(ts);
        continue;
      }
      if (payload.type === 'user_message' || payload.type === 'agent_message' || payload.type === 'agent_reasoning') {
        const text = codexEventText(payload);
        if (text === null) continue;
        const isReasoning = payload.type === 'agent_reasoning';
        insertMessage({
          uuid: lineUuid(currentLine),
          type: payload.type === 'user_message' ? 'user' : 'assistant',
          role: payload.type === 'user_message' ? 'user' : 'assistant',
          text, contentType: isReasoning ? 'thinking' : 'text', timestamp: ts,
        });
        continue;
      }
      if (payload.type === 'task_complete') {
        if (sm.lastTextAssistantUuid && payload.duration_ms !== undefined) {
          out.push({ kind: 'message-turn-duration', uuid: sm.lastTextAssistantUuid, turn_duration_ms: payload.duration_ms || null });
        }
        updateBounds(ts);
        continue;
      }
      if (payload.type === 'token_count') {
        const usage = codexUsage(payload);
        if (usage.inputTokens != null) sm.totalInputTokens = usage.inputTokens;
        if (usage.outputTokens != null) sm.totalOutputTokens = usage.outputTokens;
        if (sm.lastTextAssistantUuid && (usage.inputTokens != null || usage.outputTokens != null)) {
          const rec = msgByUuid.get(sm.lastTextAssistantUuid);
          if (rec) { rec.input_tokens = usage.inputTokens; rec.output_tokens = usage.outputTokens; }
        }
        continue;
      }
      if (payload.type === 'thread_name_updated' && payload.thread_name) sm.title = payload.thread_name;
      continue;
    }
    if (obj.type !== 'response_item') continue;
    const payload = obj.payload || {};
    if (payload.type === 'message' && payload.role !== 'developer') {
      const text = codexMessagePayloadText(payload);
      const role = payload.role || 'assistant';
      if (text !== null && !eventMessageKeys.has(codexVisibleMessageKey(role, text))) {
        insertMessage({ uuid: lineUuid(currentLine), type: role === 'user' ? 'user' : 'assistant', role, text, contentType: 'text', timestamp: ts });
      }
      continue;
    }
    if (['function_call', 'custom_tool_call', 'tool_search_call', 'web_search_call'].includes(payload.type) && payload.call_id) {
      const uuid = insertMessage({ uuid: lineUuid(currentLine), type: 'assistant', role: 'assistant', text: null, contentType: 'tool_use', timestamp: ts });
      const name = payload.name || payload.tool || payload.type.replace(/_call$/, '');
      const toolId = codexCallId(threadRawId, payload.call_id) as string;
      out.push({ kind: 'tool_call', id: toolId, message_uuid: uuid, session_id: sessionId, name, input_json: truncJson(codexToolInput(payload)) as string, file_path: null });
      continue;
    }
    if (['function_call_output', 'custom_tool_call_output', 'tool_search_output'].includes(payload.type) && payload.call_id) {
      const toolId = codexCallId(threadRawId, payload.call_id) as string;
      const rawContent = codexToolOutput(payload) || '';
      const content = truncToolResult(rawContent);
      const resultUuid = insertMessage({ uuid: lineUuid(currentLine), type: 'user', role: 'user', text: toolResultPreview(rawContent), contentType: 'tool_result', timestamp: ts });
      out.push({ kind: 'tool_result', tool_use_id: toolId, message_uuid: resultUuid, session_id: sessionId, content, file_path: null, is_error: payload.is_error ? 1 : 0 });
    }
  }

  out.push({
    kind: 'session', id: sessionId, title: sm.title, project,
    started_at: sm.started_at, ended_at: sm.ended_at, git_branch: sm.git_branch, version: sm.version,
    message_count: sm.n, countMode: 'total', jsonl_path: unit.key, source: 'codex',
  });

  yield* out;
  return outCursor;
}

function findCodexFile(rootDir: string, rawThreadId: string): string | null {
  const stack = [join(rootDir, 'sessions')];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (!existsSync(current)) continue;
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) stack.push(path);
      else if (entry.isFile() && entry.name.endsWith(`${rawThreadId}.jsonl`)) return path;
    }
  }
  return null;
}

/**
 * 依据 Codex 合成 uuid 中的 thread ID 与行号回到原始 JSONL 行，供查询 API 的
 * raw() 做证据审计和完整正文展开。
 */
function rawCodex(rootDir: string, input: RawLookup): RawRecord | null {
  const match = /^codex:([^:]+):(\d+)$/.exec(input.messageUuid);
  if (match === null) return null;
  const path = input.agentId === null && typeof input.session?.jsonl_path === 'string'
    ? input.session.jsonl_path
    : findCodexFile(rootDir, match[1]!);
  if (path === null || !existsSync(path)) return null;
  let lineNumber = 0;
  let found: string | null = null;
  readLines(path, (line: string) => {
    lineNumber++;
    if (lineNumber !== Number(match[2])) return;
    found = line;
    return false;
  });
  const raw = found as string | null;
  let messageText: string | null = null;
  if (raw !== null) {
    try {
      const obj = JSON.parse(raw);
      const payload = obj?.payload ?? {};
      if (obj?.type === 'event_msg') {
        messageText = typeof payload.message === 'string'
          ? payload.message
          : typeof payload.text === 'string'
            ? payload.text
            : null;
      } else if (obj?.type === 'response_item' && payload.type === 'message' && Array.isArray(payload.content)) {
        messageText = codexMessagePayloadText(payload);
      }
    } catch { /* malformed source line */ }
  }
  return raw === null
    ? null
    : { text: raw, totalLength: raw.length, offset: 0, limit: raw.length, hasMore: false, messageText };
}

/** 将默认根目录和 Codex 专有 discover/parse/raw 组装为 ProviderAdapter。 */
export function createCodexProvider({ rootDir = join(homedir(), '.codex') }: { rootDir?: string } = {}): ProviderAdapter {
  return {
    name,
    descriptor: { id: name, name: 'Codex', vendor: 'OpenAI', defaultRoot: rootDir, color: '#10a37f' },
    indexVersionMarker: CODEX_CANONICAL_TRANSCRIPT_MARKER,
    watchRoots: (configuredRoot) => [join(configuredRoot, 'sessions'), join(configuredRoot, 'session_index.jsonl')],
    discover: (ctx) => discoverAt(rootDir, ctx),
    parse,
    raw: (input) => rawCodex(rootDir, input),
  };
}

export const codexProvider = createCodexProvider();
