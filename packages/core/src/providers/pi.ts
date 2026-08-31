// Copyright (C) 2026 tommy0103 and contributors.
// Copyright (C) 2026 wutongyuonce and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

/** Pi JSONL session adapter. One JSONL file is one Pi session. */
import { readFileSync, readdirSync, type Dirent } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { isAbsolute, join, normalize, relative } from 'node:path';

import { projectSlugFromPath, trunc, truncJson, truncToolResult, toolResultPreview } from '../parsing.ts';
import { cursorMatchesSnapshot, fileSnapshot, sameSnapshot, snapshotCursor } from './file-snapshot.ts';
import type {
  Cursor, DiscoverContext, IndexUnit, IndexedSession, MessageRecord, ProviderAdapter,
  RawLookup, RawRecord, TranscriptRecord,
} from './types.ts';

export const name = 'pi';
export const PI_CANONICAL_TRANSCRIPT_MARKER = '__pi_canonical_transcript_v13__';

type PiEntry = Record<string, any>;
type PiToolOccurrence = {
  id: string;
  filePath: string | null;
  visibility: 'visible' | 'inactive';
};
type PiToolScope = {
  nativeId: string;
  occurrence: PiToolOccurrence | null;
  parent: PiToolScope | null;
};

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
    const snapshot = fileSnapshot(path);
    const cursor = ctx.lastCursor(path);
    if (cursorMatchesSnapshot(cursor, snapshot)) return [];
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

function imagePlaceholder(part: PiEntry): string {
  const mime = typeof part.mimeType === 'string' && part.mimeType ? part.mimeType : 'unknown';
  const chars = typeof part.data === 'string' ? part.data.length : 0;
  return `[image ${mime}; base64 chars=${chars}]`;
}

function physicalUserTitle(message: unknown): string | null {
  if (!message || typeof message !== 'object' || Array.isArray(message) || (message as PiEntry).role !== 'user') return null;
  const content = (message as PiEntry).content;
  if (typeof content === 'string') return content.trim() || null;
  if (!Array.isArray(content)) return null;
  return content
    .flatMap(part => part?.type === 'text' && typeof part.text === 'string' ? [part.text] : [])
    .join(' ')
    .trim() || null;
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

function findToolOccurrence(
  scope: PiToolScope | null,
  nativeId: string,
  visibility: 'visible' | 'inactive',
): PiToolOccurrence | null {
  for (let current = scope; current; current = current.parent) {
    if (current.nativeId !== nativeId) continue;
    if (current.occurrence === null) return null;
    return visibility === 'inactive' || current.occurrence.visibility === 'visible'
      ? current.occurrence
      : null;
  }
  return null;
}

/** Full replay is required because the current Pi transcript is a tree path. */
export function* parse(unit: IndexUnit, _cursor: Cursor): Generator<TranscriptRecord, Cursor> {
  const meta = unit.meta as { kind?: string } | undefined;
  if (meta?.kind === 'pi-tombstone') return '0:0';
  const before = fileSnapshot(unit.key);
  const raw = readFileSync(unit.key, 'utf8');
  const after = fileSnapshot(unit.key);
  if (!sameSnapshot(before, after)) throw new Error(`Pi transcript changed while reading: ${unit.key}`);
  const lines = raw.split('\n');
  if (raw.endsWith('\n')) lines.pop();
  const parsed: PiEntry[] = [];
  let processedLineCount = 0;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!.replace(/\r$/, '');
    if (!line) { processedLineCount = index + 1; continue; }
    let value: unknown;
    try { value = JSON.parse(line); } catch { break; }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`Malformed Pi JSONL value at line ${index + 1}`);
    }
    parsed.push(value as PiEntry);
    processedLineCount = index + 1;
  }
  const outCursor = snapshotCursor(after, processedLineCount);
  const header = parsed.find(entry => entry.type === 'session' && typeof entry.id === 'string');
  if (!header || header.version !== 3) return outCursor;

  const sessionRawId = header.id as string;
  const sessionId = piSessionId(sessionRawId, header.cwd);
  const physicalEntries = parsed.filter(entry => entry.type !== 'session');
  for (const entry of physicalEntries) {
    if (
      typeof entry.type !== 'string'
      || typeof entry.id !== 'string'
      || (entry.parentId !== null && typeof entry.parentId !== 'string')
    ) {
      throw new Error(`Malformed Pi entry: ${typeof entry.id === 'string' ? entry.id : 'unknown'}`);
    }
  }
  const byId = new Map<string, PiEntry>();
  for (const entry of physicalEntries) {
    if (byId.has(entry.id)) throw new Error(`Duplicate Pi entry id: ${entry.id}`);
    byId.set(entry.id, entry);
  }
  for (const entry of physicalEntries) {
    if (entry.type !== 'leaf') continue;
    if (entry.targetId !== null && typeof entry.targetId !== 'string') {
      throw new Error(`Malformed Pi leaf target: ${entry.id}`);
    }
    if (typeof entry.targetId === 'string' && !byId.has(entry.targetId)) {
      throw new Error(`Pi leaf target ${entry.targetId} does not exist`);
    }
  }
  const resolvedParents = new Set<string>();
  for (const entry of physicalEntries) {
    const path: string[] = [];
    const visiting = new Set<string>();
    let current: PiEntry | undefined = entry;
    while (current && !resolvedParents.has(current.id)) {
      if (visiting.has(current.id)) throw new Error(`Pi session contains a cycle at ${current.id}`);
      visiting.add(current.id);
      path.push(current.id);
      current = typeof current.parentId === 'string' ? byId.get(current.parentId) : undefined;
    }
    for (const id of path) resolvedParents.add(id);
  }
  const checkpoints = new Set<string>();
  for (const entry of physicalEntries) {
    if (entry.type !== 'compaction' || entry.retainedTail === undefined) continue;
    if (!Array.isArray(entry.retainedTail)) {
      throw new Error(`Malformed retainedTail at Pi entry ${entry.id}`);
    }
    checkpoints.add(entry.id);
  }
  let active: PiEntry | undefined;
  for (const entry of physicalEntries) {
    active = entry.type === 'leaf'
      ? typeof entry.targetId === 'string' ? byId.get(entry.targetId) : undefined
      : entry;
  }
  const activePath: PiEntry[] = [];
  const visited = new Set<string>();
  while (active && !visited.has(active.id as string)) {
    visited.add(active.id as string);
    activePath.push(active);
    if (checkpoints.has(active.id as string)) break;
    active = typeof active.parentId === 'string' ? byId.get(active.parentId) : undefined;
  }
  activePath.reverse();

  const activeIds = new Set<string>();
  let latestCompactionIndex = -1;
  for (let index = 0; index < activePath.length; index++) {
    if (activePath[index]!.type === 'compaction') latestCompactionIndex = index;
  }
  if (latestCompactionIndex < 0) {
    for (const entry of activePath) activeIds.add(entry.id as string);
  } else {
    const latestCompaction = activePath[latestCompactionIndex]!;
    for (const entry of activePath.slice(latestCompactionIndex)) activeIds.add(entry.id as string);
    if (!checkpoints.has(latestCompaction.id as string) && typeof latestCompaction.firstKeptEntryId === 'string') {
      const firstKeptIndex = activePath.findIndex((entry, index) => (
        index < latestCompactionIndex && entry.id === latestCompaction.firstKeptEntryId
      ));
      if (firstKeptIndex >= 0) {
        for (const entry of activePath.slice(firstKeptIndex, latestCompactionIndex)) {
          activeIds.add(entry.id as string);
        }
      }
    }
  }

  const syntheticByCompaction = new Map<string, PiEntry[]>();
  const retainedIds = new Set<string>();
  for (const checkpoint of physicalEntries) {
    if (!checkpoints.has(checkpoint.id as string) || !activeIds.has(checkpoint.id as string)) continue;
    const synthetic: PiEntry[] = [];
    for (const [index, message] of checkpoint.retainedTail.entries()) {
      if (!message || typeof message !== 'object' || Array.isArray(message)) {
        throw new Error(`Malformed retainedTail message at Pi entry ${checkpoint.id}`);
      }
      if (typeof message.role !== 'string') continue;
      const entry = {
        type: 'message',
        id: `${checkpoint.id}:retained:${index}`,
        parentId: synthetic.at(-1)?.id ?? checkpoint.id,
        timestamp: message.timestamp ?? checkpoint.timestamp,
        message,
      };
      synthetic.push(entry);
      retainedIds.add(entry.id);
      byId.set(entry.id, entry);
      activeIds.add(entry.id);
    }
    syntheticByCompaction.set(checkpoint.id, synthetic);
  }
  const entries: PiEntry[] = [];
  for (const entry of physicalEntries) {
    entries.push(entry);
    const retained = syntheticByCompaction.get(entry.id as string);
    if (retained) entries.push(...retained);
  }
  const toolScopeByEntry = new Map<string, PiToolScope | null>();
  const toolCallByMessage = new Map<string, PiToolOccurrence>();
  const toolResultByEntry = new Map<string, PiToolOccurrence>();
  const checkpointBySyntheticTail = new Map<string, string>();
  for (const [checkpointId, retained] of syntheticByCompaction) {
    const tailId = retained.at(-1)?.id;
    if (tailId) checkpointBySyntheticTail.set(tailId, checkpointId);
  }
  for (const entry of entries) {
    if (entry.type === 'leaf') {
      toolScopeByEntry.set(entry.id, typeof entry.targetId === 'string' ? toolScopeByEntry.get(entry.targetId) ?? null : null);
      continue;
    }
    let scope = typeof entry.parentId === 'string' ? toolScopeByEntry.get(entry.parentId) ?? null : null;
    if (entry.type === 'compaction' || entry.type === 'branch_summary') scope = null;
    const visibility: PiToolOccurrence['visibility'] = activeIds.has(entry.id) ? 'visible' : 'inactive';
    const message = entry.message;
    if (entry.type === 'message' && message?.role === 'assistant' && Array.isArray(message.content)) {
      for (let index = 0; index < message.content.length; index++) {
        const part = message.content[index];
        if (part?.type !== 'toolCall' || typeof part.id !== 'string') continue;
        const messageId = piId(sessionId, entry.id, `:${index}`);
        const occurrence = {
          id: `${messageId}:tool`,
          filePath: toolFilePath(part.name, part.arguments),
          visibility,
        };
        toolCallByMessage.set(messageId, occurrence);
        scope = { nativeId: part.id, occurrence, parent: scope };
      }
    } else if (entry.type === 'message' && message?.role === 'toolResult' && typeof message.toolCallId === 'string') {
      const occurrence = findToolOccurrence(scope, message.toolCallId, visibility);
      if (occurrence) toolResultByEntry.set(entry.id, occurrence);
      scope = { nativeId: message.toolCallId, occurrence: null, parent: scope };
    }
    toolScopeByEntry.set(entry.id, scope);
    const checkpointId = checkpointBySyntheticTail.get(entry.id);
    if (checkpointId) toolScopeByEntry.set(checkpointId, scope);
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
    const message = entry.message;
    let own: string | null = null;
    if (entry.type === 'compaction' && syntheticByCompaction.has(entryId)) {
      const retained = syntheticByCompaction.get(entryId)!;
      own = finalMessage(retained.at(-1)?.id);
    } else if (entry.type === 'custom_message' && textParts(entry.content, 'text').length) own = piId(sessionId, entryId);
    else if (entry.type === 'message' && message) {
      if (message.role === 'user') {
        if (typeof message.content === 'string' && message.content) own = piId(sessionId, entryId);
        else if (Array.isArray(message.content)) {
          const last = message.content.reduce((result: number, part: PiEntry, index: number) => (
            (part?.type === 'text' && typeof part.text === 'string') || part?.type === 'image' ? index : result
          ), -1);
          if (last >= 0) own = piId(sessionId, entryId, `:${last}`);
        }
      }
      else if (message.role === 'toolResult' || message.role === 'bashExecution') own = piId(sessionId, entryId);
      else if (message.role === 'assistant') {
        const parts: any[] = Array.isArray(message.content) ? message.content : [];
        if (typeof message.errorMessage === 'string' && message.errorMessage) {
          own = piId(sessionId, entryId, `:${parts.length}`);
        } else {
          const last = parts.reduce((result, part, index) => (
            part?.type === 'text'
            || (part?.type === 'thinking' && typeof part.thinking === 'string' && part.thinking.length > 0)
            || part?.type === 'toolCall' ? index : result
          ), -1);
          if (last >= 0) own = piId(sessionId, entryId, `:${last}`);
        }
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
  const firstUserTitle = physicalEntries
    .map(entry => entry.type === 'message' ? physicalUserTitle(entry.message) : null)
    .find(value => value !== null) ?? null;
  let latestName: string | null = null;
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
    if (visibility === 'visible') count++;
    if (entryTimestamp && (!startedAt || entryTimestamp < startedAt)) startedAt = entryTimestamp;
    if (entryTimestamp && (!endedAt || entryTimestamp > endedAt)) endedAt = entryTimestamp;
    return uuid;
  };

  for (const entry of entries) {
    const entryVisibility: 'visible' | 'inactive' = activeIds.has(entry.id) ? 'visible' : 'inactive';
    if (entry.type === 'session_info') { latestName = typeof entry.name === 'string' ? entry.name.trim() || null : null; continue; }
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
    const retained = retainedIds.has(entry.id);
    let parentUuid = finalMessage(entry.parentId);
    if (
      retained
      && (message.role === 'branchSummary' || message.role === 'compactionSummary')
      && typeof message.summary === 'string'
    ) {
      records.push({
        kind: 'summary', id: piId(sessionId, entry.id), session_id: sessionId,
        timestamp: entry.timestamp ?? null,
        source: message.role === 'branchSummary' ? 'branch_summary' : 'compaction',
        content: message.summary, visibility: entryVisibility, input_tokens: null, output_tokens: null,
      });
      continue;
    }
    if (message.role === 'user') {
      if (typeof message.content === 'string') {
        if (message.content) addMessage(entry, 'user', message.content, 'text', parentUuid, '', entryVisibility);
      } else if (Array.isArray(message.content)) {
        for (let index = 0; index < message.content.length; index++) {
          const part = message.content[index];
          if (part?.type === 'text' && typeof part.text === 'string') {
            parentUuid = addMessage(entry, 'user', part.text, 'text', parentUuid, `:${index}`, entryVisibility);
          } else if (part?.type === 'image') {
            parentUuid = addMessage(entry, 'user', imagePlaceholder(part), 'image', parentUuid, `:${index}`, entryVisibility);
          }
        }
      }
      continue;
    }
    if (message.role === 'assistant') {
      const parts: any[] = Array.isArray(message.content) ? message.content : [];
      const { inputTokens, outputTokens } = retained
        ? { inputTokens: null, outputTokens: null }
        : usageFields(message.usage);
      const hasError = typeof message.errorMessage === 'string' && message.errorMessage.length > 0;
      const lastPart = parts.reduce((last, part, i) => (
        part?.type === 'text'
        || (part?.type === 'thinking' && typeof part.thinking === 'string' && part.thinking.length > 0)
        || part?.type === 'toolCall' ? i : last
      ), -1);
      let index = 0;
      for (const part of parts) {
        const suffix = `:${index++}`;
        const isLast = index - 1 === lastPart;
        if (part?.type === 'text' && typeof part.text === 'string') parentUuid = addMessage(entry, 'assistant', part.text, 'text', parentUuid, suffix, entryVisibility, !hasError && isLast ? inputTokens : null, !hasError && isLast ? outputTokens : null);
        else if (part?.type === 'thinking' && typeof part.thinking === 'string' && part.thinking.length > 0) parentUuid = addMessage(entry, 'assistant', part.thinking, 'thinking', parentUuid, suffix, entryVisibility, !hasError && isLast ? inputTokens : null, !hasError && isLast ? outputTokens : null);
        else if (part?.type === 'toolCall' && typeof part.id === 'string') {
          const uuid = addMessage(entry, 'assistant', null, 'tool_use', parentUuid, suffix, entryVisibility, !hasError && isLast ? inputTokens : null, !hasError && isLast ? outputTokens : null);
          parentUuid = uuid;
          const occurrence = toolCallByMessage.get(uuid)!;
          records.push({ kind: 'tool_call', id: occurrence.id, message_uuid: uuid, session_id: sessionId, name: typeof part.name === 'string' ? part.name : 'tool', input_json: truncJson(part.arguments) ?? '{}', file_path: occurrence.filePath });
        }
      }
      if (hasError) addMessage(entry, 'assistant', message.errorMessage, 'error', parentUuid, `:${parts.length}`, entryVisibility, inputTokens, outputTokens);
      continue;
    }
    if (message.role === 'toolResult') {
      const text = textParts(message.content, 'text').join('\n');
      const { inputTokens, outputTokens } = retained
        ? { inputTokens: null, outputTokens: null }
        : usageFields(message.usage);
      const uuid = addMessage(entry, 'tool', toolResultPreview(text), 'tool_result', parentUuid, '', entryVisibility, inputTokens, outputTokens);
      const occurrence = toolResultByEntry.get(entry.id);
      if (occurrence) records.push({ kind: 'tool_result', tool_use_id: occurrence.id, message_uuid: uuid, session_id: sessionId, content: truncToolResult(text), file_path: occurrence.filePath, is_error: message.isError ? 1 : 0 });
      continue;
    }
    if (message.role === 'bashExecution') addMessage(entry, 'tool', [message.command ? `$ ${message.command}` : '', message.output, message.exitCode ? `[exit code: ${message.exitCode}]` : ''].filter(value => typeof value === 'string' && value).join('\n'), 'bash', parentUuid, '', entryVisibility);
  }
  records.push({ kind: 'session', id: sessionId, title: latestName ?? firstUserTitle, project: projectSlugFromPath(header.cwd), started_at: startedAt, ended_at: endedAt, git_branch: null, version: typeof header.version === 'number' ? String(header.version) : null, message_count: count, countMode: 'total', jsonl_path: unit.key, source: name });
  yield* records;
  return outCursor;
}

function rawMessageText(message: PiEntry, blockIndex: number): string | null | undefined {
  if (message.role === 'assistant') {
    const content = Array.isArray(message.content) ? message.content : [];
    if (blockIndex === content.length && typeof message.errorMessage === 'string' && message.errorMessage) return message.errorMessage;
    const part = content[blockIndex];
    if (part?.type === 'thinking' && typeof part.thinking === 'string') return part.thinking;
    if (part?.type === 'text' && typeof part.text === 'string') return part.text;
    if (part?.type === 'toolCall') return null;
    return part === undefined ? undefined : JSON.stringify(part);
  }
  if (message.role === 'toolResult') return blockIndex === 0 ? textParts(message.content, 'text').join('\n') : undefined;
  if (message.role === 'bashExecution') {
    if (blockIndex !== 0) return undefined;
    return [message.command ? `$ ${message.command}` : '', message.output, message.exitCode ? `[exit code: ${message.exitCode}]` : '']
      .filter(value => typeof value === 'string' && value)
      .join('\n');
  }
  if (typeof message.content === 'string') return blockIndex === 0 ? message.content : undefined;
  const part = Array.isArray(message.content) ? message.content[blockIndex] : undefined;
  if (part?.type === 'text' && typeof part.text === 'string') return part.text;
  if (part?.type === 'image') return imagePlaceholder(part);
  return undefined;
}

function rawPi(sessionDir: string, input: RawLookup): RawRecord | null {
  try {
    const path = input.session?.jsonl_path;
    const sessionId = input.session?.id;
    if (typeof path !== 'string' || typeof sessionId !== 'string') return null;
    const normalizedRoot = normalize(sessionDir);
    const normalizedPath = normalize(path);
    const inside = relative(normalizedRoot, normalizedPath);
    if (!inside || inside.startsWith('..') || isAbsolute(inside)) return null;
    const prefix = `${sessionId}:`;
    if (!input.messageUuid.startsWith(prefix)) return null;

    const entries: PiEntry[] = [];
    for (const line of readFileSync(normalizedPath, 'utf8').split('\n')) {
      if (!line) continue;
      try { entries.push(JSON.parse(line)); } catch { break; }
    }
    const header = entries.find(entry => entry?.type === 'session' && typeof entry.id === 'string');
    if (!header || piSessionId(header.id, header.cwd) !== sessionId) return null;

    const suffix = input.messageUuid.slice(prefix.length);
    const source = entries
      .filter(entry => entry?.type !== 'session' && typeof entry.id === 'string')
      .sort((left, right) => right.id.length - left.id.length)
      .find(entry => suffix === entry.id || suffix.startsWith(`${entry.id}:`));
    if (!source) return null;
    const location = suffix.slice(source.id.length);
    let message: PiEntry | null = null;
    let blockIndex = 0;
    const retainedMatch = /^:retained:(\d+)(?::(\d+))?$/.exec(location);
    if (retainedMatch && source.type === 'compaction' && Array.isArray(source.retainedTail)) {
      const retained = source.retainedTail[Number(retainedMatch[1])];
      if (retained && typeof retained === 'object' && !Array.isArray(retained)) message = retained;
      blockIndex = retainedMatch[2] === undefined ? 0 : Number(retainedMatch[2]);
    } else if (source.type === 'message' && (location === '' || /^:\d+$/.test(location))) {
      if (source.message && typeof source.message === 'object' && !Array.isArray(source.message)) message = source.message;
      if (location) blockIndex = Number(location.slice(1));
    } else if (source.type === 'custom_message' && location === '') {
      message = { role: 'custom', content: source.content, display: source.display };
    }
    if (!message) return null;
    const messageText = rawMessageText(message, blockIndex);
    if (messageText === undefined) return null;
    const text = JSON.stringify(message);
    return { text, totalLength: text.length, offset: 0, limit: text.length, hasMore: false, messageText };
  } catch {
    return null;
  }
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
