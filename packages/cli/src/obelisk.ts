#!/usr/bin/env node

/**
 * Obelisk CLI 进程入口。
 *
 * 模块定位：全局 `obelisk` 命令的薄传输层；只负责参数分发、脚本读取和 JSON 输出，
 * 所有索引、查询、记忆及 SQLite 规则均委托给 @obelisk/core。
 *
 * 调用链路：终端 → obelisk.ts → core.ts → indexer/query/db。
 */


import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  DB_PATH,
  buildIndex,
  searchText,
  executeQuery,
  executeAttune,
} from '../../core/src/core.ts';

/**
 * 分发 CLI 参数到 Core。每个命令分支完成后立即 return，保证一次进程调用只执行
 * 一项顶层动作；错误统一序列化，方便 Agent 消费。
 */
async function main() {
  const args = process.argv.slice(2);
  // 将任意异常变为稳定 JSON，避免 CLI 与 Agent 各自猜测错误格式。
  const fail = (value: unknown): void => {
    const error = value instanceof Error ? value : new Error(String(value));
    process.stdout.write(JSON.stringify({ error: error.message, stack: error.stack }) + '\n');
    process.exitCode = 1;
  };
  const emit = (value: unknown): void => {
    process.stdout.write(JSON.stringify(value, null, 2) + '\n');
  };

  // 版本查询完全脱离索引和数据库。
  if (args[0] === '--version' || args[0] === '-v') {
    const packageJson = JSON.parse(
      readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'),
    ) as { version: string };
    process.stdout.write(`${packageJson.version}\n`);
    return;
  }
  // 强制构建会要求 Core 清理可再生索引后重放 Provider 数据。
  if (args[0] === '--build') {
    try {
      buildIndex({ force: true });
      process.stdout.write(JSON.stringify({ ok: true, db: DB_PATH }) + '\n');
    } catch (error) { fail(error); }
    return;
  }
  if (args[0] === '--search' && args[1]) {
    try { emit(searchText(args.slice(1).join(' '))); } catch (error) { fail(error); }
    return;
  }
  if (args[0] === '--query' && args[1]) {
    try { emit(await executeQuery(readFileSync(resolve(args[1]), 'utf8'))); } catch (error) { fail(error); }
    return;
  }
  if (args[0] === '--attune' && args[1]) {
    try { emit(await executeAttune(readFileSync(resolve(args[1]), 'utf8'))); } catch (error) { fail(error); }
    return;
  }
  // install 不安装数据库或 daemon，只转交官方 Skill 安装器。
  if (args[0] === 'install') {
    const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
    const child = spawnSync(
      npx,
      ['--yes', 'skills', 'add', 'tommy0103/obelisk-skill', ...args.slice(1)],
      { stdio: 'inherit', shell: process.platform === 'win32' },
    );
    if (child.error) {
      process.stderr.write(`Unable to run the skills installer: ${child.error.message}\n`);
      process.exitCode = 1;
    } else {
      process.exitCode = child.status ?? 1;
    }
    return;
  }
  process.stderr.write('Usage:\n  obelisk install [skills options]\n  obelisk --build\n  obelisk --search "text"\n  obelisk --query <file.js>\n  obelisk --attune <file.js>\n');
  process.exitCode = 1;
}

void main();
