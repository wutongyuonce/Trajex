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

import { createContext, runInNewContext } from 'node:vm';

import { DB_PATH, openDb, openReadDb, openWriterLeaseDb } from './db.ts';
import { buildIndex, shouldSkipBuild } from './indexer.ts';
import { createQueryApi, createAttuneApi } from './query.ts';
import { acquireWriterLease, writerLockPathFor } from './writer-lease.ts';

export { buildIndex, DB_PATH };

type SandboxApi = Record<string, unknown>;

/**
 * 在受限 VM context 中运行用户的 CodeAct 脚本。
 *
 * 被谁调用：executeQuery()、executeAttune()。脚本包装成 async IIFE，因此可 await；
 * 30 秒 timeout 限制同步死循环。传入的 api 决定脚本可读还是可写记忆。
 */
/**
 * 在受限 VM context 中运行用户的 CodeAct 脚本。传入的 API 决定脚本可查询历史
 * 或变更记忆；async IIFE 支持 await，30 秒 timeout 限制同步死循环。
 */
function runInSandbox(api: SandboxApi, scriptContent: string): Promise<unknown> {
  const sandbox = {
    ...api, JSON, Math, Array, Object, Set, Map, Date, RegExp,
    parseInt, parseFloat, String, Number, Boolean, Error, Promise, console, setTimeout,
  };
  const ctx = createContext(sandbox);
  return runInNewContext(`(async()=>{${scriptContent}})()`, ctx, { timeout: 30000 });
}

/** 先尝试增量索引，再以只读连接执行 messages FTS 搜索。 */
/** 先尝试增量索引，再以只读连接执行消息 FTS 搜索。 */
export function searchText(text: string, opts?: Record<string, unknown>): unknown {
  buildIndex();
  const db = openReadDb();
  try {
    return createQueryApi(db).search(text, opts);
  } finally {
    db.close();
  }
}

/** 执行只读查询脚本；finally 确保无论脚本成功或抛错都关闭连接。 */
/** 执行只读查询脚本；finally 保证 SQLite 连接不会泄漏。 */
export async function executeQuery(scriptContent: string): Promise<unknown> {
  buildIndex();
  const db = openReadDb();
  try {
    return await runInSandbox(createQueryApi(db), scriptContent);
  } finally {
    db.close();
  }
}

/**
 * 执行 remember/forget 脚本。记忆属于持久层，先取得 writer lease，再二次检查
 * daemon heartbeat，避免 CLI 在 App 接管写入时绕过所有权规则。
 */
/**
 * 执行 remember/forget 脚本。记忆是持久层，必须取得 writer lease，并在持锁前后
 * 检查 daemon heartbeat，避免 CLI 绕过 App 的写入所有权。
 */
export async function executeAttune(scriptContent: string): Promise<unknown> {
  const build = buildIndex() as { reason?: string } | undefined;
  if (build?.reason === 'daemon_active') {
    throw new Error('Trajex daemon owns index writes; attune is read-only until the daemon stops');
  }
  if (build?.reason === 'writer_busy' || build?.reason === 'database_busy') {
    throw new Error('Trajex index writer is busy; attune was not applied');
  }
  const lease = acquireWriterLease({
    lockPath: writerLockPathFor(DB_PATH),
    openDb: openWriterLeaseDb,
    waitMs: 1000,
  });
  if (!lease) throw new Error('Trajex index writer is busy; attune was not applied');
  try {
    // 持有硬锁后再次确认 daemon 所有权，缩小两次检查之间的 TOCTOU 窗口。
    const ownershipDb = openReadDb();
    try {
      const ownership = shouldSkipBuild(ownershipDb, { ignoreRecentBuild: true });
      if (ownership.reason === 'daemon_active') {
        throw new Error('Trajex daemon owns index writes; attune is read-only until the daemon stops');
      }
    } finally {
      ownershipDb.close();
    }
    const db = openDb();
    try {
      return await runInSandbox(createAttuneApi(db), scriptContent);
    } finally {
      db.close();
    }
  } finally {
    lease.release();
  }
}
