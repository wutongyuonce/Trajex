// Copyright (C) 2026 tommy0103 and contributors.
// Copyright (C) 2026 wutongyuonce and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CLAUDE_CANONICAL_TRANSCRIPT_MARKER } from '../packages/core/src/providers/claude.ts';
import { CODEX_CANONICAL_TRANSCRIPT_MARKER } from '../packages/core/src/providers/codex.ts';
import { PI_CANONICAL_TRANSCRIPT_MARKER } from '../packages/core/src/providers/pi.ts';

test('all transcript providers invalidate the old canonical projection together', () => {
  assert.deepEqual([
    CLAUDE_CANONICAL_TRANSCRIPT_MARKER,
    CODEX_CANONICAL_TRANSCRIPT_MARKER,
    PI_CANONICAL_TRANSCRIPT_MARKER,
  ], [
    '__claude_canonical_transcript_v4__',
    '__codex_canonical_transcript_v4__',
    '__pi_canonical_transcript_v4__',
  ]);
});
