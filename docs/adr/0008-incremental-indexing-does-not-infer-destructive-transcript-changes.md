# Incremental indexing does not infer destructive transcript changes

**Context.** Trajex treats JSONL and similar transcript files as append-oriented
sources during ordinary indexing. Providers expose an opaque cursor (currently
typically an mtime plus processed-line count) and emit the records that can be
reliably reconciled from the observed change. This is intentionally different
from treating SQLite as a live mirror that must infer every filesystem
mutation.

A transcript may be deleted, truncated, rewritten, compacted, replaced by a
partial write, or otherwise changed in a way that cannot be distinguished safely
from a normal incremental append using the provider cursor alone. Automatically
deleting SQLite rows in response to such a change could erase valid history
when the source update is incomplete or temporarily inconsistent. It would also
require every provider to define a reliable mapping from an absent/rewritten
unit back to all derived rows, including subagents, workflows, summaries,
tool calls, and tool results.

**Decision.** Ordinary incremental indexing does **not** infer destructive
transcript changes. In particular:

- A deleted or otherwise missing source file does not automatically delete its
  existing SQLite session and derived rows.
- A transcript rewrite or truncation is not assumed to be a complete replacement
  of the previously indexed session. Provider-specific incremental parsing may
  continue from its stored cursor when the change is not explicitly recognized
  as a semantic retraction.
- SQLite is a derived, incrementally maintained search index, not a destructive
  filesystem mirror. Upserts and explicit provider records remain the normal
  synchronization mechanism.
- A full rebuild is the authoritative reconciliation operation. It clears
  regenerable transcript tables, discovers the currently existing source files,
  and re-imports them from scratch. The durable `memories` layer is preserved.

This rule has one deliberate exception: a provider may emit an explicit
`delete-session` record when it understands the semantic retraction, such as a
Codex guardian/auto-review thread that must not be shown. That is an explicit
provider decision, not an inference from a missing or damaged file.

**Operational consequence.** When transcript files have been deleted, restored,
rewritten, or otherwise damaged outside the normal append flow, users should
run the full rebuild/re-index operation. Until then, SQLite may retain stale
derived rows by design. Incremental indexing remains optimized for safe,
append-oriented updates; rebuild is the recovery path for source history
reconciliation.

**Consequences.** Normal indexing avoids destructive guesses and remains safe
around partial filesystem updates, at the cost of temporary stale rows after
destructive source changes. The cost is explicit and bounded: rebuild provides
the authoritative result. Future providers may implement stronger replacement
semantics, but only when they can prove the source unit is complete and can
identify every derived row that must be removed.
