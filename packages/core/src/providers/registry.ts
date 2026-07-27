/**
 * Provider 注册表模块。
 *
 * 模块定位：按稳定 source 名称管理 ProviderAdapter，并向索引器和展示层提供
 * 不可变的查找/枚举接口；避免调用方自行维护 provider 列表。
 */
import type {
  ProviderAdapter,
  ProviderDescriptor,
  RawLookup,
  RawRecord,
} from './types.ts';

export interface ProviderRegistry {
  catalog(): ProviderDescriptor[];
  get(source: string): ProviderAdapter | undefined;
  list(): ProviderAdapter[];
  watchRoots(configuredRoots?: Readonly<Record<string, string>>): string[];
  raw(input: RawLookup): RawRecord | null;
}

/**
 * 构建按 source 名称查找的 registry。构造时拒绝重复名称，保证持久化 source 与
 * adapter 选择之间存在一对一的稳定映射。
 */
export function createProviderRegistry(providers: readonly ProviderAdapter[]): ProviderRegistry {
  const byId = new Map<string, ProviderAdapter>();
  for (const provider of providers) {
    const id = provider.descriptor.id;
    if (provider.name !== id) {
      throw new Error(`Provider name "${provider.name}" must match descriptor id "${id}"`);
    }
    if (byId.has(id)) throw new Error(`Duplicate provider id: ${id}`);
    byId.set(id, provider);
  }

  const list = (): ProviderAdapter[] => [...byId.values()];
  return {
    catalog: () => list().map((provider) => ({ ...provider.descriptor })),
    get: (source) => byId.get(source),
    list,
    watchRoots: (configuredRoots = {}) => [
      ...new Set(
        list().flatMap((provider) =>
          provider.watchRoots(configuredRoots[provider.name] ?? provider.descriptor.defaultRoot),
        ),
      ),
    ],
    raw: (input) => byId.get(input.source)?.raw(input) ?? null,
  };
}
