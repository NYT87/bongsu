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
    const r = await yt.uploadFrom(session, SRC, 0, 3000, { budgetMs: 10_000 });
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
    const a = await yt.uploadFrom(session, SRC, 0, 3000, { budgetMs: 10_000 });
    const b = await yt.uploadFrom(session, SRC, a.offset, 3000, { budgetMs: 10_000 });
    const c = await yt.uploadFrom(session, SRC, b.offset, 3000, { budgetMs: 10_000 });
    expect([a.offset, b.offset, c.offset]).toEqual([1000, 2000, 3000]);
    expect(a.videoId).toBeUndefined();
    expect(c.videoId).toBe("vid-1");
    expect(
      w.ytPuts.map((p) => p.range).filter((r) => r.startsWith("bytes 1000") || r.startsWith("bytes 2000")),
    ).toEqual(["bytes 1000-2999/3000", "bytes 2000-2999/3000"]);
  });

  it("quota exceeded throws QuotaExceeded", async () => {
    w.ytQuota = true;
    await expect(start(10)).rejects.toBeInstanceOf(QuotaExceeded);
  });

  it("a gone session throws SessionGone", async () => {
    file("clip.mp4", 10);
    const gone = "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&upload_id=nope";
    await expect(yt.uploadOffset(gone, 10)).rejects.toBeInstanceOf(SessionGone);
    await expect(yt.uploadFrom(gone, SRC, 0, 10, { budgetMs: 10_000 })).rejects.toBeInstanceOf(SessionGone);
  });

  it("chunk mode sends 8 MiB pieces", async () => {
    const size = 20 * MIB;
    file("clip.mp4", size);
    const session = await start(size);
    const r = await yt.uploadFrom(session, SRC, 0, size, { budgetMs: 30_000, chunkBytes: 8 * MIB });
    expect(r).toEqual({ offset: size, videoId: "vid-1" });
    expect(w.ytPuts).toEqual([
      { range: `bytes 0-${8 * MIB - 1}/${size}`, length: 8 * MIB },
      { range: `bytes ${8 * MIB}-${16 * MIB - 1}/${size}`, length: 8 * MIB },
      { range: `bytes ${16 * MIB}-${size - 1}/${size}`, length: 4 * MIB },
    ]);
  });
});

describe("YouTube client after the upload", () => {
  it("captions, thumbnail, update and delete reach YouTube", async () => {
    file("clip.mp4", 10);
    file("es.srt", 20);
    file("thumb.jpg", 30);
    const session = await start(10);
    const { videoId } = await yt.uploadFrom(session, SRC, 0, 10, { budgetMs: 10_000 });
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

  it("the audit lock keeps an update private", async () => {
    file("clip.mp4", 10);
    w.ytKeepPrivate = true;
    const { videoId } = await yt.uploadFrom(await start(10), SRC, 0, 10, { budgetMs: 10_000 });
    await yt.updateVideo(videoId as string, META, { privacyStatus: "public" });
    expect((await yt.videoState(videoId as string))?.privacyStatus).toBe("private");
  });

  it("videoState reports processing, rejected and dimensions", async () => {
    file("clip.mp4", 10);
    const { videoId } = await yt.uploadFrom(await start(10), SRC, 0, 10, { budgetMs: 10_000 });
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
