// Copyright (C) 2026 tommy0103 and contributors.
// Copyright (C) 2026 wutongyuonce and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Core 公共门面。
 *
 * 模块定位：CLI、桌面 App 与未来 transport 共用的业务入口。调用方只选择搜索、
 * 查询、attune 或索引，不重复拥有数据库生命周期和检索语义。
 *
 * 调用链路：CLI/App → core.ts → indexer、query、writer lease、db。
 */
// Trajex Core package (see docs/adr/0003-core-typescript-esm-precompiled.md).
//
// The single shared implementation behind every transport. The CLI and later
// the MCP server are thin shells over these four functions;
// none of them re-implement retrieval or own the DB lifecycle.
//
// Authored in TypeScript with erasable-only syntax so Node can run it directly
// via type stripping in development, while the CLI package ships readable,
// non-bundled tsc output. Core source lives in the @trajex/core workspace.

import { Worker } from 'node:worker_threads';

import { DB_PATH, openReadDb } from './db.ts';
import { buildIndex, ensureReadableSchema } from './indexer.ts';
import { createQueryApi } from './query.ts';

export { buildIndex, DB_PATH };

const SANDBOX_TIMEOUT_MS = 30000;

function assertReadableSchema(): void {
  const schema = ensureReadableSchema();
  if (!schema.ready) {
    throw new Error(`Trajex index schema upgrade is blocked by ${schema.reason ?? 'an unknown writer'}`);
  }
}

/** 被动刷新可以跳过数据扫描，但任何读取都必须先确认当前 schema 可读。 */
function refreshQueryIndex(): void {
  assertReadableSchema();
  buildIndex();
}

function runInSandboxWorker(mode: 'query' | 'attune', script: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL(
      import.meta.url.endsWith('.js') ? './sandbox-worker.js' : './sandbox-worker.ts',
      import.meta.url,
    ), {
      workerData: { mode, script, timeoutMs: SANDBOX_TIMEOUT_MS },
    });
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };
    const timer = setTimeout(() => {
      finish(() => {
        void worker.terminate();
        reject(new Error(`Sandbox execution timed out after ${SANDBOX_TIMEOUT_MS}ms`));
      });
    }, SANDBOX_TIMEOUT_MS);
    worker.once('message', (message: { result?: unknown; error?: { message: string; stack?: string } }) => {
      finish(() => {
        if (message.error) {
          const error = new Error(message.error.message);
          error.stack = message.error.stack;
          reject(error);
        } else {
          resolve(message.result);
        }
      });
    });
    worker.once('error', (error) => finish(() => reject(error)));
    worker.once('exit', (code) => {
      if (!settled) finish(() => reject(new Error(`Sandbox worker exited with code ${code}`)));
    });
  });
}

/** 先尝试增量索引，再以只读连接执行消息 FTS 搜索。 */
export function searchText(text: string, opts?: Record<string, unknown>): unknown {
  refreshQueryIndex();
  const db = openReadDb();
  try {
    return createQueryApi(db).search(text, opts);
  } finally {
    db.close();
  }
}

/** 执行只读查询脚本；worker 持有并关闭查询连接，超时时随 worker 一起回收。 */
export async function executeQuery(scriptContent: string): Promise<unknown> {
  refreshQueryIndex();
  return runInSandboxWorker('query', scriptContent);
}

/**
 * 执行 remember/forget 脚本。记忆属于持久层：先取得 writer lease，并在持锁前后
 * 二次检查 daemon heartbeat，避免 CLI 在 App 接管写入时绕过所有权规则。
 */
export async function executeAttune(scriptContent: string): Promise<unknown> {
  assertReadableSchema();
  const build = buildIndex() as { reason?: string } | undefined;
  if (build?.reason === 'daemon_active') {
    throw new Error('Trajex daemon owns index writes; attune is read-only until the daemon stops');
  }
  if (build?.reason === 'writer_busy' || build?.reason === 'database_busy') {
    throw new Error('Trajex index writer is busy; attune was not applied');
  }
  return runInSandboxWorker('attune', scriptContent);
}
