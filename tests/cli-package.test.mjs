import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { repoRoot, runCli } from './cli-test-helpers.mjs';

const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const cliPackage = JSON.parse(readFileSync(join(repoRoot, 'packages', 'cli', 'package.json'), 'utf8'));

test('the packaged trajex command preserves the runtime query envelope', () => {
  const home = mkdtempSync(join(tmpdir(), 'trajex-cli-package-'));
  const query = join(home, 'query.mjs');
  writeFileSync(query, 'return { answer: 42 };');

  const result = runCli(['--query', query], { home });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout, '{\n  "answer": 42\n}\n');
});

test('trajex --version reports the installed CLI package version', () => {
  const result = runCli(['--version']);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.stdout, `${cliPackage.version}\n`);
  assert.equal(result.stderr, '');
});

test('CLI test process suppresses only Node ExperimentalWarning output', () => {
  const home = mkdtempSync(join(tmpdir(), 'trajex-cli-warning-'));
  const preload = join(home, 'warnings.cjs');
  writeFileSync(preload, `
    process.emitWarning('simulated SQLite warning', 'ExperimentalWarning');
    process.emitWarning('ordinary warning stays visible', 'TrajexTestWarning');
  `);

  const result = runCli(['--version'], {
    home,
    env: { NODE_OPTIONS: `--require=${preload}` },
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.doesNotMatch(result.stderr, /simulated SQLite warning/);
  assert.match(result.stderr, /ordinary warning stays visible/);
});

test('npm pack installs one platform-neutral CLI with its schema resource', () => {
  const root = mkdtempSync(join(tmpdir(), 'trajex-cli-pack-'));
  const packDir = join(root, 'pack');
  const prefix = join(root, 'prefix');
  const npmCache = join(root, 'npm-cache');
  const npmEnv = { ...process.env, npm_config_cache: npmCache };
  mkdirSync(packDir, { recursive: true });

  const packed = JSON.parse(execFileSync(
    npmCommand,
    [
      'pack',
      '--workspace',
      '@trajex-apps/cli',
      '--pack-destination',
      packDir,
      '--json',
      '--ignore-scripts',
    ],
    {
      cwd: repoRoot,
      env: npmEnv,
      encoding: 'utf8',
      shell: process.platform === 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  ));
  const metadata = packed[0];
  const paths = metadata.files.map(file => file.path);
  assert.ok(paths.includes('dist/cli/src/trajex.js'));
  assert.ok(paths.includes('dist/core/src/schema.sql'));
  assert.equal(paths.some(path => path.endsWith('.ts')), false);

  const tarball = join(packDir, metadata.filename);
  execFileSync(
    npmCommand,
    ['install', '--global', '--prefix', prefix, tarball, '--ignore-scripts'],
    {
      cwd: repoRoot,
      env: npmEnv,
      encoding: 'utf8',
      shell: process.platform === 'win32',
      stdio: 'pipe',
    },
  );

  const installedBin = process.platform === 'win32'
    ? join(prefix, 'trajex.cmd')
    : join(prefix, 'bin', 'trajex');
  const result = spawnSync(installedBin, ['--version'], {
    cwd: repoRoot,
    encoding: 'utf8',
    shell: process.platform === 'win32',
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.stdout.trim(), cliPackage.version);
});
