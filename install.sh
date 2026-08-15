#!/bin/sh
# Copyright (C) 2026 tommy0103 and contributors.
# Copyright (C) 2026 wutongyuonce and contributors.
# SPDX-License-Identifier: AGPL-3.0-only

set -eu

PACKAGE='@trajex-apps/cli'

if ! command -v node >/dev/null 2>&1; then
  echo 'Trajex requires Node.js 22.13 or newer.' >&2
  exit 1
fi

if ! node -e "const [major, minor] = process.versions.node.split('.').map(Number); process.exit(major > 22 || (major === 22 && minor >= 13) ? 0 : 1)"; then
  echo 'Trajex requires Node.js 22.13 or newer.' >&2
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo 'Trajex installation requires npm.' >&2
  exit 1
fi

echo "Installing ${PACKAGE}..."
npm install --global "$PACKAGE"

if ! command -v trajex >/dev/null 2>&1; then
  echo 'The CLI was installed, but `trajex` is not on PATH.' >&2
  echo 'Add the npm global bin directory to PATH, then run `trajex --version`.' >&2
  exit 1
fi

trajex --version
echo 'Trajex CLI installed.'
