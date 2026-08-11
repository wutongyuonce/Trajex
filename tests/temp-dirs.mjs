// Keep test-created directories from accumulating in the system temp directory.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const created = new Set();

process.on('exit', () => {
  for (const dir of created) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Best effort: one failed cleanup must not hide test results.
    }
  }
});

export function makeTempDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  created.add(dir);
  return dir;
}
