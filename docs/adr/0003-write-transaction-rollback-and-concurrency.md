# Unified persistence, transaction safety, and SQLite concurrency

## Context

The CLI and App must persist every Provider through one binding-agnostic layer.
That layer needs to handle normal records, full-replay replacement, deletion
tombstones, cursor advancement, FTS updates, and durable memories consistently.
SQLite can also report `SQLITE_BUSY` or an already-ended transaction, so an
unguarded rollback or statement-level retry can hide the real error or replay
only half a unit.

## Decision

### One unit, one persistence contract

Every discovered unit is committed independently:

```text
parse(unit, oldCursor)
  -> TranscriptRecord*; return cursor after the accepted prefix

persist(db, unit, generator)
  -> BEGIN IMMEDIATE
  -> retract unit.retractSessionIds first
  -> consume canonical records as upserts/updates
  -> delete-session removes one session's derived projection
  -> tombstone has no records and only performs the retraction
  -> write index_state only after generator completion
  -> COMMIT
```

Retraction and `delete-session` remove regenerable transcript projections
(`sessions`, `messages`, tools, workflows, subagents, and summaries), but
never `memories`. A database or record-write failure aborts the unit and leaves
its cursor unchanged. A provider's malformed-line boundary is different: the
valid prefix is a normal committed result, with the cursor deliberately before
the bad line.

### Transaction and retry policy

- `runWriteTransaction(db, work)` owns `BEGIN IMMEDIATE`, commit, conditional
  rollback, and diagnostics for both `better-sqlite3` and `node:sqlite`.
- Cleanup never masks the primary exception. Retry is an upper-layer policy and
  replays only a complete idempotent transaction after a confirmed inactive
  `SQLITE_BUSY*` failure.
- Per-file failures are reported as skipped files; finalize failures propagate.
  Affected session IDs are published only after commit.
- Force cleanup and finalize are atomic, retryable transactions.

### Writer ownership and concurrency

- A fresh `__app_heartbeat__` means the App owns writes; passive CLI paths stay
  read-only. `__app_last_successful_build__` is only an observability marker.
- `.trajex/writer.lock.sqlite` serializes writers across processes. App builds,
  heartbeats, CLI builds, migrations, attune, and manual rebuild participate.
- The App indexer runs one build at a time; lease deferral retains changed paths
  and retries without publishing false success.
- Bounded busy timeouts complement, but never replace, the lease and complete
  transaction rules.

## Non-goals and ownership boundaries

- Provider-specific parse strategy and malformed-line rules are ADR-0002.
- Source inventory, deletion proof, and tombstone creation are ADR-0004.
- Canonical UI/session-detail assembly is ADR-0005.

## Consequences

CLI and App share the same write semantics, full replay cannot accumulate stale
rows, deletion cleanup cannot remove durable memories, and a database failure
cannot silently advance a cursor.
