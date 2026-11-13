# Trajex CLI

The local Trajex runtime used by coding agents. It indexes Claude Code, Codex, and official Pi v3 transcripts into `~/.trajex/trajex.sqlite` and exposes the stable `build`, `search`, `query`, and `attune` process interface.

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
