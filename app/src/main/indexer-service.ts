// Copyright (C) 2026 tommy0103 and contributors.
// Copyright (C) 2026 wutongyuonce and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

import os from 'node:os';
import path from 'node:path';
import {
  createAdaptiveWatcher,
  type ParcelSubscribe,
  type WatchTarget,
} from '../../../packages/adaptive-watcher/src/index.ts';

const DEFAULT_PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
const DEFAULT_DEBOUNCE_MS = 250;
const DEFAULT_STABILITY_MS = 500;
const DEFAULT_MAX_WAIT_MS = 1500;
const DEFAULT_HEARTBEAT_MS = 30000;
const DEFAULT_WATCH_RETRY_MS = 5000;
const DEFAULT_DEFERRED_RETRY_MS = 250;
const DEFAULT_RECONCILE_MS = 5 * 60 * 1000;
const MAX_INVENTORY_RETRY_MS = 10 * 60 * 1000;

type TimerHandle = ReturnType<typeof setTimeout>;

interface Timers {
  setTimeout: (fn: () => void, ms?: number) => TimerHandle;
  clearTimeout: (handle: TimerHandle) => void;
  setInterval?: (fn: () => void, ms?: number) => TimerHandle;
  clearInterval?: (handle: TimerHandle) => void;
}

interface Watcher {
  close(): unknown;
  promote?(path: string): void;
  refreshMissingRoots?(): boolean;
}

interface IndexerBuildResult {
  deferred?: boolean;
  affectedSessionIds?: string[];
  watchHints?: string[];
  inventoryIssues?: Array<{ provider: string; path: string; error: string }>;
}

type IndexerBuild = (args: {
  reason?: string;
  changedPaths?: string[];
  retrySessionIds?: string[];
}) => IndexerBuildResult | void | Promise<IndexerBuildResult | void>;

interface IndexerServiceOptions {
  projectsDir?: string;
  watchTargets?: WatchTarget[];
  debounceMs?: number;
  stabilityMs?: number;
  maxWaitMs?: number;
  heartbeatMs?: number;
  watchRetryMs?: number;
  deferredRetryMs?: number;
  reconcileMs?: number;
  buildIndex?: IndexerBuild;
  writeHeartbeat?: () => unknown;
  watchProjects?: (onChange: (changedPath?: string) => void) => Watcher | null;
  subscribe?: ParcelSubscribe;
  hotPolling?: boolean;
  watchPollMs?: number;
  timers?: Timers;
  logger?: { warn?: (msg: string) => void };
}

function createIndexerService({
  projectsDir = DEFAULT_PROJECTS_DIR,
  watchTargets,
  debounceMs = DEFAULT_DEBOUNCE_MS,
  stabilityMs = DEFAULT_STABILITY_MS,
  maxWaitMs = DEFAULT_MAX_WAIT_MS,
  heartbeatMs = DEFAULT_HEARTBEAT_MS,
  watchRetryMs = DEFAULT_WATCH_RETRY_MS,
  deferredRetryMs = DEFAULT_DEFERRED_RETRY_MS,
  reconcileMs = DEFAULT_RECONCILE_MS,
  buildIndex,
  writeHeartbeat = () => {},
  watchProjects,
  subscribe,
  hotPolling,
  watchPollMs,
  timers = { setTimeout, clearTimeout, setInterval, clearInterval },
  logger = console,
}: IndexerServiceOptions = {}) {
  if (typeof buildIndex !== 'function') throw new Error('createIndexerService() requires buildIndex');
  const watch = watchProjects || ((onChange) => {
    const targets = watchTargets ?? [{ kind: 'tree' as const, path: projectsDir }];
    if (!targets.length) return null;
    return createAdaptiveWatcher({
      targets,
      subscribe,
      logger,
      timers,
      retryDelayMs: watchRetryMs,
      hotPolling,
      pollIntervalMs: watchPollMs,
      shouldPromote: (targetPath) => targetPath.endsWith('.jsonl') || targetPath.endsWith('.json'),
      onInvalidate: (invalidation) => {
        if (invalidation.type === 'rescan') {
          onChange();
          return;
        }
        for (const changedPath of invalidation.paths) {
          if (changedPath.endsWith('.jsonl') || changedPath.endsWith('.json')) onChange(changedPath);
        }
      },
    });
  });

  let buildTimer: TimerHandle | null = null;
  let stabilityTimer: TimerHandle | null = null;
  let maxWaitTimer: TimerHandle | null = null;
  let heartbeatTimer: TimerHandle | null = null;
  let reconcileTimer: TimerHandle | null = null;
  let watchRetryTimer: TimerHandle | null = null;
  let retryTimer: TimerHandle | null = null;
  let watcher: Watcher | null = null;
  let stopped = false;
  let running = false;
  let pending = false;
  let lastReason: string | null = null;
  let changedPaths = new Set<string>();
  const deferredSessionIds = new Set<string>();
  let fullInventoryPending = false;
  let nextInventoryRetryMs = heartbeatMs;
  let idlePromise = Promise.resolve();
  let stopPromise: Promise<void> | null = null;

  const requestFullInventory = () => {
    fullInventoryPending = true;
    changedPaths.clear();
  };

  const addChangedPath = (changedPath?: string | string[]) => {
    if (Array.isArray(changedPath)) {
      for (const item of changedPath) addChangedPath(item);
      return;
    }
    const name = changedPath ? String(changedPath) : '';
    if (name && !fullInventoryPending) changedPaths.add(name);
  };

  type BuildBatch = { kind: 'full' } | { kind: 'paths'; paths: string[] };

  const takeBatch = (): BuildBatch | null => {
    if (fullInventoryPending) {
      fullInventoryPending = false;
      changedPaths.clear();
      return { kind: 'full' };
    }
    if (!changedPaths.size) return null;
    const paths = [...changedPaths];
    changedPaths = new Set();
    return { kind: 'paths', paths };
  };

  const publishHeartbeat = () => {
    try {
      return writeHeartbeat();
    } catch (error) {
      logger.warn?.(`Trajex heartbeat failed: ${(error as Error).message}`);
      return false;
    }
  };

  const promoteWatchHints = (hints: string[] | undefined) => {
    for (const hint of [...(hints ?? [])].reverse()) watcher?.promote?.(hint);
  };

  const clearBurstTimers = () => {
    if (buildTimer) timers.clearTimeout(buildTimer);
    if (stabilityTimer) timers.clearTimeout(stabilityTimer);
    if (maxWaitTimer) timers.clearTimeout(maxWaitTimer);
    buildTimer = null;
    stabilityTimer = null;
    maxWaitTimer = null;
  };

  const startBuild = (reason: string, batch: BuildBatch) => {
    if (stopped) return idlePromise;
    clearBurstTimers();
    running = true;
    pending = false;
    const buildChangedPaths = batch.kind === 'full' ? undefined : batch.paths;
    idlePromise = (async () => {
      const retrySessionIds = [...deferredSessionIds];
      const result = await buildIndex({
        reason,
        changedPaths: buildChangedPaths,
        ...(retrySessionIds.length ? { retrySessionIds } : {}),
      });
      promoteWatchHints(result?.watchHints);
      if (result?.deferred) {
        for (const sessionId of result.affectedSessionIds ?? []) deferredSessionIds.add(sessionId);
      } else {
        deferredSessionIds.clear();
      }
      const inventoryIssues = result?.inventoryIssues ?? [];
      for (const issue of inventoryIssues) {
        logger.warn?.(`Trajex indexed a partial ${issue.provider} inventory at ${issue.path}: ${issue.error}`);
      }
      if (!result?.deferred && inventoryIssues.length === 0 && batch.kind === 'full') {
        nextInventoryRetryMs = heartbeatMs;
      }
      if (result?.deferred || inventoryIssues.length > 0) {
        if (inventoryIssues.length > 0 || batch.kind === 'full') requestFullInventory();
        else addChangedPath(batch.paths);
        if (!stopped && !retryTimer) {
          const retryReason = result?.deferred ? 'writer-lease' : 'incomplete-inventory';
          const retryMs = result?.deferred ? deferredRetryMs : nextInventoryRetryMs;
          retryTimer = timers.setTimeout(() => {
            retryTimer = null;
            runBuildNow(retryReason);
          }, retryMs);
          if (!result?.deferred) {
            nextInventoryRetryMs = Math.min(nextInventoryRetryMs * 2, Math.max(heartbeatMs, MAX_INVENTORY_RETRY_MS));
          }
        }
        if (result?.deferred) return;
      }
      publishHeartbeat();
    })()
      .catch((error) => {
        if (!stopped) logger.warn?.(`Trajex index build failed: ${(error as Error).message}`);
      })
      .finally(() => {
        running = false;
        if (pending && !stopped) {
          pending = false;
          const followUp = takeBatch();
          if (followUp) startBuild('pending', followUp);
        }
      });
    return idlePromise;
  };

  const runBuildNow = (reason = 'manual', paths: string[] | undefined = undefined) => {
    addChangedPath(paths);
    if (stopped) return idlePromise;
    if (running) {
      pending = true;
      return idlePromise;
    }
    return startBuild(reason, takeBatch() ?? { kind: 'full' });
  };

  const fireBurst = () => {
    const batch = takeBatch();
    clearBurstTimers();
    if (batch) startBuild(lastReason || 'watch', batch);
  };

  const scheduleBuild = (reason = 'change', changedPath: string | undefined = undefined) => {
    if (stopped) return;
    if (changedPath === undefined) requestFullInventory();
    else addChangedPath(changedPath);
    lastReason = reason;
    if (retryTimer) timers.clearTimeout(retryTimer);
    retryTimer = null;
    if (running) {
      pending = true;
      return;
    }
    if (buildTimer) timers.clearTimeout(buildTimer);
    if (stabilityTimer) timers.clearTimeout(stabilityTimer);
    buildTimer = null;
    stabilityTimer = null;
    if (maxWaitMs > 0 && !maxWaitTimer) maxWaitTimer = timers.setTimeout(fireBurst, maxWaitMs);
    buildTimer = timers.setTimeout(() => {
      buildTimer = null;
      if (stabilityMs <= 0) {
        fireBurst();
        return;
      }
      stabilityTimer = timers.setTimeout(() => {
        stabilityTimer = null;
        fireBurst();
      }, stabilityMs);
    }, debounceMs);
  };

  const scheduleWatchRetry = () => {
    if (stopped || watchRetryTimer) return;
    watchRetryTimer = timers.setTimeout(() => {
      watchRetryTimer = null;
      if (!watcher) {
        startWatching();
        return;
      }
      if (watcher.refreshMissingRoots?.() === false) scheduleWatchRetry();
    }, watchRetryMs);
  };

  const startWatching = () => {
    if (stopped || watcher) return;
    watcher = watch((changedPath) => scheduleBuild('watch', changedPath));
    if (!watcher) scheduleWatchRetry();
    else if (watcher.refreshMissingRoots?.() === false) scheduleWatchRetry();
  };

  const start = ({ buildOnStart = true } = {}) => {
    stopped = false;
    stopPromise = null;
    publishHeartbeat();
    if (buildOnStart) runBuildNow('startup');
    startWatching();
    if (typeof timers.setInterval === 'function') {
      heartbeatTimer = timers.setInterval(publishHeartbeat, heartbeatMs);
      if (reconcileMs > 0) reconcileTimer = timers.setInterval(() => scheduleBuild('reconcile'), reconcileMs);
    }
  };

  const stop = () => {
    if (stopPromise) return stopPromise;
    stopped = true;
    pending = false;
    deferredSessionIds.clear();
    clearBurstTimers();
    if (watchRetryTimer) timers.clearTimeout(watchRetryTimer);
    if (retryTimer) timers.clearTimeout(retryTimer);
    watchRetryTimer = null;
    retryTimer = null;
    nextInventoryRetryMs = heartbeatMs;
    if (typeof timers.clearInterval === 'function') {
      if (heartbeatTimer) timers.clearInterval(heartbeatTimer);
      if (reconcileTimer) timers.clearInterval(reconcileTimer);
    }
    heartbeatTimer = null;
    reconcileTimer = null;
    const currentWatcher = watcher;
    watcher = null;
    stopPromise = Promise.resolve(currentWatcher?.close?.()).then(() => undefined);
    return stopPromise;
  };

  return { start, stop, scheduleBuild, runBuildNow, promoteWatchHints, idle: () => idlePromise };
}

export { createIndexerService };
