#!/bin/sh
# Builds the project site (site/) into a folder any static host can serve (GitHub Pages: public/). It copies the page
# and the brand files, and fills in the links: REPO_URL (the repository), BLOB_URL and TREE_URL (where its files and
# folders are shown) and SITE_URL (where the site lives, for the link preview). In GitHub Actions they follow the
# repository it runs in (a fork links to itself); elsewhere they default to the project's.
set -eu
cd "$(dirname "$0")/.."

out="${1:-public}"
repo="${GITHUB_REPOSITORY:-NYT87/bongsu}"
repo_url="${REPO_URL:-${GITHUB_SERVER_URL:-https://github.com}/$repo}"
blob_url="${BLOB_URL:-$repo_url/blob/main}"
tree_url="${TREE_URL:-$repo_url/tree/main}"
owner="$(echo "${repo%%/*}" | tr '[:upper:]' '[:lower:]')"
site_url="${SITE_URL:-https://$owner.github.io/${repo#*/}}"

# BRAND_DIR: a fork's own brand files, the names site/index.html uses (site/docs/configuration.md "Branding")
brand_dir="${BRAND_DIR:-docs/assets/brand}"
for f in mark.svg mark-small.svg lockup.svg social-card.png apple-touch-icon-180.png favicon.ico; do
  [ -f "$brand_dir/$f" ] || { echo "build-site: $brand_dir/$f is missing (BRAND_DIR needs it)" >&2; exit 1; }
done

rm -rf "$out"
mkdir -p "$out/brand"
cp site/site.css "$out/"
cp "$brand_dir"/*.svg "$brand_dir"/*.png "$brand_dir/favicon.ico" "$out/brand/"
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
