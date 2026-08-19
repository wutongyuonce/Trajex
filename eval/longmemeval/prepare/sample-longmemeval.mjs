#!/usr/bin/env node

/**
 * LongMemEval 评测清单生成器
 *
 * 文件定位：Trajex eval 的数据准备入口，不运行模型，只冻结本次实验使用的题目集合。
 *
 * 功能概述：
 * - 校验 LongMemEval JSON 的最小结构和 question_id 唯一性
 * - 按“问题类型 × 是否为 abstention”进行确定性分层抽样
 * - 输出不包含答案、历史正文或证据位置的 gold-free JSONL manifest
 * - 记录源文件 SHA-256，使后续结果能够追溯到具体数据版本
 *
 * 调用链路：
 *   人工/自动化命令 → main() → loadQuestions() → sample() → allocate() → JSONL manifest
 *
 * 下游消费者：
 *   LongMemEval session 转换器和各 arm runner 根据 question_id 回到受控数据层取题；
 *   被测 Agent 只接收去敏后的任务输入，不能直接读取原始 gold 字段。
 */

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

// 统一抛出可由 CLI 顶层转换为非零退出码的用户输入错误。
function fail(message) {
  throw new Error(message);
}

/**
 * 解析成对出现的 CLI 参数，并完成与采样直接相关的基础校验。
 *
 * @param {string[]} args process.argv 中脚本路径之后的参数
 * @returns {{input: string, output: string, seed: string, size: number}} 规范化后的参数
 */
function parseArgs(args) {
  const values = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i];
    const value = args[i + 1];
    if (!key?.startsWith('--') || value === undefined) fail(`Invalid argument near ${key ?? '<end>'}`);
    values[key.slice(2)] = value;
  }
  const size = Number(values.size);
  if (!values.input || !values.output || !values.seed) fail('Required: --input, --output, --size, --seed');
  if (!Number.isInteger(size) || size < 1) fail('--size must be a positive integer');
  return { ...values, size };
}

/** 计算 Buffer 或字符串的 SHA-256 十六进制摘要。 */
function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * 读取并校验 LongMemEval 数据。
 *
 * 这里只验证生成 manifest 所需的最小字段，不提前绑定完整上游 schema；
 * answer、haystack 等 gold/正文数据由后续受控转换阶段单独处理。
 *
 * @param {string} path LongMemEval JSON 文件绝对路径
 * @returns {{rows: object[], sourceSha256: string}} 数据条目和原始文件摘要
 */
function loadQuestions(path) {
  // 对原始字节计算摘要，而不是对解析后的对象计算，确保文件发生任何变化都会被发现。
  const source = readFileSync(path);
  let rows;
  try {
    rows = JSON.parse(source);
  } catch {
    fail(`Input is not valid JSON: ${path}`);
  }
  if (!Array.isArray(rows)) fail('LongMemEval input must be a JSON array');
  const ids = new Set();
  for (const [index, row] of rows.entries()) {
    if (!row || typeof row !== 'object') fail(`Item ${index} must be an object`);
    if (typeof row.question_id !== 'string' || !row.question_id) fail(`Item ${index} has no question_id`);
    if (typeof row.question_type !== 'string' || !row.question_type) fail(`Item ${index} has no question_type`);
    if (ids.has(row.question_id)) fail(`Duplicate question_id: ${row.question_id}`);
    ids.add(row.question_id);
  }
  return { rows, sourceSha256: sha256(source) };
}

/**
 * 生成分层键。
 *
 * abstention 题没有答案位置，评测意义也不同，因此不能只按 question_type 混合抽样。
 * NUL 分隔符用于避免普通题型文本与布尔值拼接后发生歧义。
 */
function stratum(row) {
  return `${row.question_type}\u0000${row.question_id.endsWith('_abs')}`;
}

/**
 * 使用 largest remainder method 将总样本数按各层原始占比分配。
 *
 * 先给每层分配比例值的整数部分，再按小数余数从大到小补齐剩余名额；
 * 余数相同时按层名排序，使结果不受 Map 插入顺序影响。
 *
 * @param {Map<string, object[]>} groups 分层后的题目
 * @param {number} size 目标样本总数
 * @param {number} total 原始题目总数
 * @returns {Map<string, number>} 每层应抽取的题数
 */
function allocate(groups, size, total) {
  const quotas = new Map();
  const ranked = [];
  let assigned = 0;

  // 第一阶段：分配不会超过比例配额的整数部分，并记录未分配的小数余量。
  for (const [key, rows] of groups) {
    const exact = rows.length * size / total;
    const base = Math.floor(exact);
    quotas.set(key, base);
    assigned += base;
    ranked.push({ key, remainder: exact - base });
  }

  // 第二阶段：将舍入后剩余的名额依次交给余数最大的层。
  ranked.sort((a, b) => b.remainder - a.remainder || a.key.localeCompare(b.key));
  for (let i = 0; i < size - assigned; i += 1) {
    const key = ranked[i].key;
    quotas.set(key, quotas.get(key) + 1);
  }
  return quotas;
}

/**
 * 在每个层内做确定性选择。
 *
 * 使用 seed 与 question_id 的摘要顺序代替运行时伪随机数：只要输入、size 和 seed
 * 不变，不同机器和 Node 进程都会选出同一批题。
 */
function sample(rows, size, seed) {
  if (size > rows.length) fail(`--size ${size} exceeds dataset size ${rows.length}`);

  // 先按评测语义分层，避免小样本意外漏掉某类问题或 abstention 题。
  const groups = new Map();
  for (const row of rows) {
    const key = stratum(row);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  const quotas = allocate(groups, size, rows.length);

  // 每层只保留配额内摘要排序最靠前的题；此处不复制任何 gold 字段。
  return [...groups].flatMap(([key, group]) => group
    .sort((a, b) => sha256(`${seed}:${a.question_id}`).localeCompare(sha256(`${seed}:${b.question_id}`)))
    .slice(0, quotas.get(key)));
}

/** CLI 主流程：解析参数、加载数据、抽样、去敏并写出 manifest。 */
function main() {
  const opts = parseArgs(process.argv.slice(2));
  const input = resolve(opts.input);
  const output = resolve(opts.output);
  const { rows, sourceSha256 } = loadQuestions(input);

  // manifest 只保留任务身份和分层信息；答案、历史正文及证据 ID 留在 grader 侧。
  const manifest = sample(rows, opts.size, opts.seed)
    .map(row => ({
      question_id: row.question_id,
      question_type: row.question_type,
      is_abstention: row.question_id.endsWith('_abs'),
      source_sha256: sourceSha256,
    }))
    .sort((a, b) => a.question_id.localeCompare(b.question_id));

  // JSONL 便于逐题流式读取、diff 和按 task ID 断点续跑。
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${manifest.map(row => JSON.stringify(row)).join('\n')}\n`);
  process.stdout.write(`${JSON.stringify({ output, selected: manifest.length, source_sha256: sourceSha256 })}\n`);
}

// 将预期的参数/数据错误收敛为简洁 stderr；保留非零退出码供自动化 runner 判断失败。
try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
