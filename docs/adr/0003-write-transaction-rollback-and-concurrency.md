# Unified persistence, transaction safety, and SQLite concurrency

> Revised 2026-08-10. This ADR also defines schema-readiness checks for passive
> reads and App database publication.

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
its cursor unchanged. A provider's malformed-line boundary is different:
records accepted under ADR-0002 are a normal committed result, while the cursor
remains before any malformed tail that the Provider leaves unconsumed.

### Transaction and retry policy

- `runWriteTransaction(db, work)` owns `BEGIN IMMEDIATE`, commit, conditional
  rollback, and diagnostics for both `better-sqlite3` and `node:sqlite`.
- Cleanup never masks the primary exception. Retry is an upper-layer policy and
  replays only a complete idempotent transaction after a confirmed inactive
  `SQLITE_BUSY*` failure.
- Per-file failures are reported as skipped files; finalize failures propagate.
  Affected session IDs are published only after commit.
- Force cleanup and finalize are atomic, retryable transactions. Source-root
  preflight from ADR-0004 completes before force cleanup begins; a failed
  preflight performs no destructive write.

### Writer ownership and concurrency

- A fresh `__app_heartbeat__` means the App owns writes; passive CLI paths stay
  read-only. `__app_last_successful_build__` is only an observability marker.
- `.trajex/writer.lock.sqlite` serializes writers across processes. App builds,
  heartbeats, CLI builds, migrations, attune, and manual rebuild participate.
- The App indexer runs one build at a time; lease deferral retains changed paths
  and retries without publishing false success.
- Bounded busy timeouts complement, but never replace, the lease and complete
  transaction rules.

### Schema readiness precedes data access

- Index freshness and schema readability are independent. A recent
  `__last_build__` may skip Provider discovery, but it cannot prove that an
  older database contains every column required by the current executable.
- Core query and attune entry points call `ensureReadableSchema()` before
  refreshing Provider data or opening their business connection. If additive
  migration is needed, it first respects a fresh daemon heartbeat, then obtains
  the writer lease and migrates through the normal writable open path.
- A required migration blocked by a fresh daemon or another lease holder fails
  before query or memory code runs, with `daemon_active` or `writer_busy` in the
  diagnostic. The caller must not continue and expose a lower-level
  `no such column` error.
- The desktop App publishes a real database connection to IPC consumers only
  after either confirming the schema is already readable or migrating it while
  holding the writer lease. If migration is blocked, it closes the real
  connection and retains an unavailable-state sentinel that reports the same
  stable schema-upgrade diagnostic at the SQL boundary.
- Schema migration does not require Provider discovery. This keeps a transient
  source-root failure from blocking a safe additive database upgrade.

## Non-goals and ownership boundaries

- Provider-specific parse strategy and malformed-line rules are ADR-0002.
- Source inventory, deletion proof, and tombstone creation are ADR-0004.
- Canonical UI/session-detail assembly is ADR-0005.

## Consequences

CLI and App share the same write semantics, full replay cannot accumulate stale
rows, deletion cleanup cannot remove durable memories, and a database failure
cannot silently advance a cursor.
