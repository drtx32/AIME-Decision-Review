#!/usr/bin/env bash
# AIME Decision Review — submission preflight (POSIX wrapper).
#
# Thin shell around `scripts/preflight.mjs` so the script can be invoked
# uniformly from Make/CI shells and from Bash on Windows (Git Bash).
#
# Usage:
#   ./scripts/preflight.sh                # verify only
#   ./scripts/preflight.sh --zip out.zip  # verify + build deterministic ZIP
#   ./scripts/preflight.sh --tar out.tgz  # verify + build deterministic tar.gz
#
# This script never backgrounds; the Node process must exit before the
# shell returns, so callers do not have to wait for a separate wakeup.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
PREFLIGHT_JS="${SCRIPT_DIR}/preflight.mjs"

if [ ! -f "${PREFLIGHT_JS}" ]; then
  echo "preflight: ${PREFLIGHT_JS} missing" >&2
  exit 2
fi

# Prefer Node; fall back to Bun (both interpret modern ESM).
if command -v node >/dev/null 2>&1; then
  RUNNER=(node "${PREFLIGHT_JS}")
elif command -v bun >/dev/null 2>&1; then
  RUNNER=(bun run "${PREFLIGHT_JS}")
else
  echo "preflight: neither node nor bun found in PATH" >&2
  exit 2
fi

cd "${REPO_ROOT}"
exec "${RUNNER[@]}" "$@"