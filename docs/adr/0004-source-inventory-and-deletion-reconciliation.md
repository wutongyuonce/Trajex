# Source-root availability and deletion reconciliation

> Revised 2026-11-14. This ADR defines the reliability boundary for Provider
> discovery and the precondition for rebuilds. Under
> [ADR-0014](0014-source-ledger-retention-and-snapshots.md), an authoritative
> absence marks the source `missing` in `sources` instead of deleting its
> projection; only explicit purge deletes.

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
configured `sessions/` directory (and `archived_sessions/` once present or
indexed), Pi's configured final session directory, and DeepSeek Harness's
configured sessions directory. Moving a source file between a provider's roots
(such as archiving a Codex rollout) republishes the session at its new path without
tombstoning it. A DeepSeek Harness session directory that still holds a canonical
artifact but no readable supported generation keeps its last snapshot instead of
being tombstoned (ADR-0013).

- `discover()` remains responsible for source inventory and reconciliation.
  The shared context exposes `knownSources()` so a provider can compare
  previously declared `{ path, sessionId, member, status }` entries with its
  current inventory.
- If the source root is absent or its root-level enumeration fails, discovery
  reports a root issue and emits no missing units for that Provider. A normal
  build keeps the Provider's last persisted state while other Providers may
  continue updating.
- Once root-level enumeration succeeds, the inventory is authoritative. A
  missing or unreadable descendant directory is treated as an empty subtree;
  previously present sources below it are marked `missing` (ADR-0014).
- A known source path missing from an authoritative inventory produces a
  missing `IndexUnit` (`{ key: path, sessionId, missing: true }`). Same-path
  identity replacement is handled by supersession when the new identity
  declares that path (ADR-0014).
- `changedPaths` is only a scope hint. It may authorize reconciliation for the
  changed path or subtree, but it does not make unrelated paths disappear.

### Force rebuild is all-or-nothing for existing Provider snapshots

- Before force rebuild, discovery preflights every Provider represented by the
  existing local sources (`sources WHERE device_id IS NULL`). If any such
  Provider reports an unavailable source root, the whole rebuild aborts before
  any write and the current database remains unchanged.
- A Provider with no prior known sources and no available source root
  contributes no state and does not block rebuild. This keeps unused built-in
  Providers optional without weakening protection for an existing index.
- When all existing Provider roots are available, force rebuild replays every
  present source in place from a null cursor after taking a `pre-rebuild`
  snapshot ([ADR-0014](0014-source-ledger-retention-and-snapshots.md)).
  Known sources missing from an available root are marked `missing` and kept
  until explicit purge. Approved durable `memories` survive in place.

Deleting an entire source root intentionally is ambiguous and therefore keeps
the old state during a normal build. A user who wants to prove an empty
inventory can recreate the configured root as an empty readable directory and
build again (which marks those sources `missing`), then purge them in Settings.

### Daemon recovery from an incomplete inventory

- App builds return structured source-root issues to the daemon instead of
  treating a partial inventory as complete.
- The daemon retries a full inventory after 30 seconds and exponentially backs
  off repeated failures to a maximum interval of 10 minutes. A successful full
  inventory resets the delay; writer-lease deferrals keep their separate fast
  retry.
- Watch roots that do not exist at startup are retried independently. When a
  root appears, the App attaches its watcher and requests a full inventory so
  the recovered source is indexed before incremental events take over.
- The App also requests a full inventory every five minutes. This periodic
  reconcile bounds how long a missed filesystem event can leave the derived
  index stale, while missing transitions remain authorized only by Provider
  discovery after successful root enumeration.
- A manual force rebuild still fails immediately on an unavailable root. It
  never turns into an unbounded background rebuild.

## Consequences

- A genuinely deleted transcript or descendant subtree is marked `missing` once
  its source root can be enumerated, and is deleted only by explicit purge
  ([ADR-0014](0014-source-ledger-retention-and-snapshots.md)).
- A transiently missing or unreadable source root cannot cause mass `missing`
  transitions.
- A source root that recovers while the App remains open is inventoried and
  watched without requiring an App restart or manual rebuild.
- A transiently unreadable descendant marks its sources `missing` until the
  next readable scan restores them to `present`; the root is the fallback
  boundary.
- Same-path identity replacement is handled by supersession when the new
  identity declares that path (ADR-0014).
- A failed force preflight cannot partially modify the index.
- Reconciliation is source-scoped (`sources` table): main transcripts,
  subagents, workflows, and DeepSeek tree members each track their own path and
  status.
- Adaptive watcher mechanics and scheduling latency are defined in ADR-0011;
  this ADR defines the source-root availability boundary.
- This ADR does not decide how JSONL corruption is parsed, how cursors advance,
  or how SQL transactions retry. Those are parser/persistence concerns in
  ADR-0002 and ADR-0003.
