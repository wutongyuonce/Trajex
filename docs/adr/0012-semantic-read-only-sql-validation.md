# Query sandbox uses semantic read-only SQL validation

> Accepted 2026-08-30. This ADR refines ADR-0007's Tier-1 guarantee: `sql()`
> remains read-only, but read-only status is no longer inferred by scanning SQL
> text for mutation words.

## Context

The previous `sql()` guard required a `SELECT` or `WITH` prefix and rejected the
whole string when it contained words such as `UPDATE`, `DELETE`, or `CREATE`.
That check could not distinguish executable SQL from data or comments, so valid
queries such as `SELECT 'live update'` failed.

The lexical guard was not the real mutation boundary. Query workers already
open the index through `openReadDb()` with `{ readOnly: true }`, so SQLite rejects
actual writes even when an earlier classifier misses them. The old guard mainly
provided an early error, but also rejected legitimate evidence queries.

The supported Node versions do not expose one uniform semantic API:

- `DatabaseSync.setAuthorizer()` is available only in newer Node releases;
- node:sqlite exposes `StatementSync.sourceSQL`, which identifies the first
  statement SQLite compiled;
- better-sqlite3 exposes `statement.readonly` instead of an authorizer;
- node:sqlite may compile the first statement while ignoring a trailing second
  statement unless Trajex checks the uncompiled tail itself.

## Decision

`sql()` enforces its contract in four layers:

1. Keep the top-level `SELECT`/`WITH` prefix check. This is the public sandbox
   contract and excludes statement-level `PRAGMA`.
2. When `setAuthorizer()` exists, deny SQLite action codes that write data,
   modify schema, attach databases, or create savepoints. Other actions are
   allowed; the denylist therefore does not reject read syntax merely because
   of words inside literals, comments, or identifiers.
3. Use `statement.readonly === false` when the driver exposes that property.
   Use `sourceSQL` to reject any tail other than whitespace or comments, making
   one statement per `sql()` call explicit.
4. Keep the read-only database connection as the final mutation boundary on
   every supported runtime. Older Node versions may return SQLite's native
   readonly error instead of Trajex's prepare-time contract error, but writes
   still fail closed.

Trajex returns the existing stable read-only error for authorizer denials and a
separate error for multiple statements. Multiple independent `sql()` calls in
one query script remain supported.

## Consequences

- Read-only queries may contain mutation words in literals, comments, quoted
  identifiers, predicates, recursive CTEs, and pragma table-valued functions.
- Actual writes remain blocked even on runtimes without `setAuthorizer()`.
- A second SQL statement can no longer be silently ignored.
- The SQLite abstraction reserves three optional driver capabilities:
  `setAuthorizer`, `readonly`, and `sourceSQL`; no new dependency is introduced.
- Regression tests cover false positives, multi-statement tails, and the
  file-backed read-only boundary.

This selectively synchronizes Obelisk commit `9e587f9`; its benchmark and CI
gate are not copied because the correctness boundary is already covered by the
focused tests and Trajex's existing project checks.
