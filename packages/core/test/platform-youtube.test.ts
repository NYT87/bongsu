import { describe, expect, it } from "vitest";
import { leadOf, MAX_LEAD_S } from "../src/platforms/index";
import { validateOptions } from "../src/platforms/types";
import {
  MediaRolesError,
  mediaRoles,
  type RoleEntry,
  youtube,
  youtubePermalink,
  youtubeSettings,
} from "../src/platforms/youtube";

const e = (name: string, mime: string, size = 10): RoleEntry<string> => ({ name, mime, size, ref: name });
const clip = e("clip.mp4", "video/mp4");

describe("youtube platform", () => {
  it("publishes videos with a 6 h lead", () => {
    expect(youtube.formats).toEqual(["video"]);
    expect(leadOf("youtube")).toBe(21600);
    expect(leadOf("instagram")).toBe(0);
    expect(leadOf(null)).toBe(0);
    expect(MAX_LEAD_S).toBe(21600);
  });

  it("validates options", () => {
    expect(() => validateOptions(youtube, "video", { privacy: "private" })).toThrow();
    expect(() => validateOptions(youtube, "video", { category: "1000" })).toThrow();
    expect(validateOptions(youtube, "video", { madeForKids: true, privacy: "unlisted", category: "10" })).toEqual({
      madeForKids: true,
      privacy: "unlisted",
      category: "10",
    });
  });

  it("checks the description", () => {
    expect(youtube.lint("a".repeat(5001))).toHaveLength(1);
    expect(youtube.lint("a".repeat(5001))[0]).toMatchObject({ check: "Length", status: "FAIL" });
    expect(youtube.lint("a <b>")[0]).toMatchObject({ check: "Angle brackets", status: "FAIL" });
    expect(youtube.lint("ok")).toEqual([]);
  });

  it("picks the video, subtitles by language and the thumbnail", () => {
    const r = mediaRoles([
      clip,
      e("es.srt", "application/x-subrip"),
      e("pt-BR.vtt", "text/vtt"),
      e("thumbnail.jpg", "image/jpeg"),
    ]);
    expect(r.video).toBe("clip.mp4");
    expect(r.subtitles).toEqual([
      { lang: "es", ref: "es.srt" },
      { lang: "pt-BR", ref: "pt-BR.vtt" },
    ]);
    expect(r.thumbnail).toBe("thumbnail.jpg");
  });

  it("refuses bad media sets", () => {
    expect(() => mediaRoles([clip, e("es.srt", "x"), e("es.vtt", "x")])).toThrow(MediaRolesError);
    expect(() => mediaRoles([clip, e("thumbnail.jpg", "image/jpeg"), e("thumbnail.png", "image/png")])).toThrow(
      MediaRolesError,
    );
    expect(() => mediaRoles([clip, e("thumbnail.jpg", "image/jpeg", 52428801)])).toThrow(/50 MB/);
    expect(() => mediaRoles([clip, e("notes.txt", "text/plain")])).toThrow(
      "notes.txt isn't a video, a subtitle file (<lang>.srt or .vtt) or thumbnail.jpg/png",
    );
    expect(() => mediaRoles([e("es.srt", "x")])).toThrow(/no video/);
    expect(() => mediaRoles([clip, e("b.mp4", "video/mp4")])).toThrow(/one video per post/);
  });

  it("links a short vertical video to shorts and the rest to watch", () => {
    expect(youtubePermalink("abc", 180, 1080, 1920)).toBe("https://youtube.com/shorts/abc");
    expect(youtubePermalink("abc", 181, 1080, 1920)).toBe("https://youtube.com/watch?v=abc");
    expect(youtubePermalink("abc", 60, 1920, 1080)).toBe("https://youtube.com/watch?v=abc");
    expect(youtubePermalink("abc", null, null, null)).toBe("https://youtube.com/watch?v=abc");
  });

  it("takes settings from the options, then the channel, then the defaults", () => {
    expect(youtubeSettings({}, {})).toEqual({ madeForKids: false, privacy: "public", category: "22" });
    const channel = { youtube: { madeForKids: true, category: "10" } };
    expect(youtubeSettings({}, channel)).toEqual({ madeForKids: true, privacy: "public", category: "10" });
    expect(youtubeSettings({ madeForKids: false, category: "20", privacy: "unlisted" }, channel)).toEqual({
      madeForKids: false,
      privacy: "unlisted",
      category: "20",
    });
  });
});
