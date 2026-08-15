// Copyright (C) 2026 tommy0103 and contributors.
// Copyright (C) 2026 wutongyuonce and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

import { createContext, runInNewContext } from 'node:vm';
import { parentPort, workerData } from 'node:worker_threads';

import { DB_PATH, openDb, openReadDb, openWriterLeaseDb } from './db.ts';
import { createQueryApi, createAttuneApi } from './query.ts';
import { shouldSkipBuild } from './indexer.ts';
import { acquireWriterLease, writerLockPathFor } from './writer-lease.ts';

if (!parentPort) throw new Error('sandbox-worker must run as a worker thread');
const port = parentPort;
const keepAlive = setInterval(() => {}, 1000);

const sandbox = (api: Record<string, unknown>) => ({
  ...api, JSON, Math, Array, Object, Set, Map, Date, RegExp,
  parseInt, parseFloat, String, Number, Boolean, Error, Promise, console, setTimeout,
});

async function runScript(api: Record<string, unknown>, script: string, timeoutMs: number): Promise<unknown> {
  const context = createContext(sandbox(api));
  return runInNewContext(`(async()=>{${script}})()`, context, { timeout: timeoutMs });
}

async function runAttune(script: string, timeoutMs: number): Promise<unknown> {
  const lease = acquireWriterLease({
    lockPath: writerLockPathFor(DB_PATH),
    openDb: openWriterLeaseDb,
    waitMs: 1000,
  });
  if (!lease) throw new Error('Trajex index writer is busy; attune was not applied');

  let db: ReturnType<typeof openDb> | null = null;
  try {
    const ownershipDb = openReadDb();
    try {
      if (shouldSkipBuild(ownershipDb, { ignoreRecentBuild: true }).reason === 'daemon_active') {
        throw new Error('Trajex daemon owns index writes; attune is read-only until the daemon stops');
      }
    } finally {
      ownershipDb.close();
    }

    db = openDb();
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = await runScript(createAttuneApi(db), script, timeoutMs);
      db.exec('COMMIT');
      return result;
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch { /* worker termination also closes the connection */ }
      throw error;
    }
  } finally {
    db?.close();
    lease.release();
  }
}

async function main(): Promise<void> {
  const { mode, script, timeoutMs } = workerData as {
    mode: 'query' | 'attune';
    script: string;
    timeoutMs: number;
  };
  const result = mode === 'attune'
    ? await runAttune(script, timeoutMs)
    : await (async () => {
      const db = openReadDb();
      try { return await runScript(createQueryApi(db), script, timeoutMs); } finally { db.close(); }
    })();
  port.postMessage({ result });
}

void main().catch((error) => {
  port.postMessage({
    error: {
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    },
  });
}).finally(() => {
  clearInterval(keepAlive);
  port.close();
});
