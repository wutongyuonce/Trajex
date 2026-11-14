# DeepSeek Harness sessions are indexed as fully replayed session trees

Trajex indexes DeepSeek Harness (DSH) history read-only from the configured
sessions directory, or `$DSH_HOME/sessions`, or `~/.dsh/sessions`. `$DSH_HOME`
is resolved the way the harness does: an empty or blank value falls back to
`~/.dsh`, only a bare `~` and the `~/` / `~\` prefixes expand, and anything else
is resolved literally against the working directory.

## Layout and generations

DSH stores `<root>/<project-dir>/<session-dir>/session[.vN].jsonl[.zstd]`. The
first line is an immutable session header; every later line is one
`{type, seq, time, data, surfaceOp?}` event. A format migration publishes a
higher generation beside the untouched old file, so each session directory
contributes only its **highest supported** generation (v0–v4). A newer
unsupported generation never hides the readable one, and a directory with only
unsupported or unreadable artifacts is skipped and protected from deletion
(ADR-0004) until a supported generation is readable again. `session.lock`,
migration temporaries, and `*.tmp` files never match a generation. Session
identity comes from the header: `deepseek:<encoded id>:<sha256 of normalized
cwd>`, the same project-scoped scheme Pi uses.

The default encoding is a concatenation of independent checksummed Zstandard
frames. Trajex scans complete frame ranges with a vendored read-only scanner
and decodes each frame with Node's built-in `zlib.zstdDecompressSync`
(Node.js 22.15+); Core takes no extra runtime dependency. A torn final frame is
ignored because DSH repairs that tail itself, and a complete frame that fails
validation aborts the unit. On older Node runtimes compressed artifacts are
skipped with one process warning.

## Unit model

One `IndexUnit` is a root session tree: a session plus every session attached
to it through `parentSession` within the same project scope, followed through
ancestors with a cycle guard. The unit key and the session's `jsonl_path` are
the root artifact path. Children are sidechain members of the root session:
their messages carry `agent_id` (the child's identity) and each child produces
one `subagents` row. A `started subagent <id>` tool result links the child to
the spawning tool call. The cursor is
`maxMtime:lines:dsh-tree-v1:<sha256 of member path + snapshot>`. Every discovery
compares each tree's current signature, not just the trees inside watcher-hinted
directories: adding or removing one member changes the shape of a tree whose
other directories were not touched. A tree is skipped only when its signature
matches and its root is already indexed under the same path; deletion
tombstones remain scoped to watcher hints or a full reconcile.

A session directory with no readable supported generation freezes the tree it
belongs to, so replaying that tree cannot delete the member's last snapshot.
Membership is taken from the blocked header when it is still readable. Trees
whose root names the blocked session as parent are frozen too, so they are not
published as separate roots. If the header itself is unreadable, every already
indexed tree with a member in that project directory is frozen; trees that were
never indexed have no snapshot to lose and are still published.

Any member change fully replays the tree: the unit emits `delete-session` for
the root, then every member. This follows ADR-0002's full-replay rule instead of
upstream Obelisk's append fast path, which needs per-member prefix hashes,
checkpointed parent chains and anchor state that Trajex does not otherwise
carry. Each member is snapshotted before and after its read.

When a session that was indexed as its own root gains an ancestor, the tree
that adopts it lists the old identity in `retractSessionIds`, so the retraction
happens inside the same transaction as the re-emission. Such identities are
never tombstoned separately, because a tombstone's cascade on `agent_id` would
delete the rows the tree just wrote. Old identities whose path now sits in one
of the tree's session directories are retracted the same way.

## Projection

- `user/message` becomes a user message. Producer-owned sources
  (`source.kind !== 'user'`) and `surfaceOp: { op: 'replace' }` checkpoints are
  `is_meta`.
- `assistant/message` produces reasoning, text and one `tool_use` anchor per
  step, keyed by the native message id (falling back to turn/step). Usage goes
  on the primary message only, and input includes cache read/write tokens.
  Packed chunk rows, embedded streams and `assistant/attempt` duplicate the
  final message and are not indexed.
- `tool/call` and `tool/result` become tool calls and results anchored to the
  assistant step. A tool call the model requested that never started keeps its
  name and arguments. v0–v3 report errors through the `tool-result` wrapper,
  v4 through the tool-role message's `isError`, and `data.error` marks failure
  in every version. PTC and code-mode dispatches hang off the outer call's
  anchor.
- `compaction/summary` becomes a `summary` record. Events whose `seq` lies in a
  later `surfaceOp.replace` range stay indexed as `inactive` evidence, matching
  Pi's compaction semantics (ADR-0006) rather than upstream's choice to keep
  them visible.
- A seeded child attached to its parent skips the inherited prefix, which the
  parent already records. The prefix ends at the last
  `session/end-seed { inherited: true }` (v2+) or at `seedLength` (v0/v1). A
  seeded session without its parent keeps that prefix as `inactive`. If the
  end-seed marker is not durable yet, an attached child contributes no body and
  a seeded root keeps every event `inactive` until the next change.
- Complete malformed lines are skipped and an unterminated raw tail waits.
  Titles prefer the latest `session/title`, falling back to the first physical
  user text.

## Consequences

- DeepSeek Harness appears in the source catalog, Settings, the watcher and
  the query API through the provider registry, with no App-specific branches.
- A long-running tree costs a full re-read and decode on each change. This is
  accepted for correctness; an append fast path would need its own ADR.
- Generations above v4 are not interpreted. They keep the last supported
  generation indexed until support is added.

References: wutongyuonce/Trajex#21 (first DeepSeek provider proposal) and
upstream Obelisk's DeepSeek provider, ADR-0011 and ADR-0014
(`tommy0103/obelisk`).
