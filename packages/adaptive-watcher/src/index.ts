// Copyright (C) 2026 tommy0103 and contributors.
// Copyright (C) 2026 wutongyuonce and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

import fs from 'node:fs';
import parcelWatcher from '@parcel/watcher';

export type WatchTarget = { kind: 'tree' | 'file'; path: string };
export type WatchInvalidation =
  | { type: 'paths'; paths: string[] }
  | { type: 'rescan'; roots: string[]; reason: string };

export interface AdaptiveWatcher {
  promote(path: string): void;
  close(): Promise<unknown>;
}

export type ParcelSubscribe = (
  root: string,
  callback: (err: Error | null, events: Array<{ type: string; path: string }>) => void,
) => Promise<{ unsubscribe(): Promise<void> }>;

export type FileSignature = {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  isDirectory?: boolean;
};

export type StatProbeResult = {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  isDirectory?: boolean | (() => boolean);
};

export interface AdaptiveWatcherTimers {
  setTimeout: (fn: () => void, ms?: number) => any;
  clearTimeout: (handle: any) => void;
}

export interface AdaptiveWatcherOptions {
  targets: WatchTarget[];
  onInvalidate: (invalidation: WatchInvalidation) => void;
  pollIntervalMs?: number;
  retryDelayMs?: number;
  hotPolling?: boolean;
  maxHotFiles?: number;
  initialHotFiles?: string[];
  shouldPromote?: (path: string) => boolean;
  subscribe?: ParcelSubscribe;
  access?: (path: string) => Promise<unknown>;
  stat?: (path: string) => Promise<StatProbeResult>;
  timers?: AdaptiveWatcherTimers;
  logger?: { warn?: (msg: string) => void };
}

const DEFAULT_POLL_INTERVAL_MS = 1000;
const DEFAULT_RETRY_DELAY_MS = 5000;
const DEFAULT_MAX_HOT_FILES = 64;

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException)?.code;
}

function errorMessage(error: unknown): string {
  return (error as Error)?.message ?? String(error);
}

export function createAdaptiveWatcher({
  targets,
  onInvalidate,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  retryDelayMs = DEFAULT_RETRY_DELAY_MS,
  hotPolling,
  maxHotFiles = DEFAULT_MAX_HOT_FILES,
  initialHotFiles = [],
  shouldPromote,
  subscribe = parcelWatcher.subscribe as ParcelSubscribe,
  access = fs.promises.access,
  stat = fs.promises.stat,
  timers = {
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
  },
  logger = console,
}: AdaptiveWatcherOptions): AdaptiveWatcher {
  const treeRoots = [...new Set(targets.filter((target) => target.kind === 'tree').map((target) => target.path))];
  const fileTargets = [...new Set(targets.filter((target) => target.kind === 'file').map((target) => target.path))];
  const pinnedFiles = new Set(fileTargets);
  const hotEnabled = hotPolling ?? process.platform === 'darwin';
  const hotFiles = new Map<string, null>();
  const silentFirstBaseline = new Set<string>();
  const baselines = new Map<string, FileSignature | null | undefined>();
  const lastWarned = new Map<string, string>();
  let closed = false;

  const warnOnce = (subject: string, error: unknown, message: string) => {
    const key = `${errorCode(error) ?? ''}:${message}`;
    if (lastWarned.get(subject) === key) return;
    lastWarned.set(subject, key);
    logger.warn?.(message);
  };

  const subscriptions = new Map<string, { unsubscribe(): Promise<void> }>();
  const pendingRoots = new Set<string>();
  const inflightSubscribes = new Set<Promise<unknown>>();
  const pendingUnsubscribes = new Set<Promise<unknown>>();
  let retryTimer: unknown = null;
  let initialPassDone = false;

  const noteSettled = () => {
    if (!initialPassDone && pendingRoots.size === 0) initialPassDone = true;
  };

  const scheduleRetry = () => {
    if (closed || retryTimer !== null) return;
    retryTimer = timers.setTimeout(() => {
      retryTimer = null;
      refreshTrees();
    }, retryDelayMs);
  };

  const dropRoot = (root: string) => {
    const subscription = subscriptions.get(root);
    subscriptions.delete(root);
    pendingRoots.delete(root);
    noteSettled();
    if (subscription) {
      const release = subscription.unsubscribe().catch(() => {});
      pendingUnsubscribes.add(release);
      void release.then(() => pendingUnsubscribes.delete(release));
    }
    if (!closed) scheduleRetry();
  };

  const promoteHot = (path: string, silent: boolean) => {
    if (!hotEnabled || closed || pinnedFiles.has(path)) return;
    if (hotFiles.has(path)) {
      hotFiles.delete(path);
      hotFiles.set(path, null);
      return;
    }
    while (hotFiles.size >= maxHotFiles) {
      const oldest = hotFiles.keys().next().value;
      if (oldest === undefined) break;
      hotFiles.delete(oldest);
      baselines.delete(oldest);
      silentFirstBaseline.delete(oldest);
    }
    hotFiles.set(path, null);
    baselines.set(path, undefined);
    if (silent) silentFirstBaseline.add(path);
  };

  const subscribeRoot = (root: string) => {
    let result: ReturnType<ParcelSubscribe>;
    try {
      result = subscribe(root, (error, events) => {
        if (closed) return;
        if (error) {
          warnOnce(root, error, `Trajex watcher failed for ${root}: ${errorMessage(error)}`);
          dropRoot(root);
          return;
        }
        const paths = (events ?? []).map((event) => event?.path).filter(Boolean);
        if (!paths.length) return;
        if (hotEnabled && shouldPromote) {
          for (const event of events ?? []) {
            if (event?.path && event.type !== 'delete' && shouldPromote(event.path)) {
              promoteHot(event.path, true);
            }
          }
        }
        onInvalidate({ type: 'paths', paths });
      });
    } catch (error) {
      pendingRoots.delete(root);
      noteSettled();
      warnOnce(root, error, `Trajex watcher failed to subscribe ${root}: ${errorMessage(error)}`);
      if (!closed) scheduleRetry();
      return;
    }
    const tracked = Promise.resolve(result).then((subscription) => {
      inflightSubscribes.delete(tracked);
      const wasPending = pendingRoots.delete(root);
      const duringInitialPass = !initialPassDone;
      noteSettled();
      if (closed || !wasPending) return subscription.unsubscribe().catch(() => {});
      subscriptions.set(root, subscription);
      lastWarned.delete(root);
      if (!duringInitialPass) {
        onInvalidate({ type: 'rescan', roots: [root], reason: 'root-established' });
      }
      return undefined;
    }, (error) => {
      inflightSubscribes.delete(tracked);
      pendingRoots.delete(root);
      noteSettled();
      warnOnce(root, error, `Trajex watcher failed to subscribe ${root}: ${errorMessage(error)}`);
      if (!closed) scheduleRetry();
    });
    inflightSubscribes.add(tracked);
  };

  const addRoot = (root: string) => {
    if (closed || subscriptions.has(root) || pendingRoots.has(root)) return;
    pendingRoots.add(root);
    Promise.resolve(access(root)).then(() => {
      if (!closed && pendingRoots.has(root)) subscribeRoot(root);
    }, (error) => {
      pendingRoots.delete(root);
      noteSettled();
      const code = errorCode(error);
      if (code !== 'ENOENT' && code !== 'ENOTDIR') {
        warnOnce(root, error, `Trajex watcher cannot access ${root}: ${errorMessage(error)}`);
      }
      if (!closed) scheduleRetry();
    });
  };

  const refreshTrees = () => {
    for (const root of treeRoots) addRoot(root);
  };

  let pollTimer: unknown = null;
  let polling = false;

  const statFile = async (file: string): Promise<FileSignature | null> => {
    try {
      const stats = await stat(file);
      return {
        dev: stats.dev,
        ino: stats.ino,
        size: stats.size,
        mtimeMs: stats.mtimeMs,
        isDirectory: typeof stats.isDirectory === 'function' ? stats.isDirectory() : stats.isDirectory === true,
      };
    } catch (error) {
      const code = errorCode(error);
      if (code === 'ENOENT' || code === 'ENOTDIR') return null;
      warnOnce(file, error, `Trajex watcher cannot stat ${file}: ${errorMessage(error)}`);
      return baselines.get(file) ?? null;
    }
  };

  const signatureChanged = (previous: FileSignature | null, next: FileSignature | null) => {
    if (previous === null || next === null) return previous !== next;
    return previous.dev !== next.dev || previous.ino !== next.ino
      || previous.size !== next.size || previous.mtimeMs !== next.mtimeMs;
  };

  const pollTick = async () => {
    if (polling || closed) return;
    polling = true;
    try {
      const changed: string[] = [];
      const observed: Array<readonly [string, boolean]> = [
        ...fileTargets.map((file) => [file, false] as const),
        ...[...hotFiles.keys()].map((file) => [file, true] as const),
      ];
      for (const [file, isHot] of observed) {
        const previous = baselines.get(file);
        const next = await statFile(file);
        if (isHot && !hotFiles.has(file)) continue;
        if (isHot && next?.isDirectory) {
          hotFiles.delete(file);
          baselines.delete(file);
          silentFirstBaseline.delete(file);
          continue;
        }
        if (previous === undefined) {
          baselines.set(file, next);
          const silent = isHot && silentFirstBaseline.delete(file);
          if (next !== null && !silent) changed.push(file);
          continue;
        }
        if (!signatureChanged(previous ?? null, next)) continue;
        baselines.set(file, next);
        if (next !== null) lastWarned.delete(file);
        changed.push(file);
        if (!isHot) continue;
        if (next === null) {
          hotFiles.delete(file);
          baselines.delete(file);
          silentFirstBaseline.delete(file);
        } else {
          hotFiles.delete(file);
          hotFiles.set(file, null);
        }
      }
      if (changed.length && !closed) onInvalidate({ type: 'paths', paths: changed });
    } finally {
      polling = false;
      if (!closed) pollTimer = timers.setTimeout(pollTick, pollIntervalMs);
    }
  };

  refreshTrees();
  for (const file of initialHotFiles) promoteHot(file, false);
  if (fileTargets.length || hotEnabled) {
    for (const file of fileTargets) baselines.set(file, undefined);
    pollTimer = timers.setTimeout(pollTick, pollIntervalMs);
  }

  return {
    promote: (path) => promoteHot(path, false),
    close() {
      closed = true;
      if (retryTimer !== null) timers.clearTimeout(retryTimer);
      if (pollTimer !== null) timers.clearTimeout(pollTimer);
      retryTimer = null;
      pollTimer = null;
      const active = [...subscriptions.values()];
      subscriptions.clear();
      return Promise.all([
        ...active.map((subscription) => subscription.unsubscribe().catch(() => {})),
        ...inflightSubscribes,
        ...pendingUnsubscribes,
      ]);
    },
  };
}
