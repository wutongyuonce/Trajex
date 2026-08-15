// Copyright (C) 2026 tommy0103 and contributors.
// Copyright (C) 2026 wutongyuonce and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

import test from 'node:test';
import assert from 'node:assert/strict';
import { isSafeMarkdownHref } from '../app/src/renderer/src/utils.js';

test('Markdown URL policy allows normal and local links', () => {
  for (const href of [
    'https://example.com/docs',
    'mailto:test@example.com',
    '#section',
    'file:///Users/test/project/file.md',
    'file://localhost/Users/test/project/file.md',
    'notes/file.md',
  ]) {
    assert.equal(isSafeMarkdownHref(href), true, href);
  }
});

test('Markdown URL policy rejects executable and data URLs', () => {
  for (const href of [
    'javascript:alert(1)',
    'JaVaScRiPt:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'vbscript:msgbox(1)',
    'file://attacker/share/file.md',
  ]) {
    assert.equal(isSafeMarkdownHref(href), false, href);
  }
});
