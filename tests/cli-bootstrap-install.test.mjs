// Copyright (C) 2026 tommy0103 and contributors.
// Copyright (C) 2026 wutongyuonce and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

import { makeTempDir } from './temp-dirs.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

test('install.sh installs and verifies only the CLI', () => {
  const home = makeTempDir('trajex-install-script-');
  const fakeBin = join(home, 'bin');
  const npmCapture = join(home, 'npm-args');
  const trajexCapture = join(home, 'trajex-args');
  mkdirSync(fakeBin, { recursive: true });

  const npm = join(fakeBin, 'npm');
  writeFileSync(npm, `#!/bin/sh\nprintf '%s\\n' "$@" > "${npmCapture}"\n`);
  chmodSync(npm, 0o755);

  const trajex = join(fakeBin, 'trajex');
  writeFileSync(trajex, `#!/bin/sh\nprintf '%s\\n' "$@" > "${trajexCapture}"\nprintf '0.1.0\\n'\n`);
  chmodSync(trajex, 0o755);

  const result = spawnSync('sh', [join(repoRoot, 'install.sh')], {
    cwd: repoRoot,
    env: {
      ...process.env,
      HOME: home,
      PATH: `${fakeBin}${delimiter}${process.env.PATH || ''}`,
    },
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.deepEqual(readFileSync(npmCapture, 'utf8').trim().split('\n'), [
    'install',
    '--global',
    '@trajex-apps/cli',
  ]);
  assert.deepEqual(readFileSync(trajexCapture, 'utf8').trim().split('\n'), ['--version']);
});
