import { AwsClient } from "aws4fetch";
import { describe, expect, it } from "vitest";
import { mediaStoreCases } from "../src/media/conformance";
import { FakeS3 } from "../src/media/fake-s3";
import { type S3Settings, S3Store } from "../src/media/s3";
import { MediaRefused } from "../src/media/store";

const KEYS = { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY" };

function setup(o: { prefix?: string; pathStyle?: boolean } = {}) {
  const s3 = new FakeS3({ host: "s3.test", bucket: "media", accessKeyId: KEYS.accessKeyId });
  const settings: S3Settings = {
    endpoint: "https://s3.test",
    region: "auto",
    bucket: "media",
    prefix: o.prefix,
    pathStyle: o.pathStyle ?? true,
  };
  const store = new S3Store(settings, KEYS, s3.fetch);
  const root = o.prefix ? `${o.prefix.replace(/\/$/, "")}/` : "";
  return { s3, store, root };
}

describe("s3 paths with dot segments", () => {
  it("refuses a path that climbs out of its folder: resolve and inside say no, the writers throw", async () => {
    const { s3, store } = setup();
    await s3.put("client-b/x/b.jpg", "b", "image/jpeg");
    expect(await store.resolve("UPLOADS/../client-b/x/b.jpg")).toBeNull();
    expect(await store.resolve("client-b/x/./b.jpg")).toBeNull();
    const id = (await store.resolve("client-b/x/b.jpg"))!.id;
    expect(await store.inside(id, "UPLOADS/..")).toBe(false);
    await expect(store.ensureFolder("UPLOADS/../client-b")).rejects.toThrow(/not a path inside/);
    await expect(store.createUpload("a.jpg", "UPLOADS/../client-b", "image/jpeg")).rejects.toThrow(/not a path inside/);
    await expect(store.move(id, "UPLOADS/..")).rejects.toThrow(/not a path inside/);
    expect(s3.objects.has("client-b/")).toBe(false);
  });
});

for (const variant of [
  { name: "path style", o: { pathStyle: true } },
  { name: "virtual-hosted, under a prefix", o: { pathStyle: false, prefix: "bongsu/" } },
]) {
  describe(`media store conformance: s3 (${variant.name})`, () => {
    for (const c of mediaStoreCases(async (files) => {
      const { s3, store, root } = setup(variant.o);
      const ids: Record<string, string> = {};
      for (const [path, f] of Object.entries(files)) {
        await s3.put(root + path, f.bytes, f.mime);
        ids[path] = (await store.resolve(path))!.id;
      }
      return { store, ids };
    }))
      it(c.name, c.run);
  });
}

describe("s3 store", () => {
  it("treats an id with a dot or empty segment as missing: the URL would normalise it out of its folder", async () => {
    const { s3, store } = setup();
    await s3.put("client-b/trip/b.jpg", "b-bytes", "image/jpeg");
    await s3.put("UPLOADS/trip/a.jpg", "a", "image/jpeg");
    const id = (key: string) => btoa(key).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    for (const key of [
      "UPLOADS/../client-b/trip/b.jpg",
      "UPLOADS/./trip/a.jpg",
      "UPLOADS//trip/a.jpg",
      "/UPLOADS/trip/a.jpg",
      "UPLOADS/trip/../../client-b/trip/b.jpg",
      "UPLOADS/../client-b/trip/",
    ]) {
      expect(await store.inside(id(key), "UPLOADS"), key).toBe(false);
      expect(await store.stat(id(key)), key).toBeNull();
      expect((await store.stream(id(key))).status, key).toBe(404);
      await expect(store.publicUrl(id(key), 60), key).rejects.toThrow();
      await expect(store.move(id(key), "elsewhere"), key).rejects.toThrow();
      expect(await store.list(id(key)), key).toEqual([]);
    }
    expect(await store.inside(id("UPLOADS/trip/a.jpg"), "UPLOADS")).toBe(true);
  });

  it("keeps every key under its prefix, and ids are opaque and URL-safe", async () => {
    const { s3, store } = setup({ prefix: "bongsu" });
    await s3.put("other/secret.mp4", "x", "video/mp4");
    await s3.put("bongsu/UPLOADS/inbox/a b+c.mp4", "x", "video/mp4");
    expect(await store.resolve("other/secret.mp4")).toBeNull();
    const e = await store.resolve("UPLOADS/inbox/a b+c.mp4");
    expect(e?.id).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(e?.name).toBe("a b+c.mp4");
    expect(await store.stat("not base64 !")).toBeNull();
    // a folder outside the prefix can't be listed through a crafted id
    expect(await store.list(btoa("../other/").replace(/=+$/, ""))).toEqual([]);
  });

  it("lists past 1,000 keys, following continuation tokens", async () => {
    const { s3, store } = setup();
    for (let i = 0; i < 1003; i++)
      await s3.put(`UPLOADS/inbox/big/${String(i).padStart(4, "0")}.jpg`, "x", "image/jpeg");
    const dir = await store.resolve("UPLOADS/inbox/big");
    expect((await store.list(dir!.id)).length).toBe(1003);
  });

  it("presigns a GET Instagram can fetch until it expires", async () => {
    const { s3, store } = setup();
    await s3.put("UPLOADS/a.mp4", "0123456789", "video/mp4");
    const id = (await store.resolve("UPLOADS/a.mp4"))!.id;
    const url = await store.publicUrl(id, 3600);
    expect(new URL(url).searchParams.get("X-Amz-Expires")).toBe("3600");
    expect(new URL(url).searchParams.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/);
    expect(await (await s3.fetch(url)).text()).toBe("0123456789");
    const later = s3.now;
    s3.now = () => new Date(later().getTime() + 3601_000);
    expect((await s3.fetch(url)).status).toBe(403);
  });

  it("caps a presigned URL at seven days", async () => {
    const { store, s3 } = setup();
    await s3.put("UPLOADS/a.mp4", "x", "video/mp4");
    const id = (await store.resolve("UPLOADS/a.mp4"))!.id;
    expect(new URL(await store.publicUrl(id, 30 * 86400)).searchParams.get("X-Amz-Expires")).toBe("604800");
  });

  it("gives the app a presigned PUT whose id is known, and never replaces a file", async () => {
    const { s3, store } = setup();
    const a = await store.createUpload("trip clip.mp4", "Bongsu app uploads", "video/mp4");
    const b = await store.createUpload("trip clip.mp4", "Bongsu app uploads", "video/mp4");
    expect(a.chunked).toBe(false);
    expect(a.url).not.toBe(b.url);
    const put = await s3.fetch(a.url, { method: "PUT", headers: a.headers, body: "video-bytes" });
    expect(put.ok).toBe(true);
    const e = await store.stat(a.id!);
    expect(e?.mime).toBe("video/mp4");
    expect(e?.name).toMatch(/^trip_clip-[0-9a-f]{8}\.mp4$/);
    const folder = await store.resolve("Bongsu app uploads");
    expect(e?.parent).toBe(folder?.id);
  });

  it("refuses writes with MediaRefused when the key can't write, and moves nothing then", async () => {
    const { s3, store } = setup();
    await s3.put("UPLOADS/inbox/a.mp4", "x", "video/mp4");
    const id = (await store.resolve("UPLOADS/inbox/a.mp4"))!.id;
    s3.refuseWrites = true;
    await expect(store.move(id, "UPLOADS/_posted")).rejects.toBeInstanceOf(MediaRefused);
    expect(s3.objects.has("UPLOADS/inbox/a.mp4")).toBe(true);
  });

  it("removes the originals only after every copy of a folder exists", async () => {
    const { s3, store } = setup();
    await s3.put("UPLOADS/inbox/post/01.jpg", "1", "image/jpeg");
    await s3.put("UPLOADS/inbox/post/02.jpg", "2", "image/jpeg");
    const dir = await store.resolve("UPLOADS/inbox/post");
    await store.move(dir!.id, "UPLOADS/_posted");
    const order = s3.log.filter((r) => r.method === "PUT" || r.method === "DELETE").map((r) => r.method);
    expect(order.lastIndexOf("PUT")).toBeLessThan(order.indexOf("DELETE"));
    expect([...s3.objects.keys()].sort()).toEqual([
      "UPLOADS/_posted/",
      "UPLOADS/_posted/post/01.jpg",
      "UPLOADS/_posted/post/02.jpg",
    ]);
  });

  it("signs every request (the fake refuses unsigned ones)", async () => {
    const { s3 } = setup();
    await s3.put("UPLOADS/a.mp4", "x", "video/mp4");
    expect((await s3.fetch("https://s3.test/media/UPLOADS/a.mp4")).status).toBe(403);
  });
});

// The same cases against a real S3-compatible server, which checks the signatures the fake only looks at. Off unless
// S3_TEST_ENDPOINT is set (CI has no server), e.g. with versitygw in Docker (docs/media-stores.md):
//   S3_TEST_ENDPOINT=http://127.0.0.1:9100 S3_TEST_BUCKET=media S3_TEST_KEY=… S3_TEST_SECRET=… pnpm --filter @bongsu/core test
const real = process.env.S3_TEST_ENDPOINT;
describe.skipIf(!real)("media store conformance: s3 against a real server (S3_TEST_ENDPOINT)", () => {
  const keys = { accessKeyId: process.env.S3_TEST_KEY ?? "", secretAccessKey: process.env.S3_TEST_SECRET ?? "" };
  const settings = (prefix: string): S3Settings => ({
    endpoint: real ?? "",
    region: process.env.S3_TEST_REGION ?? "us-east-1",
    bucket: process.env.S3_TEST_BUCKET ?? "media",
    prefix,
    pathStyle: true,
  });
  const signer = new AwsClient({ ...keys, service: "s3", region: process.env.S3_TEST_REGION ?? "us-east-1" });
  /** A store in a prefix of its own (runs don't see each other's files), with these files written at their keys. */
  const fresh = async (files: Record<string, { bytes: string; mime: string }>) => {
    const prefix = `conformance-${crypto.randomUUID().slice(0, 8)}`;
    const s = settings(prefix);
    const store = new S3Store(s, keys, fetch);
    const ids: Record<string, string> = {};
    for (const [path, f] of Object.entries(files)) {
      const url = `${s.endpoint}/${s.bucket}/${prefix}/${path.split("/").map(encodeURIComponent).join("/")}`;
      const r = await signer.fetch(url, { method: "PUT", headers: { "Content-Type": f.mime }, body: f.bytes });
      if (!r.ok) throw new Error(`writing ${path}: ${r.status} ${await r.text()}`);
      ids[path] = (await store.resolve(path))!.id;
    }
    return { store, ids };
  };
  for (const c of mediaStoreCases(fresh)) it(c.name, c.run);
  it("uploads to a presigned PUT and reads back through a presigned GET", async () => {
    const { store } = await fresh({});
    const up = await store.createUpload("a b.mp4", "UPLOADS/x", "video/mp4");
    expect((await fetch(up.url, { method: up.method, headers: up.headers, body: "0123456789" })).ok).toBe(true);
    const id = up.id!;
    const e = await store.stat(id);
    expect(e?.mime).toBe("video/mp4");
    expect(e?.size).toBe(10);
    expect(await (await fetch(await store.publicUrl(id, 60))).text()).toBe("0123456789");
    expect((await store.stream(id, "bytes=2-4")).status).toBe(206);
    await store.move(id, "UPLOADS/_posted");
    expect((await store.list((await store.resolve("UPLOADS/_posted"))!.id)).map((f) => f.size)).toEqual([10]);
  });
});
