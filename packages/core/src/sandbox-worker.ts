// Copyright (C) 2026 tommy0103 and contributors.
// Copyright (C) 2026 wutongyuonce and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

import { createContext, runInNewContext } from 'node:vm';
import { parentPort, workerData } from 'node:worker_threads';

import { openAttuneDb, openReadDb } from './db.ts';
import { createQueryApi, createAttuneApi } from './query.ts';
import { nodeSqliteTransactionAdapter } from './tx.ts';
import { runRetryableWriteTransaction } from './write-coordinator.ts';

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
  const db = openAttuneDb();
  try {
    const runMutation = <T>(work: () => T): T => runRetryableWriteTransaction(
      nodeSqliteTransactionAdapter(db), work, { label: 'attune' },
      { retryOnBeginBusy: true, budgetMs: 5000, retryDelayMs: 100, maxAttempts: 10 },
    );
    return await runScript(createAttuneApi(db, runMutation), script, timeoutMs);
  } finally {
    db.close();
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
