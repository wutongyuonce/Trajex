// Copyright (C) 2026 tommy0103 and contributors.
// Copyright (C) 2026 wutongyuonce and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

import { statSync } from 'node:fs';
import type { Cursor } from './types.ts';

export type FileSnapshot = { mtimeMs: number; size: number; ctimeMs: number; ino: number };

export function fileSnapshot(path: string): FileSnapshot {
  const stats = statSync(path);
  return { mtimeMs: stats.mtimeMs, size: stats.size, ctimeMs: stats.ctimeMs, ino: stats.ino };
}

export function cursorMatchesSnapshot(cursor: Cursor, snapshot: FileSnapshot): boolean {
  if (!cursor) return false;
  const parts = cursor.split(':');
  return parts.length >= 5
    && Number(parts[0]) === snapshot.mtimeMs
    && Number(parts[2]) === snapshot.size
    && Number(parts[3]) === snapshot.ctimeMs
    && Number(parts[4]) === snapshot.ino;
}

export function sameSnapshot(left: FileSnapshot, right: FileSnapshot): boolean {
  return left.mtimeMs === right.mtimeMs
    && left.size === right.size
    && left.ctimeMs === right.ctimeMs
    && left.ino === right.ino;
}

export function snapshotCursor(snapshot: FileSnapshot, lines: number): string {
  return `${snapshot.mtimeMs}:${lines}:${snapshot.size}:${snapshot.ctimeMs}:${snapshot.ino}`;
}
