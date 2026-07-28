import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

test('root SKILL.md bootstraps the CLI before installing the official skill', () => {
  const source = readFileSync(join(repoRoot, 'SKILL.md'), 'utf8');

  assert.match(source, /@trajex-apps\/cli/);
  assert.match(source, /install\.sh/);
  assert.match(source, /trajex --version/);
  assert.match(source, /trajex install/);
  assert.match(source, /defaults to the current project/i);
  assert.match(source, /ask whether .*should be\s+installed/is);
  assert.match(source, /trajex install --global/);
  assert.match(source, /Do not silently choose the current-project default/);
  assert.doesNotMatch(source, /trajex --query/);
});

test('README presents agent-led installation before manual npm setup', () => {
  const source = readFileSync(join(repoRoot, 'README.md'), 'utf8');
  const publishedSkillReadme = readFileSync(
    join(repoRoot, 'packaging', 'skill-README.md'),
    'utf8',
  );
  const agentInstall = source.indexOf('Let your agent install it (recommended)');
  const manualInstall = source.indexOf('Install manually');

  assert.ok(agentInstall >= 0);
  assert.ok(manualInstall > agentInstall);
  assert.match(source, /curl -fsSL .*\/SKILL\.md/);
  assert.ok(
    publishedSkillReadme.indexOf('Install with your agent (recommended)')
      < publishedSkillReadme.indexOf('Install manually'),
  );
});

test('install.sh installs and verifies only the CLI', () => {
  const home = mkdtempSync(join(tmpdir(), 'trajex-install-script-'));
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
