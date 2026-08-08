# Architecture decision records

Canonical ADR order follows the runtime architecture from source ingestion to
packaging. The old numbered paths remain as short compatibility aliases where
an ADR was renumbered; they are not additional decisions.

| ADR | Responsibility |
| --- | --- |
| [0001](0001-parse-core-and-persist-layers.md) | Provider registry, shared indexing orchestration, and ownership boundaries |
| [0002](0002-provider-parse-boundaries-and-cursors.md) | Provider parse strategies, cursors, and malformed-line boundaries |
| [0003](0003-write-transaction-rollback-and-concurrency.md) | Unified persistence, transactions, retries, writer ownership, and concurrency |
| [0004](0004-source-inventory-and-deletion-reconciliation.md) | Complete source inventory, deletion proof, tombstones, and missing-root protection |
| [0005](0005-canonical-transcript-session-detail-seam.md) | Canonical transcript records and session-detail assembly |
| [0006](0006-pi-v3-context-projection-and-visibility.md) | Pi v3 tree projection, identity, compaction, and visibility |
| [0007](0007-two-tier-runtime-contract.md) | CLI and query API compatibility contract |
| [0008](0008-core-typescript-esm-precompiled.md) | TypeScript Core and precompiled ESM distribution |
| [0009](0009-skill-artifact-readable-not-bundled.md) | Readable CLI package versus docs-only Skill artifact |
| [0010](0010-app-electron-vite-ts-esm.md) | Electron build, preload boundary, and packaging |

The first six ADRs describe the indexing architecture itself. The last four
describe runtime compatibility and delivery mechanics around that architecture.
