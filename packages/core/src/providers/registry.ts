// Copyright (C) 2026 tommy0103 and contributors.
// Copyright (C) 2026 wutongyuonce and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

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

/**
 * Provider 注册表接口。所有方法均为查找/枚举，不包含写入或 mutate 能力。
 */
export interface ProviderRegistry {
  /** 返回所有 provider 的只读元数据快照（深度复制 descriptor，防止外部修改）。 */
  catalog(): ProviderDescriptor[];
  /** 按 source 名称（如 'claude' | 'codex' | 'pi'）查找对应的 adapter。 */
  get(source: string): ProviderAdapter | undefined;
  /** 返回当前注册的所有 adapter 列表（byId 快照的副本）。 */
  list(): ProviderAdapter[];
  /** 聚合所有 adapter 需要监视的文件/目录路径，去重后返回。
   *  configuredRoots 允许调用方覆盖某个 provider 的默认根目录，
   *  未覆盖时使用 provider.descriptor.defaultRoot。 */
  watchRoots(configuredRoots?: Readonly<Record<string, string>>): string[];
  /** 按来源定位 adapter 并查询原始消息行；未找到对应的 adapter 时返回 null。 */
  raw(input: RawLookup): RawRecord | null;
}

/**
 * 构建按 source 名称查找的 registry。构造时执行验证，保证持久化 source 与
 * adapter 选择之间存在一对一的稳定映射。
 */
export function createProviderRegistry(providers: readonly ProviderAdapter[]): ProviderRegistry {
  // ── 第一步：构建 adapter 的 ID → 实例 映射，同时做合法性校验 ──
  const byId = new Map<string, ProviderAdapter>();
  for (const provider of providers) {
    const id = provider.descriptor.id;

    // 校验 1：provider.name 必须等于 descriptor.id，防止运行时 source 列值与 adapter 查找 key 不一致。
    if (provider.name !== id) {
      throw new Error(`Provider name "${provider.name}" must match descriptor id "${id}"`);
    }

    // 校验 2：拒绝重复 ID，确保 source 列（作为 FK 值）能唯一映射到一个 adapter。
    if (byId.has(id)) throw new Error(`Duplicate provider id: ${id}`);

    byId.set(id, provider);
  }

  // ── 第二步：封装为不可变查找接口，每次返回快照副本 ──
  const list = (): ProviderAdapter[] => [...byId.values()];

  return {
    // catalog：返回描述符的浅拷贝，防止外部修改影响注册表内部。
    catalog: () => list().map((provider) => ({ ...provider.descriptor })),

    // get：O(1) Map 查找。
    get: (source) => byId.get(source),

    // list：每次返回新数组，外部增删不影响注册表。
    list,

    // watchRoots：聚合所有 adapter 需要监视的根目录，去重后返回。
    // 调用方（如 indexer.ts）用它注册 fs watcher。
    // 返回的路径最终由 indexer 的 daemon 模式消费，实现"改了什么就重索引什么"。
    watchRoots: (configuredRoots = {}) => [
      ...new Set(
        list().flatMap((provider) =>
          provider.watchRoots(configuredRoots[provider.name] ?? provider.descriptor.defaultRoot),
        ),
      ),
    ],

    // raw：按 input.source 定位 adapter，委托给 adapter.raw() 查询原始消息行。
    // 找不到 adapter 时返回 null（例如 source 列是旧版数据）。
    raw: (input) => byId.get(input.source)?.raw(input) ?? null,
  };
}
