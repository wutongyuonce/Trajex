# Trajex CLI

The local Obelisk runtime used by coding agents. It indexes Claude Code, Codex, and standard top-level Pi official v3 transcripts into `~/.obelisk/obelisk.sqlite` and exposes the stable `build`, `search`, `query`, and `attune` process interface.

```bash
npm install --global @trajex-apps/cli
trajex --version
trajex --query /tmp/query.mjs
```

The CLI remains daemon-free: each command refreshes the local index when write
ownership is available, then exits.
