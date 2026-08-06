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

Pi session identity is the normalized header `cwd` plus header `id`, not the
JSONL path. This preserves identity across file moves while preventing
project-local `--session-id` values from merging across projects. Discovery
is limited to Pi's default `~/.pi/agent/sessions` and the final session
directory selected in App Settings. The App setting stores the session
directory itself; it does not store `~/.pi` or an agent root and the adapter
does not append `agent/sessions`. This also covers users whose Pi environment
resolves `PI_CODING_AGENT_DIR` or `PI_CODING_AGENT_SESSION_DIR` to a custom
session directory, without making Trajex read those environment variables.
Provider CLI path overrides and arbitrary additional roots are out of scope.
Discovery uses provider-owned source fingerprints and explicit retraction only
when Pi can prove the replacement or move, while a full rebuild remains the
recovery path for ambiguous filesystem changes.

The canonical projection marker advances together for Claude, Codex, and Pi;
when an old provider projection is present, the indexer performs one clean
transcript rebuild before writing the three v3 markers.

## Consequences

- Default App and query surfaces expose `visible` records; `inactive` evidence
  is explicitly expandable or requested with `includeInactive`.
- `hidden` remains source-suppressed content and is not a branch state.
- `is_meta` remains independent from visibility; visible metadata is still
  allowed when the source records it as evidence.
- Existing Pi IDs and rows require a canonical-index rebuild when the new
  identity or visibility contract is introduced.
