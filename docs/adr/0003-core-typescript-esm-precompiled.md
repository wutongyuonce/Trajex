# Core is authored in TypeScript, shipped as precompiled ESM JavaScript

**Context.** The extracted Obelisk Core must serve two consumers — the ESM CLI
runtime (`node:sqlite`) and the Electron app (`better-sqlite3`) — while the CLI
must install with **zero build step** on the user's machine. Authoring in TS
gives the infrastructure checkable contracts, but raises how compiled output is
shipped and which module format it targets. The formal agent skill is a separate
docs-only artifact and must not carry a second runtime.

**Decision.** Author all of Core in the `@obelisk/core` npm workspace
(`packages/core`) in TypeScript and compile it ahead-of-time to
**ESM JavaScript plus `.d.ts`**. `@obelisk-apps/cli` ships the *precompiled*
ESM JS, so installing the CLI never runs a build. Rather than have Core
dual-publish CJS+ESM, the Electron main process migrates to ESM at Phase 5 so it
can `import` the same compiled Core. TypeScript source is the single source of
truth; the package build lives in the main repo (`build:cli`), never on the
user's machine. `build:skill` copies only `skill-doc/SKILL.md`, references, and
skill metadata.

**Consequences.** A one-time ESM migration of the Electron main process (Phase 5),
in exchange for no dual-build maintenance and a single module format across the
CLI and app. The shipped CLI package contains compiled JS, not TS. The
renderer (Vue) is out of scope and stays JavaScript. Phase 3's TS baseline only
adds root tooling (package.json, tsconfig, ESLint); it does not touch the app.
The app imports Core source so electron-vite can bundle it, while package and
CLI builds compile the same workspace source to JavaScript.
