import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

const outputSchema = resolve('out/main/schema.sql');
const sourceSchema = resolve('../packages/core/src/schema.sql');

test('main-process bundle contains Core schema beside indexer.js', () => {
  assert.ok(existsSync(outputSchema), 'out/main/schema.sql is missing');
  assert.equal(readFileSync(outputSchema, 'utf8'), readFileSync(sourceSchema, 'utf8'));
});
