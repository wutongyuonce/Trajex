// Copyright (C) 2026 Trajex contributors.
// SPDX-License-Identifier: AGPL-3.0-only

/** DeepSeek Harness session adapter. The newest immutable generation owns each session. */
import { readFileSync, readdirSync, realpathSync, type Dirent } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, normalize, relative } from 'node:path';
import * as zlib from 'node:zlib';
import { Decompress } from 'fzstd';

import { projectSlugFromPath, trunc, truncJson, truncToolResult, toolResultPreview } from '../parsing.ts';
import { cursorMatchesSnapshot, fileSnapshot, sameSnapshot, snapshotCursor } from './file-snapshot.ts';
import type {
  Cursor, DiscoverContext, IndexUnit, MessageRecord, ProviderAdapter, RawLookup,
  RawRecord, TranscriptRecord,
} from './types.ts';

export const name = 'deepseek';
export const DEEPSEEK_CANONICAL_TRANSCRIPT_MARKER = '__deepseek_canonical_transcript_v1__';
const MAX_SUPPORTED_VERSION = 4;
const MIN_SUPPORTED_VERSION = 2; // V0/V1 pack several assistant events into one physical row.
const ZSTD_MAGIC = 0xfd2fb528;

type JsonObject = Record<string, any>;
type SessionFile = { path: string; version: number };

function generationVersion(filename: string): number | null {
  const match = /^session(?:\.v([1-9]\d*))?\.jsonl(?:\.zstd)?$/.exec(filename);
  return match ? Number(match[1] ?? 0) : null;
}

function inside(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path !== '' && !path.startsWith('..') && !isAbsolute(path);
}

function selectedFiles(root: string, projects: readonly Dirent[]): SessionFile[] {
  const files: SessionFile[] = [];
  for (const project of projects) {
    if (!project.isDirectory()) continue;
    const projectDir = join(root, project.name);
    let sessions: Dirent[];
    try { sessions = readdirSync(projectDir, { withFileTypes: true }); } catch { continue; }
    for (const session of sessions) {
      if (!session.isDirectory()) continue;
      const sessionDir = join(projectDir, session.name);
      let entries: Dirent[];
      try { entries = readdirSync(sessionDir, { withFileTypes: true }); } catch { continue; }
      const generations = entries.flatMap(entry => {
        const version = entry.isFile() ? generationVersion(entry.name) : null;
        return version === null ? [] : [{ path: join(sessionDir, entry.name), version }];
      });
      // Historical generations remain on disk after migration. Never index both.
      generations.sort((left, right) => right.version - left.version || Number(right.path.endsWith('.zstd')) - Number(left.path.endsWith('.zstd')));
      if (generations[0]) files.push(generations[0]);
    }
  }
  return files;
}

/** Identify complete frames before decoding so an interrupted append cannot hide earlier batches. */
function zstdFrames(bytes: Buffer, maxFrames = Number.POSITIVE_INFINITY): { complete: Buffer[]; torn: Buffer | null } {
  const complete: Buffer[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    const start = offset;
    if (bytes.length - offset < 4) return { complete, torn: bytes.subarray(start) };
    if (bytes.readUInt32LE(offset) !== ZSTD_MAGIC) throw new Error(`Invalid DeepSeek Zstandard frame at byte ${offset}`);
    offset += 4;
    if (offset === bytes.length) return { complete, torn: bytes.subarray(start) };
    const descriptor = bytes[offset++];
    if (descriptor & 0x18) throw new Error(`Invalid DeepSeek Zstandard header at byte ${offset - 1}`);
    const contentSizeFlag = descriptor >>> 6;
    const singleSegment = Boolean(descriptor & 0x20);
    const dictionaryFlag = descriptor & 0x03;
    const headerBytes = Number(!singleSegment) + (dictionaryFlag === 3 ? 4 : dictionaryFlag)
      + (contentSizeFlag === 0 ? Number(singleSegment) : 1 << contentSizeFlag);
    if (bytes.length - offset < headerBytes) return { complete, torn: bytes.subarray(start) };
    offset += headerBytes;
    for (;;) {
      if (bytes.length - offset < 3) return { complete, torn: bytes.subarray(start) };
      const block = bytes.readUIntLE(offset, 3);
      offset += 3;
      const blockType = (block >>> 1) & 3;
      if (blockType === 3) throw new Error(`Invalid DeepSeek Zstandard block at byte ${offset - 3}`);
      const payloadBytes = blockType === 1 ? 1 : block >>> 3;
      if (bytes.length - offset < payloadBytes) return { complete, torn: bytes.subarray(start) };
      offset += payloadBytes;
      if (block & 1) break;
    }
    if (descriptor & 0x04) {
      if (bytes.length - offset < 4) return { complete, torn: bytes.subarray(start) };
      offset += 4;
    }
    complete.push(bytes.subarray(start, offset));
    if (complete.length === maxFrames) return { complete, torn: null };
  }
  return { complete, torn: null };
}

function decodeCompleteFrame(frame: Buffer): Buffer {
  if (typeof zlib.zstdDecompressSync !== 'function') {
    throw new Error('DeepSeek Zstandard logs require Node.js 22.15 or newer');
  }
  return zlib.zstdDecompressSync(frame);
}

function decodeZstd(bytes: Buffer): { text: string; torn: boolean } {
  const { complete, torn } = zstdFrames(bytes);
  const completeBytes = complete.reduce((length, frame) => length + frame.length, 0);
  const decoded: Buffer[] = completeBytes ? [decodeCompleteFrame(bytes.subarray(0, completeBytes))] : [];
  if (torn) {
    // A partial final frame can already contain complete JSONL rows in decoded blocks.
    const recovered: Buffer[] = [];
    try { new Decompress(chunk => { if (chunk.length) recovered.push(Buffer.from(chunk)); }).push(torn); }
    catch { /* Only the incomplete final frame is recoverable; prior frames stay authoritative. */ }
    decoded.push(...recovered);
  }
  return { text: Buffer.concat(decoded).toString('utf8'), torn: torn !== null };
}

function validateHeader(path: string, header: JsonObject | undefined): JsonObject {
  if (header?.type !== 'session' || typeof header.id !== 'string' || !Number.isSafeInteger(header.version)) {
    throw new Error(`Invalid DeepSeek session header: ${path}`);
  }
  if (header.version < MIN_SUPPORTED_VERSION || header.version > MAX_SUPPORTED_VERSION) {
    throw new Error(`Unsupported DeepSeek session format version ${header.version}: ${path}`);
  }
  const version = generationVersion(path.split(/[\\/]/).at(-1) ?? '');
  if (version !== header.version) throw new Error(`DeepSeek session generation mismatch: ${path}`);
  return header;
}

function readHeader(path: string): JsonObject {
  const before = fileSnapshot(path);
  const bytes = readFileSync(path);
  const text = path.endsWith('.zstd')
    ? (() => {
      const firstFrame = zstdFrames(bytes, 1).complete[0];
      if (!firstFrame) throw new Error(`Incomplete DeepSeek session header: ${path}`);
      return decodeCompleteFrame(firstFrame).toString('utf8');
    })()
    : bytes.toString('utf8');
  if (!sameSnapshot(before, fileSnapshot(path))) throw new Error(`DeepSeek transcript changed while reading: ${path}`);
  const newline = text.indexOf('\n');
  if (newline < 0) throw new Error(`Incomplete DeepSeek session header: ${path}`);
  const firstLine = text.slice(0, newline);
  return validateHeader(path, JSON.parse(firstLine));
}

function readSession(path: string): { header: JsonObject; events: JsonObject[]; lines: number; snapshot: ReturnType<typeof fileSnapshot> } {
  const before = fileSnapshot(path);
  const bytes = readFileSync(path);
  const compressed = path.endsWith('.zstd');
  const result = compressed ? decodeZstd(bytes) : { text: bytes.toString('utf8'), torn: true };
  const decoded = result.text;
  const after = fileSnapshot(path);
  if (!sameSnapshot(before, after)) throw new Error(`DeepSeek transcript changed while reading: ${path}`);
  const lines = decoded.split('\n');
  if (!decoded.endsWith('\n')) {
    if (compressed && !result.torn) throw new Error(`DeepSeek complete Zstandard frame contains an incomplete JSONL row: ${path}`);
    lines.pop(); // Ignore an unfinished raw line or an unfinished final frame.
  }
  const rows: JsonObject[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    const row = JSON.parse(line);
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error(`Invalid DeepSeek record: ${path}`);
    rows.push(row);
  }
  const [header, ...events] = rows;
  return { header: validateHeader(path, header), events, lines: rows.length, snapshot: before };
}

function sessionId(header: JsonObject): string {
  const cwd = typeof header.cwd === 'string' ? normalize(header.cwd) : '';
  const scope = createHash('sha256').update('deepseek-cwd-v1\0').update(cwd).digest('hex');
  return `deepseek:${encodeURIComponent(header.id)}:${scope}`;
}

function changed(changedPaths: readonly string[] | undefined, root: string, file: string): boolean {
  if (changedPaths === undefined) return true;
  return changedPaths.some(value => {
    const absolute = normalize(isAbsolute(value) ? value : join(root, value));
    return absolute === file || absolute === root || inside(absolute, file);
  });
}

function changedSession(changedPaths: readonly string[] | undefined, root: string, file: string): boolean {
  if (changed(changedPaths, root, file)) return true;
  return changedPaths?.some(value => {
    const absolute = normalize(isAbsolute(value) ? value : join(root, value));
    return dirname(absolute) === dirname(file);
  }) ?? false;
}

function discoverAt(root: string, ctx: DiscoverContext): IndexUnit[] {
  let projects: Dirent[];
  try { projects = readdirSync(root, { withFileTypes: true }); }
  catch (error) {
    ctx.reportUnavailableRoot?.({ path: root, error: error instanceof Error ? error.message : String(error) });
    return [];
  }
  const files = selectedFiles(root, projects);
  const currentPaths = new Set(files.map(file => normalize(file.path)));
  const selectedByDirectory = new Map(files.map(file => [dirname(normalize(file.path)), normalize(file.path)]));
  const selectedIdentity = new Map<string, string>();
  const indexedByPath = new Map((ctx.indexedSessions?.() ?? []).map(row => [normalize(row.jsonlPath), row]));
  const units: IndexUnit[] = [];
  for (const file of files) {
    const path = normalize(file.path);
    if (!changedSession(ctx.changedPaths, root, path)) continue;
    try { if (cursorMatchesSnapshot(ctx.lastCursor(path), fileSnapshot(path))) continue; }
    catch { continue; } // A generation may disappear while the directory is being scanned.
    const old = indexedByPath.get(path);
    let header: JsonObject;
    try { header = readHeader(path); }
    catch {
      // Let the indexer's per-unit error path report this file without aborting other sessions.
      units.push({ key: path, sessionId: old?.sessionId ?? `deepseek:unreadable:${createHash('sha256').update(path).digest('hex')}` });
      continue;
    }
    const id = sessionId(header);
    // Cache the snapshot even for a child log, so periodic discovery does not decompress it again.
    if (header.origin === 'subagent') {
      units.push({ key: path, sessionId: id, meta: { subagent: true } });
      continue;
    }
    units.push({ key: path, sessionId: id, ...(old && old.sessionId !== id ? { retractSessionIds: [old.sessionId] } : {}) });
  }
  for (const row of ctx.indexedSessions?.() ?? []) {
    const path = normalize(row.jsonlPath);
    if (!inside(root, path) || currentPaths.has(path) || !changedSession(ctx.changedPaths, root, path)) continue;
    const replacement = selectedByDirectory.get(dirname(path));
    if (replacement) {
      let identity = selectedIdentity.get(replacement);
      if (!identity) {
        try { identity = sessionId(readHeader(replacement)); }
        catch { continue; } // Keep the old snapshot until the replacement generation is readable.
        selectedIdentity.set(replacement, identity);
      }
      // A format migration only changes the file path; its session still exists.
      if (identity === row.sessionId) continue;
    }
    units.push({ key: path, sessionId: row.sessionId, retractSessionIds: [row.sessionId], meta: { tombstone: true } });
  }
  return units;
}

function contentText(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content.flatMap(block => block?.type === 'text' && typeof block.text === 'string' ? [block.text] : []).join('\n');
}

function toolResult(message: JsonObject): { callId: string | null; content: unknown; isError: boolean } {
  // V2–V3 stored the result inside one user-role wrapper; V4 lifted it to a tool-role message.
  const wrapped = message.content?.[0]?.type === 'tool-result' ? message.content[0] : null;
  const callId = wrapped?.toolCallId ?? message.toolCallId ?? message.source?.callId;
  return {
    callId: typeof callId === 'string' ? callId : null,
    content: wrapped ? wrapped.content : message.content,
    isError: Boolean(wrapped?.isError ?? message.isError),
  };
}

function timestamp(value: unknown): string | null {
  return typeof value === 'number' && Number.isFinite(value) ? new Date(value).toISOString() : null;
}

function usage(value: unknown): { input: number | null; output: number | null } {
  const counters = value && typeof value === 'object' ? value as JsonObject : {};
  const input = ['inputTokens', 'cacheReadTokens', 'cacheWriteTokens']
    .reduce((sum, key) => sum + (Number.isFinite(counters[key]) ? counters[key] : 0), 0);
  return { input: input || null, output: Number.isFinite(counters.outputTokens) ? counters.outputTokens : null };
}

function toolPath(name: string, argumentText: string): string | null {
  if (!['read', 'write', 'edit'].some(action => name.toLowerCase().includes(action))) return null;
  try {
    const args = JSON.parse(argumentText);
    return typeof args?.path === 'string' ? args.path : typeof args?.file_path === 'string' ? args.file_path : null;
  } catch { return null; }
}

/** Full replay keeps compaction replacements and source visibility coherent. */
export function* parse(unit: IndexUnit, _cursor: Cursor): Generator<TranscriptRecord, Cursor> {
  if ((unit.meta as JsonObject | undefined)?.tombstone) return '0:0';
  if ((unit.meta as JsonObject | undefined)?.subagent) return snapshotCursor(fileSnapshot(unit.key), 0);
  const { header, events, lines, snapshot } = readSession(unit.key);
  const id = sessionId(header);
  if (id !== unit.sessionId) throw new Error(`DeepSeek session identity changed: ${unit.key}`);
  const replacedRanges = events.flatMap(event => event.surfaceOp?.op === 'replace'
    ? [{ start: event.surfaceOp.startSeq, end: event.surfaceOp.endSeq }]
    : []);
  const inheritedThrough = header.isSeeded
    ? events.filter(event => event.type === 'session/end-seed' && event.data?.inherited === true)
      .at(-1)?.seq ?? -1
    : -1;
  const isVisible = (seq: number) => seq > inheritedThrough
    && !replacedRanges.some(range => seq >= range.start && seq <= range.end);
  const toolCalls = new Map<string, JsonObject[]>();
  for (const event of events) {
    if (event.type !== 'tool/call' || typeof event.data?.callId !== 'string') continue;
    const calls = toolCalls.get(event.data.callId) ?? [];
    calls.push(event);
    toolCalls.set(event.data.callId, calls);
  }
  const callFor = (callId: string, seq: number, direction: 'before' | 'after') => {
    const calls = toolCalls.get(callId) ?? [];
    return direction === 'before'
      ? calls.findLast(call => call.seq < seq)
      : calls.find(call => call.seq > seq);
  };
  const callKey = (callId: string, call?: JsonObject) => `${id}:call:${call?.seq ?? encodeURIComponent(callId)}`;
  const claimedCalls = new Set<number>();
  for (const event of events) {
    if (event.type !== 'assistant/message' || !Number.isSafeInteger(event.seq)) continue;
    const blocks = event.data?.message?.content ?? event.data?.content;
    if (!Array.isArray(blocks)) continue;
    for (const block of blocks) {
      if (block?.type !== 'tool-call' || typeof block.id !== 'string') continue;
      const call = callFor(block.id, event.seq, 'after');
      if (call) claimedCalls.add(call.seq);
    }
  }
  const records: TranscriptRecord[] = [{ kind: 'delete-session', sessionId: id }];
  let previous: string | null = null;
  let title: string | null = null;
  let count = 0;
  let endedAt = timestamp(header.createdAt);
  const cwd = typeof header.cwd === 'string' ? header.cwd : null;
  const addMessage = (event: JsonObject, role: string, text: string | null, contentType: string, suffix: string, tokenUsage?: { input: number | null; output: number | null }, isMeta: 0 | 1 = 0) => {
    const uuid = `${id}:${event.seq}${suffix}`;
    const visible = isVisible(event.seq);
    const time = timestamp(event.time);
    records.push({
      kind: 'message', uuid, session_id: id, type: role, parent_uuid: previous,
      timestamp: time, role, text: trunc(text), content_type: contentType, is_meta: isMeta,
      visibility: visible ? 'visible' : 'inactive', model: typeof event.data?.message?.source?.model === 'string' ? event.data.message.source.model : null,
      agent_id: null, input_tokens: tokenUsage?.input ?? null, output_tokens: tokenUsage?.output ?? null,
      cwd, skill: null, source: name,
    } satisfies MessageRecord);
    previous = uuid;
    if (visible) count++;
    if (time && (!endedAt || time > endedAt)) endedAt = time;
    return uuid;
  };
  const addToolCall = (uuid: string, callId: string, call: JsonObject | undefined, fallback: JsonObject) => {
    const argumentsText = typeof call?.data?.arguments === 'string' ? call.data.arguments
      : typeof fallback.arguments === 'string' ? fallback.arguments : '{}';
    const toolName = typeof call?.data?.name === 'string' ? call.data.name
      : typeof fallback.name === 'string' ? fallback.name : 'tool';
    let input: unknown;
    try { input = JSON.parse(argumentsText); } catch { input = { raw: argumentsText }; }
    records.push({ kind: 'tool_call', id: callKey(callId, call), message_uuid: uuid, session_id: id, name: toolName, input_json: truncJson(input as any) ?? '{}', file_path: toolPath(toolName, argumentsText) });
  };
  for (const event of events) {
    if (!Number.isSafeInteger(event.seq)) continue;
    const data = event.data;
    if (event.type === 'compaction/summary' && Array.isArray(data?.summary)) {
      const replacement = events.find(candidate => candidate.seq > event.seq && candidate.type === 'user/message' && candidate.surfaceOp);
      records.push({ kind: 'summary', id: `${id}:${event.seq}`, session_id: id, timestamp: timestamp(event.time), source: 'compaction', content: contentText(data.summary), visibility: isVisible(replacement?.seq ?? event.seq) ? 'visible' : 'inactive', input_tokens: usage(data.usage).input, output_tokens: usage(data.usage).output });
      continue;
    }
    if (event.type === 'tool/call' && typeof data?.callId === 'string') {
      if (!claimedCalls.has(event.seq)) {
        const uuid = addMessage(event, 'assistant', null, 'tool_use', ':0');
        addToolCall(uuid, data.callId, event, data);
      }
      continue;
    }
    if (!['user/message', 'assistant/message', 'tool/result'].includes(event.type)) continue;
    const message = data?.message ?? data;
    if (!Array.isArray(message?.content)) continue;
    if (event.type === 'user/message' && message.source?.kind === 'user' && event.seq > inheritedThrough && !title) title = contentText(message.content).trim() || null;
    if (event.type === 'tool/result') {
      const result = toolResult(message);
      const fullText = contentText(result.content);
      const uuid = addMessage(event, 'tool', toolResultPreview(fullText), 'tool_result', ':0');
      if (result.callId) {
        const call = callFor(result.callId, event.seq, 'before');
        const toolName = typeof call?.data?.name === 'string' ? call.data.name : 'tool';
        const argumentText = typeof call?.data?.arguments === 'string' ? call.data.arguments : '{}';
        records.push({ kind: 'tool_result', tool_use_id: callKey(result.callId, call), message_uuid: uuid, session_id: id, content: truncToolResult(fullText), file_path: toolPath(toolName, argumentText), is_error: result.isError ? 1 : 0 });
      }
      continue;
    }
    const blocks = message.content;
    const tokenUsage = event.type === 'assistant/message' ? usage(data.usage) : undefined;
    const isMeta: 0 | 1 = event.type === 'user/message' && message.source?.kind !== 'user' ? 1 : 0;
    for (let index = 0; index < blocks.length; index++) {
      const block = blocks[index];
      const suffix = `:${index}`;
      const last = index === blocks.length - 1 ? tokenUsage : undefined;
      if (block?.type === 'text' && typeof block.text === 'string') {
        addMessage(event, message.role ?? 'user', block.text, 'text', suffix, last, isMeta);
      } else if (block?.type === 'reasoning' && typeof block.text === 'string') {
        addMessage(event, 'assistant', block.text, 'thinking', suffix, last);
      } else if (block?.type === 'image' || block?.type === 'file') {
        addMessage(event, message.role ?? 'user', `[${block.type}]`, block.type, suffix, last, isMeta);
      } else if (block?.type === 'tool-call' && typeof block.id === 'string') {
        const uuid = addMessage(event, 'assistant', null, 'tool_use', suffix, last);
        const call = callFor(block.id, event.seq, 'after');
        addToolCall(uuid, block.id, call, block);
      }
    }
  }
  if (count === 0) {
    yield records[0];
    return snapshotCursor(snapshot, lines);
  }
  records.push({ kind: 'session', id, title, project: projectSlugFromPath(cwd), started_at: timestamp(header.createdAt), ended_at: endedAt, git_branch: null, version: String(header.version), message_count: count, countMode: 'total', jsonl_path: unit.key, source: name });
  yield* records;
  return snapshotCursor(snapshot, lines);
}

function rawAt(root: string, input: RawLookup): RawRecord | null {
  try {
    const path = input.session?.jsonl_path;
    if (typeof path !== 'string' || !inside(realpathSync(root), realpathSync(path))) return null;
    const { header, events } = readSession(path);
    const id = sessionId(header);
    if (input.session?.id !== id || !input.messageUuid.startsWith(`${id}:`)) return null;
    const match = /:(\d+):(\d+)$/.exec(input.messageUuid);
    if (!match) return null;
    const event = events.find(item => item.seq === Number(match[1]));
    const message = event?.data?.message ?? event?.data;
    const block = event?.type === 'tool/result'
      ? toolResult(message).content
      : message?.content?.[Number(match[2])];
    if (!block) return null;
    const text = JSON.stringify(event);
    const messageText = Array.isArray(block) ? contentText(block) : typeof block.text === 'string' ? block.text : null;
    return { text, totalLength: text.length, offset: 0, limit: text.length, hasMore: false, messageText };
  } catch { return null; }
}

export function createDeepSeekProvider({ sessionDir = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'sessions') }: { sessionDir?: string } = {}): ProviderAdapter {
  return {
    name,
    descriptor: { id: name, name: 'DeepSeek Harness', vendor: 'DeepSeek', defaultRoot: sessionDir, color: '#4d6bfe' },
    indexVersionMarker: DEEPSEEK_CANONICAL_TRANSCRIPT_MARKER,
    watchTargets: () => [{ kind: 'tree', path: sessionDir }],
    discover: ctx => discoverAt(sessionDir, ctx),
    parse,
    raw: input => rawAt(sessionDir, input),
  };
}
