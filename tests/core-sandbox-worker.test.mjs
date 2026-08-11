import { makeTempDir } from './temp-dirs.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const coreUrl = pathToFileURL(join(process.cwd(), 'packages/core/src/core.ts')).href;

test('query worker terminates an asynchronously hanging sandbox', { timeout: 35000 }, () => {
  const home = makeTempDir('trajex-sandbox-worker-');
  const script = `
    const { executeQuery } = await import(${JSON.stringify(coreUrl)});
    try {
      await executeQuery('await new Promise(() => {})');
      process.exitCode = 2;
    } catch (error) {
      if (!String(error?.message).includes('Sandbox execution timed out after 30000ms')) process.exitCode = 3;
    }
  `;
  const result = spawnSync(process.execPath, ['-e', script], {
    env: { ...process.env, HOME: home },
    encoding: 'utf8',
    timeout: 35000,
  });

  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
