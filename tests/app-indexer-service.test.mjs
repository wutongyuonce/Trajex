import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
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

test('indexer service watches a source root that appears after startup', async () => {
  const home = mkdtempSync(join(tmpdir(), 'trajex-late-watch-root-'));
  const existingRoot = join(home, 'existing');
  const missingRoot = join(home, 'missing');
  mkdirSync(existingRoot);
  const timers = manualTimers();
  const watched = [];
  const builds = [];
  const chokidar = {
    watch(root) {
      watched.push(root);
      const watcher = {
        on() { return watcher; },
        close() {},
      };
      return watcher;
    },
  };
  const service = createIndexerService({
    watchDirs: [existingRoot, missingRoot],
    buildIndex: async (args) => builds.push(args),
    chokidar,
    writeHeartbeat: () => {},
    timers,
    debounceMs: 0,
    stabilityMs: 0,
  });

  service.start({ buildOnStart: false });
  assert.deepEqual(watched, [existingRoot]);
  mkdirSync(missingRoot);
  timers.flush();
  timers.flush();
  await service.idle();

  assert.deepEqual(watched, [existingRoot, missingRoot]);
  assert.deepEqual(builds, [{ reason: 'watch', changedPaths: undefined }]);
  service.stop();
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

test('indexer service watches Claude JSON files through chokidar', async () => {
  const projectsDir = mkdtempSync(join(tmpdir(), 'trajex-chokidar-projects-'));
  const timers = manualTimers();
  const calls = [];
  let watchArgs = null;
  const handlers = {};
  const watcher = {
    on(event, handler) {
      handlers[event] = handler;
      return watcher;
    },
    closeCalled: false,
    close() {
      watcher.closeCalled = true;
    },
  };
  const chokidar = {
    watch(paths, options) {
      watchArgs = { paths, options };
      return watcher;
    },
  };

  const service = createIndexerService({
    projectsDir,
    buildIndex: async ({ reason }) => calls.push(reason),
    chokidar,
    writeHeartbeat: () => {},
    timers,
    stabilityMs: 0,
    debounceMs: 0,
  });

  try {
    service.start({ buildOnStart: false });
    assert.equal(watchArgs.paths, projectsDir);
    assert.equal(watchArgs.options.cwd, projectsDir);
    assert.equal(watchArgs.options.ignoreInitial, true);
    assert.ok(watchArgs.options.awaitWriteFinish);

    handlers.change('session.jsonl');
    timers.flush();
    await service.idle();
    assert.deepEqual(calls, ['watch']);
  } finally {
    service.stop();
  }

  assert.equal(watcher.closeCalled, true);
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

test('indexer service passes changed JSONL paths to the build worker', async () => {
  const projectsDir = mkdtempSync(join(tmpdir(), 'trajex-changed-paths-'));
  const timers = manualTimers();
  const calls = [];
  const handlers = {};
  const watcher = {
    on(event, handler) {
      handlers[event] = handler;
      return watcher;
    },
    close() {},
  };
  const chokidar = {
    watch() {
      return watcher;
    },
  };

  const service = createIndexerService({
    projectsDir,
    buildIndex: async (args) => calls.push(args),
    chokidar,
    writeHeartbeat: () => {},
    timers,
    stabilityMs: 0,
    debounceMs: 0,
  });

  service.start({ buildOnStart: false });
  handlers.change('project-a/session-1.jsonl');
  handlers.add('project-a/session-2.json');
  timers.flush();
  await service.idle();

  assert.equal(calls.length, 1);
  assert.equal(calls[0].reason, 'watch');
  assert.deepEqual(calls[0].changedPaths, [
    join(projectsDir, 'project-a/session-1.jsonl'),
    join(projectsDir, 'project-a/session-2.json'),
  ]);
});

test('indexer service watches Claude projects and Codex sessions for app-side indexing', async () => {
  const claudeProjectsDir = mkdtempSync(join(tmpdir(), 'trajex-watch-claude-'));
  const codexSessionsDir = mkdtempSync(join(tmpdir(), 'trajex-watch-codex-sessions-'));
  const timers = manualTimers();
  const calls = [];
  const watchers = [];
  const watchArgs = [];
  const chokidar = {
    watch(paths, options) {
      const handlers = {};
      const watcher = {
        handlers,
        on(event, handler) {
          handlers[event] = handler;
          return watcher;
        },
        close() {},
      };
      watchers.push(watcher);
      watchArgs.push({ paths, options });
      return watcher;
    },
  };

  const service = createIndexerService({
    projectsDir: claudeProjectsDir,
    watchDirs: [claudeProjectsDir, codexSessionsDir],
    buildIndex: async (args) => calls.push(args),
    chokidar,
    writeHeartbeat: () => {},
    timers,
    stabilityMs: 0,
    debounceMs: 0,
  });

  service.start({ buildOnStart: false });
  assert.deepEqual(watchArgs.map(arg => arg.paths), [claudeProjectsDir, codexSessionsDir]);
  assert.deepEqual(watchArgs.map(arg => arg.options.cwd), [claudeProjectsDir, codexSessionsDir]);

  watchers[1].handlers.change('2026/06/15/rollout-2026-06-15T00-00-00-codex.jsonl');
  timers.flush();
  await service.idle();

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].changedPaths, [
    join(codexSessionsDir, '2026/06/15/rollout-2026-06-15T00-00-00-codex.jsonl'),
  ]);
});
