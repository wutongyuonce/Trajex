#!/usr/bin/env node

/**
 * LongMemEval 历史会话转换器。
 *
 * 输入：原始数据与已冻结的 manifest；输出：每题独立的 Pi v3 JSONL 会话目录，
 * 以及只给被测 Agent 使用、不含答案和证据标记的 agent-input.json。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';

/** 将可预期的命令行或数据问题统一为失败信息。 */
function fail(message) { throw new Error(message); }

/** 解析本脚本固定的三组 CLI 参数。 */
function args(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith('--') || value === undefined) fail(`Invalid argument near ${key ?? '<end>'}`);
    values[key.slice(2)] = value;
  }
  if (!values.input || !values.manifest || !values.output) fail('Required: --input, --manifest, --output');
  return values;
}

/** 读取一个 JSON 文件，并在格式错误时给出路径。 */
function json(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { fail(`Invalid JSON: ${path}`); }
}

/** 按行读取 manifest，保留 JSONL 可流式恢复的语义。 */
function lines(path) {
  return readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map((line, index) => {
    try { return JSON.parse(line); } catch { fail(`Invalid JSONL line ${index + 1}: ${path}`); }
  });
}

/** 限制目录和文件名为安全的官方任务 ID，避免数据字段逃逸输出目录。 */
function safeName(value, label) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) fail(`Unsafe ${label}: ${value}`);
  return value;
}

/** 将 LongMemEval 的日期正规化为 Pi 所需的 ISO 时间。 */
function date(value, label) {
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) fail(`Invalid ${label}: ${value}`);
  return new Date(timestamp).toISOString();
}

/**
 * 将一段 LongMemEval 聊天记录转换为一份最小的 Pi v3 会话。
 *
 * 每条消息按原顺序连接成父子链，末尾 leaf 声明这条链是当前可见上下文；
 * 只拷贝 role 和 content，因此 has_answer 这类 gold 标记不会进入 Agent 历史。
 */
function piSession(id, sessionDate, messages) {
  const timestamp = date(sessionDate, `date for session ${id}`);
  const entries = [{ type: 'session', version: 3, id, timestamp, cwd: '/eval/longmemeval' }];
  let parentId = null;
  for (const [index, message] of messages.entries()) {
    if (!message || !['user', 'assistant'].includes(message.role) || typeof message.content !== 'string') fail(`Invalid message ${index} in session ${id}`);
    const entryId = `message-${index + 1}`;
    entries.push({ type: 'message', id: entryId, parentId, timestamp, message: { role: message.role, content: message.content } });
    parentId = entryId;
  }
  entries.push({ type: 'leaf', id: 'leaf', parentId, targetId: parentId });
  return entries;
}

/**
 * 按 manifest 逐题生成隔离工作目录。
 *
 * agent-input.json 是 Agent 的问题；sessions/ 是 Trajex 索引根。评分答案始终
 * 留在原始输入中，不写入输出目录。
 */
function main() {
  const opts = args(process.argv.slice(2));
  const source = json(resolve(opts.input));
  if (!Array.isArray(source)) fail('LongMemEval input must be a JSON array');
  const byId = new Map(source.map(row => [row?.question_id, row]));

  let converted = 0;
  // manifest 是唯一任务选择来源，确保四个 arm 使用同一批题。
  for (const task of lines(resolve(opts.manifest))) {
    const questionId = safeName(task.question_id, 'question_id');
    const row = byId.get(questionId);
    if (!row) fail(`Question from manifest missing in input: ${questionId}`);
    if (typeof row.question !== 'string' || typeof row.question_type !== 'string' || typeof row.question_date !== 'string') fail(`Question ${questionId} is missing task fields`);
    if (!Array.isArray(row.haystack_session_ids) || !Array.isArray(row.haystack_dates) || !Array.isArray(row.haystack_sessions)
      || row.haystack_session_ids.length !== row.haystack_dates.length || row.haystack_dates.length !== row.haystack_sessions.length) fail(`Question ${questionId} has invalid session arrays`);

    const taskDir = join(resolve(opts.output), questionId);
    const sessionDir = join(taskDir, 'sessions');
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(taskDir, 'agent-input.json'), `${JSON.stringify({ question_id: questionId, question_type: row.question_type, question: row.question, question_date: row.question_date }, null, 2)}\n`);
    // 一条 LongMemEval history session 对应一个可独立被 Pi provider 发现的 JSONL 文件。
    for (let index = 0; index < row.haystack_session_ids.length; index += 1) {
      const sessionId = safeName(row.haystack_session_ids[index], `session id in ${questionId}`);
      const entries = piSession(sessionId, row.haystack_dates[index], row.haystack_sessions[index]);
      writeFileSync(join(sessionDir, `${sessionId}.jsonl`), `${entries.map(JSON.stringify).join('\n')}\n`);
    }
    converted += 1;
  }
  process.stdout.write(`${JSON.stringify({ output: resolve(opts.output), converted })}\n`);
}

// CLI 入口：保留非零退出码，使 runner 能可靠地把坏数据视为失败。
try { main(); } catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
