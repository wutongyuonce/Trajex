# Vendor: DeepSeek Harness session-log framing

`dsh-zstd.ts` reads the multi-frame Zstandard container DeepSeek Harness uses
for its default compressed session logs. There is no standalone package for
it, and Trajex must not depend on `@deepseek-ai/*` packages or extra runtime
dependencies in Core, so the reader is vendored.

## Source

- DeepSeek Harness (MIT License, Copyright (c) DeepSeek AI):
  `packages/session/session-persistence-jsonl/src/zstd.ts`,
  harness commit `99f6f02fecdb7dff40c3fbc9470f5907c29f74ca`.
- Ported through the Obelisk copy (`tommy0103/obelisk`,
  `packages/core/src/vendor/dsh-zstd.ts`).

## Adaptations

- Read-only: compression and prefix-repair helpers are omitted.
- Decoding uses only Node's public one-shot `zlib.zstdDecompressSync` per
  frame; the upstream private-stream-handle optimization is not ported.
- RFC 8878 alignment: only the reserved frame-header bit (`0x08`) rejects a
  frame, the unused bit (`0x10`) is ignored, and skippable frames are skipped.
- `zstdDecompressSync` exists from Node.js 22.15; on older runtimes the
  DeepSeek provider skips compressed artifacts with a single process warning.

## Sync procedure

1. Diff the upstream `zstd.ts` scanner against `scanZstdFrames`.
2. Port decoder-side changes only and keep the adaptations above.
3. Update the commit hash here and in the module header.
4. Run `node --test tests/deepseek-zstd.test.mjs tests/deepseek-parse.test.mjs`.
