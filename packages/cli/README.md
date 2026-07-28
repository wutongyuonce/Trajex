# Trajex CLI

The local Trajex runtime used by coding agents. It indexes Claude Code and
Codex transcripts into `~/.trajex/trajex.sqlite` and exposes the stable
`build`, `search`, `query`, and `attune` process interface.

```bash
npm install --global @trajex-apps/cli
trajex --version
trajex install
trajex --query /tmp/query.mjs
```

`trajex install` installs the separate docs-only agent skill from
`tommy0103/trajex-skill`. The CLI itself remains daemon-free: each command
refreshes the local index when write ownership is available, then exits.
