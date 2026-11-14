// Copyright (C) 2026 tommy0103 and contributors.
// Copyright (C) 2026 wutongyuonce and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

import { parentPort } from 'node:worker_threads';
import { buildIndex, getRetentionSummary, purgeMissing, restoreSnapshot, takeSnapshot } from './indexer.ts';

if (!parentPort) throw new Error('indexer-worker must run as a worker thread');
const port = parentPort;

// 所有写操作在同一个 worker 线程里排队执行，彼此天然串行，并共用 writer lease 规则。
const OPERATIONS: Record<string, (args: any) => unknown> = {
  build: buildIndex,
  'retention-summary': getRetentionSummary,
  snapshot: takeSnapshot,
  purge: purgeMissing,
  restore: restoreSnapshot,
};

port.on('message', ({ id, op = 'build', args }: { id: number; op?: string; args?: Record<string, unknown> }) => {
  try {
    const operation = OPERATIONS[op];
    if (!operation) throw new Error(`Unknown indexer worker operation: ${op}`);
    port.postMessage({ id, result: operation(args || {}) });
  } catch (error) {
    port.postMessage({
      id,
      error: {
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      },
    });
  }
});
