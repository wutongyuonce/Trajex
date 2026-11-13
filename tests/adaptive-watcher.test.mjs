// Copyright (C) 2026 tommy0103 and contributors.
// Copyright (C) 2026 wutongyuonce and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { makeTempDir } from './temp-dirs.mjs';

import { createAdaptiveWatcher } from '../packages/adaptive-watcher/src/index.ts';

async function waitFor(cond, ms = 2000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return cond();
}

function manualTimers() {
  const pending = new Set();
  return {
    setTimeout(fn) { pending.add(fn); return fn; },
    clearTimeout(fn) { pending.delete(fn); },
    flush() {
      const timers = [...pending];
      pending.clear();
      for (const timer of timers) timer();
    },
  };
}

test('adaptive watcher polls exact files and keeps only the newest hot file', async () => {
  const timers = manualTimers();
  const signatures = new Map();
  const invalidations = [];
  const watcher = createAdaptiveWatcher({
    targets: [{ kind: 'file', path: 'index.jsonl' }],
    onInvalidate: invalidation => invalidations.push(invalidation),
    hotPolling: true,
    maxHotFiles: 1,
    timers,
    stat: async path => {
      const signature = signatures.get(path);
      if (signature) return signature;
      const error = new Error('missing');
      error.code = 'ENOENT';
      throw error;
    },
  });

  timers.flush();
  await new Promise(resolve => setImmediate(resolve));
  signatures.set('index.jsonl', { dev: 1, ino: 1, size: 1, mtimeMs: 1 });
  timers.flush();
  await new Promise(resolve => setImmediate(resolve));

  watcher.promote('old.jsonl');
  watcher.promote('hot.jsonl');
  signatures.set('old.jsonl', { dev: 1, ino: 2, size: 2, mtimeMs: 2 });
  signatures.set('hot.jsonl', { dev: 1, ino: 3, size: 3, mtimeMs: 3 });
  timers.flush();
  await new Promise(resolve => setImmediate(resolve));

  assert.deepEqual(invalidations, [
    { type: 'paths', paths: ['index.jsonl'] },
    { type: 'paths', paths: ['hot.jsonl'] },
  ]);
  await watcher.close();
});

test('close() guards event delivery synchronously, before its promise settles', async () => {
  const root = makeTempDir('trajex-adw-sync-guard-');
  const invalidations = [];
  let capturedCallback = null;
  let resolveUnsubscribe = null;
  const subscribe = (_root, callback) => {
    capturedCallback = callback;
    return Promise.resolve({
      unsubscribe() {
        return new Promise((resolve) => { resolveUnsubscribe = resolve; });
      },
    });
  };
  const watcher = createAdaptiveWatcher({
    targets: [{ kind: 'tree', path: root }],
    hotPolling: false,
    onInvalidate: (inv) => invalidations.push(inv),
    subscribe,
    logger: { warn: () => {} },
  });

  assert.ok(await waitFor(() => capturedCallback !== null), 'the tree root is subscribed');
  const closePromise = watcher.close();
  let settled = false;
  void closePromise.then(() => { settled = true; });

  capturedCallback(null, [{ type: 'update', path: join(root, 'x.jsonl') }]);
  assert.deepEqual(invalidations, [], 'an event delivered synchronously after close() is a no-op');
  await Promise.resolve();
  assert.equal(settled, false, 'close() is still pending — the guard did not depend on completion');

  resolveUnsubscribe();
  await closePromise;
  assert.equal(settled, true);
});
