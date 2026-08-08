# Provider parse boundaries and cursor semantics

## Status

Accepted — 2026-08-09

## Context

Claude Code, Codex, and Pi all emit JSONL, but their parser correctness
boundaries differ. Claude can resume an append-only file from a line cursor.
Codex needs the complete rollout to reconcile duplicate `event_msg` and
`response_item` records. Pi needs the complete tree to resolve its durable
leaf, branches, and compaction checkpoints.

Source inventory and deletion decisions belong to ADR-0004. This ADR starts
with a discovered `IndexUnit` and defines only how each provider turns source
content into canonical records and a cursor.

## Decision

| Provider | Cursor and parse flow | Malformed JSONL policy |
| --- | --- | --- |
| Claude | `mtime:lines`; skip accepted lines, stream the new tail, aggregate the session at the end | Stop after a malformed line beyond the cursor; return a cursor before the bad line. If the cursor is past EOF, restart from line 1 |
| Codex | Record `mtime:lines`, but replay the whole rollout; collect visible `event_msg` keys, then deduplicate `response_item`; session count is `total` | Stop at the first malformed line and return a cursor before it |
| Pi | Record `mtime:lines`, but replay the whole v3 tree; resolve durable leaf/compaction and project `visible` / `inactive` / `hidden` | Stop at the first malformed line and return a cursor before it |

The valid-prefix rule treats a malformed line as a recoverable boundary. The
records before it remain eligible for persistence, while later lines are
retried after the source is repaired. A provider may buffer a complete unit
when global context is required, but the adapter still emits the same
provider-neutral `TranscriptRecord` stream.

## Non-goals and ownership boundaries

- Whether a path is deleted or temporarily unavailable is ADR-0004.
- How records and cursors are committed, retracted, retried, and protected
  from memory deletion is ADR-0003.
- How canonical records become session detail is ADR-0005.

## Rationale

- Claude gets inexpensive append indexing without losing the ability to retry a
  damaged boundary.
- Codex and Pi pay for full replay because their projections depend on global
  file context.
- Provider-specific parsing stays out of SQLite and out of the UI.
