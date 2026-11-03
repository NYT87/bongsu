# Brand artwork

Regenerates the vector mark, every icon (`docs/assets/brand/`, `packages/web/public/`) and the artwork (see `docs/brand-guidelines.md`). Run them only
when the mark or the lettering changes; the outputs are committed.

A fork's icons come from `pnpm brand <mark.svg>` instead (`brand.sh`, which runs `build_icons.py --out`: the PWA's seven
files only, on `BONGSU_THEME_COLOR`; site/docs/configuration.md "Branding").

```sh
python3 -m venv /tmp/brand-venv
/tmp/brand-venv/bin/pip install potracer numpy pillow cairosvg fonttools uharfbuzz
mkdir -p /tmp/brand-fonts && cd /tmp/brand-fonts
curl -sSfLo PlusJakartaSans.ttf 'https://github.com/google/fonts/raw/main/ofl/plusjakartasans/PlusJakartaSans%5Bwght%5D.ttf'
curl -sSfLo NotoSansKR.ttf 'https://github.com/google/fonts/raw/main/ofl/notosanskr/NotoSansKR%5Bwght%5D.ttf'
cd -

# 1. mark.svg, traced from the original raster icon (a placeholder until a hand-drawn vector exists)
/tmp/brand-venv/bin/python scripts/brand/trace_mark.py docs/assets/brand/source/icon-dark-512-original.png docs/assets/brand
# 2. every icon from mark.svg: brand tiles, the PWA's icons (any + maskable), favicon.svg/.ico, Apple touch icons
#    (favicon.svg and the ICO's 16/32 px come from mark-small.svg, drawn by hand: edit it directly)
/tmp/brand-venv/bin/python scripts/brand/build_icons.py docs/assets/brand/mark.svg .
# 3. banner, social card and lockup: the mark plus the outlined lettering (no font needed to view them)
/tmp/brand-venv/bin/python scripts/brand/build_artwork.py docs/assets/brand/mark.svg /tmp/brand-fonts docs/assets/brand
rm docs/assets/brand/lockup-preview.png
```

Both fonts are under the SIL Open Font License 1.1; the artwork carries their glyphs as outlines only.
