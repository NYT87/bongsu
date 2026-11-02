# Traces the Bongsu mark from the original raster icon (docs/assets/brand/source/icon-dark-512-original.png) into
# mark.svg: the Ember gradient, the lit point redrawn as a circle. build_icons.py makes the icons from it.
# See scripts/brand/README.md.
# python trace_mark.py <icon-dark-512-original.png> <outdir>
import sys
import numpy as np
import potrace
from PIL import Image

src, out = sys.argv[1], sys.argv[2]
SCALE = 4
im = Image.open(src).convert("RGB")
im = im.resize((im.width * SCALE, im.height * SCALE), Image.LANCZOS)
a = np.asarray(im).astype(int)
r, g, b = a[..., 0], a[..., 1], a[..., 2]
mask = (r > 140) & (r - b > 90)  # the orange line art, not the navy tile
# Smooth the edges (close, then open) so faded bits of the raster don't become ragged fragments.
m = Image.fromarray((mask * 255).astype("uint8"))
from PIL import ImageFilter, ImageDraw
m = m.filter(ImageFilter.MaxFilter(5)).filter(ImageFilter.MinFilter(5)).filter(ImageFilter.MinFilter(9)).filter(ImageFilter.MaxFilter(9))
mask = np.asarray(m) > 127
# The lit point: its blob, measured, is taken out of the
# trace and draw it as a true circle with a glow instead.
cx, cy = 260 * SCALE, 220 * SCALE  # the lit point's centre in the original icon (measured)
fill = Image.fromarray((mask * 255).astype("uint8")).copy()  # a copy: floodfill leaves an array-backed image unchanged
ImageDraw.floodfill(fill, (cx, cy), 128)
blob = np.asarray(fill) == 128
by, bx = np.nonzero(blob)
dot_x, dot_y = bx.mean(), by.mean()
dot_r = (blob.sum() / np.pi) ** 0.5 * 0.9
mask = mask & ~blob
ys, xs = np.nonzero(mask)
x0, y0, x1, y1 = xs.min(), ys.min(), xs.max(), ys.max()
pad = 8 * SCALE
x0, y0, x1, y1 = x0 - pad, y0 - pad, x1 + pad, y1 + pad
crop = mask[y0:y1, x0:x1]
bm = potrace.Bitmap(~crop)  # potracer traces the False pixels
plist = bm.trace(turdsize=40 * SCALE, alphamax=1.0, opticurve=True, opttolerance=0.2)

def f(v):
    return f"{v / SCALE:.2f}".rstrip("0").rstrip(".")

parts = []
for curve in plist:
    p = curve.start_point
    d = [f"M{f(p.x)} {f(p.y)}"]
    for seg in curve.segments:
        if seg.is_corner:
            d.append(f"L{f(seg.c.x)} {f(seg.c.y)}L{f(seg.end_point.x)} {f(seg.end_point.y)}")
        else:
            d.append(f"C{f(seg.c1.x)} {f(seg.c1.y)} {f(seg.c2.x)} {f(seg.c2.y)} {f(seg.end_point.x)} {f(seg.end_point.y)}")
    d.append("Z")
    parts.append("".join(d))
w, h = (x1 - x0) / SCALE, (y1 - y0) / SCALE
dx, dy, dr = (dot_x - x0) / SCALE, (dot_y - y0) / SCALE, dot_r / SCALE
dot = (f'<circle cx="{dx:.1f}" cy="{dy:.1f}" r="{dr * 2.2:.1f}" fill="url(#glow)"/>'
       f'<circle cx="{dx:.1f}" cy="{dy:.1f}" r="{dr:.1f}" fill="url(#core)"/>')
path = " ".join(parts)
grad = """<linearGradient id="ember" x1="0" y1="1" x2="1" y2="0">
      <stop offset="0" stop-color="#e85d1c"/>
      <stop offset="0.55" stop-color="#f7931e"/>
      <stop offset="1" stop-color="#fdab1a"/>
    </linearGradient>
    <radialGradient id="core">
      <stop offset="0" stop-color="#fdb51c"/>
      <stop offset="1" stop-color="#f7931e"/>
    </radialGradient>
    <radialGradient id="glow">
      <stop offset="0.4" stop-color="#fdab1a" stop-opacity="0.55"/>
      <stop offset="1" stop-color="#fdab1a" stop-opacity="0"/>
    </radialGradient>"""
note = "<!-- Bongsu mark: auto-traced from source/icon-dark-512-original.png (potrace) as a placeholder until a hand-drawn vector exists. -->"
mark = f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {f(w * SCALE)} {f(h * SCALE)}" role="img" aria-label="Bongsu">
  {note}
  <defs>
    {grad}
  </defs>
  <path fill="url(#ember)" fill-rule="evenodd" d="{path}"/>
  {dot}
</svg>
"""
open(f"{out}/mark.svg", "w").write(mark)
print("paths", len(plist), "size", round(w), round(h), "bytes", len(mark))
