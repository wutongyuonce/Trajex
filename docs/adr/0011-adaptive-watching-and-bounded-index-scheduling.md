# App freshness uses adaptive watching and bounded index scheduling

> Accepted 2026-08-29. This ADR defines how the Electron daemon turns local
> filesystem activity into index builds. Provider inventory and deletion proof
> remain in ADR-0004; parser cursors remain in ADR-0002.

## Context

Trajex indexes files written by independent Agent processes. A recursive
directory event is useful but not a complete freshness contract:

- Provider metadata may be one exact file rather than a directory.
- A process may keep a transcript descriptor open and append repeatedly while
  platform directory notifications are delayed or coalesced.
- A configured root may not exist when the App starts and appear later.
- Pure trailing debounce can postpone a build forever while writes continue.
- Filesystem events cannot prove that an indexed file was deleted; only a
  successful Provider inventory can do that.

The daemon therefore needs a fast path for common changes, bounded fallbacks
for missed changes, and one scheduling policy that does not duplicate Provider
discovery semantics.

## Decision

### Providers declare typed watch targets

`ProviderAdapter.watchTargets(configuredRoot)` returns `{ kind, path }` values:

- `tree` means a recursively observed directory.
- `file` means one exact file whose identity and content may change.

The registry deduplicates by `kind + path`. Providers own path derivation;
the App does not infer whether a configured path is a file or directory.

Current targets are:

| Provider | Tree targets | Exact-file targets |
| --- | --- | --- |
| Claude | `projects/` | `history.jsonl` |
| Codex | `sessions/`, `archived_sessions/` | `session_index.jsonl` |
| Pi | configured final session directory | none |

### One adaptive watcher combines three bounded signals

`packages/adaptive-watcher` owns invalidation only:

1. `@parcel/watcher` subscribes to each available tree target.
2. Exact-file targets are polled using `{dev, ino, size, mtimeMs}` signatures.
3. On macOS, recently active transcripts are promoted into an LRU hot set with
   a hard limit of 64 and polled by the same signature mechanism.

The first hot-file baseline is silent when promotion came from an already
observed Parcel event, avoiding a duplicate build. Explicit build-derived
`watchHints` are allowed to invalidate on their first existing baseline so a
watcher restart cannot hide work completed before the new watcher started.

Missing roots and failed subscriptions retry after five seconds. Establishing
a root after the initial pass emits a full-rescan invalidation. `close()` stops
poll and retry timers, awaits active subscriptions, and tolerates unsubscribe
failures so App shutdown does not leave asynchronous watcher work behind.

### The scheduler bounds both latency and duplicate work

`IndexerService` owns scheduling, not file discovery or parsing:

- changed paths are deduplicated in a `Set`;
- a missing path means a typed full-inventory batch, not an empty path list;
- trailing debounce is 250ms and the write-stability window is 500ms;
- one max-wait timer fires after 1.5s even if writes keep resetting debounce;
- while a build runs, all new invalidations collapse into one pending batch;
- starting or stopping a build clears every burst timer, preventing stale
  callbacks from creating a third build.

Writer-lease deferrals retain affected session IDs and retry after 250ms.
Incomplete Provider inventories keep their separate 30-second exponential
backoff capped at ten minutes. These are different failures and are not merged
into the watch debounce policy.

### Periodic reconcile is the final freshness boundary

The App schedules a full Provider inventory every five minutes. Tree events,
exact-file polling, and hot-file polling optimize detection latency; periodic
reconcile bounds missed-event staleness. Every signal ultimately calls the same
Provider `discover()` and shared indexing pipeline.

Only Provider discovery after successful source-root enumeration may emit
deletion tombstones. A watcher `delete` event, stat miss, or reconcile request
is merely an invalidation hint and never directly deletes SQLite projections.

## Ownership boundaries

- Provider adapters own target paths, source inventory, identity, and parsing.
- `adaptive-watcher` owns subscription, polling, hot-set eviction, retry, and
  asynchronous cleanup.
- `IndexerService` owns coalescing, max-wait, pending batches, retry timing, and
  periodic reconcile.
- The worker/indexer owns writer lease, transactions, cursor persistence,
  affected session IDs, and `watchHints` derived after a successful build.
- The renderer only consumes index notifications; it never observes files.

## Consequences

- Common changes still index quickly, while a missed event is eventually
  recovered without making watcher events authoritative.
- Polling cost is bounded by exact metadata targets plus, on macOS, 64 hot
  transcripts; the design does not scan every transcript every second.
- Continuous writes cannot starve indexing, and an in-flight build produces at
  most one immediate follow-up batch.
- `@parcel/watcher` is a native runtime dependency and must be unpacked from the
  Electron asar archive alongside `better-sqlite3`.
- If all fast signals fail, freshness may lag by up to the five-minute
  reconcile interval. Lowering that interval should follow measured need
  because each reconcile performs full Provider discovery.
