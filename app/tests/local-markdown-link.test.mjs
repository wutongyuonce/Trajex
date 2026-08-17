// Copyright (C) 2026 tommy0103 and contributors.
// Copyright (C) 2026 wutongyuonce and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

import assert from 'node:assert/strict';
import test from 'node:test';
import { localMarkdownLinkCandidates } from '../src/main/local-markdown-link.mjs';
import { resolveRelativeMarkdownHref } from '../src/renderer/src/utils.js';
import { isWebHref } from '../src/renderer/src/local-markdown-links.js';

test('parses local paths and strips Codex line suffixes', () => {
  assert.deepEqual(localMarkdownLinkCandidates('/tmp/a%20file.ts:42:7'), ['/tmp/a file.ts:42:7', '/tmp/a file.ts']);
  assert.deepEqual(localMarkdownLinkCandidates('file:///tmp/a%20file.ts:42'), ['/tmp/a file.ts:42', '/tmp/a file.ts']);
});

test('rejects non-local Markdown links', () => {
  assert.deepEqual(localMarkdownLinkCandidates('https://example.com/a.ts'), []);
  assert.deepEqual(localMarkdownLinkCandidates('./a.ts'), []);
});

test('resolves relative Markdown links from the message cwd', () => {
  assert.equal(
    resolveRelativeMarkdownHref('app/src/main/index.ts:42', '/workspace/project'),
    'file:///workspace/project/app/src/main/index.ts%3A42',
  );
  assert.equal(resolveRelativeMarkdownHref('./a.ts', null), './a.ts');
  assert.equal(resolveRelativeMarkdownHref('https://example.com/a.ts', '/workspace/project'), 'https://example.com/a.ts');
});

test('web Markdown links are delegated to the system browser handler', () => {
  assert.equal(isWebHref('https://example.com/path'), true);
  assert.equal(isWebHref('http://example.com/path'), true);
  assert.equal(isWebHref('file:///tmp/example.md'), false);
  assert.equal(isWebHref('javascript:alert(1)'), false);
});
