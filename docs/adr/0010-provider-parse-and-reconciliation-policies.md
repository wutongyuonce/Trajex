# Provider parse boundaries and unified persistence

## Status

Accepted — 2026-08-09

## Context

Claude Code, Codex, and Pi all emit JSONL, but their parser correctness
boundaries differ. Claude can resume an append-only file from a line cursor.
Codex needs the complete rollout to reconcile duplicate `event_msg` and
`response_item` records. Pi needs the complete tree to resolve its durable
leaf, branches, and compaction checkpoints.

The source-inventory question — whether a missing path is a real deletion — is
owned by ADR-0008. This ADR starts after discovery has produced an
`IndexUnit`, and defines how that unit is parsed and persisted consistently.

## Decision

### Provider parse matrix

| Provider | Cursor and parse flow | Malformed JSONL policy |
| --- | --- | --- |
| Claude | `mtime:lines`; skip accepted lines, stream the new tail, aggregate the session at the end | Stop after a malformed line beyond the cursor; commit the valid prefix and return a cursor before the bad line. If the cursor is past EOF, restart from line 1 |
| Codex | Record `mtime:lines`, but replay the whole rollout; collect visible `event_msg` keys, then deduplicate `response_item`; session count is `total` | Stop at the first malformed line; commit the valid prefix and return a cursor before it |
| Pi | Record `mtime:lines`, but replay the whole v3 tree; resolve durable leaf/compaction and project `visible` / `inactive` / `hidden` | Stop at the first malformed line; commit the valid prefix and return a cursor before it |

The valid-prefix rule treats a malformed line as a recoverable boundary, not
as permission to discard earlier valid records. Lines after the boundary are
retried after the source is repaired.

### Unit-to-persist contract

Discovery may hand the indexer either a normal unit or the tombstone unit
defined by ADR-0008. `persist()` applies the same contract to both:

```text
parse(unit, oldCursor)
  -> TranscriptRecord*; return newCursor after the accepted prefix

persist(db, unit, generator)
  -> BEGIN IMMEDIATE
  -> retract each unit.retractSessionIds
  -> consume records as provider-neutral upserts/updates
  -> delete-session removes one session's derived projection
  -> tombstone has no records and only performs the retraction
  -> write index_state only after generator completion
  -> COMMIT
```

Retraction removes regenerable rows for the session (`sessions`, `messages`,
tools, workflows, subagents, and summaries) but never removes `memories`.
`delete-session` and `retractSessionIds` therefore share the same derived-data
boundary without making memories part of transcript replay.

Cursor advancement is coupled to generator completion. A database or record
write failure aborts the unit and leaves its cursor unchanged; the next build
retries it. A provider's malformed-line boundary is different: it is surfaced
as a normal, committed prefix with a deliberately earlier cursor.

## Non-goals and ownership boundaries

- This ADR does not decide whether a source path is deleted or merely
  unavailable; ADR-0008 owns inventory completeness and tombstone creation.
- This ADR does not define SQLite rollback, writer leases, or BUSY retry policy;
  ADR-0006 owns those mechanics.
- This ADR does not add provider branches to UI assembly; ADR-0007 owns the
  canonical transcript/detail seam.

## Rationale and trade-offs

- Claude gets cheap append indexing while still retrying a damaged boundary.
- Codex and Pi pay for full replay because their projections depend on global
  file context.
- A single persist contract keeps provider-specific parsing out of SQLite and
  keeps CLI/App behavior aligned.
- Full rebuild remains available when a provider cannot provide a complete
  inventory or when a user wants authoritative re-import.

## Related decisions

- ADR-0001 — provider registry and one shared persist layer
- ADR-0006 — write transactions, rollback safety, and concurrency
- ADR-0007 — canonical transcript records and session-detail assembly
- ADR-0008 — source inventory and deletion reconciliation
