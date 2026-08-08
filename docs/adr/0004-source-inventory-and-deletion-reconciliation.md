# Source inventory and deletion reconciliation

> Revised 2026-08-09. This ADR defines how discovery distinguishes a real
> source deletion from a temporarily unavailable filesystem. It does not define
> provider parsing or SQLite transaction mechanics; see ADR-0002 and ADR-0003.

## Context

The SQLite transcript index is a derived view of provider files. A file can
disappear because a user deleted it, because a session path was reused for a
new identity, or because a provider directory is temporarily unavailable
during startup, remounting, or a partial filesystem update. Treating every
missing path as deletion can erase an entire provider's history.

The watcher-provided `changedPaths` list is also not a complete filesystem
inventory. It is an optimization hint and cannot by itself authorize
destructive cleanup.

## Decision

- `discover()` remains responsible for source inventory and reconciliation.
  The shared context exposes `indexedSessions()` so a provider can compare
  previously indexed `{ sessionId, jsonlPath, source }` entries with its current
  inventory.
- A provider may emit an `IndexUnit` with `retractSessionIds` only when:
  1. the provider's configured root and relevant scope are readable;
  2. the current scan is complete for that scope; and
  3. an indexed path is absent from the current file set, or the same path now
     identifies a different session.
- The emitted unit is a **tombstone**. It carries the old session identity and
  source path, but does not pretend that a deleted file has parseable content.
  The parser/persist behavior for that unit is specified separately in
  ADR-0002 and ADR-0003.
- If the configured root is missing or unreadable, discovery marks the
  inventory incomplete and emits no tombstones. The last snapshot remains
  until a later complete scan or an explicit rebuild.
- `changedPaths` may narrow work inside a known-readable scope, but providers
  must preserve the same deletion semantics when it is omitted or stale.
- A full rebuild is the authoritative fallback when inventory completeness
  cannot be established or when cross-provider state is ambiguous.

## Consequences

- A genuinely deleted transcript is eventually removed without requiring a
  rebuild, provided its provider root can be completely inspected.
- A transiently missing mount or directory cannot cause mass deletion.
- Same-path identity replacement is handled as two facts: retract the old
  session, then index the new session.
- Reconciliation is intentionally session-scoped to indexed transcript paths;
  auxiliary files without an independent session projection are out of scope.
- This ADR does not decide how JSONL corruption is parsed, how cursors advance,
  or how SQL transactions retry. Those are parser/persistence concerns in
  ADR-0002 and ADR-0003.
