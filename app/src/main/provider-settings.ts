import type { ProviderRegistry } from '../../../packages/core/src/providers/registry.ts';

type PersistedSettings = Record<string, unknown> & {
  providerRoots?: Record<string, unknown>;
};

interface SourceStats {
  sessionCount: number;
  lastIndexed: string;
}

interface BuildSourceCatalogOptions {
  registry: ProviderRegistry;
  roots: Readonly<Record<string, string>>;
  stats?: ReadonlyMap<string, SourceStats>;
  pathExists?: (path: string) => boolean;
}

function configuredPath(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

export function resolveProviderRoots(
  registry: ProviderRegistry,
  persisted: PersistedSettings = {},
): Record<string, string> {
  const configured = persisted.providerRoots ?? {};
  return Object.fromEntries(registry.catalog().map((descriptor) => {
    const root = configuredPath(configured[descriptor.id])
      ?? configuredPath(persisted[`${descriptor.id}Dir`])
      ?? descriptor.defaultRoot;
    return [descriptor.id, root];
  }));
}

export function setPersistedSetting(
  persisted: PersistedSettings,
  key: string,
  value: unknown,
): boolean {
  const providerMatch = /^providerRoots\.(.+)$/.exec(key);
  if (providerMatch === null) {
    if (value === null) delete persisted[key];
    else persisted[key] = value;
    return false;
  }

  const providerId = providerMatch[1]!;
  const roots = persisted.providerRoots && typeof persisted.providerRoots === 'object'
    ? persisted.providerRoots
    : {};
  if (value === null) delete roots[providerId];
  else roots[providerId] = value;
  if (Object.keys(roots).length === 0) delete persisted.providerRoots;
  else persisted.providerRoots = roots;
  return true;
}

export function buildSourceCatalog({
  registry,
  roots,
  stats = new Map(),
  pathExists = () => false,
}: BuildSourceCatalogOptions) {
  return registry.catalog().map((descriptor) => {
    const path = roots[descriptor.id] ?? descriptor.defaultRoot;
    const exists = pathExists(path);
    const sourceStats = stats.get(descriptor.id) ?? { sessionCount: 0, lastIndexed: '' };
    const status = !exists ? 'error' : sourceStats.sessionCount > 0 ? 'ok' : 'warn';
    return {
      id: descriptor.id,
      name: descriptor.name,
      vendor: descriptor.vendor,
      color: descriptor.color,
      path,
      settingKey: `providerRoots.${descriptor.id}`,
      exists,
      sessionCount: sourceStats.sessionCount,
      lastIndexed: sourceStats.lastIndexed,
      status,
      statusText: !exists
        ? 'Folder not found'
        : sourceStats.sessionCount > 0
          ? 'Connected'
          : 'No sessions found',
    };
  });
}
