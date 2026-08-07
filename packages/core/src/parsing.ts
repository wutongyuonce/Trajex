/**
 * 原始日志解析公共辅助模块。
 *
 * 模块定位：Provider 可共享的纯文件/文本/路径函数集合。它不依赖 SQLite，因而
 * CLI 与桌面 App 均可复用；Provider adapter 在其上实现各自的日志语义。
 *
 * 函数分类导览（按归属分区，见下方区块标题）：
 *   1. 跨 Provider 共享 —— 无前缀、不绑定线协议格式，claude / codex / pi 通用
 *   2. Claude 专用 —— 绑定 Claude JSONL 的 content 块结构、工具名与目录布局
 *   3. Codex 专用 —— 前缀 codex，绑定 Codex rollout 的 thread / meta / payload 语义
 *   4. 索引收尾层 —— inferProjectPath，被 buildIndex 收尾回填 project_path，非 Provider 内调用
 */
// Core's pure parse/discover helpers — node:sqlite-free by construction, so the compiled
// providers can be consumed by the app (better-sqlite3 / a Node without
// node:sqlite). Originally extracted verbatim from db/indexer; it now exposes a
// typed seam while remaining limited to node:fs/path/os.
import { closeSync, existsSync, openSync, readSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, normalize } from 'node:path';
import { StringDecoder } from 'node:string_decoder';

const CLAUDE_DIR = join(homedir(), '.claude');
const CODEX_DIR = join(homedir(), '.codex');
const PROJECTS_DIR = join(CLAUDE_DIR, 'projects');
const CODEX_SESSIONS_DIR = join(CODEX_DIR, 'sessions');
const TEXT_LIMIT = 10000;

type JsonRecord = Record<string, any>;
type JsonValue = any;

/** Claude transcript 文件元数据（Claude 专用）。 */
export interface ClaudeJsonlFile {
  path: string;
  sessionId: string;
  project: string;
  isSubagent: boolean;
  agentId?: string;
  workflowRunId?: string;
  source?: 'claude';
}

/** Codex rollout 文件元数据（Codex 专用）。 */
export interface CodexJsonlFile {
  path: string;
  source: 'codex';
}

/** Codex 逐行解析记录（Codex 专用，供 guardian 判定使用）。 */
interface CodexLineRecord {
  lineNum: number;
  obj: JsonRecord;
}

// ================= 跨 Provider 共享 =================
// 无前缀、不绑定线协议格式：claude / codex / pi 通用。

/** 截断超长字符串到 TEXT_LIMIT，避免把超长消息整体写入索引。 */
function trunc(s: any): any {
  return typeof s === 'string' && s.length > TEXT_LIMIT ? s.slice(0, TEXT_LIMIT) : s;
}

/** 递归截断 JSON 中所有超长字符串再序列化；存储工具入参/输出前的统一处理。 */
function truncJson(obj: JsonValue, limit = TEXT_LIMIT): string | null {
  if (obj === null || obj === undefined) return null;
  const walk = (v: JsonValue): JsonValue => {
    if (typeof v === 'string') return v.length > limit ? v.slice(0, limit) + '...[truncated]' : v;
    if (Array.isArray(v)) return v.map(walk);
    if (typeof v === 'object' && v !== null) {
      const out: JsonRecord = {};
      for (const [k, val] of Object.entries(v)) out[k] = walk(val);
      return out;
    }
    return v;
  };
  return JSON.stringify(walk(obj));
}

/** 目录存在性判断；stat 抛错一律视为不存在。 */
function isDir(p: string): boolean { try { return statSync(p).isDirectory(); } catch { return false; } }

/**
 * 以固定大小 buffer 流式读取文本行。JSONL Provider 使用它避免把大历史文件一次性
 * 载入内存；callback 返回 false 可在已找到目标证据时提前停止。
 */
function readLines(filePath: string, callback: (line: string) => boolean | void): void {
  const fd = openSync(filePath, 'r');
  const bufSize = 64 * 1024;
  const buf = Buffer.alloc(bufSize);
  // UTF-8 字符可能跨越两个 buffer；保留不完整的尾部字节，避免出现 replacement character。
  const decoder = new StringDecoder('utf8');
  let remainder = '';
  let bytesRead;
  try {
    while ((bytesRead = readSync(fd, buf, 0, bufSize, null)) > 0) {
      const chunk = remainder + decoder.write(buf.subarray(0, bytesRead));
      const lines = chunk.split('\n');
      remainder = lines.pop() ?? '';
      for (const line of lines) {
        if (line && callback(line) === false) return;
      }
    }
    const tail = remainder + decoder.end();
    if (tail) callback(tail);
  } finally {
    closeSync(fd);
  }
}

/** 校验并规范化观察到的绝对 cwd；非绝对路径返回 null。 */
function normalizeObservedCwd(cwd: unknown): string | null {
  if (typeof cwd !== 'string' || !cwd.trim() || !isAbsolute(cwd)) return null;
  return normalize(cwd);
}

/** 绝对路径 → slug 的逆变换，供需要把项目路径写回日志标记的场合使用。 */
function projectSlugFromPath(projectPath: string | null): string | null {
  const normalized = normalizeObservedCwd(projectPath);
  if (!normalized) return null;
  return '-' + normalized.replace(/^[\\/]+/, '').replace(/[\\/]+/g, '-');
}

// ---- 隐藏/meta 判定三件套：claude 与 codex 共用同一组正则与谓词 ----
const COMMAND_ENVELOPE_RE = /^\s*(<command-name>[^<]+<\/command-name>|<(?:task-notification|system-reminder)\b|<local-command(?:\b|-))/;
const SKILL_INSTRUCTIONS_RE = /^(?:\s*Base directory for this skill(?:\s*:|\s*\r?\n)|\s*<skill>\s*<name>[^<]+<\/name>\s*<path>\/[^<]*\/SKILL\.md<\/path>|\s*(?:[\w.-]+\s+)?\/[\s\S]*?\/SKILL\.md\s+---\s+name:\s*[\w.-]+\s+description:)/i;

/** 判断消息是否应标记为 meta：显式 isMeta 字段，或文本命中命令信封。 */
function extractMessageIsMeta(record: JsonRecord, text: string | null = extractText(record?.message?.content)): 0 | 1 {
  const msg = record?.message || {};
  if (record?.isMeta === true || msg.isMeta === true) return 1;
  return typeof text === 'string' && COMMAND_ENVELOPE_RE.test(text) ? 1 : 0;
}

/** 文本是否为 skill 指令注入（这类系统注入会标记 is_meta 并折叠为 System 卡片）。 */
function isSkillInstructions(text: unknown): boolean {
  return typeof text === 'string' && SKILL_INSTRUCTIONS_RE.test(text);
}

// ================= Claude 专用 =================
// 绑定 Claude JSONL 的 content 块结构、工具名与项目目录布局；仅 claude.ts 使用。

/** 从 content block 数组提取 text/thinking 纯文本；字符串直接截断返回，无内容返回 null。 */
function extractText(content: JsonValue): string | null {
  if (typeof content === 'string') return trunc(content);
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const b of content) {
    if (b.type === 'text' && b.text) parts.push(b.text);
    else if (b.type === 'thinking' && b.thinking) parts.push(b.thinking);
  }
  return parts.length ? trunc(parts.join('\n')) : null;
}

/** 归约 content 块类型：唯一类型时返回该类型，混合或含未知块返回 'unknown'。 */
function extractContentType(content: JsonValue): string {
  if (typeof content === 'string') return 'text';
  if (!Array.isArray(content) || !content.length) return 'unknown';
  const types = new Set<string>();
  let sawUnknown = false;
  for (const b of content) {
    if (!b || typeof b !== 'object') { sawUnknown = true; continue; }
    if (b.type === 'text') types.add('text');
    else if (b.type === 'thinking') types.add('thinking');
    else if (b.type === 'tool_use') types.add('tool_use');
    else if (b.type === 'tool_result') types.add('tool_result');
    else sawUnknown = true;
  }
  return !sawUnknown && types.size === 1 ? [...types][0] : 'unknown';
}

/** 文件编辑类工具的 input 中提取 file_path，供 tool_calls 关联真实文件。 */
function filePath(name: string, input: JsonRecord | null | undefined): string | null {
  if (!input) return null;
  return ['Read', 'Edit', 'Write', 'NotebookEdit'].includes(name) ? (input.file_path || null) : null;
}

/** Claude project slug（'a-b-c'）近似还原为 '/a/b/c'，仅作无证据时的兜底。 */
function legacyProjectPathFromSlug(project: string | null | undefined): string | null {
  if (!project) return null;
  return '/' + project.replace(/-/g, '/').replace(/^\//, '');
}

/** 枚举 Claude 主会话、subagent 与 workflow-agent JSONL 的文件级元数据。 */
function discoverJsonlFiles(projectsDir = PROJECTS_DIR): ClaudeJsonlFile[] {
  const files: ClaudeJsonlFile[] = [];
  if (!existsSync(projectsDir)) return files;
  let projects;
  try { projects = readdirSync(projectsDir); } catch (e) { process.stderr.write(`Warning: cannot read projects dir: ${e instanceof Error ? e.message : String(e)}\n`); return files; }
  for (const proj of projects) {
    const projPath = join(projectsDir, proj);
    if (!isDir(projPath)) continue;
    let entries;
    try { entries = readdirSync(projPath); } catch { continue; }
    for (const f of entries) {
      if (f.endsWith('.jsonl'))
        files.push({ path: join(projPath, f), sessionId: f.slice(0, -6), project: proj, isSubagent: false });
    }
    for (const sd of entries) {
      const saDir = join(projPath, sd, 'subagents');
      if (!isDir(saDir)) continue;
      let saEntries;
      try { saEntries = readdirSync(saDir); } catch { continue; }
      for (const sf of saEntries) {
        if (sf.endsWith('.jsonl'))
          files.push({ path: join(saDir, sf), sessionId: sd, project: proj, isSubagent: true, agentId: sf.slice(0, -6) });
      }
      const wfRoot = join(saDir, 'workflows');
      if (!isDir(wfRoot)) continue;
      let wfDirs;
      try { wfDirs = readdirSync(wfRoot); } catch { continue; }
      for (const wfDir of wfDirs) {
        const wfPath = join(wfRoot, wfDir);
        if (!isDir(wfPath)) continue;
      let wfEntries;
        try { wfEntries = readdirSync(wfPath); } catch { continue; }
      for (const wf of wfEntries) {
        if (wf === 'journal.jsonl') continue;
        if (wf.endsWith('.jsonl'))
          files.push({ path: join(wfPath, wf), sessionId: sd, project: proj, isSubagent: true, agentId: wf.slice(0, -6), workflowRunId: wfDir });
      }
      }
    }
  }
  return files;
}

// ================= 索引收尾层（非 Provider） =================
// 被 buildIndex 的 refreshSessionProjectPaths() 调用，汇总各 provider 的 cwd 证据。

/**
 * 从消息中实际观察到的绝对 cwd 推导项目路径，按出现次数取最可信值；无证据时
 * 才退回旧版 project slug 的近似还原。
 */
function inferProjectPath(project: string | null | undefined, observedCwds: unknown[] = []): string | null {
  const byPath = new Map<string, { path: string; count: number; first: number }>();
  for (const cwd of observedCwds) {
    const normalized = normalizeObservedCwd(cwd);
    if (!normalized) continue;
    const current = byPath.get(normalized) || { path: normalized, count: 0, first: byPath.size };
    current.count++;
    byPath.set(normalized, current);
  }
  const best = [...byPath.values()].sort((a, b) => b.count - a.count || a.first - b.first)[0];
  return best?.path || legacyProjectPathFromSlug(project);
}

// ================= Codex 专用 =================
// 前缀 codex，绑定 Codex rollout 的 thread / meta / payload 语义；仅 codex.ts 使用。

/** 递归枚举 Codex 按日期分层保存的 rollout JSONL。 */
function discoverCodexJsonlFiles(sessionsDir = CODEX_SESSIONS_DIR): CodexJsonlFile[] {
  const files: CodexJsonlFile[] = [];
  if (!existsSync(sessionsDir)) return files;
  const walk = (dir: string): void => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const fp = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fp);
      } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        files.push({ path: fp, source: 'codex' });
      }
    }
  };
  walk(sessionsDir);
  return files;
}

/** 规范化 Codex id 为带 'codex:' 前缀的内部主键（幂等）。 */
function codexDbId(id: unknown): string | null {
  if (!id) return null;
  const raw = String(id).replace(/^codex:/, '');
  return `codex:${raw}`;
}

/** 去掉 'codex:' 前缀，还原原始 id。 */
function codexRawId(id: unknown): string | null {
  return id ? String(id).replace(/^codex:/, '') : null;
}

/** 由 thread id + 行号生成稳定的 message uuid（跨增量解析保持一致）。 */
function codexLineUuid(threadId: unknown, lineNum: number): string {
  return `codex:${codexRawId(threadId)}:${String(lineNum).padStart(6, '0')}`;
}

/** 由 thread id + tool call id 生成稳定的 call 主键。 */
function codexCallId(threadId: unknown, callId: unknown): string | null {
  if (!threadId || !callId) return null;
  return `codex:${codexRawId(threadId)}:${String(callId).replace(/^codex:/, '')}`;
}

/** 从 meta 提取父线程 id：subagent spawn 或 fork 场景。 */
function codexParentThreadId(meta: JsonRecord): string | null {
  const subagent = meta?.source?.subagent;
  return meta?.parent_thread_id
    || subagent?.thread_spawn?.parent_thread_id
    || meta?.forked_from_id
    || subagent?.parent_thread_id
    || null;
}

/** 判断 Codex rollout 是否为不应独立索引的 child/fork/subagent thread。 */
function codexIsChildThread(meta: JsonRecord): boolean {
  return meta?.thread_source === 'subagent'
    || meta?.source?.subagent != null
    || codexParentThreadId(meta) !== null;
}

/** 判断是否为 guardian/auto-review 线程（其消息不应在详情中展示）。 */
function codexIsGuardianThread(meta: JsonRecord, records: CodexLineRecord[] = []): boolean {
  const subagent = meta?.source?.subagent;
  if (subagent?.other === 'guardian') return true;
  if (meta?.thread_source !== 'subagent') return false;
  return records.some(({ obj }) => obj?.payload?.model === 'codex-auto-review' || obj?.model === 'codex-auto-review');
}

/** 字符串先 JSON.parse 成对象；解析失败或非字符串则保持原值。 */
function parseCodexJsonInput(value: JsonValue): JsonValue {
  if (value === null || value === undefined || value === '') return {};
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return value; }
}

/** 从 payload 的多种 usage 字段位置提取 token 用量。 */
interface CodexUsage {
  inputTokens: number | null;
  outputTokens: number | null;
}

function codexUsage(payload: JsonRecord): CodexUsage {
  const usage = payload?.info?.last_token_usage || payload?.info?.total_token_usage || payload?.last_token_usage || null;
  if (!usage) return { inputTokens: null, outputTokens: null };
  return {
    inputTokens: typeof usage.input_tokens === 'number' && Number.isFinite(usage.input_tokens)
      ? usage.input_tokens
      : null,
    outputTokens: typeof usage.output_tokens === 'number' && Number.isFinite(usage.output_tokens)
      ? usage.output_tokens
      : null,
  };
}

/** 删除 Codex 为附件生成的图片标记，保留可见文字用于消息去重。 */
function stripCodexImageMarkers(text: string): string {
  return text
    .replace(/<image\b[^>]*>\s*/gi, '')
    .replace(/\s*<\/image>/gi, '')
    .trim();
}

/** 提取事件级文本：message 字符串、text_elements 或 text 字段。 */
function codexEventText(payload: JsonRecord): string | null {
  if (typeof payload?.message === 'string') return stripCodexImageMarkers(payload.message);
  if (Array.isArray(payload?.text_elements) && payload.text_elements.length) {
    const parts = payload.text_elements.map((item: JsonValue) => typeof item === 'string' ? item : item?.text).filter(Boolean);
    if (parts.length) return stripCodexImageMarkers(parts.join('\n'));
  }
  if (typeof payload?.text === 'string') return stripCodexImageMarkers(payload.text);
  return null;
}

/** 提取消息级文本，跳过被 <image>...</image> 包裹的图片占位段。 */
function codexMessagePayloadText(payload: JsonRecord): string | null {
  if (!Array.isArray(payload?.content)) return null;
  const parts: string[] = [];
  for (let index = 0; index < payload.content.length; index++) {
    const block = payload.content[index];
    const image = payload.content[index + 1];
    const close = payload.content[index + 2];
    if (
      block?.type === 'input_text'
      && typeof block.text === 'string'
      && block.text.trim() === '<image>'
      && image?.type === 'input_image'
      && close?.type === 'input_text'
      && typeof close.text === 'string'
      && close.text.trim() === '</image>'
    ) {
      index += 2;
      continue;
    }
    if (typeof block?.text === 'string') parts.push(block.text);
  }
  return parts.length ? stripCodexImageMarkers(parts.join('\n')) : null;
}

/** 生成 (role, text) 复合键，用于可见消息去重。 */
function codexVisibleMessageKey(role: unknown, text: unknown): string {
  return `${role || ''}\u0000${text || ''}`;
}

/** 按工具调用类型取入参：custom_tool_call / tool_search_call / web_search_call / arguments。 */
function codexToolInput(payload: JsonRecord): JsonValue {
  if (payload?.type === 'custom_tool_call') return parseCodexJsonInput(payload.input);
  if (payload?.type === 'tool_search_call') return parseCodexJsonInput(payload.arguments);
  if (payload?.type === 'web_search_call') return { action: payload.action || null };
  return parseCodexJsonInput(payload?.arguments);
}

/** 取工具输出：优先 output 字符串，其次序列化 output/tools/execution。 */
function codexToolOutput(payload: JsonRecord): string | null {
  if (typeof payload?.output === 'string') return payload.output;
  if (payload?.output !== undefined) return JSON.stringify(payload.output);
  if (payload?.tools !== undefined) return JSON.stringify(payload.tools);
  if (payload?.execution !== undefined) return JSON.stringify(payload.execution);
  return null;
}

export {
  CLAUDE_DIR, CODEX_DIR, PROJECTS_DIR, CODEX_SESSIONS_DIR, TEXT_LIMIT,
  trunc, truncJson, extractText, extractContentType, extractMessageIsMeta, isSkillInstructions, filePath, isDir, readLines,
  legacyProjectPathFromSlug, normalizeObservedCwd, projectSlugFromPath, inferProjectPath,
  discoverJsonlFiles, discoverCodexJsonlFiles,
  codexDbId, codexRawId, codexLineUuid, codexCallId, codexParentThreadId, codexIsChildThread, codexIsGuardianThread,
  parseCodexJsonInput,
  codexUsage, codexEventText, codexMessagePayloadText, codexVisibleMessageKey, codexToolInput, codexToolOutput,
};
