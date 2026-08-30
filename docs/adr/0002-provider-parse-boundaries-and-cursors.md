# Provider parse boundaries and cursor semantics

> Revised 2026-08-31. This ADR also records the current identity relationship
> between a discovered unit, its cursor key, and the persisted session source
> path, plus the deferred extension point for multi-file providers.

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
| Claude | `mtime:lines:size:ctime:inode`; skip accepted lines, stream the new tail, aggregate the session at the end | Consume and skip newline-terminated malformed records, then continue. Leave an unterminated malformed tail unconsumed because it may still be growing. Legacy `mtime:lines` cursors remain readable. If the cursor is past EOF, restart from line 1 |
| Codex | `mtime:lines:size:ctime:inode`; replay the whole stable rollout, collect visible `event_msg` keys, then deduplicate `response_item`; session count is `total` | Stop at the first malformed line and return a cursor before it. If the snapshot changes while reading, abort the unit |
| Pi | `mtime:lines:size:ctime:inode`; replay the whole stable v3 tree, resolve durable leaf/compaction and project `visible` / `inactive` / `hidden` | Stop at the first malformed line and return a cursor before it. If the snapshot changes while reading, abort the unit |

Claude distinguishes a complete malformed record from a possibly torn tail:
only the unterminated tail remains a retry boundary. Codex and Pi retain the
valid-prefix rule, under which records before a malformed line remain eligible
for persistence while later lines wait for source repair. A provider may buffer
a complete unit when global context is required, but the adapter still emits
the same provider-neutral `TranscriptRecord` stream.

All file-backed transcript cursors compare `mtime`, `size`, `ctime`, and inode.
Codex and Pi additionally compare the snapshot before and after their full read,
so a rewrite cannot commit records from one file version with another version's
cursor. Legacy two-part full-replay cursors are replayed once and upgraded.

### Unit keys and persisted source paths

`IndexUnit.key` identifies the unit whose parse progress is stored in
`index_state`. A session record's `jsonl_path` identifies its primary source
transcript for provenance and raw lookup. These fields have different semantic
roles even though every current built-in Provider (Claude, Codex, and Pi)
deliberately emits the same concrete path for both. The shared indexing code may
rely on that equality while those are the only supported Providers.

The cursor is stored in the `index_state` row keyed by `IndexUnit.key`:

```text
IndexUnit.key
    ↓
index_state.jsonl_path = unit.key
    └── cursor / mtime / lines_processed
```

`index_state.cursor` preserves the Provider's returned string verbatim.
`mtime` and `lines_processed` remain denormalized compatibility fields taken
from the first two colon-separated segments for ordering, markers, and old
databases. `storedProviderCursor()` prefers the opaque `cursor` column and
falls back to reconstructing legacy `mtime:lines` when that column is null.
Shared persistence therefore requires numeric first and second segments today,
but it no longer discards additional Provider-owned cursor state.

`index_state.jsonl_path` is a historical column name: semantically it is a
general unit-state key and is not required to name a JSONL file. If a future
Provider allows a persisted session source path to differ from its unit key,
cursor lookup must follow this chain:

```text
sessions.jsonl_path
    ↓ Provider.sessionUnitKey()
IndexUnit.key
    ↓
SELECT cursor
FROM index_state
WHERE jsonl_path = unit.key
```

Trajex does not add a `sessionUnitKey` abstraction yet. If a future Provider
treats a directory or a group of files as one indexing unit while persisting a
particular JSONL file as the session's primary source, then `unit.key` and
`session.jsonl_path` may differ. Supporting such a Provider requires an explicit
Provider-owned mapping from the persisted session back to its unit key before
cursor lookup, version-marker replay, or other unit-state reconciliation uses
the session path. The shared indexer must not infer that mapping from a
Provider-specific directory layout.

## Non-goals and ownership boundaries

- Whether a path is deleted or temporarily unavailable is ADR-0004.
- How records and cursors are committed, retracted, retried, and protected
  from memory deletion is ADR-0003.
- How file changes schedule App builds is ADR-0011; watcher signatures are not
  parser cursors and do not authorize deletion.
- How canonical records become session detail is ADR-0005.

## Rationale

- Claude gets inexpensive append indexing, does not stall behind permanent
  newline-terminated garbage, and still retries a possibly growing torn tail.
- Codex and Pi pay for full replay because their projections depend on global
  file context.
- Provider-specific parsing stays out of SQLite and out of the UI.
