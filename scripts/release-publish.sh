#!/bin/sh
# The release workflow's publish step (.github/workflows/release.yml), run by changesets/action once the Version
# Packages pull request is merged:
# 1. The CLI (`bongsu`, the only public package) goes to npm with npm itself: trusted publishing through GitHub's
#    OIDC token, with provenance. pnpm packs it (the workspace: versions resolved); `pnpm publish` passed setup-node's
#    empty token placeholder on and npm refused it (E404).
# 2. `changeset git-tag` tags every package's version that has no tag yet, private ones included, and reports each
#    tag in CHANGESETS_OUTPUT, so the action pushes the tags and creates their GitHub releases.
# Safe to run again: a version already on npm, and a tag that exists, are skipped.
set -eu
cd "$(dirname "$0")/.."

version="$(node -p "require('./packages/cli/package.json').version")"
if npm view "bongsu@$version" version >/dev/null 2>&1; then
  echo "bongsu@$version is already on npm"
else
  dir="${RUNNER_TEMP:-/tmp}/bongsu-pack"
  rm -rf "$dir"
  mkdir -p "$dir"
  pnpm --filter bongsu pack --pack-destination "$dir"
  npm publish "$dir/bongsu-$version.tgz" --access public --provenance
fi

pnpm changeset git-tag
