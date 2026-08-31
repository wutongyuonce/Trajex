# Pi v3 context is projected through visibility

Trajex supports only official Pi v3 session JSONL and treats the source format
as a tree with a durable leaf and compaction checkpoints. The Pi adapter fully
replays a session, resolves the leaf and both compaction forms
(`firstKeptEntryId` and `retainedTail`), and projects the resulting context
into the shared `visible | inactive | hidden` visibility contract.
Superseded branches remain queryable evidence only when explicitly requested;
the canonical model has no `is_sidechain` field, and the same field is removed
from Claude and Codex records rather than carrying provider-specific branch
semantics.

For a chain containing multiple compactions, the nearest `retainedTail`
checkpoint bounds the physical parent walk. Within that bounded path, only the
latest compaction selects context: a retained-tail checkpoint replaces all
earlier physical messages, while a legacy compaction may retain ancestors from
its `firstKeptEntryId` only when that entry remains inside the bounded path.
Retained-tail messages are materialized once and reconnect later messages;
compacted physical ancestors remain indexed as `inactive` evidence.
Retained-tail branch and compaction summaries remain distinct summary evidence,
but all usage copied into the retained snapshot is excluded from accounting:
the snapshot preserves context and does not represent another model execution.

Pi's native tool-call ID is not a session-wide occurrence identity because a
fork can reuse it. Canonical tool-call IDs therefore derive from the projected
tool-use message UUID. Tool results resolve the nearest matching native ID in
the tool scope inherited through that entry's `parentId`; compaction and branch
summaries clear inherited scope, while a retained tail rebuilds its own scope.
An unmatched result remains message evidence but does not create a false
`tool_result` edge.

Source content blocks remain distinct canonical evidence. User text and image
blocks keep source order; images are represented by MIME type and encoded
length rather than persisting their base64 payload. Empty assistant thinking
placeholders are omitted, while `errorMessage` is retained as the final error
block and receives that response's usage. This keeps failed model calls and
multimodal input visible without bloating the index.
Tool-result messages also retain their own model usage, including normalized
cache read and write input, because nested model tools spend tokens independently
of the assistant turn that invoked them.

Tree identity is validated before projection. Entry IDs must be unique,
`parentId` must be a string or `null`, durable leaf targets must be `null` or
resolve to an entry, parent chains must be acyclic, and checkpoint
`retainedTail` values must have valid container structure. A missing string
parent remains an official orphan root rather than corruption. JSON syntax
damage still ends replay at the valid prefix; a structurally invalid parsed
tree fails the whole unit so the indexer cannot commit a fabricated context.

Raw lookup follows the same projected identity instead of returning an entire
physical entry indiscriminately. It validates the configured source boundary,
the indexed session ID, and the session header, then resolves the entry plus an
optional assistant-block or retained-tail index. The raw `text` is the selected
message object and `messageText` is the complete selected block. A retained
message therefore does not expose sibling messages stored in the same
compaction entry. Invalid or stale lookup coordinates return `null`; this is a
read-time evidence rule and does not change canonical IDs or persisted rows.

Pi session identity is the normalized header `cwd` plus header `id`, not the
JSONL path. This preserves identity across file moves while preventing
project-local `--session-id` values from merging across projects. Discovery
is limited to Pi's default `~/.pi/agent/sessions` and the final session
directory selected in App Settings. The App setting stores the session
directory itself; it does not store `~/.pi` or an agent root and the adapter
does not append `agent/sessions`. This also covers users whose Pi environment
resolves `PI_CODING_AGENT_DIR` or `PI_CODING_AGENT_SESSION_DIR` to a custom
directory: `PI_CODING_AGENT_SESSION_DIR` points at the session directory
directly, while `PI_CODING_AGENT_DIR` points at the agent root whose
`sessions` subdirectory holds the sessions — without making Trajex read those
environment variables.
Provider CLI path overrides and arbitrary additional roots are out of scope.
Discovery uses provider-owned source fingerprints and explicit retraction when
Pi can prove a same-path identity replacement or a deleted file below a
root-enumerable session directory. If that root is missing or root enumeration
fails, Pi preserves the previous snapshot instead of emitting mass tombstones;
descendant failures are treated as empty subtrees. Force rebuild preflights
existing Provider roots before cleanup. The retraction and parse-prefix rules
are shared with the other adapters; see ADR-0002 and ADR-0004.

Each Provider owns an independent canonical projection marker. When Pi's
projection identity or association rules change, its marker advances and the
indexer performs a clean transcript rebuild before writing the new marker.

## Consequences

- Default App and query surfaces expose `visible` records; `inactive` evidence
  is explicitly expandable or requested with `includeInactive`.
- `hidden` remains source-suppressed content and is not a branch state.
- `is_meta` remains independent from visibility; visible metadata is still
  allowed when the source records it as evidence.
- Existing Pi IDs and rows require a canonical-index rebuild when identity,
  visibility, or association rules change.
