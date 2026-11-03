#!/bin/sh
# pnpm brand <mark.svg> [out dir]: a fork's app icons from one square SVG (site/docs/configuration.md "Branding").
# Writes the seven files packages/web/public serves (favicon.svg and .ico, icon-192/512, icon-maskable-192/512,
# apple-touch-icon.png) on BONGSU_THEME_COLOR, named BONGSU_APP_NAME. Needs Python 3 and the Cairo library (libcairo2
# on Debian/Ubuntu, `brew install cairo` on macOS); the Python packages go in a venv of their own, once, outside the
# repository: no JavaScript dependency for a one-off.
set -eu
[ $# -ge 1 ] || { echo "usage: pnpm brand <mark.svg> [out dir, default packages/web/public]" >&2; exit 2; }
root="$(cd "$(dirname "$0")/../.." && pwd)"
# pnpm runs this from the repository root; relative paths are the caller's (INIT_CWD)
cd "${INIT_CWD:-$PWD}"
[ -f "$1" ] || { echo "no such file: $1" >&2; exit 2; }
mark="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
out="${2:-$root/packages/web/public}"
mkdir -p "$out"
out="$(cd "$out" && pwd)"

venv="${BONGSU_BRAND_VENV:-${XDG_CACHE_HOME:-$HOME/.cache}/bongsu-brand}"
if [ ! -x "$venv/bin/python" ]; then
  echo "setting up the icon tools in $venv (once)"
  python3 -m venv "$venv"
  "$venv/bin/pip" install --quiet cairosvg==2.9.1 pillow==13.0.0
fi

"$venv/bin/python" "$root/scripts/brand/build_icons.py" "$mark" --out "$out" \
  --ground "${BONGSU_THEME_COLOR:-#131f2a}" --name "${BONGSU_APP_NAME:-Bongsu}"
echo "next: build the app (pnpm build, or rebuild the Docker image) with the same BONGSU_APP_NAME and BONGSU_THEME_COLOR"
