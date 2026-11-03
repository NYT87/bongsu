# Builds the icons from one mark. Two uses (scripts/brand/README.md, site/docs/configuration.md "Branding"):
#
#   python build_icons.py <mark.svg> <repo root>
#     Bongsu's own: the brand tiles (docs/assets/brand), the PWA's icons (packages/web/public: any + maskable), the
#     favicons (SVG and ICO) and the Apple touch icons. Tab-sized icons (favicon.svg, the ICO's 16 and 32 px) use
#     docs/assets/brand/mark-small.svg, the mark redrawn for small sizes.
#
#   python build_icons.py <mark.svg> --out <dir> [--ground #rrggbb] [--name NAME] [--small <small.svg>]
#     A fork's (`pnpm brand`): only the seven files the PWA serves, into <dir>, on the fork's theme colour. Without
#     --small the mark itself is used at tab sizes too.
#
# The mark is any square-ish SVG: its viewBox (else its width and height) gives the drawing's size, and a top-level
# <defs> is kept at the top level of each icon.
import argparse
import io
import re

import cairosvg
from PIL import Image

NAVY, PALE = "#131f2a", "#eff4f7"


def parse(svg):
    """(viewBox, defs, body) of an SVG: the drawing without its root element, its defs apart when it has some."""
    m = re.search(r'viewBox="([^"]+)"', svg)
    if m:
        vb = [float(v) for v in m.group(1).replace(",", " ").split()]
    else:
        size = [re.search(rf'<svg[^>]*\b{a}="([\d.]+)', svg) for a in ("width", "height")]
        if not all(size):
            raise SystemExit("the mark needs a viewBox (or width and height) to be scaled")
        vb = [0.0, 0.0, float(size[0].group(1)), float(size[1].group(1))]
    d = re.search(r"<defs>(.*?)</defs>", svg, re.S)
    if d:
        # Bongsu's own marks: everything after the defs is the drawing
        return vb, d.group(1), svg[d.end() : svg.rindex("</svg>")]
    return vb, "", svg[re.search(r"<svg\b[^>]*>", svg).end() : svg.rindex("</svg>")]


def build(mark, small, ground, name, note):
    vb, defs, body = parse(mark)

    def tile(ground, *, radius=0.18, scale=0.76):
        """The mark centred on a square of `ground` (rounded unless radius is 0), at `scale` of the side."""
        side = 512
        s = scale * side / max(vb[2], vb[3])
        tx, ty = (side - vb[2] * s) / 2 - vb[0] * s, (side - vb[3] * s) / 2 - vb[1] * s
        rx = f' rx="{side * radius:.0f}"' if radius else ""
        return (
            f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {side} {side}" role="img" aria-label="{name}">\n'
            f"  {note}\n  <defs>{defs}</defs>\n"
            f'  <rect width="{side}" height="{side}"{rx} fill="{ground}"/>\n'
            f'  <g transform="translate({tx:.2f} {ty:.2f}) scale({s:.4f})">{body}</g>\n</svg>\n'
        )

    def small_tile(ground):
        """mark-small.svg on a rounded square of `ground`; its 64-unit grid already holds the tile's margins."""
        _, sdefs, sbody = parse(small)
        return (
            f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" role="img" aria-label="{name}">\n'
            "  <!-- Bongsu tab icon: built from mark-small.svg by scripts/brand/build_icons.py. -->\n"
            f"  <defs>{sdefs}</defs>\n"
            f'  <rect width="64" height="64" rx="11.5" fill="{ground}"/>{sbody}</svg>\n'
        )

    return {
        "tile": tile(ground),
        "light": tile(PALE),
        # Full-bleed squares: the platform rounds or masks them itself. Maskable keeps the mark in the central safe zone.
        "maskable": tile(ground, radius=0, scale=0.62),
        "apple": tile(ground, radius=0, scale=0.68),
        "tab": small_tile(ground) if small else tile(ground),
    }


def raster(svg, size):
    return Image.open(io.BytesIO(cairosvg.svg2png(bytestring=svg.encode(), output_width=size, output_height=size)))


def png(svg, path, size, flat=False):
    im = raster(svg, size)
    (im.convert("RGB") if flat else im).save(path, optimize=True)


def ico(icons, paths):
    """The ICO: the tab icon at 16 and 32 px, the full tile from 48 px up."""
    images = [raster(icons["tab"] if n <= 32 else icons["tile"], n) for n in (16, 32, 48, 64)]
    for path in paths:
        images[-1].save(path, sizes=[im.size for im in images], append_images=images[:-1])


def pwa(icons, out):
    """The seven files packages/web/public serves (packages/web/icons.ts checks them at build)."""
    open(f"{out}/favicon.svg", "w").write(icons["tab"])
    png(icons["tile"], f"{out}/icon-512.png", 512)
    png(icons["tile"], f"{out}/icon-192.png", 192)
    png(icons["maskable"], f"{out}/icon-maskable-512.png", 512, flat=True)
    png(icons["maskable"], f"{out}/icon-maskable-192.png", 192, flat=True)
    png(icons["apple"], f"{out}/apple-touch-icon.png", 180, flat=True)
    ico(icons, [f"{out}/favicon.ico"])


def main():
    p = argparse.ArgumentParser(description="Build the app's icons from one SVG mark.")
    p.add_argument("mark")
    p.add_argument("root", nargs="?", help="Bongsu's own icons: the repository root")
    p.add_argument("--out", help="a fork's icons: the directory for the PWA's seven files")
    p.add_argument("--ground", default=NAVY, help="the tiles' background (#rrggbb)")
    p.add_argument("--name", default="Bongsu", help="the icons' accessible name")
    p.add_argument("--small", help="a mark redrawn for tab sizes")
    a = p.parse_args()
    if bool(a.root) == bool(a.out):
        p.error("give either the repository root (Bongsu's own icons) or --out <dir> (a fork's)")
    if not re.fullmatch(r"#[0-9a-fA-F]{6}", a.ground):
        p.error(f"--ground must be #rrggbb, not {a.ground}")
    mark = open(a.mark).read()

    if a.out:
        small = open(a.small).read() if a.small else None
        note = "<!-- App icon: built from one mark by scripts/brand/build_icons.py (pnpm brand). -->"
        pwa(build(mark, small, a.ground, a.name.replace('"', "&quot;"), note), a.out)
        print(f"icons built in {a.out}")
        return

    brand, public = f"{a.root}/docs/assets/brand", f"{a.root}/packages/web/public"
    note = "<!-- Bongsu icon: built from mark.svg by scripts/brand/build_icons.py. -->"
    icons = build(mark, open(f"{brand}/mark-small.svg").read(), NAVY, "Bongsu", note)
    open(f"{brand}/icon-dark.svg", "w").write(icons["tile"])
    open(f"{brand}/icon-light.svg", "w").write(icons["light"])
    png(icons["tile"], f"{brand}/icon-dark-512.png", 512)
    png(icons["light"], f"{brand}/icon-light-512.png", 512)
    png(icons["apple"], f"{brand}/apple-touch-icon-180.png", 180, flat=True)
    pwa(icons, public)
    ico(icons, [f"{brand}/favicon.ico"])
    print("icons built")


if __name__ == "__main__":
    main()
