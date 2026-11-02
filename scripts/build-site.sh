#!/bin/sh
# Builds the project site (site/) into a folder any static host can serve (GitLab Pages: public/). It copies the page
# and the brand files, and fills in the links: REPO_URL (the repository), BLOB_URL and TREE_URL (where its files and
# folders are shown) and SITE_URL (where the site lives, for the link preview). On GitLab CI they default to the
# project's own variables; on GitHub, pass them (BLOB_URL="$REPO_URL/blob/main" TREE_URL="$REPO_URL/tree/main").
set -eu
cd "$(dirname "$0")/.."

out="${1:-public}"
repo_url="${REPO_URL:-${CI_PROJECT_URL:-https://gitlab.com/nyt87/bongsu}}"
blob_url="${BLOB_URL:-$repo_url/-/blob/${CI_DEFAULT_BRANCH:-main}}"
tree_url="${TREE_URL:-$repo_url/-/tree/${CI_DEFAULT_BRANCH:-main}}"
site_url="${SITE_URL:-${CI_PAGES_URL:-}}"

rm -rf "$out"
mkdir -p "$out/brand"
cp site/site.css "$out/"
cp docs/assets/brand/*.svg docs/assets/brand/*.png docs/assets/brand/favicon.ico "$out/brand/"
# The docs pages (site/docs/*.md) are rendered first with their links, then every page gets the same placeholders filled.
node scripts/build-docs.mjs "$out" "$blob_url" "$site_url"

fill() {
  sed -e "s|{{REPO_URL}}|$repo_url|g" -e "s|{{BLOB_URL}}|$blob_url|g" -e "s|{{TREE_URL}}|$tree_url|g" \
    -e "s|{{SITE_URL}}|$site_url|g" "$1" >"$1.tmp"
  mv "$1.tmp" "$1"
}
cp site/index.html "$out/index.html"
fill "$out/index.html"
find "$out/docs" -name '*.html' | while read -r page; do fill "$page"; done

if grep -rIq "{{" "$out/index.html" "$out/docs"; then
  echo "build-site: unfilled placeholder in $out" >&2
  exit 1
fi
echo "build-site: $out/ ready"
