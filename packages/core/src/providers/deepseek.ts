// Copyright (C) 2026 tommy0103 and contributors.
// Copyright (C) 2026 wutongyuonce and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * DeepSeek Harness（DSH）Provider adapter（见 docs/adr/0013）。
 *
 * 来源布局（`$DSH_HOME/sessions`，默认 `~/.dsh/sessions`）：
 *   <root>/--<normalized-cwd>--/<encoded-session-id>/session[.vN].jsonl[.zstd]
 * v0 为 `session.jsonl`，N≥1 为 `session.vN.jsonl`；默认 Zstandard 压缩时追加 `.zstd`。
 * DSH 迁移格式时在同目录发布更高 generation，旧文件保持不变，因此每个会话目录只读取
 * 本 adapter 支持（v0–v4）的最高 generation。更高的未知 generation 不会挡住旧版本。
 *
 * 日志首行是不可变的 session header，之后每行一个 `{type, seq, time, data}` 事件。
 * 一个 IndexUnit 是一棵根会话树：根会话加上通过 `parentSession` 归属到它的子代理/
 * fork 会话。每次变化全量重放整棵树（ADR-0002），按文件快照判断是否需要重放；
 * 子会话消息携带 agent_id 并生成 subagent 记录。被 `surfaceOp.replace` 替换的历史
 * 和 fork 继承的前缀保留为 inactive 证据，compaction 摘要作为 summary 记录。
 *
 * 纯模块：只读来源文件，不访问 Trajex SQLite。
 */
import { closeSync, openSync, readFileSync, readSync, readdirSync, type Dirent } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';

import { filePath, projectSlugFromPath, trunc, truncJson, truncToolResult } from '../parsing.ts';
import { decodeZstdFrames, scanZstdFrames, zstdDecoder } from '../vendor/dsh-zstd.ts';
import { fileSnapshot, sameSnapshot, type FileSnapshot } from './file-snapshot.ts';
import type {
  Cursor, DiscoverContext, IndexUnit, IndexedSession, MessageRecord, MessageVisibility, ProviderAdapter,
  RawLookup, RawRecord, TranscriptRecord,
} from './types.ts';

export const name = 'deepseek';
export const DEEPSEEK_CANONICAL_TRANSCRIPT_MARKER = '__deepseek_canonical_transcript_v1__';

/** DSH 规范 artifact 文件名；`session.v0.*`、`session.lock`、`*.tmp` 都不匹配。 */
export const SESSION_FILE_RE = /^session(?:\.v([1-9][0-9]*))?\.jsonl(\.zstd)?$/;
export const MIN_FORMAT_VERSION = 0;
export const MAX_FORMAT_VERSION = 4;
const CURSOR_TAG = 'dsh-tree-v1';
const HEADER_PROBE_BYTES = 64 * 1024;
const SUBAGENT_RESULT_RE = /started\s+subagent\s+(\S+)/;
const DSH_FILE_TOOLS = new Set(['read', 'edit', 'write']);

type Json = Record<string, any>;

interface Artifact {
  path: string;
  version: number;
  compressed: boolean;
}

/** 发现阶段确认可用的一个会话目录。 */
interface DiscoveredSession {
  sessionDir: string;
  artifact: Artifact;
  header: Json;
  rawId: string;
  scope: string;
  memberId: string;
}

interface MemberMeta {
  path: string;
  version: number;
  compressed: boolean;
  rawId: string;
  memberId: string;
  header: Json;
}

interface TreeMeta {
  kind: 'deepseek-tree';
  members: MemberMeta[];
}

interface TombstoneMeta {
  kind: 'deepseek-tombstone';
}

interface DshEvent {
  seq: number;
  type: string;
  time: number | null;
  data: Json;
  surfaceOp: unknown;
  line: string;
}

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// ──────────────────────────────────────────────
// 身份
// ──────────────────────────────────────────────

/** 项目作用域：同一原生 session id 在不同 cwd 下不得互相覆盖（与 Pi 的方案一致）。 */
export function deepseekProjectScope(cwd: unknown): string {
  const normalizedCwd = typeof cwd === 'string' && cwd.trim() ? normalize(cwd) : '';
  return createHash('sha256').update('deepseek-cwd-v1\0').update(normalizedCwd).digest('hex');
}

export function deepseekSessionId(rawId: string, cwd: unknown): string {
  return memberIdFor(rawId, deepseekProjectScope(cwd));
}

function memberIdFor(rawId: string, scope: string): string {
  return `deepseek:${encodeURIComponent(rawId)}:${scope}`;
}

// ──────────────────────────────────────────────
// 读取
// ──────────────────────────────────────────────

let warnedZstdUnavailable = false;
function warnZstdUnavailable(): void {
  if (warnedZstdUnavailable) return;
  warnedZstdUnavailable = true;
  process.emitWarning(
    'Compressed DeepSeek Harness sessions (*.jsonl.zstd) need Node.js 22.15 or newer; they are skipped on this runtime.',
    { code: 'TRAJEX_DSH_ZSTD_UNAVAILABLE' },
  );
}

function readPrefix(path: string, bytes: number): Buffer {
  const fd = openSync(path, 'r');
  try {
    const buffer = Buffer.allocUnsafe(bytes);
    const read = readSync(fd, buffer, 0, bytes, 0);
    return buffer.subarray(0, read);
  } finally {
    closeSync(fd);
  }
}

/** 只读取 header：原始 JSONL 取第一条以换行结束的行，压缩日志只解码第一帧。 */
function readHeaderLine(artifact: Artifact, size: number): string | null {
  if (artifact.compressed) {
    if (zstdDecoder() === null) { warnZstdUnavailable(); return null; }
    let buffer = readPrefix(artifact.path, Math.min(size, HEADER_PROBE_BYTES));
    let { frames } = scanZstdFrames(buffer, 1);
    if (frames.length === 0 && buffer.length < size) {
      buffer = readFileSync(artifact.path);
      ({ frames } = scanZstdFrames(buffer, 1));
    }
    if (frames.length === 0) return null;
    const text = decodeZstdFrames(buffer, frames)[0]!.toString('utf8');
    return text.split('\n').map(line => line.replace(/\r$/, '')).find(line => line.trim()) ?? null;
  }
  let buffer = readPrefix(artifact.path, Math.min(size, HEADER_PROBE_BYTES));
  if (!buffer.includes(0x0a) && buffer.length < size) buffer = readFileSync(artifact.path);
  const text = buffer.toString('utf8');
  let offset = 0;
  for (;;) {
    const newline = text.indexOf('\n', offset);
    // header 行尚未以换行结束时可能仍在写入，本轮不使用。
    if (newline < 0) return null;
    const line = text.slice(offset, newline).replace(/\r$/, '');
    if (line.trim()) return line;
    offset = newline + 1;
  }
}

function sessionHeader(value: unknown): Json | null {
  return isRecord(value) && value.type === 'session' && typeof value.id === 'string' && value.id ? value : null;
}

function validHeader(value: unknown, artifact: Artifact): Json | null {
  const header = sessionHeader(value);
  if (header === null) return null;
  const version = header.version === undefined ? 0 : header.version;
  return version === artifact.version ? header : null;
}

/** 按文件快照缓存 header 行的解析结果（未校验版本）。 */
const headerCache = new Map<string, { signature: string; header: Json | null }>();

function snapshotSignature(snapshot: FileSnapshot): string {
  return `${snapshot.mtimeMs}:${snapshot.size}:${snapshot.ctimeMs}:${snapshot.ino}`;
}

/** 读取 artifact 的 session header（不论版本是否受支持）；同一文件快照只解析一次。 */
function peekHeader(artifact: Artifact): Json | null {
  let snapshot: FileSnapshot;
  try { snapshot = fileSnapshot(artifact.path); } catch { return null; }
  const signature = snapshotSignature(snapshot);
  const cached = headerCache.get(artifact.path);
  if (cached?.signature === signature) return cached.header;
  let header: Json | null = null;
  try {
    const line = readHeaderLine(artifact, snapshot.size);
    if (line !== null) header = sessionHeader(JSON.parse(line));
  } catch {
    header = null;
  }
  headerCache.set(artifact.path, { signature, header });
  return header;
}

/** 可索引的 header：版本必须与文件名 generation 一致。不可读或未完成时返回 null。 */
function cachedHeader(artifact: Artifact): Json | null {
  return validHeader(peekHeader(artifact), artifact);
}

/**
 * 全量读取一个 artifact。读前读后快照必须一致；压缩日志只解码结构完整的帧，原始日志
 * 丢弃未以换行结束的尾行；无法解析的完整行跳过，不让一处损坏遮蔽后续证据。
 */
function readArtifact(artifact: Artifact): { header: Json | null; events: DshEvent[]; lines: number; snapshot: FileSnapshot } {
  const before = fileSnapshot(artifact.path);
  const buffer = readFileSync(artifact.path);
  const after = fileSnapshot(artifact.path);
  if (!sameSnapshot(before, after)) throw new Error(`DeepSeek Harness session changed while reading: ${artifact.path}`);
  let text: string;
  if (artifact.compressed) {
    const { frames } = scanZstdFrames(buffer);
    text = decodeZstdFrames(buffer, frames).map(frame => frame.toString('utf8')).join('');
  } else {
    text = buffer.toString('utf8');
  }
  const lines = text.split('\n');
  if (!text.endsWith('\n')) lines.pop();
  let header: Json | null = null;
  const events: DshEvent[] = [];
  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, '');
    if (!line.trim()) continue;
    let value: unknown;
    try { value = JSON.parse(line); } catch { continue; }
    if (header === null) {
      header = validHeader(value, artifact);
      if (header === null) break;
      continue;
    }
    if (!isRecord(value) || typeof value.type !== 'string') continue;
    events.push({
      seq: typeof value.seq === 'number' && Number.isSafeInteger(value.seq) ? value.seq : -1,
      type: value.type,
      time: typeof value.time === 'number' && Number.isFinite(value.time) ? value.time : null,
      data: isRecord(value.data) ? value.data : {},
      surfaceOp: value.surfaceOp,
      line,
    });
  }
  return { header, events, lines: lines.length, snapshot: after };
}

// ──────────────────────────────────────────────
// 发现
// ──────────────────────────────────────────────

function listDirs(path: string, known?: readonly Dirent[]): Dirent[] {
  let entries = known;
  if (!entries) {
    try { entries = readdirSync(path, { withFileTypes: true }); } catch { return []; }
  }
  return entries.filter(entry => entry.isDirectory());
}

function artifactsIn(sessionDir: string): Artifact[] {
  let names: string[];
  try { names = readdirSync(sessionDir); } catch { return []; }
  const artifacts: Artifact[] = [];
  for (const fileName of names) {
    const match = SESSION_FILE_RE.exec(fileName);
    if (!match) continue;
    artifacts.push({ path: join(sessionDir, fileName), version: match[1] ? Number(match[1]) : 0, compressed: Boolean(match[2]) });
  }
  // 最高 generation 优先；同版本时与 DSH 默认编码一致，优先压缩文件。
  return artifacts.sort((a, b) => b.version - a.version || Number(b.compressed) - Number(a.compressed));
}

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return Boolean(rel) && !rel.startsWith('..') && !isAbsolute(rel);
}

/** 有规范 artifact 却没有可读的受支持 generation 的会话目录；header 仍可读时用于判断归属。 */
interface BlockedSession {
  sessionDir: string;
  projectDir: string;
  header: Json | null;
}

/** 列出来源根下所有可用会话；有规范 artifact 但都不可用的目录记入 protectedDirs / blocked。 */
function inventory(root: string, rootEntries: readonly Dirent[]) {
  const sessions: DiscoveredSession[] = [];
  const protectedDirs = new Set<string>();
  const blocked: BlockedSession[] = [];
  const seen = new Set<string>();
  for (const project of listDirs(root, rootEntries)) {
    const projectDir = join(root, project.name);
    for (const sessionEntry of listDirs(projectDir)) {
      const sessionDir = normalize(join(projectDir, sessionEntry.name));
      const artifacts = artifactsIn(sessionDir);
      let found: DiscoveredSession | null = null;
      for (const artifact of artifacts) {
        if (artifact.version < MIN_FORMAT_VERSION || artifact.version > MAX_FORMAT_VERSION) continue;
        const header = cachedHeader(artifact);
        if (header === null) continue;
        const scope = deepseekProjectScope(header.cwd);
        found = {
          sessionDir, artifact: { ...artifact, path: normalize(artifact.path) }, header,
          rawId: header.id, scope, memberId: memberIdFor(header.id, scope),
        };
        break;
      }
      if (found === null) {
        if (artifacts.length > 0) {
          protectedDirs.add(sessionDir);
          const header = artifacts.map(peekHeader).find(value => value !== null) ?? null;
          blocked.push({ sessionDir, projectDir: normalize(projectDir), header });
        }
        continue;
      }
      // 同一作用域身份的副本只保留路径序最靠前的一份。
      if (seen.has(found.memberId)) continue;
      seen.add(found.memberId);
      sessions.push(found);
    }
  }
  return {
    sessions: sessions.sort((a, b) => a.artifact.path.localeCompare(b.artifact.path)),
    protectedDirs,
    blocked,
  };
}

/** 沿 `parentSession` 在同一项目作用域内找到最上层仍存在的祖先；防环。没有可用祖先时返回 null。 */
function ancestorRoot(
  byKey: ReadonlyMap<string, DiscoveredSession>, scope: string, parentId: unknown, start?: DiscoveredSession,
): DiscoveredSession | null {
  let root: DiscoveredSession | null = start ?? null;
  let nextParent = parentId;
  const visited = new Set<string>(start ? [start.memberId] : []);
  for (;;) {
    if (typeof nextParent !== 'string' || !nextParent) return root;
    const parent = byKey.get(`${scope}\0${nextParent}`);
    if (!parent || visited.has(parent.memberId)) return root;
    visited.add(parent.memberId);
    root = parent;
    nextParent = parent.header.parentSession;
  }
}

function groupTrees(sessions: readonly DiscoveredSession[], byKey: ReadonlyMap<string, DiscoveredSession>): DiscoveredSession[][] {
  const trees = new Map<string, DiscoveredSession[]>();
  for (const session of sessions) {
    const root = ancestorRoot(byKey, session.scope, session.header.parentSession, session)!;
    const members = trees.get(root.memberId) ?? [];
    members.push(session);
    trees.set(root.memberId, members);
  }
  return [...trees.entries()].map(([rootId, members]) => [
    ...members.filter(member => member.memberId === rootId),
    ...members.filter(member => member.memberId !== rootId),
  ]);
}

function treeSignature(members: ReadonlyArray<{ path: string; snapshot: FileSnapshot }>): string {
  const hash = createHash('sha256');
  for (const { path, snapshot } of [...members].sort((a, b) => a.path.localeCompare(b.path))) {
    hash.update(path).update('\0').update(snapshotSignature(snapshot)).update('\n');
  }
  return hash.digest('hex');
}

function cursorSignature(cursor: Cursor): string | null {
  if (!cursor) return null;
  const parts = cursor.split(':');
  return parts.length === 4 && parts[2] === CURSOR_TAG ? parts[3]! : null;
}

function discoverAt(root: string, ctx: DiscoverContext): IndexUnit[] {
  const normalizedRoot = normalize(root);
  let rootEntries: Dirent[];
  try {
    rootEntries = readdirSync(root, { withFileTypes: true });
  } catch (error) {
    ctx.reportUnavailableRoot?.({ path: root, error: error instanceof Error ? error.message : String(error) });
    return [];
  }

  const changed: string[] = [];
  let changedRoot = ctx.changedPaths === undefined;
  for (const changedPath of ctx.changedPaths ?? []) {
    const absolute = isAbsolute(changedPath) ? normalize(changedPath) : normalize(join(root, changedPath));
    if (absolute === normalizedRoot || inside(absolute, normalizedRoot)) changedRoot = true;
    else if (inside(normalizedRoot, absolute)) changed.push(absolute);
  }
  /** 某会话目录是否被本轮变更触及：变更路径位于其中，或是它的上级目录。 */
  const touched = (sessionDir: string): boolean => changedRoot || changed.some(path => (
    path === sessionDir || inside(sessionDir, path) || inside(path, sessionDir)
  ));

  const { sessions, protectedDirs, blocked } = inventory(normalizedRoot, rootEntries);
  const indexed = (ctx.indexedSessions?.() ?? []).filter(session => inside(normalizedRoot, normalize(session.jsonlPath)));
  const indexedById = new Map<string, IndexedSession[]>();
  const indexedByDir = new Map<string, IndexedSession[]>();
  for (const session of indexed) {
    indexedById.set(session.sessionId, [...(indexedById.get(session.sessionId) ?? []), session]);
    const dir = dirname(normalize(session.jsonlPath));
    indexedByDir.set(dir, [...(indexedByDir.get(dir) ?? []), session]);
  }
  const byKey = new Map(sessions.map(session => [`${session.scope}\0${session.rawId}`, session]));

  // 受保护的会话目录不能参与重放，但它可能属于某棵树：重放那棵树会把它上次的快照一并删除。
  // header 仍可读时冻结它所属的树；header 完全不可读时无法判断归属，冻结同项目目录下的树。
  // 以受保护会话为父的树同样冻结，否则子会话会被重复发布为独立根。
  const frozenRoots = new Set<string>();
  const frozenProjects = new Set<string>();
  const blockedKeys = new Set<string>();
  for (const entry of blocked) {
    if (entry.header === null) { frozenProjects.add(entry.projectDir); continue; }
    const scope = deepseekProjectScope(entry.header.cwd);
    blockedKeys.add(`${scope}\0${entry.header.id}`);
    const owner = ancestorRoot(byKey, scope, entry.header.parentSession);
    if (owner) frozenRoots.add(owner.memberId);
  }

  const liveRootIds = new Set<string>();
  const memberIds = new Set(sessions.map(session => session.memberId));
  const retracted = new Set<string>();
  const units: IndexUnit[] = [];

  for (const members of groupTrees(sessions, byKey)) {
    const rootSession = members[0]!;
    liveRootIds.add(rootSession.memberId);
    if (frozenRoots.has(rootSession.memberId)
      || blockedKeys.has(`${rootSession.scope}\0${rootSession.header.parentSession}`)
      || members.some(member => frozenProjects.has(dirname(member.sessionDir)))) continue;
    const key = rootSession.artifact.path;
    // 这棵树现在拥有的旧身份：曾作为独立根索引的成员，或同目录下已被替换的旧 session。
    const retractSessionIds = new Set<string>();
    for (const member of members) {
      for (const session of [...(indexedById.get(member.memberId) ?? []), ...(indexedByDir.get(member.sessionDir) ?? [])]) {
        if (session.sessionId !== rootSession.memberId) retractSessionIds.add(session.sessionId);
      }
    }

    let snapshots: Array<{ path: string; snapshot: FileSnapshot }>;
    try {
      snapshots = members.map(member => ({ path: member.artifact.path, snapshot: fileSnapshot(member.artifact.path) }));
    } catch {
      // 成员在枚举后消失；下一轮发现会看到一致的 inventory。
      continue;
    }
    // 每轮都按成员快照签名判断，而不是只看 watcher 提示的目录：删除或新增一个成员会改变
    // 其他成员所在树的形状。根身份尚未以自身路径索引时也必须重放。
    const indexedRoot = indexedById.get(rootSession.memberId) ?? [];
    const projectedHere = indexedRoot.some(session => normalize(session.jsonlPath) === key);
    if (retractSessionIds.size === 0 && projectedHere
      && cursorSignature(ctx.lastCursor(key)) === treeSignature(snapshots)) continue;
    for (const id of retractSessionIds) retracted.add(id);
    const project = projectSlugFromPath(rootSession.header.cwd);
    units.push({
      key,
      sessionId: rootSession.memberId,
      ...(project ? { project } : {}),
      ...(retractSessionIds.size ? { retractSessionIds: [...retractSessionIds] } : {}),
      meta: {
        kind: 'deepseek-tree',
        members: members.map(member => ({
          path: member.artifact.path,
          version: member.artifact.version,
          compressed: member.artifact.compressed,
          rawId: member.rawId,
          memberId: member.memberId,
          header: member.header,
        })),
      } satisfies TreeMeta,
    });
  }

  // 根层可读时 inventory 是权威的：已索引但不再存在的身份生成 tombstone。仍有规范
  // artifact 却暂不可读/格式未知的目录受保护，保留上次快照。
  const tombstones = indexed
    .filter(session => {
      const path = normalize(session.jsonlPath);
      return !liveRootIds.has(session.sessionId)
        && !memberIds.has(session.sessionId)
        && !retracted.has(session.sessionId)
        && !protectedDirs.has(dirname(path))
        && touched(dirname(path));
    })
    .map(session => ({
      key: normalize(session.jsonlPath),
      sessionId: session.sessionId,
      retractSessionIds: [session.sessionId],
      meta: { kind: 'deepseek-tombstone' } satisfies TombstoneMeta,
    }));

  return [...units, ...tombstones];
}

// ──────────────────────────────────────────────
// 投影
// ──────────────────────────────────────────────

function timestampOf(ms: unknown): string | null {
  return typeof ms === 'number' && Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function joinBlocks(content: unknown, type: string): string | null {
  if (!Array.isArray(content)) return null;
  const parts = content.flatMap(part => isRecord(part) && part.type === type && typeof part.text === 'string' ? [part.text] : []);
  return parts.length ? parts.join('\n') : null;
}

/** 用户内容：文本块按顺序拼接，图片/文件只保留占位说明，不落库二进制内容。 */
function userContent(content: unknown): { text: string | null; contentType: string } {
  if (!Array.isArray(content)) return { text: null, contentType: 'unknown' };
  const parts: string[] = [];
  let hasText = false;
  let hasImage = false;
  for (const part of content) {
    if (!isRecord(part)) continue;
    if (part.type === 'text' && typeof part.text === 'string') { parts.push(part.text); hasText = true; }
    else if (part.type === 'image') { parts.push(`[image ${typeof part.mimeType === 'string' ? part.mimeType : 'unknown'}]`); hasImage = true; }
    else if (part.type === 'file') parts.push(`[file ${typeof part.name === 'string' ? part.name : 'attachment'}]`);
  }
  return {
    text: parts.length ? parts.join('\n') : null,
    contentType: hasText ? 'text' : hasImage ? 'image' : parts.length ? 'file' : 'unknown',
  };
}

function toolResultText(content: unknown): string {
  if (!Array.isArray(content)) return typeof content === 'string' ? content : '';
  const parts: string[] = [];
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
    else if (block.type === 'tool-result') parts.push(toolResultText(block.content));
    else if (block.type === 'image') parts.push(`[image ${typeof block.mimeType === 'string' ? block.mimeType : 'unknown'}]`);
  }
  return parts.join('\n');
}

function summaryText(value: unknown): string | null {
  if (typeof value === 'string') return value || null;
  return joinBlocks(value, 'text');
}

/** v0–v3 的错误标记在 tool-result 包装块上，v4 提升为 tool 角色消息的 isError；data.error 在所有版本都表示失败。 */
function toolResultIsError(data: Json, message: Json, version: number): 0 | 1 {
  if (data.error !== undefined && data.error !== null) return 1;
  if (version >= 4) return message.role === 'tool' && message.isError === true ? 1 : 0;
  return Array.isArray(message.content)
    && message.content.some((block: unknown) => isRecord(block) && block.type === 'tool-result' && block.isError === true) ? 1 : 0;
}

function usageTokens(usage: unknown): { input: number | null; output: number | null } {
  if (!isRecord(usage)) return { input: null, output: null };
  let seen = false;
  let input = 0;
  for (const field of ['inputTokens', 'cacheReadTokens', 'cacheWriteTokens']) {
    const value = usage[field];
    if (typeof value === 'number' && Number.isFinite(value)) { seen = true; input += value; }
  }
  return {
    input: seen ? input : null,
    output: typeof usage.outputTokens === 'number' && Number.isFinite(usage.outputTokens) ? usage.outputTokens : null,
  };
}

function parseArguments(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return value; }
}

function toolFilePath(toolName: string, input: unknown): string | null {
  if (!isRecord(input)) return null;
  if (DSH_FILE_TOOLS.has(toolName)) {
    if (typeof input.file_path === 'string') return input.file_path;
    if (typeof input.path === 'string') return input.path;
  }
  return filePath(toolName, input);
}

function replaceRange(surfaceOp: unknown): { start: number; end: number } | null {
  if (!isRecord(surfaceOp) || surfaceOp.op !== 'replace') return null;
  const start = surfaceOp.startSeq;
  const end = surfaceOp.endSeq;
  return Number.isSafeInteger(start) && Number.isSafeInteger(end) && start <= end ? { start, end } : null;
}

/**
 * 继承前缀的长度（以 seq 计）。v2+ 的 seeded 会话以最后一个 `session/end-seed{inherited:true}`
 * 为界，标记尚未落盘时返回 null；v0/v1 使用 header.seedLength。
 */
function inheritedCut(header: Json, version: number, events: readonly DshEvent[]): number | null {
  if (version >= 2) {
    if (header.isSeeded !== true) return 0;
    let cut: number | null = null;
    for (const event of events) {
      if (event.type === 'session/end-seed' && event.data.inherited === true) cut = event.seq;
    }
    return cut;
  }
  return Number.isSafeInteger(header.seedLength) && header.seedLength > 0 ? header.seedLength : 0;
}

function* parse(unit: IndexUnit, _cursor: Cursor): Generator<TranscriptRecord, Cursor> {
  const meta = unit.meta as TreeMeta | TombstoneMeta | undefined;
  if (meta?.kind === 'deepseek-tombstone') return '0:0';
  if (meta?.kind !== 'deepseek-tree') throw new Error(`Unknown DeepSeek Harness unit: ${unit.key}`);

  const sessionId = unit.sessionId;
  const records: TranscriptRecord[] = [{ kind: 'delete-session', sessionId }];
  const messages: MessageRecord[] = [];
  const emitted = new Set<string>();
  const snapshots: Array<{ path: string; snapshot: FileSnapshot }> = [];
  const subagentParents = new Map<string, string>();
  const subagents: Array<{ agentId: string; descriptor: Json | null; startedAt: unknown; lastTime: number | null }> = [];
  let totalLines = 0;
  let title: string | null = null;
  let fallbackTitle: string | null = null;
  let endedAt: string | null = null;
  let count = 0;
  const rootMember = meta.members[0]!;
  const rootScope = deepseekProjectScope(rootMember.header.cwd);

  for (const member of meta.members) {
    const isRoot = member.memberId === sessionId;
    const artifact: Artifact = { path: member.path, version: member.version, compressed: member.compressed };
    const { header, events, lines, snapshot } = readArtifact(artifact);
    if (!header || header.id !== member.rawId || deepseekProjectScope(header.cwd) !== deepseekProjectScope(member.header.cwd)) {
      throw new Error(`DeepSeek Harness session identity changed after discovery: ${member.path}`);
    }
    snapshots.push({ path: member.path, snapshot });
    totalLines += lines;
    const agentId = isRoot ? null : member.memberId;
    const cwd = typeof header.cwd === 'string' ? header.cwd : null;
    const version = member.version;

    // 归属到父树的子会话跳过继承前缀（父会话已有同一证据）；作为根时保留为 inactive。
    // seeded 标记尚未落盘时整段跳过子会话正文，等待下一次变化重放，避免泄漏父前缀。
    const cut = inheritedCut(header, version, events);
    const skipBody = !isRoot && cut === null;
    // 作为根的 seeded 会话尚未写入结束标记时，已有事件全部属于继承前缀。
    const inheritedBefore = cut ?? Number.POSITIVE_INFINITY;
    const replaced = new Set<number>();
    for (const event of events) {
      const range = replaceRange(event.surfaceOp);
      if (!range) continue;
      for (const candidate of events) {
        if (candidate.seq >= range.start && candidate.seq <= range.end) replaced.add(candidate.seq);
      }
    }
    const visibilityOf = (seq: number): MessageVisibility => (
      replaced.has(seq) || (isRoot && seq < inheritedBefore) ? 'inactive' : 'visible'
    );

    const stepsWithToolCallParts = new Set<string>();
    const durableCallIds = new Set<string>();
    for (const event of events) {
      if (event.type === 'tool/call' && typeof event.data.callId === 'string') durableCallIds.add(event.data.callId);
      if (event.type !== 'assistant/message') continue;
      const content = isRecord(event.data.message) ? event.data.message.content : null;
      if (Array.isArray(content) && content.some(part => isRecord(part) && part.type === 'tool-call')) {
        stepsWithToolCallParts.add(`${event.data.turn}:${event.data.step}`);
      }
    }

    let parentUuid: string | null = null;
    let currentModel: string | null = null;
    let descriptor: Json | null = null;
    let lastTime: number | null = null;
    const callAnchors = new Map<string, string>();
    const callFiles = new Map<string, string | null>();
    const ptcAnchors = new Map<string, string>();
    const toolCallIds = new Set<string>();
    const memberPrefix = member.memberId;
    const callKey = (nativeCallId: string) => `${memberPrefix}:call:${encodeURIComponent(nativeCallId)}`;
    const stepAnchor = (turn: unknown, step: unknown) => `${memberPrefix}:t${turn}:s${step}:tool_use`;

    const pushMessage = (
      baseUuid: string, seq: number, time: number | null, role: string, text: string | null, contentType: string,
      fields: { isMeta?: 0 | 1; model?: string | null; input?: number | null; output?: number | null } = {},
    ): string => {
      let uuid = baseUuid;
      if (emitted.has(uuid)) uuid = `${baseUuid}#${seq}`;
      emitted.add(uuid);
      const visibility = visibilityOf(seq);
      const timestamp = timestampOf(time);
      messages.push({
        kind: 'message', uuid, session_id: sessionId, type: role, parent_uuid: parentUuid, timestamp, role,
        text: trunc(text), content_type: contentType, is_meta: fields.isMeta ?? 0, visibility,
        model: fields.model ?? null, agent_id: agentId, input_tokens: fields.input ?? null,
        output_tokens: fields.output ?? null, cwd, skill: null, source: name,
      });
      parentUuid = uuid;
      if (isRoot && visibility === 'visible' && contentType !== 'tool_use') count++;
      if (timestamp && (!endedAt || timestamp > endedAt)) endedAt = timestamp;
      return uuid;
    };
    const ensureAnchor = (anchor: string, seq: number, time: number | null) => {
      if (emitted.has(anchor)) return;
      pushMessage(anchor, seq, time, 'assistant', null, 'tool_use', { model: currentModel });
    };
    const pushToolCall = (id: string, anchor: string, toolName: string, args: unknown) => {
      if (toolCallIds.has(id)) return;
      toolCallIds.add(id);
      records.push({
        kind: 'tool_call', id, message_uuid: anchor, session_id: sessionId, name: toolName,
        input_json: truncJson(args as never) ?? '{}', file_path: toolFilePath(toolName, args),
      });
    };

    for (const event of skipBody ? [] : events) {
      if (!isRoot && event.seq < inheritedBefore) continue;
      if (event.time !== null && (lastTime === null || event.time > lastTime)) lastTime = event.time;
      const data = event.data;
      switch (event.type) {
        case 'request/header': {
          const config = isRecord(data.header) ? data.header.config : undefined;
          if (isRecord(config) && typeof config.model === 'string') currentModel = config.model;
          break;
        }
        case 'subagent/descriptor':
          descriptor = data;
          break;
        case 'session/title':
          if (isRoot && typeof data.title === 'string' && data.title.trim()) title = data.title.trim();
          break;
        case 'user/message': {
          const { text, contentType } = userContent(data.content);
          const sourceKind = isRecord(data.source) ? data.source.kind : undefined;
          const isMeta: 0 | 1 = sourceKind !== 'user' || replaceRange(event.surfaceOp) !== null ? 1 : 0;
          const nativeId = typeof data.id === 'string' && data.id ? data.id : String(event.seq);
          pushMessage(`${memberPrefix}:u${nativeId}`, event.seq, event.time, 'user', text, contentType, { isMeta });
          // 标题回退在可见性投影之前取第一条物理用户文本（与 Pi 一致），压缩不会改变会话名。
          if (isRoot && !isMeta && contentType === 'text' && text && fallbackTitle === null && event.seq >= inheritedBefore) {
            fallbackTitle = text.trim().split('\n')[0]!.slice(0, 200) || null;
          }
          break;
        }
        case 'assistant/message': {
          const message = isRecord(data.message) ? data.message : {};
          const content = message.content;
          const reasoning = joinBlocks(content, 'reasoning');
          const visible = joinBlocks(content, 'text');
          const toolParts: Json[] = Array.isArray(content)
            ? content.filter((part: unknown): part is Json => isRecord(part) && part.type === 'tool-call' && typeof part.id === 'string')
            : [];
          const model = isRecord(message.source) && typeof message.source.model === 'string' ? message.source.model : currentModel;
          const { input, output } = usageTokens(data.usage);
          // 同一 (turn, step) 在真实日志中可以重复；有原生消息 id 时以它为稳定身份。
          const base = typeof message.id === 'string' && message.id
            ? `${memberPrefix}:a${encodeURIComponent(message.id)}`
            : `${memberPrefix}:t${data.turn}:s${data.step}`;
          const anchor = toolParts.length ? `${base}:tool_use` : null;
          // 一个 step 没有可投影内容时仍产出无文本消息，避免丢失 usage。
          const needsText = visible !== null || (reasoning === null && anchor === null);
          // usage 落在该 step 的主消息：正文 > tool_use 锚点 > 思考。
          const primary = needsText ? 'text' : anchor ? 'tool_use' : 'reasoning';
          if (reasoning !== null) {
            pushMessage(`${base}:reasoning`, event.seq, event.time, 'assistant', reasoning, 'thinking',
              primary === 'reasoning' ? { model, input, output } : { model });
          }
          if (needsText) {
            pushMessage(`${base}:text`, event.seq, event.time, 'assistant', visible, visible !== null ? 'text' : 'unknown',
              primary === 'text' ? { model, input, output } : { model });
          }
          if (anchor) {
            const uuid = pushMessage(anchor, event.seq, event.time, 'assistant', null, 'tool_use',
              primary === 'tool_use' ? { model, input, output } : { model });
            for (const part of toolParts) {
              callAnchors.set(part.id, uuid);
              // 从未开始执行（没有持久 tool/call）的调用仍保留模型请求的名称与参数。
              if (!durableCallIds.has(part.id)) {
                const toolName = typeof part.name === 'string' ? part.name : 'tool';
                const args = parseArguments(part.arguments);
                callFiles.set(part.id, toolFilePath(toolName, args));
                pushToolCall(callKey(part.id), uuid, toolName, args);
              }
            }
          }
          break;
        }
        case 'tool/call': {
          const nativeCallId = typeof data.callId === 'string' && data.callId ? data.callId : null;
          if (nativeCallId === null) break;
          let anchor = callAnchors.get(nativeCallId);
          if (!anchor) {
            anchor = stepAnchor(data.turn, data.step);
            if (!stepsWithToolCallParts.has(`${data.turn}:${data.step}`)) ensureAnchor(anchor, event.seq, event.time);
            callAnchors.set(nativeCallId, anchor);
          }
          ptcAnchors.set(nativeCallId, anchor);
          const toolName = typeof data.name === 'string' ? data.name : 'tool';
          const args = parseArguments(data.arguments);
          callFiles.set(nativeCallId, toolFilePath(toolName, args));
          pushToolCall(callKey(nativeCallId), anchor, toolName, args);
          break;
        }
        case 'tool/result': {
          const message = isRecord(data.message) ? data.message : {};
          const source = isRecord(message.source) ? message.source : {};
          const nativeCallId = typeof source.callId === 'string' && source.callId ? source.callId
            : typeof message.toolCallId === 'string' && message.toolCallId ? message.toolCallId : null;
          if (nativeCallId === null) break;
          let anchor = callAnchors.get(nativeCallId);
          if (!anchor) {
            anchor = stepAnchor(data.turn, data.step);
            ensureAnchor(anchor, event.seq, event.time);
            callAnchors.set(nativeCallId, anchor);
          }
          const text = toolResultText(message.content);
          records.push({
            kind: 'tool_result', tool_use_id: callKey(nativeCallId), message_uuid: anchor, session_id: sessionId,
            content: truncToolResult(text), file_path: callFiles.get(nativeCallId) ?? null,
            is_error: toolResultIsError(data, message, version),
          });
          ptcAnchors.delete(nativeCallId);
          const spawned = SUBAGENT_RESULT_RE.exec(text);
          if (spawned?.[1]) subagentParents.set(memberIdFor(spawned[1], rootScope), callKey(nativeCallId));
          break;
        }
        // PTC/code-mode 内部调用只有 settle 事件，挂到外层调用的 tool_use 锚点上。
        case 'tool/ptc-dispatch':
        case 'tool/code-dispatch': {
          const subCallId = typeof data.subCallId === 'string' && data.subCallId ? data.subCallId : null;
          const parentCallId = typeof data.parentCallId === 'string' && data.parentCallId ? data.parentCallId : null;
          if (subCallId === null || parentCallId === null) break;
          let anchor = ptcAnchors.get(parentCallId) ?? callAnchors.get(parentCallId);
          if (!anchor) {
            anchor = `${memberPrefix}:ptc:${encodeURIComponent(parentCallId)}`;
            ensureAnchor(anchor, event.seq, event.time);
          }
          ptcAnchors.set(subCallId, anchor);
          const toolName = typeof data.name === 'string' ? data.name : 'tool';
          const id = callKey(subCallId);
          pushToolCall(id, anchor, toolName, data.arguments);
          records.push({
            kind: 'tool_result', tool_use_id: id, message_uuid: anchor, session_id: sessionId,
            content: truncToolResult(toolResultText(data.content)), file_path: toolFilePath(toolName, data.arguments),
            is_error: data.isError === true || (data.error !== undefined && data.error !== null) ? 1 : 0,
          });
          break;
        }
        case 'compaction/summary': {
          const content = summaryText(data.summary);
          if (content === null) break;
          const id = typeof data.compactionId === 'string' && data.compactionId ? data.compactionId : String(event.seq);
          records.push({
            kind: 'summary', id: `${memberPrefix}:compaction:${encodeURIComponent(id)}:${event.seq}`, session_id: sessionId,
            agent_id: agentId, timestamp: timestampOf(event.time), source: 'compaction', content,
            visibility: visibilityOf(event.seq), input_tokens: null, output_tokens: null,
          });
          break;
        }
        default:
          break;
      }
    }

    if (!isRoot) subagents.push({ agentId: member.memberId, descriptor, startedAt: header.createdAt, lastTime });
  }

  for (const child of subagents) {
    const descriptor = child.descriptor ?? {};
    const agentType = [descriptor.agentProvider, descriptor.agentModel, descriptor.provider]
      .find(value => typeof value === 'string' && value) ?? null;
    const started = typeof child.startedAt === 'number' ? child.startedAt : null;
    records.push({
      kind: 'subagent', agent_id: child.agentId, session_id: sessionId,
      parent_tool_use_id: subagentParents.get(child.agentId) ?? null,
      agent_type: agentType,
      description: typeof descriptor.label === 'string' ? descriptor.label : null,
      duration_ms: started !== null && child.lastTime !== null ? Math.max(0, child.lastTime - started) : null,
      total_tokens: null,
    });
  }

  const rootHeader = rootMember.header;
  records.push({
    kind: 'session', id: sessionId, title: title ?? fallbackTitle,
    project: projectSlugFromPath(typeof rootHeader.cwd === 'string' ? rootHeader.cwd : null),
    started_at: timestampOf(rootHeader.createdAt), ended_at: endedAt, git_branch: null,
    version: String(rootMember.version), message_count: count, countMode: 'total',
    jsonl_path: unit.key, source: name,
  });
  yield* records;
  yield* messages;
  const maxMtime = Math.max(...snapshots.map(entry => entry.snapshot.mtimeMs));
  return `${maxMtime}:${totalLines}:${CURSOR_TAG}:${treeSignature(snapshots)}`;
}

// ──────────────────────────────────────────────
// raw lookup
// ──────────────────────────────────────────────

const MEMBER_PREFIX_RE = /^(deepseek:[^:]+:[0-9a-f]{64}):(.+)$/;

function findMemberArtifact(root: string, memberId: string): Artifact | null {
  let rootEntries: Dirent[];
  try { rootEntries = readdirSync(root, { withFileTypes: true }); } catch { return null; }
  const { sessions } = inventory(normalize(root), rootEntries);
  return sessions.find(session => session.memberId === memberId)?.artifact ?? null;
}

function rawDeepseek(root: string, input: RawLookup): RawRecord | null {
  try {
    const match = MEMBER_PREFIX_RE.exec(input.messageUuid);
    if (!match) return null;
    const memberId = match[1]!;
    const duplicate = /#(-?\d+)$/.exec(match[2]!);
    const location = duplicate ? match[2]!.slice(0, duplicate.index) : match[2]!;
    const seqMatches = (candidate: DshEvent) => !duplicate || candidate.seq === Number(duplicate[1]);
    const sessionPath = typeof input.session?.jsonl_path === 'string' ? normalize(input.session.jsonl_path) : null;
    let artifact: Artifact | null = null;
    if (sessionPath && input.session?.id === memberId && inside(normalize(root), sessionPath)) {
      const fileMatch = SESSION_FILE_RE.exec(sessionPath.slice(sessionPath.lastIndexOf(sep) + 1));
      if (fileMatch) artifact = { path: sessionPath, version: fileMatch[1] ? Number(fileMatch[1]) : 0, compressed: Boolean(fileMatch[2]) };
    }
    artifact ??= findMemberArtifact(root, memberId);
    if (!artifact || !inside(normalize(root), normalize(artifact.path))) return null;
    const { header, events } = readArtifact(artifact);
    if (!header || memberIdFor(header.id, deepseekProjectScope(header.cwd)) !== memberId) return null;

    let event: DshEvent | undefined;
    let messageText: string | null = null;
    const user = /^u(.+)$/.exec(location);
    const assistant = /^t([^:]+):s([^:]+):(reasoning|text|tool_use)$/.exec(location);
    const assistantById = /^a([^:]+):(reasoning|text|tool_use)$/.exec(location);
    if (assistantById) {
      const nativeId = decodeURIComponent(assistantById[1]!);
      event = events.find(candidate => candidate.type === 'assistant/message' && seqMatches(candidate)
        && isRecord(candidate.data.message) && candidate.data.message.id === nativeId);
      if (event) {
        const content = (event.data.message as Json).content;
        messageText = assistantById[2] === 'reasoning' ? joinBlocks(content, 'reasoning')
          : assistantById[2] === 'text' ? joinBlocks(content, 'text') : null;
      }
    } else if (user) {
      const nativeId = user[1]!;
      event = events.find(candidate => candidate.type === 'user/message' && seqMatches(candidate)
        && (candidate.data.id === nativeId || String(candidate.seq) === nativeId));
      if (event) messageText = userContent(event.data.content).text;
    } else if (assistant) {
      event = events.find(candidate => candidate.type === 'assistant/message' && seqMatches(candidate)
        && String(candidate.data.turn) === assistant[1] && String(candidate.data.step) === assistant[2]);
      if (event) {
        const content = isRecord(event.data.message) ? event.data.message.content : null;
        messageText = assistant[3] === 'reasoning' ? joinBlocks(content, 'reasoning')
          : assistant[3] === 'text' ? joinBlocks(content, 'text') : null;
      } else if (assistant[3] === 'tool_use') {
        event = events.find(candidate => candidate.type === 'tool/call'
          && String(candidate.data.turn) === assistant[1] && String(candidate.data.step) === assistant[2]);
      }
    }
    if (!event) return null;
    const text = event.line;
    return { text, totalLength: text.length, offset: 0, limit: text.length, hasMore: false, messageText };
  } catch {
    return null;
  }
}

// ──────────────────────────────────────────────
// 装配
// ──────────────────────────────────────────────

/**
 * 与 DSH 的 resolveDshHome() 一致：`$DSH_HOME` 为空或仅空白时回退 `~/.dsh`；只展开
 * 单独的 `~` 以及 `~/`、`~\` 前缀，其余按字面量并相对 cwd 解析，最后追加 `sessions`。
 */
export function deepseekSessionsRoot(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.DSH_HOME;
  const home = configured !== undefined && configured.trim().length > 0 ? configured : join(homedir(), '.dsh');
  const expanded = home === '~' ? homedir()
    : home.startsWith('~/') || home.startsWith('~\\') ? join(homedir(), home.slice(2))
      : home;
  return join(resolve(expanded), 'sessions');
}

export function createDeepseekProvider({ rootDir = deepseekSessionsRoot() }: { rootDir?: string } = {}): ProviderAdapter {
  return {
    name,
    descriptor: { id: name, name: 'DeepSeek Harness', vendor: 'DeepSeek', defaultRoot: rootDir, color: '#4d6bfe' },
    indexVersionMarker: DEEPSEEK_CANONICAL_TRANSCRIPT_MARKER,
    watchTargets: () => [{ kind: 'tree', path: rootDir }],
    discover: ctx => discoverAt(rootDir, ctx),
    parse,
    raw: input => rawDeepseek(rootDir, input),
  };
}

export { parse };
