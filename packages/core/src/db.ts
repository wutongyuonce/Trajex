// Copyright (C) 2026 tommy0103 and contributors.
// Copyright (C) 2026 wutongyuonce and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * SQLite 连接生命周期。
 *
 * 模块定位：为 node:sqlite 提供可写、只读和 writer-lease 三种连接工厂；schema 安装与
 * 迁移统一交给 schema-migrations.ts 的 installCoreSchema。
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { configureConnection } from './tx.ts';
import { installCoreSchema } from './schema-migrations.ts';
import { readSnapshotSettings, snapshotDirFor } from './snapshots.ts';
import type { NodeSqliteDb } from './sqlite-types.ts';

// runner 在子进程中指定该目录，使评测索引不触碰用户的默认 ~/.trajex。
const TRAJEX_DIR = process.env.TRAJEX_DIR || join(homedir(), '.trajex');
const DB_PATH = join(TRAJEX_DIR, 'trajex.sqlite');
const SCHEMA = readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');

/** 打开（必要时创建并迁移）主索引连接。调用方必须持有 writer lease。 */
function openDb(): NodeSqliteDb {
  mkdirSync(dirname(DB_PATH), { recursive: true });
  const db = new DatabaseSync(DB_PATH);
  configureConnection(db, { busyTimeoutMs: 250 });
  try {
    installCoreSchema(db, SCHEMA, { snapshotDir: snapshotDirFor(DB_PATH), snapshotKeep: readSnapshotSettings(TRAJEX_DIR).keep });
  } catch (error) {
    db.close();
    throw error;
  }
  return db;
}

// Queries and daemon-arbitration checks must never migrate/configure the index.
// The caller is responsible for ensuring the database exists first.
/** 打开只读主索引，供查询和 daemon 所有权判断使用。 */
function openReadDb(): NodeSqliteDb {
  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  db.exec('PRAGMA busy_timeout=250');
  return db;
}

/** 打开既有记忆层：attune 不创建、迁移或配置索引，避免与 daemon 索引写入争夺所有权。 */
function openAttuneDb(): NodeSqliteDb {
  if (!existsSync(DB_PATH)) {
    throw new Error('Trajex index is not initialized; run an index build before writing approved durable memory');
  }
  const db = new DatabaseSync(DB_PATH);
  configureConnection(db, { busyTimeoutMs: 250 });
  const required = ['memories', 'memories_fts', 'memories_fts_ai', 'memories_fts_ad', 'memories_fts_au'];
  const present = new Set(db.prepare("SELECT name FROM sqlite_master WHERE name IN ('memories', 'memories_fts', 'memories_fts_ai', 'memories_fts_ad', 'memories_fts_au')").all().map(row => String(row.name)));
  if (required.some(name => !present.has(name))) {
    db.close();
    throw new Error('Trajex index predates the approved durable memory layer; run an index build first');
  }
  return db;
}

/** 打开独立锁库；该连接只承载 writer lease，不承载业务表。 */
function openWriterLeaseDb(lockPath: string): NodeSqliteDb {
  return new DatabaseSync(lockPath);
}

export { TRAJEX_DIR, DB_PATH, openDb, openReadDb, openAttuneDb, openWriterLeaseDb };
