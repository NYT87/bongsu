// @vitest-environment happy-dom
// The app's main screens rendered through the app itself, with fetch faked at the API boundary, checked by axe: no
// serious or critical violation on sign-in, Today, the Queue, the Calendar or an item.
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App";
import { LeaveCard } from "../src/Settings";
import { axeProblems } from "./axe";
import { fakeApi } from "./fake-api";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  location.hash = "";
});

const me = {
  signedIn: true,
  locale: "en",
  setupNeeded: false,
  vapidPublicKey: "",
  dryRun: false,
  workspace: { id: "w1", name: "Demo Travel", mediaFolder: "UPLOADS", iconUrl: null },
  workspaces: [{ id: "w1", name: "Demo Travel", role: "admin", iconUrl: null, shownAs: null }],
  you: { name: "Ada", emailName: "ada", displayName: null, shownAs: "Ada" },
};
const today = new Date().toISOString().slice(0, 10);
const queued = {
  key: "lisbon-reel",
  platform: "instagram",
  label: "Reel",
  account: "demo_travel",
  due: `${today} 18:00`,
  folder: "lisbon",
  name: "reel.mp4",
  title: "Lisbon at dusk",
  format: "video",
  options: {},
  hold: false,
  approved: false,
  approval_matches_schedule: false,
};
const item = {
  ...queued,
  postFormat: "video",
  posted: false,
  content: "db",
  published: null,
  caption: "Lisbon at dusk #travel",
  comment: null,
  alt: "",
  media: [
    {
      store: "drive",
      id: "f1",
      checksum: "c1",
      mime: "video/mp4",
      name: "reel.mp4",
      url: "/m/f1",
    },
  ],
  approved: null,
  problems: [],
  fingerprint: "fp",
};
const event = {
  date: today,
  time: "18:00",
  platform: "instagram",
  format: "video",
  label: "Reel",
  title: "Lisbon at dusk",
  status: "not approved",
  key: "lisbon-reel",
  account: "demo_travel",
};

/** The signed-in app's answers, by path without its query: a screen's filters and months don't matter here. */
const answers: Record<string, unknown> = {
  me,
  platforms: {
    platforms: [
      {
        id: "instagram",
        name: "Instagram",
        accountNoun: "account",
        formats: [{ format: "video", name: "Reel", plural: "Reels" }],
        post: { name: "post", plural: "posts" },
        features: {},
      },
    ],
  },
  status: { dry_run: false, paused: false, today, timezone: "UTC", jobs_last_7_days: [] },
  queue: { items: [queued] },
  "queue/groups": { channels: [], groups: [] },
  drafts: { drafts: [] },
  "comments/unseen": { n: 0 },
  notifications: { notifications: [] },
  day: { events: [event], warnings: [] },
  calendar: { events: [event], warnings: [] },
  item,
};
const signedIn = () =>
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input)
        .replace(/^\/app-api\//, "")
        .split("?")[0];
      return path in answers
        ? new Response(JSON.stringify(answers[path]))
        : new Response(JSON.stringify({ error: `no route ${path}` }), { status: 404 });
    }),
  );

describe("accessibility (axe)", () => {
  it("finds a problem when there is one (axe runs under happy-dom)", async () => {
    render(
      <main>
        <button type="button" />
      </main>,
    );
    expect((await axeProblems()).map((p) => p.split(":")[0]).sort()).toEqual(["button-name"]);
  });

  it("sign-in", async () => {
    fakeApi({ "GET me": { body: { signedIn: false, setupNeeded: false, vapidPublicKey: "", locale: "en" } } });
    render(<App />);
    await screen.findByRole("button", { name: "Sign in with passkey" });
    expect(await axeProblems()).toEqual([]);
  });

  for (const [screenName, hash, text] of [
    ["Today", "#/", "Lisbon at dusk"],
    ["the Queue", "#/queue", "Lisbon at dusk"],
    ["the Calendar", "#/calendar", "Lisbon at dusk"],
    ["an item", "#/item/lisbon-reel", "#travel"],
  ])
    it(screenName, async () => {
      location.hash = hash;
      signedIn();
      render(<App />);
      await screen.findAllByText(text, { exact: false });
      expect(await axeProblems()).toEqual([]);
    });
});

describe("keyboard", () => {
  it("a button that asks first moves the focus to Cancel, then back to the button", async () => {
    render(<LeaveCard me={me} onLeft={() => {}} />);
    const user = userEvent.setup();
    await user.tab();
    expect(document.activeElement?.textContent).toBe("Leave Demo Travel");
    await user.keyboard("{Enter}");
    expect(document.activeElement?.textContent).toBe("Cancel");
    await user.keyboard("{Enter}");
    expect(document.activeElement?.textContent).toBe("Leave Demo Travel");
  });
});
