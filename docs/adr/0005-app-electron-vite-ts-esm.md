# The app builds with electron-vite (TS + ESM), packages with electron-builder

**Context.** The desktop app must consume the shared TypeScript/ESM Core
(`providers/*` + `persist`) instead of maintaining its own duplicate indexer, and
the app itself should be TypeScript + ESM long-term. The app previously ran raw
CommonJS on Electron's Node with only the Vue renderer built by Vite; the main
process had no build step, and Electron's bundled Node (20 on Electron 33) can
neither strip TypeScript nor use `node:sqlite`. Options for the main-process build
were a hand-rolled tsc/esbuild step, `vite-plugin-electron`, or `electron-vite`.

**Decision.** Adopt **electron-vite** to build all three processes (main, preload,
renderer) as TypeScript + ESM, and keep **electron-builder** for packaging
(dmg/nsis/AppImage). electron-vite is purpose-built for the Electron three-process
model and handles the parts a DIY build would force us to hand-maintain forever
(per-process module format, native-module externalization, dev reload). Specific
decisions within this:

- **Preload is emitted as CommonJS** even though the app is ESM: the sandboxed
  renderer (sandbox is on by default since Electron 20, and we keep it on for
  security) does not support ESM preload. Source stays ESM; only the preload
  output format is CJS. `main` loads `../preload/index.js`.
- **The app consumes the Core from source**: electron-vite/rollup bundles
  `packages/core/src/providers/*` + `packages/core/src/persist.ts` (and their
  `packages/core/src/parsing.ts` dependency) into the app's main/worker build,
  injecting `better-sqlite3`. This
  works because the provider→parsing import graph is node:sqlite-free (ADR-0001),
  so nothing drags `node:sqlite` into the app. The `dist/` from `build:core`
  (ADR-0003) remains for the CLI package; the app does not need it.
- **better-sqlite3 stays the app's binding**, externalized (not bundled) and
  unpacked from the asar.
- **The app main + preload source is TypeScript with types at its seams**, but
  under a *deliberately more lenient* project than the runtime core. `app/tsconfig.json`
  keeps `strict` on yet sets `noImplicitAny: false`, because the app mostly
  orchestrates the already-strictly-typed core (`packages/core/src/`), and annotating every
  internal SQLite-handle helper would be high-cost, low-value churn. Types are
  added where they matter: the core-consumption seam (`BuildIndexOptions`/
  `BuildIndexResult`, `FileInfo`), the service/worker factories, and the IPC
  bridge. Module-to-module specifiers use the real `.ts` extension (mirroring
  Core source, since Node's type-stripping does not rewrite `.js`→`.ts`), which
  needs `allowImportingTsExtensions` (safe under the project's `noEmit`); the
  worker's *runtime* path stays `indexer-worker.js` because that is the built
  output. `@types/better-sqlite3` is a devDependency for the injected binding.

**Two-tier typechecking.** `npm run typecheck` runs the root project (`packages/core/src/` +
`tests/`, fully strict including `noImplicitAny`) and then the app project. The
root project **excludes the app-importing tests** (`tests/app-*.test.mjs`,
`tests/recap-capture-query.test.mjs`): those tests import app source, which would
otherwise drag the lenient app files into the strict root program and fail on
implicit `any`. The app source is instead covered by `app/tsconfig.json`, so
nothing loses type coverage — the strict core and the lenient app are checked by
the project that owns each, and never mixed.

**Consequences.** The app is restructured into `src/{main,preload,renderer}` with
`electron.vite.config.ts`; each main module is a build input so relative imports
between them and the indexer worker (`{ type: 'module' }`) resolve at runtime.
`npm run dev` is `electron-vite dev`. Tests that loaded app modules moved
to ESM imports, and `app-main-settings` was rewritten from CJS `Module._load`
mocking to `node:test` `mock.module` (needs `--experimental-test-module-mocks`).
A future contributor may be tempted to make the preload ESM or disable the
sandbox — this ADR records that CJS preload under an on sandbox is the intended,
secure default.
