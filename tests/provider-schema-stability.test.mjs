// Copyright (C) 2026 tommy0103 and contributors.
// Copyright (C) 2026 wutongyuonce and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

test('canonical transcript persistence schema changes only by explicit decision', () => {
  const schema = readFileSync(new URL('../packages/core/src/schema.sql', import.meta.url));
  assert.equal(
    createHash('sha256').update(schema).digest('hex'),
    // 2026-11-14: source ledger, ownership columns, session source_status, and device_id sync columns (ADR-0014).
    '5d18386236fdcd15fd3e8fefded7c2caf6ba6cc077aeb2ed6abbef218ba26810',
  );
});
