/**
 * 内建 Provider 装配模块。
 *
 * 模块定位：将 Claude、Codex、Pi 的默认 adapter 组合成 registry。这里仅负责
 * 依赖装配；每个 provider 的路径发现、解析和 raw lookup 仍完全由自身负责。
 */
import { createClaudeProvider } from './claude.ts';
import { createCodexProvider } from './codex.ts';
import { createPiProvider } from './pi.ts';
import { createProviderRegistry, type ProviderRegistry } from './registry.ts';

export type BuiltinProviderRoots = Readonly<Record<string, string | undefined>>;

/**
 * 创建默认 registry，并允许调用方替换各 Provider 数据目录，主要服务测试和设置页；
 * Pi 的值是最终 session directory，Claude/Codex 的值是各自 provider root。
 */
export function createBuiltinProviderRegistry(roots: BuiltinProviderRoots = {}): ProviderRegistry {
  return createProviderRegistry([
    createClaudeProvider({ rootDir: roots['claude'] }),
    createCodexProvider({ rootDir: roots['codex'] }),
    createPiProvider({ sessionDir: roots['pi'] }),
  ]);
}
