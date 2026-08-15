// Copyright (C) 2026 tommy0103 and contributors.
// Copyright (C) 2026 wutongyuonce and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  inactiveMessageCount,
  visibleSessionMessages,
} from '../app/src/renderer/src/session-sidechains.mjs';

test('inactive messages are hidden by default and return when expanded', () => {
  const messages = [
    { uuid: 'main', visibility: 'visible' },
    { uuid: 'branch', visibility: 'inactive' },
    { uuid: 'hidden', visibility: 'hidden' },
  ];
  assert.deepEqual(visibleSessionMessages(messages, false), [messages[0]]);
  assert.deepEqual(visibleSessionMessages(messages, true), [messages[0], messages[1]]);
  assert.equal(inactiveMessageCount(messages), 1);
});
