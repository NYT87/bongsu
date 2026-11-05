import { describe, expect, it } from "vitest";
import { FakeS3 } from "../src/media/fake-s3";
import { MediaStores } from "../src/media/index";
import { MemoryStore } from "../src/media/memory";
import { assertOwns, MediaError, ownsRef } from "../src/media/owns";
import { S3Store } from "../src/media/s3";

async function setup() {
  const shared = new MemoryStore("s3");
  const own = new MemoryStore("s3-w_b");
  const ids = {
    mine: await shared.put("client-a/x/a.jpg", "a", "image/jpeg"),
    theirs: await shared.put("client-b/x/b.jpg", "b", "image/jpeg"),
    root: await shared.put("loose.jpg", "r", "image/jpeg"),
    own: await own.put("anything/at/all.jpg", "o", "image/jpeg"),
  };
  const stores = new MediaStores(
    new Map([
      ["s3", shared],
      ["s3-w_b", own],
    ]),
    "s3",
    new Map(),
    "s3",
    new Set(["s3-w_b"]),
  );
  return { stores, shared, ids };
}

describe("ownsRef", () => {
  it("is true for a file below the workspace's folder, false outside it, at the root, or for the folder itself", async () => {
    const { stores, ids, shared } = await setup();
    expect(await ownsRef(stores, "client-a", { store: "s3", id: ids.mine })).toBe(true);
    expect(await ownsRef(stores, "client-a", { store: "s3", id: ids.theirs })).toBe(false);
    expect(await ownsRef(stores, "client-a", { store: "s3", id: ids.root })).toBe(false);
    const folder = (await shared.resolve("client-a"))!.id;
    expect(await ownsRef(stores, "client-a", { store: "s3", id: folder })).toBe(false);
  });

  it("is false for a store that isn't set up and true for anything in the workspace's own store", async () => {
    const { stores, ids } = await setup();
    expect(await ownsRef(stores, "client-a", { store: "drive", id: ids.mine })).toBe(false);
    expect(await ownsRef(stores, "client-a", { store: "s3-w_b", id: ids.own })).toBe(true);
    expect(stores.isOwn("s3-w_b")).toBe(true);
    expect(stores.isOwn("s3")).toBe(false);
  });

  it("is false when the walk throws or hangs", async () => {
    const { shared, ids } = await setup();
    const boom = Object.assign(Object.create(shared), {
      inside: async () => {
        throw new Error("drive 500");
      },
    }) as MemoryStore;
    const stores = new MediaStores(new Map([["s3", boom]]), "s3");
    expect(await ownsRef(stores, "client-a", { store: "s3", id: ids.mine })).toBe(false);
  });
});

describe("ownsRef with S3 ids", () => {
  it("refuses a key that climbs out of the folder with dot segments", async () => {
    const s3 = new FakeS3({ host: "s3.test", bucket: "media", accessKeyId: "AKIDEXAMPLE" });
    await s3.put("client-b/x/b.jpg", "b", "image/jpeg");
    const store = new S3Store(
      { endpoint: "https://s3.test", region: "auto", bucket: "media", pathStyle: true },
      { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "secret" },
      s3.fetch,
    );
    const stores = new MediaStores(new Map([["s3", store]]), "s3");
    const id = btoa("UPLOADS/../client-b/x/b.jpg").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    expect(await ownsRef(stores, "UPLOADS", { store: "s3", id })).toBe(false);
  });
});

describe("assertOwns", () => {
  it("passes when every reference is the workspace's and throws a 400 MediaError for any other", async () => {
    const { stores, ids } = await setup();
    await expect(
      assertOwns(stores, "client-a", [
        { store: "s3", id: ids.mine },
        { store: "s3-w_b", id: ids.own },
      ]),
    ).resolves.toBeUndefined();
    const err = await assertOwns(stores, "client-a", [
      { store: "s3", id: ids.mine },
      { store: "s3", id: ids.theirs },
    ]).catch((e) => e);
    expect(err).toBeInstanceOf(MediaError);
    expect([err.status, err.message]).toEqual([400, "not in this workspace's media"]);
  });
});
