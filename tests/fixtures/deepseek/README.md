# DeepSeek Harness fixtures

Copied unchanged from the upstream Obelisk repository (`tommy0103/obelisk`,
`tests/fixtures/deepseek/sessions/`).

- `--home-dev-project--/` holds two real DeepSeek Harness v0 session logs
  (`session.jsonl.zstd`) committed with the first Obelisk DeepSeek provider.
- `--dsh-v3--/` and `--dsh-v4--/` were produced by upstream
  `scripts/gen-dsh-fixtures.mjs` through the real DSH persistence writers,
  frozen codecs and migration path: compressed and raw v3 logs, a v2→v3
  migrated directory, compaction, PTC dispatches, a seeded subagent tree, and
  v3/v4 generation twins for the v4 tool-result representation.
- `session.lock` and `*.tmp` siblings are kept on purpose: they must never be
  read as session generations.

No production transcript of a Trajex user is read by the tests.
