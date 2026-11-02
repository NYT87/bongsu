# Builds Bongsu's brand artwork as SVG (text outlined, no font needed to view it) and PNG:
#   banner.svg/.png (README, 1600x480; PNG at 2x), social-card.svg/.png (1280x640; PNG at 2x), lockup.svg
#   (mark + Bongsu + 봉수).
# See scripts/brand/README.md.
# python build_artwork.py <mark.svg> <fonts dir> <out dir>
import re
import sys

import cairosvg
import uharfbuzz as hb
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont

mark_svg, fonts, out = sys.argv[1:4]
NAVY, WHITE, GLOW, MUTED = "#131f2a", "#f8fafc", "#fdab1a", "#cbd5e1"


class Face:
    def __init__(self, path, wght):
        self.blob = open(path, "rb").read()
        self.hbfont = hb.Font(hb.Face(self.blob))
        self.hbfont.set_variations({"wght": wght})
        tt = TTFont(path)
        self.tt = instantiateVariableFont(tt, {"wght": wght})
        self.upem = self.tt["head"].unitsPerEm
        self.glyphs = self.tt.getGlyphSet()
        self.order = self.tt.getGlyphOrder()

    def run(self, text, size, x, y, fill, tracking=0.0):
        """Outlines for `text` with its baseline at (x, y); returns (svg, width)."""
        buf = hb.Buffer()
        buf.add_str(text)
        buf.guess_segment_properties()
        hb.shape(self.hbfont, buf, {"kern": True, "liga": True})
        k = size / self.upem
        pen = SVGPathPen(self.glyphs)
        cx = 0.0
        for info, pos in zip(buf.glyph_infos, buf.glyph_positions):
            name = self.order[info.codepoint]
            tp = TransformPen(pen, (k, 0, 0, -k, x + (cx + pos.x_offset) * k, y - pos.y_offset * k))
            self.glyphs[name].draw(tp)
            cx += pos.x_advance + tracking * self.upem
        return f'<path fill="{fill}" d="{pen.getCommands()}"/>', (cx - tracking * self.upem) * k


latin = Face(f"{fonts}/PlusJakartaSans.ttf", 800)
latin_semi = Face(f"{fonts}/PlusJakartaSans.ttf", 600)
korean = Face(f"{fonts}/NotoSansKR.ttf", 700)

# The traced mark: its viewBox, defs and body, to place anywhere.
m = open(mark_svg).read()
vb = [float(v) for v in re.search(r'viewBox="([^"]+)"', m).group(1).split()]
defs = re.search(r"<defs>(.*?)</defs>", m, re.S).group(1)
body = m[m.index("</defs>") + 7 : m.rindex("</svg>")]


def mark(x, y, height):
    s = height / vb[3]
    return f'<g transform="translate({x:.1f} {y:.1f}) scale({s:.4f})">{body}</g>', vb[2] * s


def lockup(x, y, cap, tagline=None):
    """The mark, then "Bongsu" and 봉수 (and the tagline under them); `y` is the top. Returns (svg, width, height).

    The text block runs from the name's cap height to the tagline's descenders; the mark is centred on it."""
    name_size = cap / 0.72  # Jakarta's cap height is ~0.72 em
    tag_size = name_size * 0.25
    text_h = cap + (name_size * 0.62 + tag_size * 0.25 if tagline else name_size * 0.0)
    mh = max(cap * 1.75, text_h * 1.08)
    msvg, mw = mark(x, y, mh)
    tx = x + mw + cap * 0.45
    top = y + (mh - text_h) / 2
    base = top + cap
    name, nw = latin.run("Bongsu", name_size, tx, base, WHITE, tracking=-0.01)
    ko, kw = korean.run("봉수", name_size * 0.42, tx + nw + cap * 0.28, base, GLOW)
    parts = [msvg, name, ko]
    width = tx + nw + cap * 0.28 + kw - x
    if tagline:
        tl, tw = latin_semi.run(tagline, tag_size, tx + cap * 0.04, base + name_size * 0.62, MUTED)
        parts.append(tl)
        width = max(width, tx + tw - x)
    return "".join(parts), width, mh


def page(w, h, inner, bg=True):
    rect = f'<rect width="{w}" height="{h}" fill="{NAVY}"/>' if bg else ""
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}" width="{w}" height="{h}" role="img" '
        f'aria-label="Bongsu (봉수): Light the signal. Reach every channel.">\n'
        f"<!-- Generated: Plus Jakarta Sans ExtraBold/SemiBold and Noto Sans KR Bold (both SIL OFL 1.1), outlined. -->\n"
        f"<defs>{defs}</defs>{rect}{inner}</svg>\n"
    )


TAG = "Light the signal. Reach every channel."

def centred(w, h, cap, tagline):
    _, lw, lh = lockup(0, 0, cap, tagline)
    svg, _, _ = lockup((w - lw) / 2, (h - lh) / 2, cap, tagline)
    return svg

for name, w, h, cap in [("banner", 1600, 480, 150), ("social-card", 1280, 640, 118)]:
    svg = page(w, h, centred(w, h, cap, TAG))
    open(f"{out}/{name}.svg", "w").write(svg)
    # 2x, for sharp results on high-density screens wherever a PNG is needed (the README uses the SVG)
    cairosvg.svg2png(bytestring=svg.encode(), write_to=f"{out}/{name}.png", output_width=w * 2)

inner, lw, lh = lockup(0, 0, 100)
open(f"{out}/lockup.svg", "w").write(page(round(lw) + 2, round(lh) + 2, inner, bg=False))
cairosvg.svg2png(url=f"{out}/lockup.svg", write_to=f"{out}/lockup-preview.png", output_width=900, background_color=NAVY)
print("ok")
