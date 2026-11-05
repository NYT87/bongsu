// A PNG as the icon check sees one (signature, IHDR with the size, then filler): enough for checkIcon, not a picture.
const SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** `w` wide and `h` high (square by default), about 40 KB of every byte value so the base64 round trip is tested. */
export function png(w: number, fill = 0, h = w, size = 24 + 40_000): Uint8Array {
  const b = new Uint8Array(size);
  b.set(SIG, 0);
  b.set([0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52], 8);
  const v = new DataView(b.buffer);
  v.setUint32(16, w);
  v.setUint32(20, h);
  for (let i = 24; i < b.length; i++) b[i] = (i * 7 + fill) & 0xff;
  return b;
}
