# The CLI ships readable compiled JS; the skill remains docs-only

**Context.** Trajex indexes a user's entire local Claude Code, Codex, Kimi Code,
and Pi session history, so auditability is the foundation of trust.
Bundling/minifying Core into one opaque file would make the runtime harder to
inspect. Shipping executable Core inside `.claude/skills` / `.agents/skills`
would also blur the boundary between the agent's instructions and the local data
runtime.

The CLI package (`@trajex-apps/cli`) is installed globally by npm or the
`install.sh` bootstrap script and owns all executable code. The agent skill
(`trajex-skill/`) is installed by the standard skills installer and owns only
agent guidance — SKILL.md plus reference documents. The two artifacts are
published from the same repository but through different mechanisms (npm vs.
skills installer) and must not cross-contaminate.

**Decision.**

- **`@trajex-apps/cli` ships readable, non-bundled, non-minified compiled
  JavaScript** emitted straight from `tsc` (module structure preserved,
  import extensions rewritten, comments intact — ~1:1 with the TypeScript
  source), plus `schema.sql` copied from `packages/core/src/schema.sql`. The
  published package (`"files": ["dist", "README.md"]`) excludes the app,
  renderer, release assets, and tests.

- **The separately published agent skill ships only `SKILL.md`, `references/`,
  and metadata.** Every executable action in the skill delegates to the
  installed `trajex` command. The skill never ships JavaScript, SQL, or any
  runtime code. Its `SKILL.md` documents the CLI's API surface but never
  reimplements it.

- **Bundling into one file is deliberately rejected** because it trades
  auditability for marginal size savings. A user inspecting a `node_modules`
  or `dist/` copy of `@trajex-apps/cli` should be able to read the module
  structure, trace imports, and verify what the code does — without
  decompiling or unminifying. The same principle prohibits embedding
  precompiled Core into the skill artifact as a second runtime.

**Consequences.** Runtime ownership is unambiguous: npm installs the CLI,
while the skills installer installs only agent guidance. A user who inspects
either artifact can immediately tell which is which — the CLI contains `.js`
files and `schema.sql`, the skill contains only markdown and structured
metadata.

A future contributor may be tempted to re-embed Core in the skill or bundle
the CLI — this ADR records that both are intentional boundaries.
`npm run build:cli` in the root `package.json` owns compiled code (via
`packages/cli/scripts/build.mjs`); the `trajex-skill/` directory owns
docs-only packaging. Neither target should ever produce the other's artifact.
