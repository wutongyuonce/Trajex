# Trajex CLI

The local Trajex runtime used by coding agents. It indexes Claude Code, Codex, official Pi v3, and DeepSeek Harness transcripts into `~/.trajex/trajex.sqlite` and exposes the stable `build`, `search`, `query`, and `attune` process interface.

DeepSeek Harness sessions are read from `$DSH_HOME/sessions` (default `~/.dsh/sessions`). Its default compressed logs (`*.jsonl.zstd`) need Node.js 22.15 or newer; on older runtimes they are skipped with a warning and uncompressed logs are still indexed.

```bash
npm install --global @trajex-apps/cli
trajex --version
trajex --query /tmp/query.mjs
```

The CLI remains daemon-free: each command refreshes the local index when write
ownership is available, then exits.

### Index access errors

`--search` and `--query` read from SQLite, but their pre-query refresh needs
write access to `~/.trajex/trajex.sqlite`, its directory (including SQLite
`-wal`/`-shm` sidecars), and the writer-lease file. The CLI probes the index with
a no-op write before source discovery; on SQLite read-only/cannot-open or
filesystem `EACCES`/`EPERM`/`EROFS` failures it stops once, names the index
path, and keeps the original error. It does not fall back to stale results or
change permissions. If a host sandbox is responsible, retry the same command
with host-approved permissions.
