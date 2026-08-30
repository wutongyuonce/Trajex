// Copyright (C) 2026 tommy0103 and contributors.
// Copyright (C) 2026 wutongyuonce and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

/** Pi JSONL session adapter. One JSONL file is one Pi session. */
import { readFileSync, readdirSync, statSync, type Dirent } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { isAbsolute, join, normalize, relative } from 'node:path';

import { projectSlugFromPath, trunc, truncJson, truncToolResult, toolResultPreview } from '../parsing.ts';
import type {
  Cursor, DiscoverContext, IndexUnit, IndexedSession, MessageRecord, ProviderAdapter,
  RawLookup, RawRecord, TranscriptRecord,
} from './types.ts';

export const name = 'pi';
export const PI_CANONICAL_TRANSCRIPT_MARKER = '__pi_canonical_transcript_v5__';

type PiEntry = Record<string, any>;

function piId(sessionId: string, entryId: string, suffix = ''): string {
  return `${sessionId}:${entryId}${suffix}`;
}

function sessionFiles(dir: string, rootEntries: readonly Dirent[]): string[] {
  const out: string[] = [];
  const walk = (current: string, knownEntries?: readonly Dirent[]): void => {
    let entries = knownEntries;
    if (!entries) {
      try {
        entries = readdirSync(current, { withFileTypes: true });
      } catch {
        // 根层已成功枚举后，后代读取失败按空子树处理。
        return;
      }
    }
    for (const file of entries) {
      const path = join(current, file.name);
      if (file.isDirectory()) walk(path);
      else if (file.isFile() && file.name.endsWith('.jsonl')) out.push(path);
    }
  };
  walk(dir, rootEntries);
  return out;
}

function discoverAt(sessionDir: string, ctx: DiscoverContext): IndexUnit[] {
  const normalizedSessionDir = normalize(sessionDir);
  const changed = new Set<string>();
  let changedRoot = false;
  for (const changedPath of ctx.changedPaths ?? []) {
    const absolute = isAbsolute(changedPath) ? normalize(changedPath) : normalize(join(sessionDir, changedPath));
    const inside = relative(sessionDir, absolute);
    if (absolute === normalizedSessionDir) changedRoot = true;
    if (absolute === normalizedSessionDir || (inside && !inside.startsWith('..') && !isAbsolute(inside))) changed.add(absolute);
  }
  // 来源根是唯一回退边界；根层枚举成功后，后代失败按空子树处理。
  let rootEntries: Dirent[];
  try {
    rootEntries = readdirSync(sessionDir, { withFileTypes: true });
  } catch (error) {
    ctx.reportUnavailableRoot?.({
      path: sessionDir,
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
  const files = sessionFiles(sessionDir, rootEntries).map(normalize);
  const currentFiles = new Set(files);
  const indexedByPath = new Map<string, IndexedSession[]>();
  for (const session of ctx.indexedSessions?.() ?? []) {
    const path = normalize(session.jsonlPath);
    const inside = relative(normalizedSessionDir, path);
    if (!inside || inside.startsWith('..') || isAbsolute(inside)) continue;
    const rows = indexedByPath.get(path) ?? [];
    rows.push(session);
    indexedByPath.set(path, rows);
  }

  const units = files.flatMap((path) => {
    if (ctx.changedPaths !== undefined && !changed.has(path) && !changedRoot) return [];
    const mtime = statSync(path).mtimeMs;
    const cursor = ctx.lastCursor(path);
    if (cursor !== null && Number(cursor.split(':')[0]) >= mtime) return [];
    let header: PiEntry | null = null;
    try { header = JSON.parse(readFileSync(path, 'utf8').split('\n')[0] || 'null'); } catch { /* malformed file */ }
    if (header?.type !== 'session' || header.version !== 3 || typeof header.id !== 'string') return [];
    const project = projectSlugFromPath(header.cwd);
    const sessionId = piSessionId(header.id, header.cwd);
    const retractSessionIds = (indexedByPath.get(path) ?? [])
      .map(session => session.sessionId)
      .filter(id => id !== sessionId);
    return [{
      key: path,
      sessionId,
      ...(project ? { project } : {}),
      ...(retractSessionIds.length ? { retractSessionIds } : {}),
      meta: { sessionId: header.id, cwd: header.cwd ?? null },
    }];
  });

  // A readable Pi root gives us a complete inventory. If a previously indexed
  // session file disappeared from that inventory, emit an empty tombstone unit
  // so persist can retract its old projection without touching other sessions.
  const tombstones = (ctx.indexedSessions?.() ?? [])
    .filter(session => {
      const path = normalize(session.jsonlPath);
      const inside = relative(normalizedSessionDir, path);
      const pathChanged = changed.has(path);
      return inside && !inside.startsWith('..') && !isAbsolute(inside)
        && !currentFiles.has(path)
        && (ctx.changedPaths === undefined || changedRoot || pathChanged);
    })
    .map(session => ({
      key: normalize(session.jsonlPath),
      sessionId: session.sessionId,
      retractSessionIds: [session.sessionId],
      meta: { kind: 'pi-tombstone' as const },
    }));

  return [...units, ...tombstones];
}

function piSessionId(rawId: string, cwd: unknown): string {
  const normalizedCwd = typeof cwd === 'string' && cwd.trim() ? normalize(cwd) : '';
  const scope = createHash('sha256').update('pi-cwd-v1\0').update(normalizedCwd).digest('hex');
  return `pi:${encodeURIComponent(rawId)}:${scope}`;
}

function textParts(content: unknown, kind: 'text' | 'thinking'): string[] {
  if (typeof content === 'string') return kind === 'text' ? [content] : [];
  if (!Array.isArray(content)) return [];
  return content.flatMap((part) => part?.type === kind && typeof part[kind] === 'string' ? [part[kind]] : []);
}

function timestamp(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value).toISOString();
  return typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? value : null;
}

function usageFields(value: unknown): { inputTokens: number | null; outputTokens: number | null } {
  const usage = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const inputTokens = ['input', 'cacheRead', 'cacheWrite']
    .reduce((total, key) => total + (Number.isFinite(usage[key]) ? Number(usage[key]) : 0), 0) || null;
  return { inputTokens, outputTokens: Number.isFinite(usage.output) ? Number(usage.output) : null };
}

function toolFilePath(name: unknown, input: unknown): string | null {
  if (typeof name !== 'string' || !['read', 'edit', 'write'].includes(name.toLowerCase())) return null;
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const args = input as PiEntry;
  return typeof args.path === 'string' ? args.path : typeof args.file_path === 'string' ? args.file_path : null;
}

/** Full replay is required because the current Pi transcript is a tree path. */
export function* parse(unit: IndexUnit, _cursor: Cursor): Generator<TranscriptRecord, Cursor> {
  const meta = unit.meta as { kind?: string } | undefined;
  if (meta?.kind === 'pi-tombstone') return '0:0';
  const stat = statSync(unit.key);
  const raw = readFileSync(unit.key, 'utf8');
  const lines = raw.split('\n');
  if (raw.endsWith('\n')) lines.pop();
  const parsed: PiEntry[] = [];
  let processedLineCount = 0;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!.replace(/\r$/, '');
    if (!line) { processedLineCount = index + 1; continue; }
    try { parsed.push(JSON.parse(line)); } catch { break; }
    processedLineCount = index + 1;
  }
  const outCursor = `${stat.mtimeMs}:${processedLineCount}`;
  const header = parsed.find(entry => entry.type === 'session' && typeof entry.id === 'string');
  if (!header || header.version !== 3) return outCursor;

  const sessionRawId = header.id as string;
  const sessionId = piSessionId(sessionRawId, header.cwd);
  const physicalEntries = parsed.filter(entry => entry.type !== 'session' && typeof entry.id === 'string');
  const byId = new Map(physicalEntries.map(entry => [entry.id as string, entry]));
  const activeIds = new Set<string>();
  let active = physicalEntries.at(-1);
  for (const entry of physicalEntries) {
    if (entry.type === 'leaf') active = typeof entry.targetId === 'string' ? byId.get(entry.targetId) : undefined;
  }
  const activePath: PiEntry[] = [];
  while (active && !activeIds.has(active.id as string)) {
    activeIds.add(active.id as string);
    activePath.push(active);
    active = typeof active.parentId === 'string' ? byId.get(active.parentId) : undefined;
  }
  activePath.reverse();

  const suppressed = new Set<string>();
  const syntheticByCompaction = new Map<string, PiEntry[]>();
  const latestCompaction = [...activePath].reverse().find(entry => entry.type === 'compaction');
  if (latestCompaction) {
    const retainedTail = Array.isArray(latestCompaction.retainedTail) ? latestCompaction.retainedTail : null;
    const firstKept = typeof latestCompaction.firstKeptEntryId === 'string' ? latestCompaction.firstKeptEntryId : null;
    const cutAt = retainedTail ? latestCompaction.id : firstKept;
    if (cutAt) {
      for (const entry of activePath) {
        if (entry.id === cutAt) break;
        suppressed.add(entry.id as string);
      }
    }
    if (retainedTail) {
      const synthetic: PiEntry[] = [];
      for (const [index, message] of retainedTail.entries()) {
        if (!message || typeof message !== 'object' || typeof message.role !== 'string') continue;
        const entry = {
          type: 'message',
          id: `${latestCompaction.id}:retained:${index}`,
          parentId: synthetic.at(-1)?.id ?? latestCompaction.id,
          timestamp: message.timestamp ?? latestCompaction.timestamp,
          message,
        };
        synthetic.push(entry);
        byId.set(entry.id, entry);
        activeIds.add(entry.id);
      }
      syntheticByCompaction.set(latestCompaction.id, synthetic);
    }
  }
  const entries: PiEntry[] = [];
  for (const entry of physicalEntries) {
    if (!suppressed.has(entry.id as string)) entries.push(entry);
    const retained = syntheticByCompaction.get(entry.id as string);
    if (retained) entries.push(...retained);
  }
  const finalMessageByEntry = new Map<string, string | null>();
  const resolvingFinal = new Set<string>();
  const finalMessage = (entryId: unknown): string | null => {
    if (typeof entryId !== 'string') return null;
    if (finalMessageByEntry.has(entryId)) return finalMessageByEntry.get(entryId) ?? null;
    if (resolvingFinal.has(entryId)) return null;
    resolvingFinal.add(entryId);
    const entry = byId.get(entryId);
    if (!entry) return null;
    if (suppressed.has(entryId)) {
      resolvingFinal.delete(entryId);
      finalMessageByEntry.set(entryId, null);
      return null;
    }
    const message = entry.message;
    let own: string | null = null;
    if (entry.type === 'compaction' && syntheticByCompaction.has(entryId)) {
      const retained = syntheticByCompaction.get(entryId)!;
      own = finalMessage(retained.at(-1)?.id);
    } else if (entry.type === 'custom_message' && textParts(entry.content, 'text').length) own = piId(sessionId, entryId);
    else if (entry.type === 'message' && message) {
      if (message.role === 'user' && textParts(message.content, 'text').length) own = piId(sessionId, entryId);
      else if (message.role === 'toolResult' || message.role === 'bashExecution') own = piId(sessionId, entryId);
      else if (message.role === 'assistant') {
        const parts: any[] = Array.isArray(message.content) ? message.content : [];
        const last = parts.reduce((result, part, index) => (
          part?.type === 'text' || part?.type === 'thinking' || part?.type === 'toolCall' ? index : result
        ), -1);
        if (last >= 0) own = piId(sessionId, entryId, `:${last}`);
      }
    }
    const result = own ?? finalMessage(entry.parentId);
    resolvingFinal.delete(entryId);
    finalMessageByEntry.set(entryId, result);
    return result;
  };
  const modelByEntry = new Map<string, string | null>();
  const resolvingModel = new Set<string>();
  const modelAt = (entry: PiEntry): string | null => {
    if (modelByEntry.has(entry.id)) return modelByEntry.get(entry.id) ?? null;
    if (resolvingModel.has(entry.id)) return null;
    resolvingModel.add(entry.id);
    const parent = typeof entry.parentId === 'string' ? byId.get(entry.parentId) : undefined;
    const model = typeof entry.message?.model === 'string'
      ? entry.message.model
      : entry.type === 'model_change' && typeof entry.modelId === 'string'
        ? entry.modelId
        : parent ? modelAt(parent) : null;
    resolvingModel.delete(entry.id);
    modelByEntry.set(entry.id, model);
    return model;
  };
  const records: TranscriptRecord[] = [{
    kind: 'delete-session', sessionId,
  }];
  let title: string | null = null;
  let count = 0;
  let startedAt: string | null = header.timestamp ?? null;
  let endedAt: string | null = header.timestamp ?? null;
  const addMessage = (entry: PiEntry, role: string, text: string | null, contentType: string, parentUuid: string | null, suffix = '', visibility: 'visible' | 'inactive' | 'hidden' = 'visible', inputTokens: number | null = null, outputTokens: number | null = null, isMeta: 0 | 1 = 0) => {
    const entryTimestamp = timestamp(entry.timestamp ?? entry.message?.timestamp);
    const uuid = piId(sessionId, entry.id, suffix);
    const message: MessageRecord = {
      kind: 'message', uuid, session_id: sessionId, type: role, parent_uuid: parentUuid,
      timestamp: entryTimestamp, role, text: trunc(text), content_type: contentType, is_meta: visibility === 'hidden' ? 1 : isMeta,
      visibility, model: modelAt(entry), agent_id: null, input_tokens: inputTokens, output_tokens: outputTokens,
      cwd: typeof header.cwd === 'string' ? header.cwd : null, skill: null, source: name,
    };
    records.push(message);
    count++;
    if (entryTimestamp && (!startedAt || entryTimestamp < startedAt)) startedAt = entryTimestamp;
    if (entryTimestamp && (!endedAt || entryTimestamp > endedAt)) endedAt = entryTimestamp;
    return uuid;
  };

  for (const entry of entries) {
    const entryVisibility: 'visible' | 'inactive' = activeIds.has(entry.id) ? 'visible' : 'inactive';
    if (entry.type === 'session_info' && typeof entry.name === 'string') { title = entry.name; continue; }
    if (entry.type === 'model_change') continue;
    if (entry.type === 'compaction' || entry.type === 'branch_summary') {
      if (typeof entry.summary === 'string') {
        const usage = usageFields(entry.usage);
        records.push({
          kind: 'summary', id: piId(sessionId, entry.id), session_id: sessionId,
          timestamp: entry.timestamp ?? null, source: entry.type, content: entry.summary,
          visibility: entryVisibility, input_tokens: usage.inputTokens, output_tokens: usage.outputTokens,
        });
      }
      continue;
    }
    if (entry.type === 'custom_message') {
      const text = textParts(entry.content, 'text').join('\n');
      if (text) addMessage(entry, 'custom', text, 'text', finalMessage(entry.parentId), '', entry.display === false ? 'hidden' : entryVisibility, null, null, 1);
      continue;
    }
    if (entry.type !== 'message' || !entry.message || typeof entry.id !== 'string') continue;
    const message = entry.message;
    let parentUuid = finalMessage(entry.parentId);
    if (message.role === 'user') {
      const text = textParts(message.content, 'text').join('\n');
      if (text) addMessage(entry, 'user', text, 'text', parentUuid, '', entryVisibility);
      continue;
    }
    if (message.role === 'assistant') {
      const parts: any[] = Array.isArray(message.content) ? message.content : [];
      const { inputTokens, outputTokens } = usageFields(message.usage);
      const lastPart = parts.reduce((last, part, i) => (
        part?.type === 'text' || part?.type === 'thinking' || part?.type === 'toolCall' ? i : last
      ), -1);
      let index = 0;
      for (const part of parts) {
        const suffix = `:${index++}`;
        const isLast = index - 1 === lastPart;
        if (part?.type === 'text' && typeof part.text === 'string') parentUuid = addMessage(entry, 'assistant', part.text, 'text', parentUuid, suffix, entryVisibility, isLast ? inputTokens : null, isLast ? outputTokens : null);
        else if (part?.type === 'thinking' && typeof part.thinking === 'string') parentUuid = addMessage(entry, 'assistant', part.thinking, 'thinking', parentUuid, suffix, entryVisibility, isLast ? inputTokens : null, isLast ? outputTokens : null);
        else if (part?.type === 'toolCall' && typeof part.id === 'string') {
          const uuid = addMessage(entry, 'assistant', null, 'tool_use', parentUuid, suffix, entryVisibility, isLast ? inputTokens : null, isLast ? outputTokens : null);
          parentUuid = uuid;
          records.push({ kind: 'tool_call', id: piId(sessionId, part.id), message_uuid: uuid, session_id: sessionId, name: typeof part.name === 'string' ? part.name : 'tool', input_json: truncJson(part.arguments) ?? '{}', file_path: toolFilePath(part.name, part.arguments) });
        }
      }
      continue;
    }
    if (message.role === 'toolResult') {
      const text = textParts(message.content, 'text').join('\n');
      const uuid = addMessage(entry, 'tool', toolResultPreview(text), 'tool_result', parentUuid, '', entryVisibility);
      if (typeof message.toolCallId === 'string') records.push({ kind: 'tool_result', tool_use_id: piId(sessionId, message.toolCallId), message_uuid: uuid, session_id: sessionId, content: truncToolResult(text), file_path: null, is_error: message.isError ? 1 : 0 });
      continue;
    }
    if (message.role === 'bashExecution') addMessage(entry, 'tool', [message.command ? `$ ${message.command}` : '', message.output, message.exitCode ? `[exit code: ${message.exitCode}]` : ''].filter(value => typeof value === 'string' && value).join('\n'), 'bash', parentUuid, '', entryVisibility);
  }
  records.push({ kind: 'session', id: sessionId, title, project: projectSlugFromPath(header.cwd), started_at: startedAt, ended_at: endedAt, git_branch: null, version: typeof header.version === 'number' ? String(header.version) : null, message_count: count, countMode: 'total', jsonl_path: unit.key, source: name });
  yield* records;
  return outCursor;
}

function rawPi(sessionDir: string, input: RawLookup): RawRecord | null {
  const path = input.session?.jsonl_path;
  if (typeof path !== 'string' || !path.startsWith(normalize(sessionDir))) return null;
  const parts = input.messageUuid.split(':');
  const entryId = parts[3];
  if (!entryId) return null;
  const line = readFileSync(path, 'utf8').split('\n').find((value: string) => { try { return JSON.parse(value)?.id === entryId; } catch { return false; } });
  if (!line) return null;
  return { text: line, totalLength: line.length, offset: 0, limit: line.length, hasMore: false };
}

export function createPiProvider({ sessionDir = process.env.PI_CODING_AGENT_SESSION_DIR || join(homedir(), '.pi', 'agent', 'sessions') }: { sessionDir?: string } = {}): ProviderAdapter {
  return {
    name,
    descriptor: { id: name, name: 'Pi', vendor: 'Pi', defaultRoot: sessionDir, color: '#7c3aed' },
    indexVersionMarker: PI_CANONICAL_TRANSCRIPT_MARKER,
    watchTargets: configuredRoot => [{ kind: 'tree', path: configuredRoot }],
    discover: ctx => discoverAt(sessionDir, ctx),
    parse,
    raw: input => rawPi(sessionDir, input),
  };
}

export const piProvider = createPiProvider();
