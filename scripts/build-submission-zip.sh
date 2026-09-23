#!/usr/bin/env bash
set -euo pipefail

out="${1:-aime-decision-review-submission.zip}"
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

rm -f "$out"
git archive --format=zip --output="$out" HEAD \
  ':!.git*' ':!**/.env' ':!**/*.db' ':!**/node_modules/**' ':!**/dist/**' \
  ':!**/logs/**' ':!**/*.log'
echo "wrote $out"
