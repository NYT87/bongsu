// The YouTube provider against the fake world: a private resumable upload, then subtitles and the thumbnail, YouTube's
// processing, waiting for the due time, going public at finish, and revising after a change.
import type { YouTubeTexts } from "@bongsu/core/formats/youtube-texts";
import type { OutgoingMedia, OutgoingPost, Step } from "@bongsu/core/providers/types";
import { type UploadData, YouTubeLocked, YouTubeProvider } from "@bongsu/core/providers/youtube";
import { beforeEach, describe, expect, it } from "vitest";
import { World } from "./world";

const OAUTH = JSON.stringify({
  client_id: "c",
  client_secret: "s",
  refresh_token: "r-provider-test",
  token_uri: "https://oauth2.googleapis.com/token",
});
const TEXTS: YouTubeTexts = {
  title: "A demo trip",
  language: "en",
  audioLanguage: "en",
  tags: ["travel", "demo"],
  translations: { es: { title: "Un viaje", description: "Una demo" } },
};

let w: World;
let pr: YouTubeProvider;

const file = (name: string, size: number) => {
  w.ytFiles.set(
    name,
    new Uint8Array(size).map((_, i) => i % 251),
  );
};
const media = (name: string, checksum: string, video = false): OutgoingMedia => ({
  id: name,
  url: `https://files.example.com/${name}`,
  video,
  name,
  checksum,
});
const post = (o: Partial<OutgoingPost> = {}): OutgoingPost => ({
  format: "video",
  caption: "A day out",
  alts: [],
  media: [media("clip.mp4", "v1", true), media("es.srt", "s1"), media("thumbnail.jpg", "t1")],
  options: {},
  texts: TEXTS,
  settings: { madeForKids: false, privacy: "public", category: "22" },
  ...o,
});
const data = (s: Step) => s.data as unknown as UploadData;

/** check until the step is ready (or failed), returning every phase it went through. */
async function walk(s: Step): Promise<{ step: Step; phases: string[] }> {
  const phases = [data(s).phase as string];
  for (let i = 0; i < 20 && s.state === "processing"; i++) {
    s = await pr.check(s);
    if (s.state === "processing" && data(s).phase === "processing")
      w.ytVideos.get(data(s).videoId!)!.processing = "succeeded";
    if (phases.at(-1) !== data(s).phase) phases.push(data(s).phase);
  }
  return { step: s, phases };
}

beforeEach(() => {
  w = new World();
  pr = new YouTubeProvider(OAUTH, w.fetch);
  file("clip.mp4", 3000);
  file("es.srt", 40);
  file("fr.srt", 50);
  file("thumbnail.jpg", 70);
});

describe("YouTube provider", () => {
  it("start opens a private session with the snippet, status and localizations", async () => {
    const s = await pr.start(post());
    expect(s.state).toBe("processing");
    expect(data(s)).toMatchObject({ phase: "uploading", size: 3000, videoChecksum: "v1" });
    expect(data(s).session).toMatch(/upload_id=up-1/);
    const v = w.ytVideos.get("vid-1")!;
    expect(v.size).toBe(3000);
    expect(v.status).toMatchObject({ privacyStatus: "private", selfDeclaredMadeForKids: false });
    expect(v.status).not.toHaveProperty("publishAt");
    expect(v.meta).toMatchObject({
      title: "A demo trip",
      description: "A day out",
      tags: ["travel", "demo"],
      categoryId: "22",
      defaultLanguage: "en",
      defaultAudioLanguage: "en",
    });
    expect(v.meta.localizations.es).toEqual({ title: "Un viaje", description: "Una demo" });
  });

  it("check walks uploading → extras → processing → waiting", async () => {
    const { step, phases } = await walk(await pr.start(post()));
    expect(phases).toEqual(["uploading", "extras", "processing", "waiting"]);
    expect(step.state).toBe("ready");
    expect(data(step).videoId).toBe("vid-1");
    expect(w.ytCaptionInserts).toEqual([{ video: "vid-1", lang: "es", id: "cap-1" }]);
    expect(w.ytVideos.get("vid-1")!.thumbnail).toEqual({ bytes: 70, type: "application/octet-stream" });
    expect(data(step).captions).toEqual({ es: { trackId: "cap-1", md5: "s1" } });
    expect(data(step).thumbnailMd5).toBe("t1");
    // a ready step stays ready
    expect((await pr.check(step)).state).toBe("ready");
  });

  it("a failed caption retry doesn't duplicate a track", async () => {
    w.ytCaptionFailOnce = 2;
    const p = post({ media: [media("clip.mp4", "v1", true), media("es.srt", "s1"), media("fr.srt", "f1")] });
    const { step } = await walk(await pr.start(p));
    expect(step.state).toBe("ready");
    expect(w.ytCaptionInserts.map((c) => c.lang).sort()).toEqual(["es", "fr"]);
    expect(Object.keys(data(step).captions).sort()).toEqual(["es", "fr"]);
  });

  it("an extras call that lands nothing rethrows the error", async () => {
    w.ytCaptionFailOnce = 1;
    let s = await pr.start(post({ media: [media("clip.mp4", "v1", true), media("es.srt", "s1")] }));
    s = await pr.check(s); // uploading → extras
    await expect(pr.check(s)).rejects.toThrow(/captions.insert: 500/);
    s = await pr.check(s);
    expect(data(s).phase).toBe("processing");
    expect(w.ytCaptionInserts).toHaveLength(1);
  });

  it("rejected processing fails the step with YouTube's reason", async () => {
    let s = await pr.start(post({ media: [media("clip.mp4", "v1", true)] }));
    s = await pr.check(s);
    s = await pr.check(s);
    expect(data(s).phase).toBe("processing");
    w.ytVideos.get("vid-1")!.processing = "rejected";
    s = await pr.check(s);
    expect(s.state).toBe("failed");
    expect(s.error).toMatch(/duplicate/);
  });

  it("finish makes the video public or unlisted and keeps the other status fields", async () => {
    const { step } = await walk(await pr.start(post()));
    const v = w.ytVideos.get("vid-1")!;
    v.status = { ...v.status, license: "creativeCommon", embeddable: false };
    const got = await pr.finish(step);
    expect(got.mediaId).toBe("vid-1");
    expect(got.permalink).toBe("https://youtube.com/watch?v=vid-1");
    expect(v.status).toMatchObject({ privacyStatus: "public", license: "creativeCommon", embeddable: false });
    expect(v.meta.title).toBe("A demo trip");

    w = new World();
    pr = new YouTubeProvider(OAUTH, w.fetch);
    file("clip.mp4", 3000);
    const settings = { madeForKids: true, privacy: "unlisted" as const, category: "19" };
    const r = await walk(await pr.start(post({ media: [media("clip.mp4", "v1", true)], settings })));
    await pr.finish(r.step);
    expect(w.ytVideos.get("vid-1")!.status).toMatchObject({ privacyStatus: "unlisted", selfDeclaredMadeForKids: true });
    expect(w.ytVideos.get("vid-1")!.meta.categoryId).toBe("19");
  });

  it("finish throws YouTubeLocked when YouTube keeps it private", async () => {
    w.ytKeepPrivate = true;
    const { step } = await walk(await pr.start(post()));
    const e = await pr.finish(step).catch((x) => x);
    expect(e).toBeInstanceOf(YouTubeLocked);
    expect(e.message).toBe(
      "YouTube keeps this video private until your Google project passes YouTube's audit (see the YouTube guide)",
    );
  });

  it("a vertical 60 s video's permalink is a Short", async () => {
    const { step } = await walk(await pr.start(post()));
    Object.assign(w.ytVideos.get("vid-1")!, { seconds: 60, width: 1080, height: 1920 });
    expect((await pr.finish(step)).permalink).toBe("https://youtube.com/shorts/vid-1");
  });

  it("a refused thumbnail doesn't stop the video", async () => {
    w.ytThumbnailRefused = true;
    const { step, phases } = await walk(await pr.start(post()));
    expect(phases).toEqual(["uploading", "extras", "processing", "waiting"]);
    expect(step.data.thumbnailRefused).toBe(true);
    expect(w.ytVideos.get("vid-1")!.thumbnail).toBeUndefined();
    expect(w.ytCaptionInserts).toHaveLength(1);
  });

  it("a rate-limited thumbnail is retried, not dropped", async () => {
    w.ytThumbnailRefused = 429;
    let s = await pr.start(post());
    for (let i = 0; i < 10 && data(s).phase !== "extras"; i++) s = await pr.check(s);
    // the caption lands, the thumbnail's 429 is kept for the next run instead of counting as a refusal
    s = await pr.check(s);
    expect(data(s).phase).toBe("extras");
    expect(data(s).thumbnailRefused).toBeFalsy();
    expect(data(s).pending.thumbnail).toBe(true);
    w.ytThumbnailRefused = false;
    const { step } = await walk(s);
    expect(step.data.thumbnailRefused).toBe(false);
    expect(w.ytVideos.get("vid-1")!.thumbnail).toBeDefined();
    expect(w.ytCaptionInserts).toHaveLength(1);
  });

  it("revising with the same video updates texts and replaces only the changed track", async () => {
    const first = post({
      media: [
        media("clip.mp4", "v1", true),
        media("es.srt", "s1"),
        media("fr.srt", "f1"),
        media("thumbnail.jpg", "t1"),
      ],
    });
    const { step } = await walk(await pr.start(first));
    const before = w.ytVideos.get("vid-1")!;
    const thumbBytes = before.thumbnail;
    before.thumbnail = undefined; // to see whether it is set again
    const fr = data(step).captions.fr.trackId;

    const texts = { ...TEXTS, title: "A better title" };
    const second = post({
      texts,
      media: [media("clip.mp4", "v1", true), media("es.srt", "s2"), media("thumbnail.jpg", "t1")],
    });
    const s = await pr.start(second, step);
    expect(w.ytSessions.size).toBe(1); // no new upload
    expect(data(s)).toMatchObject({
      phase: "extras",
      videoId: "vid-1",
      pending: { captions: ["es"], dropCaptions: ["fr"], thumbnail: false },
    });
    const v = w.ytVideos.get("vid-1")!;
    expect(v.meta.title).toBe("A better title");
    expect(v.status.privacyStatus).toBe("private");

    const r = await walk(s);
    expect(r.step.state).toBe("ready");
    expect([...v.captions].map(([id, c]) => [id, c.lang])).toEqual([["cap-3", "es"]]);
    expect(fr).toBe("cap-2");
    expect(data(r.step).captions).toEqual({ es: { trackId: "cap-3", md5: "s2" } });
    expect(v.thumbnail).toBeUndefined();
    expect(thumbBytes).toBeDefined();
  });

  it("revising with another video deletes the old one and uploads again", async () => {
    const { step } = await walk(await pr.start(post()));
    const s = await pr.start(post({ media: [media("clip.mp4", "v2", true), media("es.srt", "s1")] }), step);
    expect(w.ytVideos.has("vid-1")).toBe(false);
    expect(data(s)).toMatchObject({ phase: "uploading", videoChecksum: "v2", captions: {} });
    expect(data(s).videoId).toBeUndefined();
    const r = await walk(s);
    expect(data(r.step).videoId).toBe("vid-2");
    expect(w.ytCaptionInserts.at(-1)).toMatchObject({ video: "vid-2", lang: "es" });
  });

  it("discard deletes the uploaded video, best effort", async () => {
    const { step } = await walk(await pr.start(post()));
    expect(await pr.discard(step)).toBe(true);
    expect(w.ytVideos.has("vid-1")).toBe(false);
    expect(await pr.discard(step)).toBe(true); // already gone (404): no error
    expect(await pr.discard({ state: "processing", data: { phase: "uploading" } })).toBe(false);
    w.ytQuota = true; // a delete YouTube refuses: no error, reported
    expect(await pr.discard({ state: "processing", data: { videoId: "vid-9" } })).toBe(false);
  });
});
