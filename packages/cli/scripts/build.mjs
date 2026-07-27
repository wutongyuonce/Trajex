/**
 * CLI 发布构建脚本。
 *
 * 模块定位：清理 dist，使用仓库根目录 TypeScript 编译 CLI 与被其相对导入的 Core，
 * 并复制运行时必须存在的 schema.sql。它不参与用户机器上的索引流程。
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const cliRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(cliRoot, '../..');
const outDir = resolve(cliRoot, 'dist');
const tsc = resolve(repoRoot, 'node_modules/typescript/bin/tsc');

rmSync(outDir, { recursive: true, force: true });
execFileSync(process.execPath, [tsc, '-p', resolve(cliRoot, 'tsconfig.build.json')], {
  cwd: repoRoot,
  stdio: 'inherit',
});

const schemaTarget = resolve(outDir, 'core/src/schema.sql');
mkdirSync(dirname(schemaTarget), { recursive: true });
copyFileSync(resolve(repoRoot, 'packages/core/src/schema.sql'), schemaTarget);
