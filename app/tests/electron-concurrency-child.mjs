import { createRequire } from 'node:module';
import { createInterface } from 'node:readline';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

const [mode, payloadJson] = process.argv.slice(2);
const payload = JSON.parse(payloadJson || '{}');

if (mode === 'holder') {
  const db = new Database(payload.lockPath);
  db.pragma('busy_timeout = 0');
  db.exec('BEGIN IMMEDIATE');
  process.stdout.write('READY\n');
  const input = createInterface({ input: process.stdin });
  await new Promise(resolve => input.once('line', resolve));
  db.exec('ROLLBACK');
  db.close();
  input.close();
} else if (mode === 'build') {
  const { buildIndex } = await import('../out/main/indexer.js');
  process.stdout.write('STARTING\n');
  const result = buildIndex(payload.options);
  process.stdout.write(`RESULT ${JSON.stringify(result)}\n`);
} else {
  throw new Error(`Unknown concurrency child mode: ${mode}`);
}
