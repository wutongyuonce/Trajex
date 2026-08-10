# Source-root availability and deletion reconciliation

> Revised 2026-08-09. This ADR defines the reliability boundary for Provider
> discovery and the precondition for destructive rebuilds. It does not define
> provider parsing or SQLite transaction mechanics; see ADR-0002 and ADR-0003.

## Context

The SQLite transcript index is a derived view of provider files. A source can
disappear because a user deleted it or because its configured root is
temporarily unavailable during startup, remounting, or a permissions change.
Those cases cannot be distinguished from filesystem state alone. Trajex needs
one small, predictable boundary that protects a whole prior snapshot without
turning every nested I/O problem into permanent stale data.

The watcher-provided `changedPaths` list is also not a complete filesystem
inventory. It is an optimization hint and cannot by itself authorize
destructive cleanup.

## Decision

### The Provider source root is the reliability boundary

The inventory roots are Claude's configured `projects/` directory, Codex's
configured `sessions/` directory, and Pi's configured final session directory.

- `discover()` remains responsible for source inventory and reconciliation.
  The shared context exposes `indexedSessions()` so a provider can compare
  previously indexed `{ sessionId, jsonlPath }` entries with its current
  inventory.
- If the source root is absent or its root-level enumeration fails, discovery
  reports a root issue and emits no deletion tombstones for that Provider. A
  normal build keeps the Provider's last persisted snapshot while other
  Providers may continue updating.
- Once root-level enumeration succeeds, the inventory is authoritative. A
  missing or unreadable descendant directory is treated as an empty subtree;
  previously indexed sessions below it are retracted. This deliberately accepts
  deletion on nested I/O failures in exchange for a simple, bounded fallback.
- An indexed JSONL path missing from an authoritative inventory, or a path now
  identifying a different session, may produce an `IndexUnit` with
  `retractSessionIds`.
- The emitted unit is a **tombstone**. It carries the old session identity and
  source path, but does not pretend that a deleted file has parseable content.
  The parser/persist behavior for that unit is specified separately in
  ADR-0002 and ADR-0003.
- `changedPaths` is only a scope hint. It may authorize reconciliation for the
  changed path or subtree, but it does not make unrelated paths disappear.

### Force rebuild is all-or-nothing for existing Provider snapshots

- Before force cleanup, discovery preflights every Provider represented by the
  existing index. If any such Provider reports an unavailable source root, the
  whole rebuild aborts before destructive cleanup and the current database
  remains unchanged.
- A Provider with no prior indexed sessions and no available source root
  contributes no state and does not block rebuild. This keeps unused built-in
  Providers optional without weakening protection for an existing snapshot.
- When all existing Provider roots are available, force rebuild replaces all
  regenerable transcript projections with the authoritative current inventory.
  An available but empty root therefore removes that Provider's old sessions.
- App rebuild applies the same rule before swapping its temporary database;
  CLI/Core rebuild applies it before cleaning the current database. Approved
  durable `memories` survive either form.

Deleting an entire source root intentionally is ambiguous and therefore keeps
the old snapshot during a normal build. A user who wants to prove an empty
inventory can recreate the configured root as an empty readable directory and
build again.

## Consequences

- A genuinely deleted transcript or descendant subtree is removed once its
  source root can be enumerated.
- A transiently missing or unreadable source root cannot cause mass deletion.
- A transiently unreadable descendant can cause deletion by design; the root is
  the only fallback boundary.
- Same-path identity replacement is handled as two facts: retract the old
  session, then index the new session.
- A failed force preflight cannot partially clean or replace the usable index.
- Reconciliation is intentionally session-scoped to indexed transcript paths;
  auxiliary files without an independent session projection are out of scope.
- This ADR does not decide how JSONL corruption is parsed, how cursors advance,
  or how SQL transactions retry. Those are parser/persistence concerns in
  ADR-0002 and ADR-0003.
