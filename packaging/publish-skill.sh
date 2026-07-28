#!/usr/bin/env bash
set -euo pipefail

SKILL_ARTIFACT="dist/trajex-skill"
SKILL_REPO="dist/trajex-skill-repo"
REMOTE="git@github.com:tommy0103/trajex-skill.git"

if [ ! -f "$SKILL_ARTIFACT/SKILL.md" ] || [ ! -d "$SKILL_ARTIFACT/references" ]; then
  echo "Error: run 'npm run build:skill' first" >&2
  exit 1
fi

bash packaging/stage-skill-repo.sh "$SKILL_REPO" "$SKILL_ARTIFACT"

cd "$SKILL_REPO"
rm -rf .git
git init
git remote add origin "$REMOTE"
git add -A
git commit -m "publish: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
git push --force origin HEAD:main
