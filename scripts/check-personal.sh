#!/usr/bin/env bash
# Fails if any string from .personal-strings (one regex per line, git-ignored, kept only on the owner's machine) appears
# in the tracked files. Run before every push while the repository is being cleaned for its public release.
set -euo pipefail
cd "$(dirname "$0")/.."
list=.personal-strings
[ -f "$list" ] || { echo "no $list here: nothing to check" >&2; exit 0; }
pattern=$(grep -v '^\s*\(#\|$\)' "$list" | paste -sd '|')
if git ls-files -z | grep -zv -e 'package-lock.json$' -e 'pnpm-lock.yaml$' | xargs -0 grep -IEin "$pattern"; then
  echo "personal strings found (above)" >&2; exit 1
fi
echo "no personal strings in tracked files"
