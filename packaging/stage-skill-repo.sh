#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET_DIR="${1:-}"
ARTIFACT_DIR="${2:-$ROOT_DIR/dist/obelisk-skill}"

if [ -z "$TARGET_DIR" ]; then
  echo "Usage: packaging/stage-skill-repo.sh <target-repo> [skill-artifact]" >&2
  exit 1
fi

if [ "$TARGET_DIR" = "/" ] || [ "$TARGET_DIR" = "." ] || [ "$TARGET_DIR" = "$ROOT_DIR" ]; then
  echo "Error: refusing to replace unsafe target directory: $TARGET_DIR" >&2
  exit 1
fi

for required in SKILL.md package.json references; do
  if [ ! -e "$ARTIFACT_DIR/$required" ]; then
    echo "Error: skill artifact missing $required at $ARTIFACT_DIR" >&2
    exit 1
  fi
done

mkdir -p "$TARGET_DIR"
find "$TARGET_DIR" -mindepth 1 \
  ! -path "$TARGET_DIR/.git" \
  ! -path "$TARGET_DIR/.git/*" \
  -delete

mkdir -p "$TARGET_DIR/skills/obelisk"
cp -R "$ARTIFACT_DIR"/. "$TARGET_DIR/skills/obelisk/"
cp "$ROOT_DIR/packaging/skill-README.md" "$TARGET_DIR/README.md"
cp "$ROOT_DIR/packaging/skill-LICENSE" "$TARGET_DIR/LICENSE"
