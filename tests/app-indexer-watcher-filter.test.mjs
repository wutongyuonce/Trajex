// Copyright (C) 2026 tommy0103 and contributors.
// Copyright (C) 2026 wutongyuonce and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeTempDir } from './temp-dirs.mjs';

const WATCHER_URL = new URL('../packages/adaptive-watcher/src/index.ts', import.meta.url).href;

function manualTimers() {
  const pending = new Set();
  return {
    setTimeout(fn) { pending.add(fn); return fn; },
    clearTimeout(fn) { pending.delete(fn); },
    setInterval() { return 0; },
    clearInterval() {},
    flush() {
      const timers = [...pending];
      pending.clear();
      for (const timer of timers) timer();
    },
  };
}

test('caller routes provider-declared exact files regardless of suffix', async () => {
  let captured = null;
  const ctx = mock.module(WATCHER_URL, {
    namedExports: {
      createAdaptiveWatcher: (options) => {
        captured = options;
        return { close: () => Promise.resolve(), promote: () => {} };
      },
    },
  });

  const dir = makeTempDir('trajex-wf-');
  try {
    const { createIndexerService } = await import(`../app/src/main/indexer-service.ts?watcher-filter=${Date.now()}`);
    const timers = manualTimers();
    const builds = [];
    const sourceDb = join(dir, 'db.sqlite');
    const pinnedTranscript = join(dir, 'history.jsonl');
    writeFileSync(sourceDb, 'sqlite fixture');
    writeFileSync(pinnedTranscript, '');
    const service = createIndexerService({
      buildIndex: async (args) => builds.push(args),
      watchTargets: [
        { kind: 'tree', path: dir },
        { kind: 'file', path: sourceDb },
        { kind: 'file', path: pinnedTranscript },
      ],
      writeHeartbeat: () => {},
      timers,
      stabilityMs: 0,
    });
    service.start({ buildOnStart: false });

    // Only transcripts discovered under a tree join the hot overlay.
    assert.equal(captured.shouldPromote(join(dir, 'session.jsonl.zstd')), true, '.jsonl.zstd promotes');
    assert.equal(captured.shouldPromote(join(dir, 'session.jsonl.zst')), true, '.jsonl.zst promotes');
    assert.equal(captured.shouldPromote(join(dir, 'session.jsonl')), true);
    assert.equal(captured.shouldPromote(join(dir, 'notes.txt')), false);
    assert.equal(captured.shouldPromote(pinnedTranscript), false, 'pinned .jsonl stays out of the hot overlay');

    mkdirSync(join(dir, 'repo.v2')); // dotted directory name
    writeFileSync(join(dir, 'notes.txt'), 'x'); // plain non-transcript file
    const unrelatedDb = join(dir, 'unrelated.sqlite');
    writeFileSync(unrelatedDb, 'not a provider target');

    // Transcripts forward synchronously.
    captured.onInvalidate({ type: 'paths', paths: [join(dir, 'sid', 'session.jsonl.zstd')] });
    timers.flush();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(builds.map((b) => b.changedPaths ?? []), [[join(dir, 'sid', 'session.jsonl.zstd')]]);

    // Exact file targets are provider-declared sources.
    captured.onInvalidate({ type: 'paths', paths: [sourceDb] });
    timers.flush();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(builds.at(-1).changedPaths, [sourceDb], 'exact file update reaches the indexer');

    // Non-transcripts resolve asynchronously: real directories and missing
    // paths (rename sources) forward; real stray files are dropped.
    captured.onInvalidate({
      type: 'paths',
      paths: [join(dir, 'repo.v2'), join(dir, 'notes.txt'), unrelatedDb, join(dir, 'renamed-away')],
    });
    const forwarded = await (async () => {
      for (let i = 0; i < 40; i++) {
        await new Promise((resolve) => setTimeout(resolve, 25));
        timers.flush();
        if (builds.length >= 3) return builds.at(-1).changedPaths ?? [];
      }
      return [];
    })();
    assert.ok(forwarded.some((p) => p.endsWith('repo.v2')), 'dotted directory forwarded');
    assert.ok(forwarded.some((p) => p.endsWith('renamed-away')), 'missing rename source forwarded');
    assert.ok(!forwarded.some((p) => p.endsWith('notes.txt')), 'real stray file dropped');
    assert.ok(!forwarded.includes(unrelatedDb), 'non-target SQLite file dropped');
    await service.stop();
  } finally {
    ctx.restore();
    mock.reset();
    rmSync(dir, { recursive: true, force: true });
  }
});
