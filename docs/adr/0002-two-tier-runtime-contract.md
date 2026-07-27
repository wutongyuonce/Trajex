# The runtime contract is two-tier, with api-reference.md authoritative

**Context.** Before the TypeScript migration and module extraction, we need to
pin what "the contract" is so refactoring cannot silently change observable
behavior. The four verbs (`build`/`search`/`query`/`attune`) are only the entry
surface; agents actually depend on the *return shapes* of the sandbox helpers
(`search`, `overview`, `memories`, …), which are already documented in
`skill-doc/references/api-reference.md` and relied on by every example in
`skill-doc/references/query-patterns.md`. Current behavior is good and there is no reason to
change it during migration.

**Decision.** Freeze the contract in two tiers. **Tier 1 (hard freeze, golden
tests):** the four-verb CLI I/O envelope (file/args → pretty JSON on stdout,
`{error, stack}` error envelope, exit codes) and the sandbox contract (`sql()`
read-only enforcement, `attune` exposing only `remember`/`forget`, the set of
globals/helpers available inside `query`/`attune`). **Tier 2 (locked to
api-reference.md):** each helper's documented return shape — not frozen forever,
but never allowed to drift silently; contract tests assert the live shape matches
`skill-doc/references/api-reference.md`, so changing a helper forces a doc change plus a
deliberate version bump. `skill-doc/references/api-reference.md` is therefore promoted from
description to authoritative contract, and Phase 1 becomes "make it authoritative
and enforce it," not "write a new contract doc."

**Consequences.** Behavior is preserved across the TS/module refactor by
construction: the golden and contract tests fail if any observable shape moves.
The cost is that helper shapes can no longer be reshaped casually mid-migration.
