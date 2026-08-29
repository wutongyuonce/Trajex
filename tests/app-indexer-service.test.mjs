// Copyright (C) 2026 tommy0103 and contributors.
// Copyright (C) 2026 wutongyuonce and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

import { makeTempDir } from './temp-dirs.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import { createIndexerService } from '../app/src/main/indexer-service.ts';

function manualTimers() {
  const timers = new Set();
  const delays = [];
  return {
    delays,
    setTimeout(fn, ms) {
      timers.add(fn);
      delays.push(ms);
      return fn;
    },
    clearTimeout(fn) {
      timers.delete(fn);
    },
    flush() {
      const pending = [...timers];
      timers.clear();
      for (const fn of pending) fn();
    },
  };
}

function clockTimers() {
  let now = 0;
  let nextId = 0;
  const pending = new Map();
  return {
    setTimeout(fn, ms = 0) {
      const id = ++nextId;
      pending.set(id, { fn, due: now + ms });
      return id;
    },
    clearTimeout(id) { pending.delete(id); },
    tick(ms) {
      now += ms;
      for (;;) {
        const due = [...pending.entries()]
          .filter(([, timer]) => timer.due <= now)
          .sort((a, b) => a[1].due - b[1].due)[0];
        if (!due) return;
        pending.delete(due[0]);
        due[1].fn();
      }
    },
  };
}

test('indexer service debounces repeated build requests', async () => {
  const timers = manualTimers();
  const calls = [];
  const service = createIndexerService({
    buildIndex: async ({ reason }) => calls.push(reason),
    watchProjects: () => null,
    writeHeartbeat: () => {},
    timers,
    stabilityMs: 0,
  });

  service.scheduleBuild('first');
  service.scheduleBuild('second');
  service.scheduleBuild('third');
  timers.flush();
  await service.idle();

  assert.deepEqual(calls, ['third']);
});

test('indexer service runs one pending build after an in-flight build finishes', async () => {
  const timers = manualTimers();
  const calls = [];
  let finishFirst;
  const service = createIndexerService({
    buildIndex: async ({ reason }) => {
      calls.push(reason);
      if (reason === 'first') await new Promise(resolve => { finishFirst = resolve; });
    },
    watchProjects: () => null,
    writeHeartbeat: () => {},
    timers,
    stabilityMs: 0,
  });

  const first = service.runBuildNow('first');
  service.scheduleBuild('second');
  timers.flush();

  assert.deepEqual(calls, ['first']);
  finishFirst();
  await first;
  await service.idle();

  assert.deepEqual(calls, ['first', 'pending']);
  timers.flush();
  await service.idle();
  assert.deepEqual(calls, ['first', 'pending']);
});

test('indexer service bounds a continuous change burst', async () => {
  const timers = clockTimers();
  const calls = [];
  const service = createIndexerService({
    buildIndex: async ({ changedPaths }) => calls.push(changedPaths),
    watchProjects: () => null,
    writeHeartbeat: () => {},
    timers,
    debounceMs: 1000,
    stabilityMs: 500,
    maxWaitMs: 1500,
  });

  service.scheduleBuild('watch', 'a.jsonl');
  timers.tick(500);
  service.scheduleBuild('watch', 'b.jsonl');
  timers.tick(500);
  service.scheduleBuild('watch', 'c.jsonl');
  timers.tick(499);
  assert.equal(calls.length, 0);
  timers.tick(1);
  await service.idle();
  assert.deepEqual(calls, [['a.jsonl', 'b.jsonl', 'c.jsonl']]);
});

test('indexer service periodically reconciles the full inventory', async () => {
  const timers = manualTimers();
  const intervals = new Map();
  timers.setInterval = (fn, ms) => { intervals.set(ms, fn); return fn; };
  timers.clearInterval = () => {};
  const calls = [];
  const service = createIndexerService({
    buildIndex: async (args) => calls.push(args),
    watchProjects: () => null,
    writeHeartbeat: () => {},
    timers,
    debounceMs: 0,
    stabilityMs: 0,
    maxWaitMs: 0,
    reconcileMs: 321,
  });

  service.start({ buildOnStart: false });
  intervals.get(321)();
  timers.flush();
  await service.idle();
  assert.deepEqual(calls, [{ reason: 'reconcile', changedPaths: undefined }]);
  await service.stop();
});

test('indexer service reschedules a writer-lease deferral without publishing a heartbeat', async () => {
  const timers = manualTimers();
  const calls = [];
  let heartbeats = 0;
  const service = createIndexerService({
    buildIndex: async ({ reason, changedPaths }) => {
      calls.push({ reason, changedPaths });
      return calls.length === 1 ? { deferred: true, reason: 'writer_busy' } : { deferred: false };
    },
    watchProjects: () => null,
    writeHeartbeat: () => { heartbeats += 1; },
    timers,
    stabilityMs: 0,
  });

  await service.runBuildNow('watch', ['project/session.jsonl']);
  assert.equal(heartbeats, 0);
  assert.equal(calls.length, 1);

  timers.flush();
  await service.idle();
  assert.deepEqual(calls, [
    { reason: 'watch', changedPaths: ['project/session.jsonl'] },
    { reason: 'writer-lease', changedPaths: ['project/session.jsonl'] },
  ]);
  assert.equal(heartbeats, 1);
});

test('incomplete inventory retries back off to ten minutes and reset after recovery', async () => {
  const timers = manualTimers();
  let incomplete = true;
  const service = createIndexerService({
    buildIndex: async () => incomplete
      ? {
          inventoryIssues: [{
            provider: 'pi',
            path: '/tmp/pi/locked',
            error: 'EACCES: permission denied',
          }],
        }
      : { inventoryIssues: [] },
    watchProjects: () => ({ close() {} }),
    writeHeartbeat: () => {},
    timers,
    heartbeatMs: 120_000,
    stabilityMs: 0,
    logger: { warn() {} },
  });

  await service.runBuildNow('startup');
  for (let attempt = 0; attempt < 4; attempt++) {
    timers.flush();
    await service.idle();
  }
  assert.deepEqual(timers.delays, [120_000, 240_000, 480_000, 600_000, 600_000]);

  incomplete = false;
  timers.flush();
  await service.idle();
  incomplete = true;
  await service.runBuildNow('manual');
  assert.equal(timers.delays.at(-1), 120_000);
  service.stop();
});

test('indexer service does not log a build cancelled by a service stop', async () => {
  const timers = manualTimers();
  const warnings = [];
  let rejectBuild;
  const service = createIndexerService({
    buildIndex: () => new Promise((_resolve, reject) => { rejectBuild = reject; }),
    watchProjects: () => null,
    writeHeartbeat: () => {},
    timers,
    stabilityMs: 0,
    logger: { warn: (msg) => warnings.push(msg) },
  });

  const build = service.runBuildNow('startup');
  service.stop(); // manual rebuild path tears the worker down mid-build
  rejectBuild(new Error('Indexer worker stopped'));
  await build;

  assert.deepEqual(warnings, []);
});

test('indexer service logs a build that fails while running', async () => {
  const timers = manualTimers();
  const warnings = [];
  let rejectBuild;
  const service = createIndexerService({
    buildIndex: () => new Promise((_resolve, reject) => { rejectBuild = reject; }),
    watchProjects: () => null,
    writeHeartbeat: () => {},
    timers,
    stabilityMs: 0,
    logger: { warn: (msg) => warnings.push(msg) },
  });

  const build = service.runBuildNow('watch');
  rejectBuild(new Error('disk on fire'));
  await build;

  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /Trajex index build failed: disk on fire/);
});

test('indexer service waits for a stability window before building', async () => {
  const timers = manualTimers();
  const calls = [];
  const service = createIndexerService({
    buildIndex: async ({ reason }) => calls.push(reason),
    watchProjects: () => null,
    writeHeartbeat: () => {},
    timers,
    stabilityMs: 500,
    maxWaitMs: 0,
  });

  service.scheduleBuild('jsonl-change');
  timers.flush();
  await service.idle();
  assert.deepEqual(calls, []);

  timers.flush();
  await service.idle();
  assert.deepEqual(calls, ['jsonl-change']);
});

test('indexer service retries watcher setup when the projects directory is missing', () => {
  const timers = manualTimers();
  let attempts = 0;
  const service = createIndexerService({
    buildIndex: async () => {},
    watchProjects: () => {
      attempts++;
      return attempts === 1 ? null : { close() {} };
    },
    writeHeartbeat: () => {},
    timers,
    stabilityMs: 0,
  });

  service.start({ buildOnStart: false });
  assert.equal(attempts, 1);

  timers.flush();
  assert.equal(attempts, 2);

  timers.flush();
  assert.equal(attempts, 2);
});

test('indexer service publishes daemon ownership as soon as it starts', () => {
  const timers = manualTimers();
  let heartbeats = 0;
  const service = createIndexerService({
    buildIndex: async () => ({ deferred: false }),
    watchProjects: () => null,
    writeHeartbeat: () => { heartbeats += 1; },
    timers,
    stabilityMs: 0,
  });

  service.start({ buildOnStart: false });
  assert.equal(heartbeats, 1);
  service.stop();
});

test('indexer service runs a startup build immediately', async () => {
  const timers = manualTimers();
  const calls = [];
  const service = createIndexerService({
    buildIndex: async ({ reason }) => calls.push(reason),
    watchProjects: () => null,
    writeHeartbeat: () => {},
    timers,
  });

  service.start({ buildOnStart: true });
  assert.deepEqual(calls, ['startup']);
  await service.idle();
  service.stop();
});

test('indexer service routes adaptive watcher paths into one build batch', async () => {
  const projectsDir = makeTempDir('trajex-adaptive-projects-');
  const timers = manualTimers();
  const calls = [];
  let subscribedRoot = null;
  let callback = null;
  let unsubscribed = false;

  const service = createIndexerService({
    projectsDir,
    buildIndex: async (args) => calls.push(args),
    subscribe: async (root, handler) => {
      subscribedRoot = root;
      callback = handler;
      return { unsubscribe: async () => { unsubscribed = true; } };
    },
    hotPolling: false,
    writeHeartbeat: () => {},
    timers,
    stabilityMs: 0,
    debounceMs: 0,
  });

  try {
    service.start({ buildOnStart: false });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(subscribedRoot, projectsDir);
    callback(null, [
      { type: 'update', path: join(projectsDir, 'session.jsonl') },
      { type: 'update', path: join(projectsDir, 'workflow.json') },
    ]);
    timers.flush();
    await service.idle();
    assert.deepEqual(calls, [{
      reason: 'watch',
      changedPaths: [join(projectsDir, 'session.jsonl'), join(projectsDir, 'workflow.json')],
    }]);
  } finally {
    await service.stop();
  }
  assert.equal(unsubscribed, true);
});

test('indexer service waits for the watcher to close', async () => {
  let resolveClose;
  const watcher = {
    on() { return watcher; },
    close() { return new Promise(resolve => { resolveClose = resolve; }); },
  };
  const service = createIndexerService({
    buildIndex: async () => {},
    watchProjects: () => watcher,
    writeHeartbeat: () => {},
  });

  service.start({ buildOnStart: false });
  let stopped = false;
  const stopping = service.stop().then(() => { stopped = true; });
  await Promise.resolve();
  assert.equal(stopped, false);

  resolveClose();
  await stopping;
  assert.equal(stopped, true);
});

test('indexer service subscribes every typed tree target', async () => {
  const claudeProjectsDir = makeTempDir('trajex-watch-claude-');
  const codexSessionsDir = makeTempDir('trajex-watch-codex-sessions-');
  const timers = manualTimers();
  const calls = [];
  const subscriptions = new Map();

  const service = createIndexerService({
    projectsDir: claudeProjectsDir,
    watchTargets: [
      { kind: 'tree', path: claudeProjectsDir },
      { kind: 'tree', path: codexSessionsDir },
    ],
    buildIndex: async (args) => calls.push(args),
    subscribe: async (root, callback) => {
      subscriptions.set(root, callback);
      return { unsubscribe: async () => {} };
    },
    hotPolling: false,
    writeHeartbeat: () => {},
    timers,
    stabilityMs: 0,
    debounceMs: 0,
  });

  service.start({ buildOnStart: false });
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual([...subscriptions.keys()].sort(), [claudeProjectsDir, codexSessionsDir].sort());

  const changedPath = join(codexSessionsDir, '2026/06/15/rollout-2026-06-15T00-00-00-codex.jsonl');
  subscriptions.get(codexSessionsDir)(null, [{ type: 'update', path: changedPath }]);
  timers.flush();
  await service.idle();

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].changedPaths, [changedPath]);
  await service.stop();
});
