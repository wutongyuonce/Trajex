/**
 * CLI 构建脚本。
 *
 * 模块定位：清理 dist，使用仓库根目录 TypeScript 编译 CLI 与被其相对导入的 Core，
 * 并复制运行时必须存在的 schema.sql 和许可证文件。它只负责生成 npm 包的构建产物，
 * 不执行 npm publish，也不参与用户机器上的索引流程。
 *
 * 发布链路：npm publish -> npm 生命周期 prepack -> npm run build -> 本脚本。
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

/* 将仓库根 LICENSE 复制到 dist，确保 npm 发布的包内含 AGPL-3.0 许可证 */
const licenseTarget = resolve(outDir, 'LICENSE');
copyFileSync(resolve(repoRoot, 'LICENSE'), licenseTarget);
