import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createProviderRegistry } from '../packages/core/src/providers/registry.ts';
import {
  buildSourceCatalog,
  resolveProviderRoots,
  setPersistedSetting,
} from '../app/src/main/provider-settings.ts';

function provider(id, defaultRoot, color) {
  return {
    name: id,
    descriptor: { id, name: `${id} name`, vendor: `${id} vendor`, defaultRoot, color },
    watchRoots: () => [],
    discover: () => [],
    *parse() { yield* []; return null; },
    raw: () => null,
  };
}

test('provider roots and source settings are derived from the registry without source branches', () => {
  const registry = createProviderRegistry([
    provider('alpha', '/default/alpha', '#112233'),
    provider('beta', '/default/beta', '#445566'),
  ]);
  const persisted = {
    alphaDir: '/legacy/alpha',
    providerRoots: { beta: '/custom/beta' },
  };

  assert.deepEqual(resolveProviderRoots(registry, persisted), {
    alpha: '/legacy/alpha',
    beta: '/custom/beta',
  });

  const rootsChanged = setPersistedSetting(persisted, 'providerRoots.alpha', '/custom/alpha');
  assert.equal(rootsChanged, true);
  assert.deepEqual(persisted.providerRoots, {
    alpha: '/custom/alpha',
    beta: '/custom/beta',
  });

  const sources = buildSourceCatalog({
    registry,
    roots: resolveProviderRoots(registry, persisted),
    stats: new Map([
      ['alpha', { sessionCount: 2, lastIndexed: '2026-07-20T10:00:00.000Z' }],
      ['beta', { sessionCount: 0, lastIndexed: '' }],
    ]),
    pathExists: path => path === '/custom/alpha' || path === '/custom/beta',
  });

  assert.deepEqual(sources, [
    {
      id: 'alpha', name: 'alpha name', vendor: 'alpha vendor', color: '#112233',
      path: '/custom/alpha', settingKey: 'providerRoots.alpha', exists: true,
      sessionCount: 2, lastIndexed: '2026-07-20T10:00:00.000Z',
      status: 'ok', statusText: 'Connected',
    },
    {
      id: 'beta', name: 'beta name', vendor: 'beta vendor', color: '#445566',
      path: '/custom/beta', settingKey: 'providerRoots.beta', exists: true,
      sessionCount: 0, lastIndexed: '', status: 'warn', statusText: 'No sessions found',
    },
  ]);
});

test('removing a generic provider root restores its descriptor default', () => {
  const registry = createProviderRegistry([provider('gamma', '/default/gamma', '#778899')]);
  const persisted = { providerRoots: { gamma: '/custom/gamma' } };

  assert.equal(setPersistedSetting(persisted, 'providerRoots.gamma', null), true);
  assert.deepEqual(resolveProviderRoots(registry, persisted), { gamma: '/default/gamma' });
});
