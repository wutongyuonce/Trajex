# Incremental discovery and safe transcript reconciliation

> This ADR keeps its original filename for link compatibility. The decision
> was revised on 2026-08-09; the canonical text is now in
> [0008-incremental-discovery-and-safe-transcript-reconciliation.md](0008-incremental-discovery-and-safe-transcript-reconciliation.md).

The original “do not infer destructive transcript changes” rule has been
replaced by a safer, explicit reconciliation rule: providers may emit
session-level tombstones only after a readable root proves that an indexed
file disappeared; a missing or unreadable root preserves the previous
snapshot. See ADR-0010 for the provider parse matrix and unified persist
contract.
