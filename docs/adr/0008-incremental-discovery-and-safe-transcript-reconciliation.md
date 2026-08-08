# Incremental discovery and safe transcript reconciliation

> Revised 2026-08-09. This ADR supersedes the earlier rule that ordinary
> indexing never inferred source-file deletion. See ADR-0010 for the complete
> provider matrix and shared persistence flow.

## Context

Trajex treats JSONL and similar transcript files as append-oriented sources,
but the index must also recover when a file is deleted or replaced. Blindly
deleting rows from one watcher event is unsafe: a provider root can disappear
temporarily during startup, a mount can be unavailable, or a directory scan
can be incomplete. The index also contains derived rows across messages,
tools, workflows, subagents, summaries, and sessions, while `memories` is a
durable user-owned layer.

## Decision

- Discovery remains provider-owned and incremental. The shared context exposes
  `indexedSessions()` so a provider can compare the previous indexed path set
  with a complete current inventory.
- A provider may emit an `IndexUnit` with `retractSessionIds` only when its
  configured root is readable and the old path is provably absent, or the same
  path is now occupied by a different session identity. The unit is a
  tombstone: `parse()` does not read a source file and returns an empty cursor.
- If the configured root is missing or unreadable, inventory is incomplete and
  no tombstone is emitted. The last snapshot remains visible until a later
  complete scan or an explicit rebuild.
- Shared `persist` retracts the listed sessions before consuming the unit's
  generator, in the same unit transaction. Retraction removes regenerable
  transcript projections but never `memories`.
- Full rebuild remains the authoritative recovery operation for ambiguous or
  cross-provider state. It clears regenerable tables and re-imports the
  currently readable sources while preserving `memories`.
- Parse corruption uses valid-prefix semantics rather than an all-build
  rollback: Claude stops after a malformed new line and leaves its cursor before
  it; Codex and Pi stop their full replay at the first malformed line and do the
  same. Database errors still use the normal transaction/error policy.

## Consequences

- Deleting a transcript from a healthy, readable provider root is eventually
  reflected without requiring rebuild.
- A temporarily unavailable root cannot erase an entire provider's history.
- A malformed line makes later lines temporarily invisible, but the valid
  prefix is durable and the broken boundary is retried after repair.
- The implementation is session-level: cleanup is keyed by the indexed
  `sessions.jsonl_path` and does not claim to reconcile arbitrary auxiliary
  files that have no independent session projection.
- Providers must keep their inventory rules and path scopes explicit; the
  shared layer does not guess whether a missing path is deletion or outage.
