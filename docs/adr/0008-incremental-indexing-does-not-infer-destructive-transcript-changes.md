# Incremental discovery and full session replacement

**Context.** Trajex treats JSONL and similar transcript files as append-oriented
sources during ordinary indexing. Providers expose an opaque cursor, typically
including a source fingerprint, and emit the records that can be
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

**Decision.** Discovery remains incremental, but providers with a full-replay
session projection use explicit session replacement. In particular:

- A deleted or otherwise missing source file does not automatically delete its
  existing SQLite session and derived rows.
- A transcript rewrite or truncation is not assumed to be a complete replacement
  of the previously indexed session. Provider-specific incremental parsing may
  continue from its stored cursor when the change is not explicitly recognized
  as a semantic retraction.
- SQLite is a derived search index, not a destructive filesystem mirror. Claude
  may continue incrementally from its cursor; Pi and Codex root threads fully
  replay changed files and explicitly replace the affected session projection.
- A full rebuild is the authoritative reconciliation operation. It clears
  regenerable transcript tables, discovers the currently existing source files,
  and re-imports them from scratch. The durable `memories` layer is preserved.

Pi and Codex use `delete-session` as the first record of a changed full-replay
session. `persist` removes the old transcript-derived rows for that session,
preserves durable `memories`, then consumes the complete record stream and
writes the replacement projection. Codex
child/fork/subagent/guardian rollouts are filtered out before parsing, so they
do not emit `delete-session` or any other indexed records.

**Operational consequence.** When transcript files have been deleted, restored,
rewritten, or otherwise damaged outside the normal append flow, users should
run the full rebuild/re-index operation. Until then, SQLite may retain stale
derived rows by design. Incremental indexing remains optimized for safe,
append-oriented updates; rebuild is the recovery path for source history
reconciliation.

**Consequences.** Full replay keeps each changed Pi/Codex session projection
exactly aligned with the records emitted from the current complete file, at the
cost of deleting and rebuilding that session inside the write transaction.
Source-file deletion or partial filesystem updates still do not trigger a
session delete automatically; rebuild remains the recovery path for those
cases.
