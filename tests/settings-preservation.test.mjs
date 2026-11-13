// Copyright (C) 2026 tommy0103 and contributors.
// Copyright (C) 2026 wutongyuonce and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { makeTempDir } from './temp-dirs.mjs';
import { preserveRejectedSettings, readSettingsFile } from '../app/src/main/settings-preservation.ts';

test('readSettingsFile distinguishes a missing file from a rejected one', () => {
  const dir = makeTempDir('trajex-settings-read-');
  const path = join(dir, 'settings.json');
  assert.deepEqual(readSettingsFile(path), { ok: true, settings: {} });
  writeFileSync(path, JSON.stringify({ autoRefresh: false, providerRoots: { pi: '/x' } }));
  assert.deepEqual(readSettingsFile(path), { ok: true, settings: { autoRefresh: false, providerRoots: { pi: '/x' } } });
  for (const text of ['{ broken', '[]', 'null', '"text"']) {
    writeFileSync(path, text);
    const result = readSettingsFile(path);
    assert.equal(result.ok, false, text);
    assert.deepEqual(result.settings, {});
    assert.match(result.error, /settings\.json/u);
  }
});

test('a readable or missing settings file is never moved', () => {
  const dir = makeTempDir('trajex-settings-keep-');
  const path = join(dir, 'settings.json');
  assert.equal(preserveRejectedSettings(path, readSettingsFile(path)), null);
  writeFileSync(path, '{"autoRefresh":true}');
  assert.equal(preserveRejectedSettings(path, readSettingsFile(path)), null);
  assert.deepEqual(readdirSync(dir), ['settings.json']);
});

test('a rejected settings file is moved aside with its original bytes', () => {
  const dir = makeTempDir('trajex-settings-move-');
  const path = join(dir, 'settings.json');
  writeFileSync(path, '{ "providerRoots": { "pi": "/keep" ');
  const backup = preserveRejectedSettings(path, readSettingsFile(path));
  assert.match(backup, /settings\.json\.corrupt-\d+$/u);
  assert.equal(existsSync(path), false);
  assert.equal(readFileSync(backup, 'utf8'), '{ "providerRoots": { "pi": "/keep" ');
});

test('a refused rename falls back to copying the rejected bytes', () => {
  const dir = makeTempDir('trajex-settings-copy-');
  const path = join(dir, 'settings.json');
  writeFileSync(path, 'not json');
  const backup = preserveRejectedSettings(path, readSettingsFile(path), {
    rename: () => { throw Object.assign(new Error('busy'), { code: 'EBUSY' }); },
    copyFile: (from, to) => copyFileSync(from, to),
  });
  assert.equal(readFileSync(backup, 'utf8'), 'not json');
  assert.equal(readFileSync(path, 'utf8'), 'not json', 'the original is replaced by the save afterwards');
});

test('when neither rename nor copy can preserve the file, the save is refused', () => {
  const dir = makeTempDir('trajex-settings-refuse-');
  const path = join(dir, 'settings.json');
  writeFileSync(path, 'not json');
  assert.throws(() => preserveRejectedSettings(path, readSettingsFile(path), {
    rename: () => { throw new Error('rename denied'); },
    copyFile: () => { throw new Error('copy denied'); },
  }), /could not back up .*copy denied.*left unchanged/u);
  assert.equal(readFileSync(path, 'utf8'), 'not json');
});
