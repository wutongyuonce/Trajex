# Write-transaction rollback safety and SQLite concurrency

**Context.** The app surfaced `Obelisk index build failed: cannot rollback - no
transaction is active`. That text was a secondary cleanup failure. SQLite had
already ended the transaction, then the catch block's unguarded `ROLLBACK`
threw over the primary exception and turned a skippable per-file failure into a
whole-build failure. The masked exception was not preserved, so contention
(`SQLITE_BUSY` / `SQLITE_BUSY_SNAPSHOT`) is the leading explanation rather than
a proven historical fact. It is plausible because daemon builds, manual
rebuilds, CLI passive-pull indexing, heartbeat writes, and reads share one WAL
database.

`busy_timeout` alone is not a correctness fix. In particular,
`SQLITE_BUSY_SNAPSHOT` is not made safe by waiting longer, and retrying only the
failed statement can replay part of a transaction.

**Decision.** Use one transaction primitive plus two explicit coordination
layers.

- `packages/core/src/tx.ts` owns the binding-agnostic
  `runWriteTransaction(db, work)`.
  Adapters expose transaction state from better-sqlite3's `inTransaction` and
  node:sqlite's `isTransaction`. The primitive performs `BEGIN IMMEDIATE`, runs
  `work` exactly once, commits, and attempts rollback only when the binding says
  a transaction is active or its state is unknown. Cleanup never masks the
  primary exception. Diagnostics record phase, SQLite code, rollback outcome,
  transaction state, label, and attempts.
- Retry is an upper-layer policy in `packages/core/src/write-coordinator.ts`, never hidden
  inside the transaction primitive. Only an idempotent whole transaction that
  failed during work/commit with `SQLITE_BUSY*` and is confirmed inactive may be
  retried. The default is three attempts within a one-second budget with short
  backoff. BEGIN contention is deferred to the build scheduler; an active or
  unknown post-error transaction aborts the build.
- Per-file failures remain warnings and are reported in `skippedFiles`; finalize
  failures propagate. `affectedSessionIds` is updated only after the relevant
  commit. Force cleanup is one atomic, retryable transaction, and finalize is
  likewise retried as a complete idempotent transaction.
- A fresh `__app_heartbeat__` is policy ownership: while it is fresh, the CLI
  opens no write connection and performs no migration, schema setup, checkpoint,
  index build, or `attune`. `__app_last_successful_build__` remains an
  observability/freshness marker and is not required for ownership. The CLI
  checks ownership again after acquiring the hard lease to close the TOCTOU
  window. Search/query connections are read-only.
- A dedicated `.obelisk/writer.lock.sqlite` provides the cross-process safety
  mutex on every platform. Acquisition is `BEGIN IMMEDIATE` with non-blocking or
  bounded waiting; release is idempotent. App builds and heartbeats, CLI builds
  and attune, app schema/legacy migrations and memory mutations, and manual
  rebuild all participate. Manual rebuild's main process owns the lease across
  worker build, atomic target replacement, and database reopen; the worker uses
  the explicit `caller-held` mode.
- The app's in-process indexer service permits one build at a time. A lease
  deferral retains changed paths and schedules a short retry without announcing
  a successful build. Service start publishes the ownership heartbeat
  immediately, then refreshes it periodically.
- Index-writer and CLI read connections use an explicit 250 ms SQLite busy
  timeout inside the larger bounded coordination budget. The long-lived app
  query connection retains a 5 s timeout; heartbeat is deliberately non-blocking
  (`0 ms`) so it never stalls the Electron main thread. Builds use
  `BEGIN IMMEDIATE`. Routine checkpointing is `PASSIVE`; blocking `TRUNCATE` is
  reserved for explicit maintenance.

**Verification.** Fast tests inject auto-rollback and BUSY failures to prove the
primary error is preserved, retry replays the whole transaction, persistent
per-file failure is skipped, force cleanup is atomic, and affected-session state
is commit-aware. The Electron harness uses real Electron-ABI better-sqlite3 and
two child processes: one holds the SQLite writer lease until signalled, while
the other runs synchronous `buildIndex`. It verifies both release-within-budget
success and bounded `writer_busy` deferral. Separate arbitration tests prove a
heartbeat-only daemon marker keeps query and attune paths read-only.

**Consequences.** Heartbeat and lease have deliberately different jobs: the
heartbeat decides who should write, while the lease guarantees writers cannot
overlap when policy information races or is stale. A single bad transcript can
still be skipped so the index self-heals on a later build; structural/finalize
failures remain visible. Longer timeouts must not replace the transaction and
ownership rules recorded here.
