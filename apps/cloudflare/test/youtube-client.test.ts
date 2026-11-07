// The YouTube client's uploads, captions, thumbnails, updates and deletes against the fake world.
import { QuotaExceeded, SessionGone, type VideoMeta, YouTube } from "@bongsu/core/clients/youtube";
import { beforeEach, describe, expect, it } from "vitest";
import { World } from "./world";

const OAUTH = JSON.stringify({
  client_id: "c",
  client_secret: "s",
  refresh_token: "r-client-test",
  token_uri: "https://oauth2.googleapis.com/token",
});
const META: VideoMeta = {
  title: "Demo",
  description: "A demo",
  tags: ["demo"],
  categoryId: "22",
  defaultLanguage: "en",
  madeForKids: false,
  localizations: { es: { title: "Demostración", description: "Una demo" } },
};
const SRC = "https://files.example.com/clip.mp4";
const MIB = 1024 * 1024;

let w: World;
let yt: YouTube;
const file = (name: string, size: number) => {
  const b = new Uint8Array(size).map((_, i) => i % 251);
  w.ytFiles.set(name, b);
  return b;
};
const start = (size: number) => yt.startUpload(META, size, "video/mp4");

beforeEach(() => {
  w = new World();
  yt = new YouTube(OAUTH, w.fetch);
});

describe("YouTube client uploads", () => {
  it("a resumable upload sends the file and returns the video id", async () => {
    file("clip.mp4", 3000);
    const session = await start(3000);
    const r = await yt.uploadFrom(session, SRC, 0, 3000, { signal: AbortSignal.timeout(10_000) });
    expect(r).toEqual({ offset: 3000, videoId: "vid-1" });
    const v = w.ytVideos.get("vid-1");
    expect(v?.received).toBe(3000);
    expect(v?.status.privacyStatus).toBe("private");
    expect(v?.meta.title).toBe("Demo");
    expect(v?.meta.localizations.es.title).toBe("Demostración");
    expect(w.ytPuts).toEqual([{ range: "bytes 0-2999/3000", length: 3000 }]);
  });

  it("an upload cut off twice resumes from the offset each time", async () => {
    file("clip.mp4", 3000);
    w.ytUploadCut = 1000;
    const session = await start(3000);
    const a = await yt.uploadFrom(session, SRC, 0, 3000, { signal: AbortSignal.timeout(10_000) });
    const b = await yt.uploadFrom(session, SRC, a.offset, 3000, { signal: AbortSignal.timeout(10_000) });
    const c = await yt.uploadFrom(session, SRC, b.offset, 3000, { signal: AbortSignal.timeout(10_000) });
    expect([a.offset, b.offset, c.offset]).toEqual([1000, 2000, 3000]);
    expect(a.videoId).toBeUndefined();
    expect(c.videoId).toBe("vid-1");
    expect(
      w.ytPuts.map((p) => p.range).filter((r) => r.startsWith("bytes 1000") || r.startsWith("bytes 2000")),
    ).toEqual(["bytes 1000-2999/3000", "bytes 2000-2999/3000"]);
  });

  it("YouTube refuses translations without the video's default language", async () => {
    const { defaultLanguage: _none, ...meta } = META;
    await expect(yt.startUpload(meta, 10, "video/mp4")).rejects.toThrow(/defaultLanguageNotSet/);
    file("clip.mp4", 10);
    const { videoId } = await yt.uploadFrom(await start(10), SRC, 0, 10, { signal: AbortSignal.timeout(10_000) });
    await expect(yt.updateVideo(videoId as string, meta, { privacyStatus: "private" })).rejects.toThrow(
      /defaultLanguageNotSet/,
    );
  });

  it("quota exceeded throws QuotaExceeded", async () => {
    w.ytQuota = true;
    await expect(start(10)).rejects.toBeInstanceOf(QuotaExceeded);
  });

  it("a gone session throws SessionGone", async () => {
    file("clip.mp4", 10);
    const gone = "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&upload_id=nope";
    await expect(yt.uploadOffset(gone, 10)).rejects.toBeInstanceOf(SessionGone);
    await expect(yt.uploadFrom(gone, SRC, 0, 10, { signal: AbortSignal.timeout(10_000) })).rejects.toBeInstanceOf(
      SessionGone,
    );
  });

  it("an upload limit refused with 400 throws QuotaExceeded", async () => {
    w.ytUploadLimit = true;
    await expect(start(10)).rejects.toBeInstanceOf(QuotaExceeded);
  });

  it("uploadFrom at the end of a finished upload returns the video id", async () => {
    file("clip.mp4", 3000);
    const session = await start(3000);
    await yt.uploadFrom(session, SRC, 0, 3000, { signal: AbortSignal.timeout(10_000) });
    const putsBefore = w.ytPuts.length;
    const r = await yt.uploadFrom(session, SRC, 3000, 3000, { signal: AbortSignal.timeout(10_000) });
    expect(r).toEqual({ offset: 3000, videoId: "vid-1" });
    expect(w.ytPuts.length).toBe(putsBefore + 1); // only the offset query
  });

  it("each resumed PUT starts from the server's offset, not the client's guess", async () => {
    file("clip.mp4", 3000);
    w.ytCuts = [1000, 500];
    const session = await start(3000);
    const a = await yt.uploadFrom(session, SRC, 0, 3000, { signal: AbortSignal.timeout(10_000) });
    const b = await yt.uploadFrom(session, SRC, a.offset, 3000, { signal: AbortSignal.timeout(10_000) });
    const c = await yt.uploadFrom(session, SRC, b.offset, 3000, { signal: AbortSignal.timeout(10_000) });
    expect([a.offset, b.offset, c.offset]).toEqual([1000, 1500, 3000]);
    expect(w.ytPuts.map((p) => p.range).filter((r) => !r.includes("*"))).toEqual([
      "bytes 0-2999/3000",
      "bytes 1000-2999/3000",
      "bytes 1500-2999/3000",
    ]);
  });

  it("a network error is rethrown, not turned into an offset query", async () => {
    file("clip.mp4", 10);
    const session = await start(10);
    const failing = new YouTube(OAUTH, (async (input, init) => {
      if (new URL(String(input)).host === "files.example.com") throw new TypeError("network down");
      return w.fetch(input, init);
    }) as typeof fetch);
    const putsBefore = w.ytPuts.length;
    await expect(
      failing.uploadFrom(session, SRC, 0, 10, { signal: AbortSignal.timeout(10_000) }),
    ).rejects.toBeInstanceOf(TypeError);
    expect(w.ytPuts.length).toBe(putsBefore);
  });

  it("chunk mode refuses a source that ignores Range", async () => {
    file("clip.mp4", 100);
    const session = await start(100);
    const ignoring = new YouTube(OAUTH, (async (input, init) => {
      if (new URL(String(input)).host === "files.example.com")
        return new Response(w.ytFiles.get("clip.mp4"), { status: 200 });
      return w.fetch(input, init);
    }) as typeof fetch);
    await expect(
      ignoring.uploadFrom(session, SRC, 0, 100, { signal: AbortSignal.timeout(10_000), chunkBytes: 40 }),
    ).rejects.toThrow(/Range/);
  });

  it("chunk mode stops within the run's subrequests and returns the offset YouTube confirmed", async () => {
    file("clip.mp4", 1000);
    const session = await start(1000);
    let n = 0;
    const capped = new YouTube(OAUTH, (async (input, init) => {
      if (++n > 50) throw new Error("over the Worker's 50 subrequests");
      return w.fetch(input, init);
    }) as typeof fetch);
    const o = { signal: AbortSignal.timeout(10_000), chunkBytes: 16, requestsLeft: () => 50 - n };
    const a = await capped.uploadFrom(session, SRC, 0, 1000, o);
    expect(n).toBeLessThanOrEqual(50);
    expect(a.videoId).toBeUndefined();
    expect(a.offset).toBeGreaterThan(0);
    expect(a.offset).toBe(w.ytVideos.get("vid-1")!.received);
    // the next runs go on from there, each within its own 50
    let r = a;
    for (let run = 0; run < 3 && !r.videoId; run++) {
      n = 0;
      r = await capped.uploadFrom(session, SRC, r.offset, 1000, o);
      expect(n).toBeLessThanOrEqual(50);
    }
    expect(r).toEqual({ offset: 1000, videoId: "vid-1" });
  });

  it("chunk mode sends 8 MiB pieces", async () => {
    const size = 20 * MIB;
    file("clip.mp4", size);
    const session = await start(size);
    const r = await yt.uploadFrom(session, SRC, 0, size, { signal: AbortSignal.timeout(30_000), chunkBytes: 8 * MIB });
    expect(r).toEqual({ offset: size, videoId: "vid-1" });
    expect(w.ytPuts).toEqual([
      { range: `bytes 0-${8 * MIB - 1}/${size}`, length: 8 * MIB },
      { range: `bytes ${8 * MIB}-${16 * MIB - 1}/${size}`, length: 8 * MIB },
      { range: `bytes ${16 * MIB}-${size - 1}/${size}`, length: 4 * MIB },
    ]);
  });
});

describe("YouTube client after the upload", () => {
  it("a thumbnail is streamed from its source with its length, not held in memory", async () => {
    file("clip.mp4", 10);
    const thumb = new Uint8Array(40).map((_, i) => i);
    const session = await start(10);
    const id = (await yt.uploadFrom(session, SRC, 0, 10, { signal: AbortSignal.timeout(10_000) })).videoId as string;
    const sent: { body: unknown; length: string | null }[] = [];
    const real = w.fetch;
    const f: typeof fetch = async (input, init) => {
      const url = String(input instanceof Request ? input.url : input);
      // a source that says its length, as the scheduler's media links do
      if (url === "https://files.example.com/thumb.jpg")
        return new Response(thumb, { headers: { "Content-Type": "image/png", "Content-Length": "40" } });
      if (url.includes("/thumbnails/set"))
        sent.push({ body: init?.body, length: new Headers(init?.headers).get("Content-Length") });
      return real(input, init);
    };
    await new YouTube(OAUTH, f).setThumbnail(id, "https://files.example.com/thumb.jpg");
    expect(sent).toHaveLength(1);
    expect(sent[0].body).toBeInstanceOf(ReadableStream);
    expect(sent[0].length).toBe("40");
    expect(w.ytVideos.get(id)?.thumbnail).toEqual({ bytes: 40, type: "image/png" });
  });

  it("captions, thumbnail, update and delete reach YouTube", async () => {
    file("clip.mp4", 10);
    file("es.srt", 20);
    file("thumb.jpg", 30);
    const session = await start(10);
    const { videoId } = await yt.uploadFrom(session, SRC, 0, 10, { signal: AbortSignal.timeout(10_000) });
    const id = videoId as string;

    const track = await yt.insertCaption(id, "es", "https://files.example.com/es.srt", "Español");
    expect(w.ytVideos.get(id)?.captions.get(track)).toEqual({ lang: "es" });
    await yt.deleteCaption(track);
    expect(w.ytVideos.get(id)?.captions.size).toBe(0);

    await yt.setThumbnail(id, "https://files.example.com/thumb.jpg");
    expect(w.ytVideos.get(id)?.thumbnail?.bytes).toBe(30);

    await yt.updateVideo(
      id,
      { ...META, title: "Renamed" },
      { privacyStatus: "private", publishAt: "2030-01-01T00:00:00Z" },
    );
    expect(w.ytVideos.get(id)?.meta.title).toBe("Renamed");
    expect(w.ytVideos.get(id)?.status.publishAt).toBe("2030-01-01T00:00:00Z");

    await yt.deleteVideo(id);
    expect(w.ytVideos.has(id)).toBe(false);
    await expect(yt.deleteVideo(id)).resolves.toBeUndefined(); // 404 counts as done
    await expect(yt.videoState(id)).resolves.toBeNull();
  });

  it("a subtitle file over 5 MB is refused before it is held whole, with or without its length", async () => {
    file("clip.mp4", 10);
    const session = await start(10);
    const id = (await yt.uploadFrom(session, SRC, 0, 10, { signal: AbortSignal.timeout(10_000) })).videoId as string;
    const big = 5 * MIB + 1;
    let pulled = 0;
    const source = (withLength: boolean) =>
      new YouTube(OAUTH, (async (input, init) => {
        if (new URL(String(input)).host !== "files.example.com") return w.fetch(input, init);
        pulled = 0;
        // a stream of 1 MiB pieces, counting what is read of it
        const body = new ReadableStream<Uint8Array>({
          pull(ctl) {
            if (pulled >= big) return ctl.close();
            const n = Math.min(MIB, big - pulled);
            pulled += n;
            ctl.enqueue(new Uint8Array(n));
          },
        });
        return new Response(body, { headers: withLength ? { "Content-Length": String(big) } : {} });
      }) as typeof fetch);
    const refused = "the es subtitle file is over 5 MB";
    await expect(source(true).insertCaption(id, "es", "https://files.example.com/es.srt", "es")).rejects.toThrow(
      refused,
    );
    expect(pulled).toBeLessThanOrEqual(MIB); // refused by its Content-Length, before reading it
    await expect(source(false).insertCaption(id, "es", "https://files.example.com/es.srt", "es")).rejects.toThrow(
      refused,
    );
    expect(w.ytVideos.get(id)?.captions.size).toBe(0);
  });

  it("the audit lock keeps an update private", async () => {
    file("clip.mp4", 10);
    w.ytKeepPrivate = true;
    const { videoId } = await yt.uploadFrom(await start(10), SRC, 0, 10, { signal: AbortSignal.timeout(10_000) });
    await yt.updateVideo(videoId as string, META, { privacyStatus: "public" });
    expect((await yt.videoState(videoId as string))?.privacyStatus).toBe("private");
  });

  it("videoState reports processing, rejected and dimensions", async () => {
    file("clip.mp4", 10);
    const { videoId } = await yt.uploadFrom(await start(10), SRC, 0, 10, { signal: AbortSignal.timeout(10_000) });
    const id = videoId as string;
    const v = w.ytVideos.get(id);
    expect(await yt.videoState(id)).toMatchObject({
      uploadStatus: "uploaded",
      privacyStatus: "private",
      seconds: null,
      width: null,
      height: null,
    });
    if (!v) throw new Error("no video");
    Object.assign(v, { processing: "succeeded", seconds: 42, width: 1080, height: 1920 });
    expect(await yt.videoState(id)).toMatchObject({
      uploadStatus: "processed",
      seconds: 42,
      width: 1080,
      height: 1920,
    });
    v.processing = "rejected";
    expect(await yt.videoState(id)).toMatchObject({ uploadStatus: "rejected", rejectionReason: "duplicate" });
  });
});
