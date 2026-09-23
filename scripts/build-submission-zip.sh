#!/usr/bin/env bash
set -euo pipefail

# Build a reproducible, tracked-files-only submission skeleton. The archive is
# intentionally a draft until PR #7 / ELI-333 / ELI-318 evidence is reconciled.
repo_root=$(git rev-parse --show-toplevel)
cd "$repo_root"

output=${1:-"/tmp/aime-decision-review-submission-$(git rev-parse --short HEAD).tar.gz"}
mkdir -p "$(dirname "$output")"
manifest=$(mktemp)
trap 'rm -f "$manifest"' EXIT

git ls-files -z | while IFS= read -r -d '' path; do
  case "$path" in
    .git/*|.env|*/.env|*/.env.*|*.db|*.sqlite|*.sqlite3|*.sqlite-wal|*.sqlite-shm|*.wal|*.shm|*.log|*.bak|node_modules/*|dist/*|build/*|artifacts/*)
      continue
      ;;
  esac
  printf '%s\0' "$path"
done >"$manifest"

tar --null --files-from="$manifest" \
  --sort=name --mtime='UTC 2026-01-01' --owner=0 --group=0 --numeric-owner \
  --format=posix -czf "$output"

echo "$output"
