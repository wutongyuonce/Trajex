# Provider parse boundaries and unified persistence

## Status

Accepted — 2026-08-09

## Context

Claude Code, Codex, and Pi all emit JSONL, but their correctness boundaries are
different. Claude can resume an append-only file from a line cursor. Codex
needs the complete rollout to reconcile duplicate `event_msg` and
`response_item` records. Pi needs the complete tree to resolve its durable
leaf, branches, and compaction checkpoints. Treating all three as one generic
incremental parser either duplicates messages or loses context.

The same distinction must not leak into SQLite persistence. Retraction,
upsert, cursor advancement, FTS maintenance, and memory preservation need one
provider-independent contract.

## Decision

### Provider parse and discovery matrix

| Provider | Discover / cursor | Parse flow | Corruption policy | Reconciliation policy |
| --- | --- | --- | --- | --- |
| Claude | Discover main/subagent/workflow units; cursor is `mtime:lines` | Skip accepted lines, stream new tail, aggregate session at the end | A malformed line after the cursor stops the stream; commit the valid prefix and return a cursor before that line. If the cursor is past current EOF, restart from line 1 | When readable `projects/` inventory proves an indexed main transcript disappeared, emit a tombstone. Missing/unreadable root preserves the snapshot |
| Codex | Discover root rollouts; cursor records `mtime:lines`, but replay ignores the line offset | Read the whole file, collect visible `event_msg` keys, then replay `response_item` with deduplication; emit `countMode: total` | Stop at the first malformed line, commit the valid prefix, and return a cursor before it | When readable `sessions/` inventory proves an indexed rollout disappeared, emit a tombstone. Missing/unreadable root preserves the snapshot |
| Pi | Discover v3 session files; cursor records `mtime:lines`, but replay ignores the line offset | Read the whole tree, resolve durable leaf/compaction, and project `visible` / `inactive` / `hidden` | Stop at the first malformed line, commit the valid prefix, and return a cursor before it | Emit retraction for a proven deletion or same-path identity replacement. Missing/unreadable configured session root preserves the snapshot |

The valid-prefix rule is deliberate: a malformed source line is a recoverable
boundary, not permission to discard previously valid records. Lines after the
boundary are retried on the next run after the source is repaired.

### Unified persist flow

Every `IndexUnit` is committed independently:

```text
discover(ctx)
  -> normal unit or tombstone unit(retractSessionIds)
parse(unit, oldCursor)
  -> TranscriptRecord*; return newCursor only after the valid prefix is read
persist(db, unit, generator)
  -> BEGIN IMMEDIATE
  -> deleteSession(id) for each retractSessionIds
  -> consume records:
       session/message/tool/result/summary/... = provider-neutral upsert
       delete-session = delete one session's derived projection
  -> if generator completed: write index_state cursor
  -> COMMIT
```

`deleteSession()` removes `sessions`, `messages`, `tool_calls`, `tool_results`,
`subagents`, `workflow_agents`, `workflows`, and `summaries` rows associated
with the session. It never removes `memories`; memories are a separate,
user-confirmed durable domain. A tombstone has no source file to parse and
therefore only performs the retraction and records an empty cursor.

Cursor advancement is coupled to generator completion. If parsing or a record
write fails for reasons other than the provider's malformed-line boundary, the
unit transaction does not advance `index_state`; the next build retries the
unit. Transaction handling therefore protects database consistency without
turning a known malformed line into an all-history rollback.

## Rationale and trade-offs

- Claude gets inexpensive append indexing without giving up safe recovery from
  truncation or corruption.
- Codex and Pi pay the cost of full replay because their projections depend on
  global file context.
- Root-readability guards prevent a transient missing mount or startup state
  from becoming mass deletion.
- Explicit tombstones make deletion observable and testable while keeping the
  shared persist layer unaware of provider-specific directory layouts.
- Full rebuild remains available when a provider cannot prove inventory
  completeness or when a user wants authoritative re-import.

## Related decisions

- ADR-0001 — provider registry and one shared persist layer
- ADR-0006 — write transactions, rollback safety, and concurrency
- ADR-0008 — incremental discovery and safe transcript reconciliation
- ADR-0009 — Pi v3 context projection and visibility
