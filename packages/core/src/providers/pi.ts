/** Pi JSONL session adapter. One JSONL file is one Pi session. */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, normalize, relative } from 'node:path';

import { projectSlugFromPath, trunc, truncJson } from '../parsing.ts';
import type {
  Cursor, DiscoverContext, IndexUnit, MessageRecord, ProviderAdapter,
  RawLookup, RawRecord, TranscriptRecord,
} from './types.ts';

export const name = 'pi';
export const PI_CANONICAL_TRANSCRIPT_MARKER = '__pi_canonical_transcript_v2__';

type PiEntry = Record<string, any>;

function piId(sessionId: string, entryId: string, suffix = ''): string {
  return `pi:${sessionId}:${entryId}${suffix}`;
}

function sessionFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const project of readdirSync(dir, { withFileTypes: true })) {
    if (!project.isDirectory()) continue;
    const projectDir = join(dir, project.name);
    for (const file of readdirSync(projectDir, { withFileTypes: true })) {
      if (file.isFile() && file.name.endsWith('.jsonl')) out.push(join(projectDir, file.name));
    }
  }
  return out;
}

function discoverAt(rootDir: string, ctx: DiscoverContext): IndexUnit[] {
  const sessionsDir = join(rootDir, 'sessions');
  const changed = new Set<string>();
  for (const changedPath of ctx.changedPaths ?? []) {
    const absolute = isAbsolute(changedPath) ? normalize(changedPath) : normalize(join(sessionsDir, changedPath));
    const inside = relative(sessionsDir, absolute);
    if (absolute === normalize(sessionsDir) || (inside && !inside.startsWith('..') && !isAbsolute(inside))) changed.add(absolute);
  }
  return sessionFiles(sessionsDir).flatMap((path) => {
    if (ctx.changedPaths !== undefined && !changed.has(normalize(path)) && !changed.has(normalize(dirname(path))) && !changed.has(normalize(sessionsDir))) return [];
    const mtime = statSync(path).mtimeMs;
    const cursor = ctx.lastCursor(path);
    if (cursor !== null && Number(cursor.split(':')[0]) >= mtime) return [];
    let header: PiEntry | null = null;
    try { header = JSON.parse(readFileSync(path, 'utf8').split('\n')[0] || 'null'); } catch { /* malformed file */ }
    if (header?.type !== 'session' || header.version !== 3 || typeof header.id !== 'string') return [];
    const project = projectSlugFromPath(header.cwd);
    return [{ key: path, sessionId: `pi:${header.id}`, ...(project ? { project } : {}), meta: { sessionId: header.id, cwd: header.cwd ?? null } }];
  });
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

function toolFilePath(name: unknown, input: unknown): string | null {
  if (typeof name !== 'string' || !['read', 'edit', 'write'].includes(name.toLowerCase())) return null;
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const args = input as PiEntry;
  return typeof args.path === 'string' ? args.path : typeof args.file_path === 'string' ? args.file_path : null;
}

/** Full replay is required because the current Pi transcript is a tree path. */
export function* parse(unit: IndexUnit, _cursor: Cursor): Generator<TranscriptRecord, Cursor> {
  const stat = statSync(unit.key);
  const raw = readFileSync(unit.key, 'utf8');
  const lines = raw.split('\n');
  if (raw.endsWith('\n')) lines.pop();
  const outCursor = `${stat.mtimeMs}:${lines.length}`;
  const parsed: PiEntry[] = [];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!.replace(/\r$/, '');
    if (!line) continue;
    try { parsed.push(JSON.parse(line)); } catch (error) {
      if (index === lines.length - 1 && !raw.endsWith('\n')) break;
      throw new Error(`Pi session: corrupted line ${index + 1} in ${unit.key}`, { cause: error });
    }
  }
  const header = parsed.find(entry => entry.type === 'session' && typeof entry.id === 'string');
  if (!header || header.version !== 3) return outCursor;

  const sessionRawId = header.id as string;
  const sessionId = `pi:${sessionRawId}`;
  const entries = parsed.filter(entry => entry.type !== 'session' && typeof entry.id === 'string');
  const byId = new Map(entries.map(entry => [entry.id as string, entry]));
  const activeIds = new Set<string>();
  let active = entries.at(-1);
  while (active && !activeIds.has(active.id as string)) {
    activeIds.add(active.id as string);
    active = typeof active.parentId === 'string' ? byId.get(active.parentId) : undefined;
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
    if (entry.type === 'custom_message' && textParts(entry.content, 'text').length) own = piId(sessionRawId, entryId);
    else if (entry.type === 'message' && message) {
      if (message.role === 'user' && textParts(message.content, 'text').length) own = piId(sessionRawId, entryId);
      else if (message.role === 'toolResult' || message.role === 'bashExecution') own = piId(sessionRawId, entryId);
      else if (message.role === 'assistant') {
        const parts: any[] = Array.isArray(message.content) ? message.content : [];
        const last = parts.reduce((result, part, index) => (
          part?.type === 'text' || part?.type === 'thinking' || part?.type === 'toolCall' ? index : result
        ), -1);
        if (last >= 0) own = piId(sessionRawId, entryId, `:${last}`);
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
  const addMessage = (entry: PiEntry, role: string, text: string | null, contentType: string, parentUuid: string | null, suffix = '', visibility: 'visible' | 'hidden' = 'visible', inputTokens: number | null = null, outputTokens: number | null = null, isMeta: 0 | 1 = 0) => {
    const entryTimestamp = timestamp(entry.timestamp ?? entry.message?.timestamp);
    const uuid = piId(sessionRawId, entry.id, suffix);
    const message: MessageRecord = {
      kind: 'message', uuid, session_id: sessionId, type: role, parent_uuid: parentUuid,
      timestamp: entryTimestamp, role, text: trunc(text), content_type: contentType, is_meta: visibility === 'hidden' ? 1 : isMeta,
      visibility, model: modelAt(entry), is_sidechain: activeIds.has(entry.id) ? 0 : 1, agent_id: null, input_tokens: inputTokens, output_tokens: outputTokens,
      cwd: typeof header.cwd === 'string' ? header.cwd : null, skill: null, source: name,
    };
    records.push(message);
    count++;
    if (entryTimestamp && (!startedAt || entryTimestamp < startedAt)) startedAt = entryTimestamp;
    if (entryTimestamp && (!endedAt || entryTimestamp > endedAt)) endedAt = entryTimestamp;
    return uuid;
  };

  for (const entry of entries) {
    if (entry.type === 'session_info' && typeof entry.name === 'string') { title = entry.name; continue; }
    if (entry.type === 'model_change') continue;
    if (entry.type === 'compaction' || entry.type === 'branch_summary') {
      if (typeof entry.summary === 'string') records.push({ kind: 'summary', id: piId(sessionRawId, entry.id), session_id: sessionId, timestamp: entry.timestamp ?? null, source: entry.type, content: entry.summary });
      continue;
    }
    if (entry.type === 'custom_message') {
      const text = textParts(entry.content, 'text').join('\n');
      if (text) addMessage(entry, 'custom', text, 'text', finalMessage(entry.parentId), '', entry.display === false ? 'hidden' : 'visible', null, null, 1);
      continue;
    }
    if (entry.type !== 'message' || !entry.message || typeof entry.id !== 'string') continue;
    const message = entry.message;
    let parentUuid = finalMessage(entry.parentId);
    if (message.role === 'user') {
      const text = textParts(message.content, 'text').join('\n');
      if (text) addMessage(entry, 'user', text, 'text', parentUuid);
      continue;
    }
    if (message.role === 'assistant') {
      const parts: any[] = Array.isArray(message.content) ? message.content : [];
      const usage = message.usage ?? {};
      const inputTokens = ['input', 'cacheRead', 'cacheWrite'].reduce((total, key) => total + (Number.isFinite(usage[key]) ? usage[key] : 0), 0) || null;
      const outputTokens = Number.isFinite(usage.output) ? usage.output : null;
      const lastPart = parts.reduce((last, part, i) => (
        part?.type === 'text' || part?.type === 'thinking' || part?.type === 'toolCall' ? i : last
      ), -1);
      let index = 0;
      for (const part of parts) {
        const suffix = `:${index++}`;
        const isLast = index - 1 === lastPart;
        if (part?.type === 'text' && typeof part.text === 'string') parentUuid = addMessage(entry, 'assistant', part.text, 'text', parentUuid, suffix, 'visible', isLast ? inputTokens : null, isLast ? outputTokens : null);
        else if (part?.type === 'thinking' && typeof part.thinking === 'string') parentUuid = addMessage(entry, 'assistant', part.thinking, 'thinking', parentUuid, suffix, 'visible', isLast ? inputTokens : null, isLast ? outputTokens : null);
        else if (part?.type === 'toolCall' && typeof part.id === 'string') {
          const uuid = addMessage(entry, 'assistant', null, 'tool_use', parentUuid, suffix, 'visible', isLast ? inputTokens : null, isLast ? outputTokens : null);
          parentUuid = uuid;
          records.push({ kind: 'tool_call', id: piId(sessionRawId, part.id), message_uuid: uuid, session_id: sessionId, name: typeof part.name === 'string' ? part.name : 'tool', input_json: truncJson(part.arguments) ?? '{}', file_path: toolFilePath(part.name, part.arguments) });
        }
      }
      continue;
    }
    if (message.role === 'toolResult') {
      const text = textParts(message.content, 'text').join('\n');
      const uuid = addMessage(entry, 'tool', text, 'tool_result', parentUuid);
      if (typeof message.toolCallId === 'string') records.push({ kind: 'tool_result', tool_use_id: piId(sessionRawId, message.toolCallId), message_uuid: uuid, session_id: sessionId, content: text, file_path: null, is_error: message.isError ? 1 : 0 });
      continue;
    }
    if (message.role === 'bashExecution') addMessage(entry, 'tool', [message.command ? `$ ${message.command}` : '', message.output, message.exitCode ? `[exit code: ${message.exitCode}]` : ''].filter(value => typeof value === 'string' && value).join('\n'), 'bash', parentUuid);
  }
  records.push({ kind: 'session', id: sessionId, title, project: projectSlugFromPath(header.cwd), started_at: startedAt, ended_at: endedAt, git_branch: null, version: typeof header.version === 'number' ? String(header.version) : null, message_count: count, countMode: 'total', jsonl_path: unit.key, source: name });
  yield* records;
  return outCursor;
}

function rawPi(rootDir: string, input: RawLookup): RawRecord | null {
  const path = input.session?.jsonl_path;
  if (typeof path !== 'string' || !path.startsWith(join(rootDir, 'sessions'))) return null;
  const match = /^pi:([^:]+):([^:]+)/.exec(input.messageUuid);
  if (!match) return null;
  const line = readFileSync(path, 'utf8').split('\n').find((value: string) => { try { return JSON.parse(value)?.id === match[2]; } catch { return false; } });
  if (!line) return null;
  return { text: line, totalLength: line.length, offset: 0, limit: line.length, hasMore: false };
}

export function createPiProvider({ rootDir = join(homedir(), '.pi', 'agent') }: { rootDir?: string } = {}): ProviderAdapter {
  return {
    name,
    descriptor: { id: name, name: 'Pi', vendor: 'Pi', defaultRoot: rootDir, color: '#7c3aed' },
    indexVersionMarker: PI_CANONICAL_TRANSCRIPT_MARKER,
    watchRoots: configuredRoot => [join(configuredRoot, 'sessions')],
    discover: ctx => discoverAt(rootDir, ctx),
    parse,
    raw: input => rawPi(rootDir, input),
  };
}

export const piProvider = createPiProvider();
