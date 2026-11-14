// Copyright (C) 2026 tommy0103 and contributors.
// Copyright (C) 2026 wutongyuonce and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Codex Provider adapter（见 docs/adr/0001、0002）。
 *
 * 模块定位：发现 ~/.codex session rollout 文件，执行全量重放和 event_msg/
 * response_item 去重，再输出规范 TranscriptRecord；它不访问 Trajex SQLite。
 * 去重需要整文件的双向信息（两种镜像可能以任意顺序相邻出现），因此每次全量重放，
 * session 使用 countMode 'total'。
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, normalize, relative } from 'node:path';

import {
  trunc, truncJson, truncToolResult, toolResultPreview, readLines,
  discoverCodexJsonlFiles, isCodexRolloutPath, normalizeObservedCwd, projectSlugFromPath,
  codexRawId, codexDbId, codexCallId, codexLineUuid, codexIsChildThread,
  codexIsGuardianThread, codexUsage,
  codexEventText, codexMessagePayloadText, codexVisibleMessageKey,
  codexToolInput, codexToolOutput,
  extractMessageIsMeta, isSkillInstructions, normalizeTranscriptTimestamp,
} from '../parsing.ts';
import { decodeZstdFrames, scanZstdFrames, zstdDecoder } from '../vendor/dsh-zstd.ts';
import { cursorMatchesSnapshot, fileSnapshot, sameSnapshot, snapshotCursor, type FileSnapshot } from './file-snapshot.ts';

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
// v1.2：读取 Codex 压缩的 `.jsonl.zst`，并把长会话的分段合并为一个会话；一次性重放旧投影。
export const CODEX_CANONICAL_TRANSCRIPT_MARKER = '__codex_canonical_transcript_v1.2__';
const CODEX_TRANSCRIPT_DIRS = ['sessions', 'archived_sessions'] as const;

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

function codexTranscriptDirs(rootDir: string): string[] {
  return CODEX_TRANSCRIPT_DIRS.map((dir) => join(rootDir, dir));
}

const ZST_SUFFIX = '.zst';
const isCompressed = (path: string) => path.endsWith(`.jsonl${ZST_SUFFIX}`);
/** 同一个 rollout 的另一种形态：Codex 压缩冷会话时把 `x.jsonl` 换成 `x.jsonl.zst`。 */
const rolloutSibling = (path: string) => (isCompressed(path) ? path.slice(0, -ZST_SUFFIX.length) : `${path}${ZST_SUFFIX}`);

// `rollout-<时间>-<thread>.jsonl[.zst]`；长会话的后续分段是 `rollout-<时间>-<thread>_<分段>.jsonl[.zst]`。
const ROLLOUT_NAME_RE = /-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:_[0-9a-f-]{36})?\.jsonl(?:\.zst)?$/i;
const THREAD_CURSOR_TAG = 'codex-thread-v1';

/** 按文件名里的 thread id 分组；无法识别的文件各自成组。 */
const threadKey = (path: string) => ROLLOUT_NAME_RE.exec(basename(path))?.[1]?.toLowerCase() ?? `path:${path}`;

/**
 * 一个 thread 实际要读的分段，按文件名（以时间开头）排序。同一分段可能同时存在 `.jsonl` 与
 * `.jsonl.zst`（压缩过渡），或在 sessions/ 与 archived_sessions/ 各留一份：只取一份，仍在写入的
 * `.jsonl` 优先，其次修改时间较新的副本。
 */
function threadMembers(paths: readonly string[]): string[] {
  const bySegment = new Map<string, string>();
  for (const path of paths) {
    const segment = basename(path).replace(/\.zst$/, '');
    const current = bySegment.get(segment);
    if (current === undefined || preferRollout(path, current)) bySegment.set(segment, path);
  }
  // 按码点排序（不用 localeCompare，它会忽略 `.` 与 `_`）：主文件 `…<thread>.jsonl` 排在分段 `…<thread>_…` 前。
  return [...bySegment.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, path]) => path);
}

function preferRollout(candidate: string, current: string): boolean {
  if (isCompressed(candidate) !== isCompressed(current)) return !isCompressed(candidate);
  try { return statSync(candidate).mtimeMs > statSync(current).mtimeMs; } catch { return false; }
}

/** 多分段 thread 的变化签名：任一分段增删或内容变化都会改变它。 */
function threadSignature(members: ReadonlyArray<{ path: string; snapshot: FileSnapshot }>): string {
  const hash = createHash('sha256');
  for (const { path, snapshot } of members) {
    hash.update(`${path}\0${snapshot.mtimeMs}:${snapshot.size}:${snapshot.ctimeMs}:${snapshot.ino}\n`);
  }
  return hash.digest('hex');
}

/** 单文件 thread 沿用五段快照 cursor；多分段 thread 用 `maxMtime:lines:codex-thread-v1:<签名>`。 */
function threadCursor(members: ReadonlyArray<{ path: string; snapshot: FileSnapshot }>, lines: number): string {
  if (members.length === 1) return snapshotCursor(members[0]!.snapshot, lines);
  const mtime = Math.max(...members.map(member => member.snapshot.mtimeMs));
  return `${mtime}:${lines}:${THREAD_CURSOR_TAG}:${threadSignature(members)}`;
}

function threadCursorMatches(cursor: Cursor, members: readonly string[]): boolean {
  if (members.length === 1) return cursorMatchesSnapshot(cursor, fileSnapshot(members[0]!));
  const parts = cursor?.split(':') ?? [];
  return parts[2] === THREAD_CURSOR_TAG
    && parts[3] === threadSignature(members.map(path => ({ path, snapshot: fileSnapshot(path) })));
}

let warnedZstdUnavailable = false;
function warnZstdUnavailable(): void {
  if (warnedZstdUnavailable) return;
  warnedZstdUnavailable = true;
  process.emitWarning(
    'Compressed Codex rollouts (*.jsonl.zst) need Node.js 22.15 or newer; they are skipped on this runtime.',
    { code: 'TRAJEX_CODEX_ZSTD_UNAVAILABLE' },
  );
}

/**
 * 按行读取 rollout；`.jsonl.zst` 先整体解压再分行，回调语义与 readLines 一致。
 * Codex 只压缩已经不再写入的会话，压缩文件不完整就是还在写：整单元失败，下次重试。
 */
function readCodexLines(path: string, callback: (line: string, terminated: boolean) => boolean | void): void {
  if (!isCompressed(path)) return readLines(path, callback);
  if (zstdDecoder() === null) throw new Error('Reading Zstandard-compressed Codex rollouts requires Node.js 22.15 or newer');
  const buffer = readFileSync(path);
  const { frames, tornStart } = scanZstdFrames(buffer);
  if (tornStart !== undefined) throw new Error(`Compressed Codex rollout is incomplete: ${path}`);
  const text = decodeZstdFrames(buffer, frames).map(frame => frame.toString('utf8')).join('');
  const lines = text.split('\n');
  const tail = lines.pop() ?? '';
  for (const line of lines) {
    if (line && callback(line, true) === false) return;
  }
  if (tail) callback(tail, false);
}

function discoverAt(rootDir: string, ctx: DiscoverContext): IndexUnit[] {
  const [sessionsDir, archivedSessionsDir] = codexTranscriptDirs(rootDir);
  const sessionIndexPath = normalize(join(rootDir, 'session_index.jsonl'));
  const sessionIndex = new Map<string, { title: string; updatedAt: string | null }>();
  if (existsSync(sessionIndexPath)) {
    readLines(sessionIndexPath, (line: string) => {
      try {
        const item = JSON.parse(line);
        if (item?.id && item?.thread_name) {
          sessionIndex.set(codexRawId(item.id) as string, {
            title: item.thread_name,
            updatedAt: normalizeTranscriptTimestamp(item.updated_at),
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
    for (const transcriptDir of [sessionsDir, archivedSessionsDir]) {
      const absolute = isAbsolute(changedPath)
        ? normalize(changedPath)
        : normalize(join(transcriptDir, changedPath));
      const inside = relative(transcriptDir, absolute);
      if (!inside || inside.startsWith('..') || isAbsolute(inside)) continue;
      changedScopes.push(absolute);
      if (isCodexRolloutPath(absolute)) {
        // 压缩会产生「旧 .jsonl 消失、新 .jsonl.zst 出现」两个事件，可能分在不同批次里。
        // 任一事件都重新检查两种形态，让新路径与旧路径的 tombstone 进入同一个计划。
        changedFiles.add(absolute);
        changedFiles.add(rolloutSibling(absolute));
      }
    }
  }
  // A missing/unreadable sessions directory is not a complete inventory. Do
  // not turn an empty scan into deletion until the directory is readable.
  let inventoryComplete = true;
  const discoveredFiles = [
    ...discoverCodexJsonlFiles(sessionsDir, (issue) => {
      inventoryComplete = false;
      ctx.reportUnavailableRoot?.(issue);
    }),
    // archived_sessions 是可选目录：从未存在且没有索引过其中的会话时不算来源缺失；
    // 否则与 sessions 一样，不可读时保留上次快照（ADR-0004）。
    ...discoverCodexJsonlFiles(archivedSessionsDir, (issue) => {
      const indexedHere = (ctx.indexedSessions?.() ?? [])
        .some(session => pathWithin(normalize(archivedSessionsDir), normalize(session.jsonlPath)));
      if (!existsSync(archivedSessionsDir) && !indexedHere) return;
      inventoryComplete = false;
      ctx.reportUnavailableRoot?.(issue);
    }),
  ];
  const currentFiles = new Set(discoveredFiles.map(file => normalize(file.path)));
  // 一个 thread 的所有分段合成一个单元；分开索引时各分段会互相覆盖同一个会话。
  const threads = new Map<string, string[]>();
  for (const file of discoveredFiles) {
    const path = normalize(file.path);
    const key = threadKey(path);
    threads.set(key, [...(threads.get(key) ?? []), path]);
  }
  const units = [...threads.values()].flatMap((paths) => {
    const members = threadMembers(paths);
    const key = members[0]!;
    const fileChanged = paths.some(path => changedFiles.has(path));
    if (ctx.changedPaths !== undefined && !sessionIndexChanged && !fileChanged) return [];
    if (members.some(isCompressed) && zstdDecoder() === null) { warnZstdUnavailable(); return []; }
    let meta: any = null;
    try {
      if (!sessionIndexChanged && !fileChanged && threadCursorMatches(ctx.lastCursor(key), members)) {
        return [];
      }
      readCodexLines(key, (line: string) => {
        try {
          const record = JSON.parse(line);
          if (record?.type === 'session_meta' && record.payload?.id) {
            meta = record.payload;
            return false;
          }
        } catch { /* malformed source line */ }
      });
    } catch {
      // 枚举后被删除、不可读或压缩文件尚未写完：只跳过这个文件。它仍在 inventory 中，
      // 不会被 tombstone，下一轮重试。
      return [];
    }
    const rawId = meta ? codexRawId(meta.id) : null;
    const indexed = rawId ? sessionIndex.get(rawId) : undefined;
    if (meta && codexIsChildThread(meta)) return [];
    return [{
      key,
      sessionId: codexDbId(rawId) ?? '',
      meta: {
        source: 'codex',
        members,
        indexedTitle: indexed?.title,
        indexedUpdatedAt: indexed?.updatedAt,
      },
    }];
  });
  if (!inventoryComplete) return units;
  const tombstones = (ctx.indexedSessions?.() ?? [])
    .filter(session => {
      const path = normalize(session.jsonlPath);
      if (!codexTranscriptDirs(rootDir).some((dir) => pathWithin(normalize(dir), path)) || currentFiles.has(path)) return false;
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
 * 全量读取一个 Codex rollout，并产出完整 session 事实。必须先收集所有可见
 * event_msg，再处理 response_item，才能双向去重这两种可能乱序的消息镜像。
 */
export function* parse(unit: IndexUnit, _cursor: Cursor): Generator<TranscriptRecord, Cursor> {
  if ((unit.meta as { kind?: string } | undefined)?.kind === 'codex-tombstone') return '0:0';
  // 分段按顺序连续读取，行号跨分段连续编号：单文件 thread 的消息 id 与以前完全一致。
  const members = (unit.meta as { members?: string[] } | undefined)?.members ?? [unit.key];
  const snapshots: Array<{ path: string; snapshot: FileSnapshot }> = [];
  const records: { lineNum: number; obj: any }[] = [];
  let lineNum = 0;
  let processedLineCount = 0;
  for (const member of members) {
    const before = fileSnapshot(member);
    readCodexLines(member, (line: string, terminated: boolean) => {
      lineNum++;
      let obj: any;
      try { obj = JSON.parse(line); } catch { obj = undefined; }
      if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
        // Permanent terminated garbage (including valid JSON that is not an
        // object) must not hide later rollout records. An unterminated tail may
        // still be growing, so leave it for the next replay.
        if (terminated) { processedLineCount = lineNum; return; }
        lineNum--;
        return false;
      }
      records.push({ lineNum, obj });
      processedLineCount = lineNum;
    });
    const after = fileSnapshot(member);
    if (!sameSnapshot(before, after)) throw new Error(`Codex transcript changed while reading: ${member}`);
    snapshots.push({ path: member, snapshot: after });
  }
  const outCursor = threadCursor(snapshots, processedLineCount);

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
  const initialTimestamp = normalizeTranscriptTimestamp(meta.timestamp || metaRecord.obj.timestamp);
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
    const ts = normalizeTranscriptTimestamp(obj.timestamp);
    if (obj.type === 'session_meta') {
      if (obj.payload?.cwd) currentCwd = normalizeObservedCwd(obj.payload.cwd) || currentCwd;
      if (obj.payload?.git?.branch) sm.git_branch = obj.payload.git.branch;
      if (obj.payload?.cli_version) sm.version = obj.payload.cli_version;
      updateBounds(normalizeTranscriptTimestamp(obj.payload?.timestamp) || ts);
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

/** 找到一个 thread 的全部分段文件（顺序与索引时一致）。 */
function findCodexThreadFiles(rootDir: string, rawThreadId: string, known: string | null): string[] {
  const id = rawThreadId.toLowerCase();
  const matches = (path: string) => threadKey(path) === id
    || basename(path).endsWith(`${rawThreadId}.jsonl`) || basename(path).endsWith(`${rawThreadId}.jsonl.zst`);
  const found: string[] = [];
  for (const path of known === null ? [] : [known, rolloutSibling(known)]) {
    if (existsSync(path)) found.push(normalize(path));
  }
  const stack = codexTranscriptDirs(rootDir);
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (!existsSync(current)) continue;
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) stack.push(path);
      else if (entry.isFile() && isCodexRolloutPath(entry.name) && matches(path)) found.push(normalize(path));
    }
  }
  return threadMembers([...new Set(found)]);
}

/**
 * 依据 Codex 合成 uuid 中的 thread ID 与行号回到原始 JSONL 行，供查询 API 的
 * raw() 做证据审计和完整正文展开。
 */
function rawCodex(rootDir: string, input: RawLookup): RawRecord | null {
  const match = /^codex:([^:]+):(\d+)$/.exec(input.messageUuid);
  if (match === null) return null;
  // 索引记着的路径可能已被 Codex 压缩成 `.jsonl.zst`，长会话的行号也可能落在后续分段里。
  const known = input.agentId === null && typeof input.session?.jsonl_path === 'string' ? input.session.jsonl_path : null;
  const members = findCodexThreadFiles(rootDir, match[1]!, known);
  if (members.length === 0) return null;
  let lineNumber = 0;
  let found: string | null = null;
  try {
    for (const member of members) {
      readCodexLines(member, (line: string) => {
        lineNumber++;
        if (lineNumber !== Number(match[2])) return;
        found = line;
        return false;
      });
      if (found !== null) break;
    }
  } catch {
    return null;
  }
  const raw = found as string | null;
  let messageText: string | null = null;
  if (raw !== null) {
    try {
      const obj = JSON.parse(raw);
      const payload = obj?.payload ?? {};
      if (obj?.type === 'event_msg') {
        messageText = codexEventText(payload);
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
    watchTargets: () => [
      ...codexTranscriptDirs(rootDir).map((dir) => ({ kind: 'tree' as const, path: dir })),
      { kind: 'file', path: join(rootDir, 'session_index.jsonl') },
    ],
    discover: (ctx) => discoverAt(rootDir, ctx),
    parse,
    raw: (input) => rawCodex(rootDir, input),
  };
}
