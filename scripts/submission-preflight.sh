#!/usr/bin/env bash
set -euo pipefail

repo_root=$(git rev-parse --show-toplevel)
cd "$repo_root"

git diff --check
npm run build >/dev/null
env -u INITIAL_ADMIN_PASSWORD docker compose config >/dev/null

secret_pattern='sk-[A-Za-z0-9]{20,}|Bearer[[:space:]]+[A-Za-z0-9._-]{20,}|Authorization:[[:space:]]*Bearer[[:space:]]+[A-Za-z0-9._-]{20,}'
if rg -n "$secret_pattern"   --glob '!package-lock.json' --glob '!bun.lock' --glob '!node_modules/**'   --glob '!dist/**' --glob '!.git/**' .; then
  echo 'repository secret scan failed' >&2
  exit 1
fi

archive=$(mktemp --suffix=.zip)
scripts/build-submission-zip.sh "$archive" >/dev/null

manifest=$(mktemp)
unpacked=$(mktemp -d)
trap 'rm -f "$manifest" "$archive"; rm -rf "$unpacked"' EXIT

unzip -Z1 "$archive" >"$manifest"
unzip -q "$archive" -d "$unpacked"

if rg -n '(^|/)(\.env$|.*\.db$|.*\.sqlite|.*\.wal$|.*\.shm$|node_modules/|dist/|build/|\.git/|.*\.log$|.*\.bak$|artifacts/)' "$manifest"; then
  echo 'archive path preflight failed' >&2
  exit 1
fi

if rg -n "$secret_pattern" "$unpacked"; then
  echo 'archive secret scan failed' >&2
  exit 1
fi

printf 'preflight=pass\narchive=%s\nentries=%s\nsha=%s\n'   "$archive" "$(wc -l < "$manifest")" "$(git rev-parse HEAD)"
