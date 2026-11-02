import { describe, expect, it } from "vitest";
import { mediaStoreCases } from "../src/media/conformance";
import { MemoryStore } from "../src/media/memory";
import { MediaRefused } from "../src/media/store";

describe("media store conformance: memory", () => {
  for (const c of mediaStoreCases(async (files) => {
    const store = new MemoryStore();
    const ids: Record<string, string> = {};
    for (const [path, f] of Object.entries(files)) ids[path] = await store.put(path, f.bytes, f.mime);
    return { store, ids };
  }))
    it(c.name, c.run);

  it("refuses writes with MediaRefused when told to", async () => {
    const store = new MemoryStore();
    const id = await store.put("UPLOADS/a.mp4", "x", "video/mp4");
    store.refuseWrites = true;
    await expect(store.move(id, "UPLOADS/_posted")).rejects.toBeInstanceOf(MediaRefused);
  });
});
