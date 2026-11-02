# Builds every icon from mark.svg: the brand tiles, the PWA's icons (any + maskable), the favicons (SVG and ICO) and
# the Apple touch icons. Tab-sized icons (favicon.svg, the ICO's 16 and 32 px) use mark-small.svg, the mark redrawn
# for small sizes. See scripts/brand/README.md.
# python build_icons.py <mark.svg> <repo root>
import io
import re
import sys

import cairosvg
from PIL import Image

mark_svg, root = sys.argv[1:3]
NAVY, PALE = "#131f2a", "#eff4f7"
brand, public = f"{root}/docs/assets/brand", f"{root}/packages/web/public"

m = open(mark_svg).read()
vb = [float(v) for v in re.search(r'viewBox="([^"]+)"', m).group(1).split()]
defs = re.search(r"<defs>(.*?)</defs>", m, re.S).group(1)
body = m[m.index("</defs>") + 7 : m.rindex("</svg>")]
NOTE = "<!-- Bongsu icon: built from mark.svg by scripts/brand/build_icons.py. -->"
small = open(f"{brand}/mark-small.svg").read()
small_defs = re.search(r"<defs>(.*?)</defs>", small, re.S).group(1)
small_body = small[small.index("</defs>") + 7 : small.rindex("</svg>")]


def tile(ground, *, radius=0.18, scale=0.76):
    """The mark centred on a square of `ground` (rounded unless radius is 0), at `scale` of the side."""
    side = 512
    s = scale * side / max(vb[2], vb[3])
    tx, ty = (side - vb[2] * s) / 2, (side - vb[3] * s) / 2
    rx = f' rx="{side * radius:.0f}"' if radius else ""
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {side} {side}" role="img" aria-label="Bongsu">\n'
        f"  {NOTE}\n  <defs>{defs}</defs>\n"
        f'  <rect width="{side}" height="{side}"{rx} fill="{ground}"/>\n'
        f'  <g transform="translate({tx:.2f} {ty:.2f}) scale({s:.4f})">{body}</g>\n</svg>\n'
    )


def small_tile(ground):
    """mark-small.svg on a rounded square of `ground`; its 64-unit grid already holds the tile's margins."""
    return (
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" role="img" aria-label="Bongsu">\n'
        "  <!-- Bongsu tab icon: built from mark-small.svg by scripts/brand/build_icons.py. -->\n"
        f"  <defs>{small_defs}</defs>\n"
        f'  <rect width="64" height="64" rx="11.5" fill="{ground}"/>{small_body}</svg>\n'
    )


def raster(svg, size):
    return Image.open(io.BytesIO(cairosvg.svg2png(bytestring=svg.encode(), output_width=size, output_height=size)))


def png(svg, path, size, flat=False):
    im = raster(svg, size)
    (im.convert("RGB") if flat else im).save(path, optimize=True)


dark, light = tile(NAVY), tile(PALE)
# Full-bleed squares: the platform rounds or masks them itself. Maskable keeps the mark in the central safe zone.
maskable = tile(NAVY, radius=0, scale=0.62)
apple = tile(NAVY, radius=0, scale=0.68)

open(f"{brand}/icon-dark.svg", "w").write(dark)
open(f"{brand}/icon-light.svg", "w").write(light)
open(f"{public}/favicon.svg", "w").write(small_tile(NAVY))
png(dark, f"{brand}/icon-dark-512.png", 512)
png(light, f"{brand}/icon-light-512.png", 512)
png(dark, f"{public}/icon-512.png", 512)
png(dark, f"{public}/icon-192.png", 192)
png(maskable, f"{public}/icon-maskable-512.png", 512, flat=True)
png(maskable, f"{public}/icon-maskable-192.png", 192, flat=True)
for path in (f"{public}/apple-touch-icon.png", f"{brand}/apple-touch-icon-180.png"):
    png(apple, path, 180, flat=True)
# The ICO: the small mark at tab sizes, the full one from 48 px up.
tab = small_tile(NAVY)
ico = [raster(tab if n <= 32 else dark, n) for n in (16, 32, 48, 64)]
for path in (f"{public}/favicon.ico", f"{brand}/favicon.ico"):
    ico[-1].save(path, sizes=[im.size for im in ico], append_images=ico[:-1])
print("icons built")
