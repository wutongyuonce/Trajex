# Indexing architecture: provider registry and shared orchestration

> Revised 2026-08-29. This ADR defines the top-level layering and ownership
> boundaries. Detailed parsing, persistence, source reconciliation, and UI
> projection decisions live in ADR-0002 through ADR-0006.

## Context

Trajex previously had separate CLI and App indexers that duplicated Claude and
Codex parsing and slowly diverged in SQLite write behavior. More providers are
expected, and the CLI (`node:sqlite`) and App (`better-sqlite3`) must consume the
same indexing semantics.

## Decision

Split indexing into two orthogonal axes:

- **Provider registry.** Each source implements a complete adapter boundary:
  descriptor metadata, `watchTargets(root)`, `discover(context)`,
  `parse(unit, cursor)`, and `raw(lookup)`. Adapters understand provider
  formats and emit canonical `TranscriptRecord` values; they never touch a
  database. Adding a provider means adding and registering one adapter.
- **One shared orchestration/persist layer.** A provider-agnostic coordinator
  invokes discovery, parsing, per-unit persistence, index-state bookkeeping,
  FTS maintenance, and finalization. The database handle is injected, so both
  `node:sqlite` and `better-sqlite3` use the same implementation.
- **Canonical record center.** Provider-specific semantics are projected into
  the shared record language before persistence and session-detail assembly.
  Shared layers do not add provider branches or infer semantics from text.
- **Two triggers, one behavior.** App daemon mode converts Provider-owned typed
  watch targets into invalidation hints; passive CLI mode indexes on demand
  when no daemon owns writes. Both use the same discovery and persistence
  behavior and are separated by heartbeat/lease policy. Watch events never
  become a second source-inventory implementation.

## Ownership boundaries

- ADR-0002 defines provider parse strategies, cursors, and malformed-line
  boundaries.
- ADR-0003 defines the shared persist contract, transactions, retries, and
  writer coordination.
- ADR-0004 defines source inventory and deletion proof.
- ADR-0005 defines canonical records and session-detail assembly.
- ADR-0006 defines Pi's tree/visibility projection.
- ADR-0011 defines App watch targets, adaptive invalidation, bounded scheduling,
  and periodic reconciliation.

## Consequences

Golden parser tests can run without SQLite; persistence tests can use either
database binding; App and CLI cannot silently fork provider semantics; and a
new provider does not require changes to query or renderer code.
