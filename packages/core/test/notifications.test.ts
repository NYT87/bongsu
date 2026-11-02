// Every notification's wording lives in texts/notifications.ts: these pin each builder's title, text, target and
// buttons to what the scheduler has always sent, so a wording change is a deliberate one.
import { describe, expect, it } from "vitest";
import { actionsFor } from "../src/notify";
import * as N from "../src/texts/notifications";

const KEY = "reel:demo/first_reel";
const URL = "https://example.com/p/1";

describe("notification builders", () => {
  it("job verdicts, failures, refusals and holds name the item", () => {
    expect(N.jobVerdict(KEY, "refused", "no caption")).toEqual({
      title: `${KEY}: refused`,
      text: "no caption",
      target: KEY,
    });
    expect(N.jobVerdict(KEY, "done", null)).toEqual({ title: `${KEY}: done`, text: "", target: KEY });
    expect(N.jobFailed(KEY, "boom")).toEqual({ title: `${KEY}: failed`, text: "boom", target: KEY });
    expect(N.jobRefused(KEY, "approve again")).toEqual({
      title: `${KEY}: refused`,
      text: "approve again",
      target: KEY,
    });
    expect(N.jobHeld(KEY, 6)).toEqual({
      title: `${KEY}: held`,
      text: "not published within 6 h of its time",
      target: KEY,
    });
    expect(N.providerFailed(KEY, "Instagram", "container EXPIRED")).toEqual({
      title: `${KEY}: failed`,
      text: "Instagram reported: container EXPIRED",
      target: KEY,
    });
    expect(N.processingTimeout(KEY, "Instagram")).toEqual({
      title: `${KEY}: failed`,
      text: "Instagram didn't finish processing within 2 h",
      target: KEY,
    });
  });

  it("dry runs say what would have gone out", () => {
    expect(N.dryRunPublish(KEY, "reel", "demo_travel")).toEqual({
      title: `dry run: would publish ${KEY}`,
      text: "reel on demo_travel",
      target: KEY,
    });
    expect(N.dryRunPublish(KEY, "reel", "demo_travel", "1 media, caption 40 chars, with self-comment")).toEqual({
      title: `dry run: would publish ${KEY}`,
      text: "reel on demo_travel, 1 media, caption 40 chars, with self-comment",
      target: KEY,
    });
    expect(N.dryRunComment("Short 9", "Hello there", "comment:dQw4w9WgXcQ")).toEqual({
      title: "dry run: would comment on Short Short 9",
      text: "Hello there",
      target: "comment:dQw4w9WgXcQ",
    });
  });

  it("published posts carry the permalink and an Open button", () => {
    expect(N.published(KEY, URL, { story: false, locationDropped: false })).toEqual({
      title: `published ${KEY}`,
      text: `${URL}. Pin the self-comment in the app.`,
      target: KEY,
      actions: [{ label: "Open post", url: URL }],
    });
    expect(N.published(KEY, URL, { story: false, locationDropped: true }).text).toBe(
      `${URL} (without its location: Instagram refused it). Pin the self-comment in the app.`,
    );
    expect(N.published("post:demo/story1", URL, { story: true, locationDropped: false })).toEqual({
      title: "published Story post:demo/story1",
      text: `${URL} (a Story: it disappears after 24 h).`,
      target: "post:demo/story1",
      actions: [{ label: "Open post", url: URL }],
    });
    expect(N.published(KEY, null, { story: false, locationDropped: false })).toEqual({
      title: `published ${KEY}`,
      text: ". Pin the self-comment in the app.",
      target: KEY,
      actions: [],
    });
    expect(N.publishedTrial(KEY, URL)).toEqual({
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
    expect(N.shortsWaiting("demo_channel", "main")).toEqual({
      title: "demo_channel: Shorts comments waiting",
      text: "the account has no working connection",
      target: "main",
    });
    expect(N.commented("Short 9", "comment:dQw4w9WgXcQ")).toEqual({
      title: "commented on Short Short 9",
      text: "Pin it in YouTube Studio.",
      target: "comment:dQw4w9WgXcQ",
    });
  });

  it("the runs' summaries count what they found", () => {
    expect(N.digest("Today", "2 posts")).toEqual({ title: "Today", text: "2 posts", target: "today" });
    expect(N.newDrafts(["a/b"])).toEqual({
      title: "new draft from the inbox",
      text: "a/b: review in the app.",
      target: "drafts",
    });
    expect(N.newDrafts(["a/b", "c/d", "e/f"])).toMatchObject({
      title: "3 new drafts from the inbox",
      text: "a/b, c/d, e/f: review in the app.",
    });
    expect(N.newComments(["@x: hi"], 1)).toEqual({ title: "New comment", text: "@x: hi", target: "comments" });
    expect(N.newComments(["@x: hi", "@y: yo"], 2)).toMatchObject({ title: "2 new comments", text: "@x: hi\n@y: yo" });
    expect(N.cleanupRefused(["a.mp4: locked", "b.jpg: read-only"])).toEqual({
      title: "Media cleanup: the store refused",
      text: "a.mp4: locked; b.jpg: read-only. Those files stay where they are.",
    });
    expect(N.results(["one"], `results:${KEY}`)).toEqual({
      title: "24 h results",
      text: "one",
      target: `results:${KEY}`,
    });
    expect(N.results(["one", "two"], undefined)).toEqual({
      title: "24 h results (2)",
      text: "one\ntwo",
      target: undefined,
    });
    expect(N.connectionProblem("conn-a: 401 (the token has run out)\nPosting may stop for it")).toEqual({
      title: "A connection needs attention",
      text: "conn-a: 401 (the token has run out)\nPosting may stop for it",
    });
    expect(N.connectionMailSubject).toBe("Bongsu: a connection needs attention");
  });

  it("releaseMoved", () => {
    expect(N.releaseMoved("Lisbon Short", "2026-11-05 18:00 Asia/Seoul", "2026-11-06 19:00 Asia/Seoul", "you")).toEqual(
      {
        title: "Release moved: Lisbon Short",
        text: "from 2026-11-05 18:00 Asia/Seoul to 2026-11-06 19:00 Asia/Seoul, by you",
      },
    );
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
});
