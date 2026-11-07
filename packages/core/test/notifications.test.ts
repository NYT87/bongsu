// Every notification's wording lives in texts/notifications.ts: these pin each builder's title, text, target and
// buttons to what the scheduler has always sent, so a wording change is a deliberate one.
import { describe, expect, it } from "vitest";
import { actionsFor, withWorkspace } from "../src/notify";
import { isNoteGroup } from "../src/notify-prefs";
import * as N from "../src/texts/notifications";

const KEY = "reel:demo/first_reel";
const URL = "https://example.com/p/1";

describe("notification builders", () => {
  it("job verdicts, failures, refusals and holds name the item", () => {
    expect(N.jobVerdict(KEY, "refused", "no caption")).toMatchObject({
      title: `${KEY}: refused`,
      text: "no caption",
      target: KEY,
    });
    expect(N.jobVerdict(KEY, "done", null)).toMatchObject({ title: `${KEY}: done`, text: "", target: KEY });
    expect(N.jobFailed(KEY, "boom")).toMatchObject({ title: `${KEY}: failed`, text: "boom", target: KEY });
    expect(N.jobRefused(KEY, "approve again")).toMatchObject({
      title: `${KEY}: refused`,
      text: "approve again",
      target: KEY,
    });
    expect(N.jobHeld(KEY, 6)).toMatchObject({
      title: `${KEY}: held`,
      text: "not published within 6 h of its time",
      target: KEY,
    });
    expect(N.providerFailed(KEY, "Instagram", "container EXPIRED")).toMatchObject({
      title: `${KEY}: failed`,
      text: "Instagram reported: container EXPIRED",
      target: KEY,
    });
    expect(N.providerFailed(KEY, "YouTube", "YouTube rejected the video: duplicate", "refused")).toMatchObject({
      group: "problems",
      text: "YouTube reported: YouTube rejected the video: duplicate\nYouTube refused the video: it is still there, private, for you to inspect.",
    });
    expect(N.providerFailed(KEY, "YouTube", "videos.list: 500", "kept")).toMatchObject({
      group: "problems",
      text: "YouTube reported: videos.list: 500\nThe video is still on YouTube, private: inspect it there or publish it by hand.",
    });
    expect(N.youtubeLocked(KEY)).toMatchObject({
      group: "problems",
      title: `${KEY}: failed`,
      text: "YouTube keeps this video private until your Google project passes YouTube's audit (see the YouTube guide)",
      target: KEY,
    });
    expect(N.youtubeQuota()).toMatchObject({
      group: "problems",
      text: "YouTube's daily quota is used up: uploads continue after midnight Pacific time",
    });
    expect(N.youtubeThumbnailRefused(KEY)).toMatchObject({
      group: "problems",
      text: "YouTube refused the thumbnail: the channel needs YouTube's verified features (the video still goes out)",
      target: KEY,
    });
    expect(N.processingTimeout(KEY, "Instagram")).toMatchObject({
      title: `${KEY}: failed`,
      text: "Instagram didn't finish processing within 2 h",
      target: KEY,
    });
  });

  it("dry runs say what would have gone out", () => {
    expect(N.dryRunPublish(KEY, "reel", "demo_travel")).toMatchObject({
      title: `dry run: would publish ${KEY}`,
      text: "reel on demo_travel",
      target: KEY,
    });
    expect(N.dryRunPublish(KEY, "reel", "demo_travel", "1 media, caption 40 chars, with self-comment")).toMatchObject({
      title: `dry run: would publish ${KEY}`,
      text: "reel on demo_travel, 1 media, caption 40 chars, with self-comment",
      target: KEY,
    });
    expect(N.dryRunComment("Short 9", "Hello there", "comment:dQw4w9WgXcQ")).toMatchObject({
      title: "dry run: would comment on Short Short 9",
      text: "Hello there",
      target: "comment:dQw4w9WgXcQ",
    });
  });

  it("published posts carry the permalink and an Open button", () => {
    expect(N.published(KEY, URL, { story: false, locationDropped: false })).toMatchObject({
      title: `published ${KEY}`,
      text: `${URL}. Pin the self-comment in the app.`,
      target: KEY,
      actions: [{ label: "Open post", url: URL }],
    });
    expect(N.published(KEY, URL, { story: false, locationDropped: true }).text).toBe(
      `${URL} (without its location: Instagram refused it). Pin the self-comment in the app.`,
    );
    expect(N.published("post:demo/story1", URL, { story: true, locationDropped: false })).toMatchObject({
      title: "published Story post:demo/story1",
      text: `${URL} (a Story: it disappears after 24 h).`,
      target: "post:demo/story1",
      actions: [{ label: "Open post", url: URL }],
    });
    expect(N.published(KEY, null, { story: false, locationDropped: false })).toMatchObject({
      title: `published ${KEY}`,
      text: ". Pin the self-comment in the app.",
      target: KEY,
      actions: [],
    });
    expect(N.publishedTrial(KEY, URL)).toMatchObject({
      title: `published Trial Reel ${KEY}`,
      text: `${URL} — shown to non-followers first; it reaches your followers if they respond well.`,
      target: KEY,
      actions: [{ label: "Open trial", url: URL }],
    });
    expect(N.publishedTrial(KEY, null)).toMatchObject({
      text: " — shown to non-followers first; it reaches your followers if they respond well.",
      actions: [],
    });
  });

  it("Shorts comments name the channel or the video", () => {
    expect(N.shortsWaiting("demo_channel", "main")).toMatchObject({
      title: "demo_channel: Shorts comments waiting",
      text: "the account has no working connection",
      target: "main",
    });
    expect(N.commented("Short 9", "comment:dQw4w9WgXcQ")).toMatchObject({
      title: "commented on Short Short 9",
      text: "Pin it in YouTube Studio.",
      target: "comment:dQw4w9WgXcQ",
    });
  });

  it("the runs' summaries count what they found", () => {
    expect(N.digest("Today", "2 posts")).toMatchObject({ title: "Today", text: "2 posts", target: "today" });
    expect(N.newDrafts(["a/b"])).toMatchObject({
      title: "new draft from the inbox",
      text: "a/b: review in the app.",
      target: "drafts",
    });
    expect(N.newDrafts(["a/b", "c/d", "e/f"])).toMatchObject({
      title: "3 new drafts from the inbox",
      text: "a/b, c/d, e/f: review in the app.",
    });
    expect(N.newComments(["@x: hi"], 1)).toMatchObject({ title: "New comment", text: "@x: hi", target: "comments" });
    expect(N.newComments(["@x: hi", "@y: yo"], 2)).toMatchObject({ title: "2 new comments", text: "@x: hi\n@y: yo" });
    expect(N.cleanupRefused(["a.mp4: locked", "b.jpg: read-only"])).toMatchObject({
      title: "Media cleanup: the store refused",
      text: "a.mp4: locked; b.jpg: read-only. Those files stay where they are.",
    });
    expect(N.results(["one"], `results:${KEY}`)).toMatchObject({
      title: "24 h results",
      text: "one",
      target: `results:${KEY}`,
    });
    expect(N.results(["one", "two"], undefined)).toMatchObject({
      title: "24 h results (2)",
      text: "one\ntwo",
      target: undefined,
    });
    expect(N.connectionProblem("conn-a: 401 (the token has run out)\nPosting may stop for it")).toMatchObject({
      title: "A connection needs attention",
      text: "conn-a: 401 (the token has run out)\nPosting may stop for it",
    });
    expect(N.connectionMailSubject).toBe("Bongsu: a connection needs attention");
  });

  it("releaseMoved", () => {
    expect(
      N.releaseMoved("Lisbon Short", "2026-11-05 18:00 Asia/Seoul", "2026-11-06 19:00 Asia/Seoul", "you"),
    ).toMatchObject({
      title: "Release moved: Lisbon Short",
      text: "from 2026-11-05 18:00 Asia/Seoul to 2026-11-06 19:00 Asia/Seoul, by you",
    });
  });
});

describe("where a notification opens", () => {
  const results = { label: "Open results", url: "/#/item/reel%3Aa%2Fb/results" };

  it("a result opens the item's Results view, a Trial Reel's its Reel's", () => {
    expect(actionsFor("results:reel:a/b")).toEqual({ url: results.url, actions: [results] });
    expect(actionsFor("results:trial:reel:a/b")).toEqual({ url: results.url, actions: [results] });
  });

  it("a Trial Reel's job (a bare trial: target) opens its Reel's page, not Results", () => {
    const own = { label: "Open in app", url: "/#/item/reel%3Aa%2Fb" };
    expect(actionsFor("trial:reel:a/b")).toEqual({ url: own.url, actions: [own] });
  });

  it("an item opens its page; drafts and comments their lists", () => {
    expect(actionsFor("reel:a/b").url).toBe("/#/item/reel%3Aa%2Fb");
    expect(actionsFor("drafts").url).toBe("/#/drafts");
    expect(actionsFor(undefined, [{ label: "Open post", url: URL }]).actions).toEqual([
      { label: "Open post", url: URL },
      { label: "Open app", url: "/#/" },
    ]);
  });

  it("an app link opens its workspace (w); a link to another site is left as it is", () => {
    expect(withWorkspace("/#/item/reel%3Aa%2Fb", "w2")).toBe("/?w=w2#/item/reel%3Aa%2Fb");
    expect(withWorkspace("/#/", "default")).toBe("/?w=default#/");
    const studio = "https://studio.youtube.com/video/x/comments";
    expect(withWorkspace(studio, "w")).toBe(studio);
  });
});

describe("every builder has a group", () => {
  const notes = {
    jobVerdict: N.jobVerdict(KEY, "done", null),
    jobFailed: N.jobFailed(KEY, "boom"),
    jobRefused: N.jobRefused(KEY, "no"),
    jobHeld: N.jobHeld(KEY, 6),
    jobHeldLive: N.jobHeldLive(KEY, "on hold", "YouTube"),
    providerFailed: N.providerFailed(KEY, "Instagram", "x"),
    processingTimeout: N.processingTimeout(KEY, "Instagram"),
    dryRunPublish: N.dryRunPublish(KEY, "reel", "demo_travel"),
    published: N.published(KEY, URL, { story: false, locationDropped: false }),
    publishedTrial: N.publishedTrial(KEY, URL),
    shortsWaiting: N.shortsWaiting("demo_travel", "a1"),
    dryRunComment: N.dryRunComment("x", "hi", KEY),
    commented: N.commented("x", KEY),
    digest: N.digest("t", "x"),
    newDrafts: N.newDrafts(["a"]),
    newComments: N.newComments(["a"], 1),
    cleanupRefused: N.cleanupRefused(["a"]),
    results: N.results(["a"], KEY),
    connectionProblem: N.connectionProblem("x"),
    mediaStoreProblem: N.mediaStoreProblem("x"),
    releaseMoved: N.releaseMoved("t", "a", "b", "c"),
    youtubeLocked: N.youtubeLocked(KEY),
    youtubeQuota: N.youtubeQuota(),
    youtubeThumbnailRefused: N.youtubeThumbnailRefused(KEY),
  };

  it("covers every exported builder", () => {
    const builders = Object.entries(N)
      .filter(([, v]) => typeof v === "function")
      .map(([k]) => k);
    expect(Object.keys(notes).sort()).toEqual(builders.sort());
  });

  it("gives each a known group, and the ones that matter the right one", () => {
    for (const [name, n] of Object.entries(notes)) expect(isNoteGroup(n.group), name).toBe(true);
    const expected: Record<string, string[]> = {
      needs_you: ["jobHeld", "shortsWaiting"],
      problems: [
        "jobVerdict",
        "jobFailed",
        "jobRefused",
        "jobHeldLive",
        "providerFailed",
        "processingTimeout",
        "connectionProblem",
        "cleanupRefused",
        "mediaStoreProblem",
        "youtubeLocked",
        "youtubeQuota",
        "youtubeThumbnailRefused",
      ],
      published: ["published", "publishedTrial", "commented", "dryRunPublish", "dryRunComment", "results"],
      inbox: ["newDrafts", "newComments", "releaseMoved"],
      digest: ["digest"],
    };
    for (const [group, names] of Object.entries(expected))
      for (const name of names) expect(notes[name as keyof typeof notes].group, name).toBe(group);
    expect(Object.values(expected).flat().sort()).toEqual(Object.keys(notes).sort());
  });

  it("sends a workspace's own broken store to Settings → Media, the instance's to Media", () => {
    expect(N.mediaStoreProblem("x").mail?.page).toBe("/dashboard/media");
    const own = N.mediaStoreProblem("x", true);
    expect(own.mail?.page).toBe("/dashboard/settings/media");
    expect(own.text).toContain("Settings → Media");
  });
});
