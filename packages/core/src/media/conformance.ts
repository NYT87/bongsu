// What "works" means for a media store: every store's tests run these cases (docs/media-stores.md). They use no test
// framework, so any runner can call them: `for (const c of mediaStoreCases(setup)) it(c.name, c.run)`.
import type { MediaStore } from "./store";

/** A fresh store with these files in it, by path: "UPLOADS/inbox/trip/a.mp4" → its content and type. */
export type StoreSetup = (
  files: Record<string, { bytes: string; mime: string }>,
) => Promise<{ store: MediaStore; ids: Record<string, string> }>;

const FILES = {
  "UPLOADS/inbox/trip/short1.mp4": { bytes: "0123456789abcdef", mime: "video/mp4" },
  "UPLOADS/inbox/trip/short1.txt": { bytes: "A caption\n", mime: "text/plain" },
  "UPLOADS/inbox/trip/post1/01.jpg": { bytes: "jpeg-bytes", mime: "image/jpeg" },
};

function check(ok: unknown, what: string): asserts ok {
  if (!ok) throw new Error(`media store conformance: ${what}`);
}

export function mediaStoreCases(setup: StoreSetup): { name: string; run: () => Promise<void> }[] {
  const fresh = () => setup(FILES);
  return [
    {
      name: "stat gives the name, type, size and a checksum; null for an unknown id",
      run: async () => {
        const { store, ids } = await fresh();
        const e = await store.stat(ids["UPLOADS/inbox/trip/short1.mp4"]);
        check(e, "stat found the file");
        check(e.name === "short1.mp4", `name ${e.name}`);
        check(e.mime === "video/mp4", `mime ${e.mime}`);
        check(e.size === 16, `size ${e.size}`);
        check(e.checksum.length > 0 && !e.folder, "checksum set, not a folder");
        check((await store.stat("does-not-exist-000000")) === null, "unknown id is null");
      },
    },
    {
      name: "the checksum is stable and differs between contents",
      run: async () => {
        const { store, ids } = await fresh();
        const a = await store.stat(ids["UPLOADS/inbox/trip/short1.mp4"]);
        const again = await store.stat(ids["UPLOADS/inbox/trip/short1.mp4"]);
        const b = await store.stat(ids["UPLOADS/inbox/trip/post1/01.jpg"]);
        check(a && again && b && a.checksum === again.checksum && a.checksum !== b.checksum, "checksums");
      },
    },
    {
      name: "stream gives the whole file, and a range as 206 with Content-Range",
      run: async () => {
        const { store, ids } = await fresh();
        const id = ids["UPLOADS/inbox/trip/short1.mp4"];
        const all = await store.stream(id);
        check(all.status === 200 && (await all.text()) === "0123456789abcdef", "whole file");
        const part = await store.stream(id, "bytes=2-5");
        check(part.status === 206, `range status ${part.status}`);
        check(
          part.headers.get("Content-Range") === "bytes 2-5/16",
          `Content-Range ${part.headers.get("Content-Range")}`,
        );
        check((await part.text()) === "2345", "range bytes");
        check((await store.stream("does-not-exist-000000")).status === 404, "missing is 404");
      },
    },
    {
      name: "readText reads a caption file",
      run: async () => {
        const { store, ids } = await fresh();
        check((await store.readText(ids["UPLOADS/inbox/trip/short1.txt"])) === "A caption\n", "caption text");
      },
    },
    {
      name: "resolve finds files and folders by path, null when missing; list shows a folder's contents",
      run: async () => {
        const { store, ids } = await fresh();
        const f = await store.resolve("UPLOADS/inbox/trip/short1.mp4");
        check(f?.id === ids["UPLOADS/inbox/trip/short1.mp4"], "file by path");
        const dir = await store.resolve("UPLOADS/inbox/trip");
        check(dir?.folder, "folder by path");
        check((await store.resolve("UPLOADS/inbox/nope")) === null, "missing path is null");
        check(f.parent === dir.id, "a file names its folder");
        const names = (await store.list(dir.id)).map((e) => e.name).sort();
        check(JSON.stringify(names) === JSON.stringify(["post1", "short1.mp4", "short1.txt"]), `list ${names}`);
        const post = (await store.list(dir.id)).find((e) => e.name === "post1");
        check(post?.folder, "subfolder flagged");
      },
    },
    {
      name: "ensureFolder creates a path once and returns the same folder after",
      run: async () => {
        const { store } = await fresh();
        const a = await store.ensureFolder("UPLOADS/_posted/trip");
        const b = await store.ensureFolder("UPLOADS/_posted/trip");
        check(a === b, "same folder twice");
        check((await store.resolve("UPLOADS/_posted/trip"))?.id === a, "resolvable");
      },
    },
    {
      name: "move puts a file in another folder (created when missing) and keeps it",
      run: async () => {
        const { store, ids } = await fresh();
        const id = ids["UPLOADS/inbox/trip/short1.mp4"];
        await store.move(id, "UPLOADS/_posted");
        const moved = await store.resolve("UPLOADS/_posted/short1.mp4");
        check(moved, "file in its new folder");
        check((await store.resolve("UPLOADS/inbox/trip/short1.mp4")) === null, "gone from the old folder");
        check((await store.stream(moved.id)).status === 200, "still readable");
      },
    },
    {
      name: "move takes a folder with its contents",
      run: async () => {
        const { store, ids } = await fresh();
        const dir = await store.resolve("UPLOADS/inbox/trip/post1");
        check(dir, "post folder");
        await store.move(dir.id, "UPLOADS/_posted");
        const moved = await store.resolve("UPLOADS/_posted/post1/01.jpg");
        check(moved?.id === ids["UPLOADS/inbox/trip/post1/01.jpg"], "same file, new place");
      },
    },
  ];
}
