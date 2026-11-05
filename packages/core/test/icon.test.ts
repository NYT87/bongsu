import { describe, expect, it } from "vitest";
import { checkIcon, IconError, iconUrl } from "../src/icon";

const SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
function png(w: number, h: number, extra = 0): Uint8Array {
  const b = new Uint8Array(24 + extra);
  b.set(SIG, 0);
  b.set([0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52], 8);
  const v = new DataView(b.buffer);
  v.setUint32(16, w);
  v.setUint32(20, h);
  return b;
}
const msg = (b: Uint8Array) => {
  try {
    checkIcon(b);
  } catch (e) {
    expect(e).toBeInstanceOf(IconError);
    return (e as Error).message;
  }
  return null;
};

describe("checkIcon", () => {
  it("accepts square PNGs of 192 to 1024 px", () => {
    expect(checkIcon(png(256, 256))).toEqual({ width: 256 });
    expect(checkIcon(png(1024, 1024))).toEqual({ width: 1024 });
    expect(checkIcon(png(192, 192))).toEqual({ width: 192 });
  });

  it("says why it refuses", () => {
    expect(msg(png(300, 200))).toBe("the icon must be square (it's 300×200)");
    expect(msg(png(128, 128))).toBe("the icon must be 192 to 1024 pixels wide (it's 128)");
    expect(msg(png(2048, 2048))).toBe("the icon must be 192 to 1024 pixels wide (it's 2048)");
    expect(msg(png(256, 256, 204_800))).toBe("the icon is over 200 KB");
  });

  it("refuses what is not a PNG", () => {
    const gif = new TextEncoder().encode("GIF89a\u0001\u0000\u0001\u0000\u0000\u0000\u0000;;;;;;;;;;;;;;;;;;");
    expect(msg(gif)).toBe("the icon must be a PNG");
    expect(msg(new Uint8Array())).toBe("the icon must be a PNG");
    expect(msg(png(256, 256).slice(0, 20))).toBe("the icon must be a PNG");
    const noIhdr = png(256, 256);
    noIhdr[12] = 0x58;
    expect(msg(noIhdr)).toBe("the icon must be a PNG");
  });
});

describe("iconUrl", () => {
  it("is absolute, and null without a hash", () => {
    expect(iconUrl("https://bongsu.example.com", "ab")).toBe("https://bongsu.example.com/icon/ab.png");
    expect(iconUrl("https://bongsu.example.com", undefined)).toBeNull();
  });
});
