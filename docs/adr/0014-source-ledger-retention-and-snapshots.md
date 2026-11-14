# The index is an archive: a source ledger, retention, and snapshots

Status: accepted (0.4.0). Supersedes the deletion half of ADR-0004 and the
force-cleanup half of ADR-0003; ADR-0002 parse boundaries are unchanged.

## Context

Until 0.3.x the index mirrored the source files: when a transcript file
disappeared, the next build deleted its session. Agents delete their own
history (Claude Code removes sessions after `cleanupPeriodDays`, 30 by
default), so Trajex silently lost it too. A rebuild re-derived only what was
still on disk, and a Claude session whose main transcript vanished while a
subagent file kept growing left orphan rows under a deleted session.

Upcoming snapshots and multi-device sync both need the same three facts per
source file: does it still exist, what does it own, and how far was it read.

## Decision

### 1. A source ledger owns every projected row

`sources` has one row per **logical source**, keyed by `(session_id, member)`:

| member | meaning |
| --- | --- |
| `''` | the session's own transcript (Claude main file, Codex thread, Pi file, DeepSeek root) |
| `<agent id>` | a Claude subagent file or a DeepSeek child/fork session |
| `workflow:<file>` | a Claude workflow JSON file |

Columns: `provider`, `path` (current location), `status` (`present` or
`missing`), `first_seen_at`, `last_seen_at`, `missing_since` (epoch ms).
Every row in `messages`, `tool_calls`, `tool_results`, `summaries`,
`subagents`, `workflows` and `workflow_agents` carries `source_id`. The
`sessions` row belongs to the session's `''` source. Invariant: every
projected row has exactly one owning source, and every source has a session
row.

Providers declare ownership in the record stream with a `source` record
(`session_id`, `member`, `path`, `replace`) before the records it owns.
`replace: true` means "this parse starts from the beginning": persist first
deletes the rows that source owns (and, for member `''`, the session row,
keeping its resolved `project_path`), then writes the new records.
Full-replay providers always replace; Claude replaces when it parses a file
from line 1 (a new file, a rewind, or a same-path replacement).

A source that moves keeps its key and gets a new `path` (Codex archiving or
compression, a renamed Pi file). A path belongs to at most one source: when
`(S, m)` is declared at a path another source holds, that other source is
**superseded**. Its rows and ledger row are deleted, and its session too if
that leaves the session with no sources. This is how evidence changes identity
(a DeepSeek child that was indexed as its own root and is later adopted by
its parent's tree). Trade-off: a file overwritten in place by a different
session is not retained. No supported agent rewrites a session file under a
new identity.

### 2. Disappearance marks; only purge deletes

Providers still own inventory authority (ADR-0004): only a readable root
proves absence, and watcher hints scope it. A provider now reports a vanished
path as a **missing unit** (`{ key: path, missing: true }`) instead of a
retraction. Core marks the source at that path `missing` and records
`missing_since`; no projected row is deleted. A later declaration of the same
`(session, member)` makes it `present` again, whether in the same plan or a
later batch. A compressed Codex rollout reappears as `.jsonl.zst` this way.

`sessions.source_status` is derived from the ledger and stored for querying:
`present` (the `''` source and all others present), `partial` (some missing,
or the `''` source absent or missing), `missing` (nothing present). When rows
arrive for a session that has no session row yet (a Claude subagent written
before, or without, its main transcript), persist creates a placeholder
session row, so rows are never orphaned.

**Purge** is the only deleting operation. It removes `missing` sources,
optionally only those missing for at least N days, together with their rows.
It then removes sessions left without sources. `memories` are never touched.
Purge is an App action and takes a snapshot first.

### 3. Rebuild re-reads; it does not delete

A rebuild (`trajex --build`, App "Rebuild index", or a provider marker change)
replays every discovered unit from a null cursor, so every present source
replaces its own projection in its own transaction. Missing sources and
sources the provider protects (unreadable files, unsupported DeepSeek
generations) are left as they are. Readers never see a session disappear
mid-rebuild, and the App no longer builds into a temporary database. A
projection whose file still exists but which the current parser no longer
emits (for example a thread type that is now ignored) is not cleaned up by a
rebuild. This is the accepted cost of never deleting from a rebuild.

### 4. Snapshots

A snapshot is `VACUUM INTO <TRAJEX_DIR>/snapshots/trajex-<UTC stamp>-<reason>.sqlite`,
a consistent, compacted copy of the whole index including FTS and memories.

- **When:**
  - daily after a successful App build (`autoSnapshot`, default on);
  - before an operation that rewrites or deletes projections in bulk: schema
    upgrade, provider replay or rebuild, purge, and restore.

  The pre-change snapshot is skipped if one was taken in the last 10 minutes,
  so an upgrade does not take two.
- **Retention:** the newest `snapshotKeep` files (default 3, 1–20) are kept;
  older ones are deleted after each snapshot.
- **Restore (App):** the snapshot is validated (`quick_check`, and its
  `user_version` must not be newer than this build) before anything changes.
  Then the App:
  1. takes a `pre-restore` snapshot;
  2. stops the indexer and closes the database;
  3. replaces the file and drops the WAL sidecars;
  4. copies the current `memories` back in, so approved memory is never lost;
  5. reopens, migrating an older snapshot, and resumes incremental sync.

  The archive model makes restore safe: the next build re-reads present
  sources and marks absent ones missing, and never deletes the history it
  just restored.

Snapshot failure aborts the purge, restore or replay that needed it. A failed
daily snapshot is retried after the next build. `PRAGMA user_version` (now 1)
versions the schema.

### 5. Migration from 0.3.x

On first open the schema adds `sources`, the `source_id` columns and
`sessions.source_status`. It then creates one source per session from
`sessions.jsonl_path`, plus one per `(session, agent_id)` with a null path,
and assigns every row to its owner. Each provider's canonical marker is
bumped, so the first build replays everything and providers declare their
exact sources and paths. Afterwards, path-less legacy sources that own nothing
are dropped, and real ones that were never re-declared stay `missing`. A
`pre-upgrade` snapshot is taken before migrating.

## Failure semantics

| Situation | Result |
| --- | --- |
| Root unavailable / inventory incomplete | no source changes status (ADR-0004) |
| File unreadable, header incomplete, unsupported generation | source unchanged, still `present`, old rows kept |
| Unit parse fails | its sources untouched, retried next build |
| File deleted | source `missing`, rows kept and searchable |
| Same `(session, member)` declared at a new path | source moved, stays `present` |
| A different source declared at a held path | holder superseded (rows deleted) |
| Snapshot cannot be written | purge / restore / replay aborted before changing anything |
| Snapshot corrupt or from a newer schema | restore refused, current index untouched |

## Non-goals

- Multi-device sync. It builds on this ledger (one writer per device), but the
  transport is a separate decision.
- Purge or restore from the CLI. Both are App actions. The CLI takes pre-change
  snapshots and never deletes.
- Per-segment retention inside one Codex thread; the thread is one source.
- Cleaning up projections of files that still exist but are no longer emitted.

## Consequences

- The index grows with history. Purge and the per-session status make that
  visible and controllable.
- Each projected table gains a `source_id` column and index. Replacing one
  source deletes by `source_id` instead of by session, so a partial session
  keeps its missing members.
- `retractSessionIds`, `delete-session` and the DeepSeek frozen-tree rules
  are removed. Supersession and missing units express the same cases.
