// @vitest-environment happy-dom
// The screens Phase 13 added, rendered with fetch faked at the API boundary (test/fake-api.ts).
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PausedBanner, WorkspaceSheet } from "../src/App";
import { type DraftsAnswer, type Me, type Shared, SharedCtx } from "../src/common";
import { DraftsPage } from "../src/Drafts";
import { ApprovedText, TrialCopy } from "../src/Item";
import { LeaveCard, VersionInfo, YouCard } from "../src/Settings";
import { fakeApi } from "./fake-api";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const base: Me = {
  signedIn: true,
  locale: "en",
  setupNeeded: false,
  vapidPublicKey: "",
  dryRun: false,
  workspace: { id: "w1", name: "Demo Travel", mediaFolder: "UPLOADS", iconUrl: null },
  you: { name: "Ada", emailName: "ada", displayName: null, shownAs: "Ada" },
};

describe("the version card", () => {
  it("shows the app's release and commit, and the server's beside it", () => {
    vi.stubGlobal("fetch", () => new Promise(() => {})); // the deployed version.json: not needed here
    render(<VersionInfo me={{ ...base, server: { version: "0.7.0", commit: "abc1234" } }} />);
    expect(screen.getByText(__APP_VERSION__.commit)).toBeTruthy();
    expect(screen.getByText("abc1234").parentElement?.textContent).toBe("Server 0.7.0 abc1234");
  });

  it("says when the server's commit isn't known, and shows no server line signed out", () => {
    vi.stubGlobal("fetch", () => new Promise(() => {}));
    const { unmount } = render(<VersionInfo me={{ ...base, server: { version: "0.7.0", commit: null } }} />);
    expect(screen.getByText("unknown commit")).toBeTruthy();
    unmount();
    render(<VersionInfo me={{ ...base, server: null }} />);
    expect(screen.queryByText(/^Server/)).toBeNull();
  });
});

describe("the You card", () => {
  it("shows the workspace's name in the label, and the person's own name as the placeholder", () => {
    render(<YouCard me={base} onRefresh={() => {}} />);
    const shown = screen.getByLabelText("Shown in Demo Travel as") as HTMLInputElement;
    expect(shown.placeholder).toBe("Ada");
    expect(shown.value).toBe("");
  });

  it("falls back to the email's name for the placeholder when the person has no name yet", () => {
    render(
      <YouCard
        me={{ ...base, you: { name: null, emailName: "ada", displayName: null, shownAs: "ada" } }}
        onRefresh={() => {}}
      />,
    );
    expect((screen.getByLabelText("Shown in Demo Travel as") as HTMLInputElement).placeholder).toBe("ada");
  });

  it("saves a field alone, says so under it, and asks the app to refresh", async () => {
    const calls = fakeApi({ "POST me/display-name": { body: { ok: true } } });
    const onRefresh = vi.fn();
    render(<YouCard me={base} onRefresh={onRefresh} />);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Shown in Demo Travel as"), " Captain  ");
    await user.click(screen.getAllByRole("button", { name: "Save" })[1]);
    expect(await screen.findByText("Saved.")).toBeTruthy();
    expect(calls).toEqual([{ method: "POST", path: "me/display-name", body: { name: "Captain" } }]);
    expect(onRefresh).toHaveBeenCalledOnce();
  });

  it("shows the server's refusal inline, under the field that was saved only", async () => {
    fakeApi({ "POST me/name": { status: 400, body: { error: "A name is at most 60 characters." } } });
    const onRefresh = vi.fn();
    render(<YouCard me={base} onRefresh={onRefresh} />);
    await userEvent.setup().click(screen.getAllByRole("button", { name: "Save" })[0]);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("A name is at most 60 characters.");
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(onRefresh).not.toHaveBeenCalled();
  });
});

describe("the workspace picker", () => {
  const me: Me = {
    ...base,
    workspaces: [
      { id: "w1", name: "Demo Travel", role: "admin", iconUrl: "/icons/w1.png", shownAs: "Ada" },
      { id: "w2", name: "Demo Running", role: "editor", iconUrl: null, shownAs: "Captain" },
      { id: "w3", name: "Demo Cooking", role: "creator", iconUrl: null, shownAs: null },
    ],
  };
  const row = (name: string) => screen.getByText(name).closest("li") as HTMLElement;

  it("says 'Shown as …' only where the name differs from the person's own", () => {
    render(<WorkspaceSheet me={me} onClose={() => {}} onSwitched={() => {}} />);
    expect(within(row("Demo Running")).getByText("Shown as Captain")).toBeTruthy();
    expect(within(row("Demo Travel")).queryByText(/Shown as/)).toBeNull();
    expect(within(row("Demo Cooking")).queryByText(/Shown as/)).toBeNull();
  });

  it("compares with the email's name when the person has no name, so nobody sees it under every workspace", () => {
    const nameless: Me = {
      ...me,
      you: { name: null, emailName: "ada", displayName: null, shownAs: "ada" },
      workspaces: me.workspaces?.map((w) => ({ ...w, shownAs: "ada" })),
    };
    render(<WorkspaceSheet me={nameless} onClose={() => {}} onSwitched={() => {}} />);
    expect(screen.queryByText(/Shown as/)).toBeNull();
  });

  it("shows a workspace's icon, and nothing for one without", () => {
    render(<WorkspaceSheet me={me} onClose={() => {}} onSwitched={() => {}} />);
    expect(row("Demo Travel").querySelector("img.ws-icon")?.getAttribute("src")).toBe("/icons/w1.png");
    expect(row("Demo Running").querySelector("img")).toBeNull();
  });

  it("marks where the session is, and a click on another moves the session there, to Today", async () => {
    location.hash = "#/stats";
    const calls = fakeApi({ "POST session/workspace": { body: { ok: true, id: "w2" } } });
    const onSwitched = vi.fn();
    render(<WorkspaceSheet me={me} onClose={() => {}} onSwitched={onSwitched} />);
    expect(row("Demo Travel").querySelector("button")?.getAttribute("aria-current")).toBe("true");
    await userEvent.setup().click(within(row("Demo Running")).getByRole("button"));
    await waitFor(() => expect(onSwitched).toHaveBeenCalledOnce());
    expect(calls).toEqual([{ method: "POST", path: "session/workspace", body: { id: "w2" } }]);
    expect(location.hash).toBe("#/");
  });

  it("says so when the person is no longer in the workspace they chose", async () => {
    fakeApi({ "POST session/workspace": { status: 403, body: { error: "forbidden" } } });
    render(<WorkspaceSheet me={me} onClose={() => {}} onSwitched={() => {}} />);
    await userEvent.setup().click(within(row("Demo Running")).getByRole("button"));
    expect((await screen.findByRole("alert")).textContent).toBe("You're no longer in that workspace.");
  });
});

describe("the Trial Reel copy", () => {
  const trial = { on: true, byDefault: true, explicit: false, permalink: null, at: null, results: null };

  it("a copy closed without going out says it wasn't posted and why, not that it's still posting (#99)", () => {
    const { container, rerender } = render(
      <TrialCopy trial={{ ...trial, state: "done", error: "trial copy switched off" }} />,
    );
    expect(container.textContent).toBe("Trial Reel not posted: trial copy switched off");
    expect(container.querySelector(".pill.bad")).toBeNull(); // nothing went wrong
    rerender(<TrialCopy trial={{ ...trial, state: "pending", error: null }} />);
    expect(container.textContent).toBe("Trial Reel posting the trial copy…");
    rerender(<TrialCopy trial={{ ...trial, state: "failed", error: "Instagram busy" }} />);
    expect(container.querySelector(".pill.bad")).toBeTruthy();
  });
});

describe("who approved and who paused", () => {
  it("names the approver when the approval still matches", () => {
    render(<ApprovedText approved={{ at: "2026-10-21T02:56:18Z", matches: true, by: "Ada" }} />);
    expect(screen.getByText(/^Approved by Ada, .*exactly as shown\.$/)).toBeTruthy();
  });

  it("leaves the name out of an approval that has none, and says what changed once it doesn't match", () => {
    const { container, rerender } = render(<ApprovedText approved={{ at: "2026-10-21T02:56:18Z", matches: true }} />);
    expect(container.textContent).toMatch(/^Approved .*exactly as shown\.$/);
    expect(container.textContent).not.toMatch(/Approved by/);
    rerender(<ApprovedText approved={{ at: "2026-10-21T02:56:18Z", matches: false, by: "Ada" }} />);
    expect(container.textContent).toBe("Approved before, but something changed since: approve again.");
  });

  it("the paused banner names who paused, or says nothing goes out", () => {
    const { container, rerender } = render(<PausedBanner pausedBy="Ada" />);
    expect(container.textContent).toContain("Paused by Ada. Nothing goes out until you resume.");
    rerender(<PausedBanner />);
    expect(container.textContent).toContain("Nothing goes out until you resume.");
    expect(container.textContent).not.toContain("Paused by");
  });
});

describe("scheduling a draft to several accounts (#30)", () => {
  const answer: DraftsAnswer = {
    accounts: ["demo_travel", "demo_bsky"],
    accountInfo: { demo_travel: { platform: "instagram" }, demo_bsky: { platform: "bluesky" } },
    drafts: [
      {
        id: "d_x",
        kind: "photo",
        account: "demo_travel",
        source: "pwa",
        created_by: "owner",
        created_at: "2026-10-19 10:00",
        // the payload type is a string record with media beside it: a literal needs the cast
        payload: {
          name: "photo",
          folder: "20261020_DEMO",
          caption: "Hello",
          media: ["m1"],
        } as unknown as DraftsAnswer["drafts"][number]["payload"],
      },
    ],
  };
  const page = () =>
    render(
      <SharedCtx.Provider
        value={{ drafts: { data: answer, error: null, reload: () => {}, stale: null, at: null } } as unknown as Shared}
      >
        <DraftsPage />
      </SharedCtx.Provider>,
    );
  const keys = ["post:20261020_DEMO/photo.demo_travel", "post:20261020_DEMO/photo.demo_bsky"];

  it("sends every account picked, then opens the item whose caption was shortened", async () => {
    const calls = fakeApi({
      "GET uploads/enabled": { body: { enabled: false, stores: [] } },
      "POST drafts/d_x/schedule": { body: { key: keys[0], keys, shortened: ["demo_bsky"] } },
    });
    page();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Schedule…" }));
    const picks = screen.getByRole("group", { name: "Accounts" });
    expect(within(picks).getByRole("button", { name: "@demo_travel" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.queryByText(/Each account gets its own item/)).toBeNull();
    await user.click(within(picks).getByRole("button", { name: "@demo_bsky" }));
    expect(screen.getByText(/Each account gets its own item/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Schedule" }));
    await waitFor(() => expect(location.hash).toBe(`#/item/${encodeURIComponent(keys[1])}`));
    const sent = calls.find((c) => c.path === "drafts/d_x/schedule")?.body as Record<string, unknown>;
    expect(sent.accounts).toEqual(["demo_travel", "demo_bsky"]);
    expect(sent.account).toBeUndefined();
  });

  it("asks for an account when none is picked, and sends nothing", async () => {
    const calls = fakeApi({ "GET uploads/enabled": { body: { enabled: false, stores: [] } } });
    page();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Schedule…" }));
    await user.click(screen.getByRole("button", { name: "@demo_travel" }));
    await user.click(screen.getByRole("button", { name: "Schedule" }));
    expect(await screen.findByText("Pick at least one account.")).toBeTruthy();
    expect(calls.some((c) => c.path.startsWith("drafts/"))).toBe(false);
  });
});

describe("leaving the workspace", () => {
  it("asks first, then leaves, goes to Today and refreshes", async () => {
    location.hash = "#/settings";
    const calls = fakeApi({ "POST session/leave": { body: { left: "w1" } } });
    const onLeft = vi.fn();
    render(<LeaveCard me={base} onLeft={onLeft} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Leave Demo Travel" }));
    const ask = screen.getByRole("alertdialog", { name: "Leave Demo Travel?" });
    await user.click(within(ask).getByRole("button", { name: "Leave Demo Travel" }));
    await waitFor(() => expect(onLeft).toHaveBeenCalledOnce());
    expect(calls).toEqual([{ method: "POST", path: "session/leave", body: {} }]);
    expect(location.hash).toBe("#/");
  });

  it("says why when the last admin can't leave, and stays", async () => {
    fakeApi({
      "POST session/leave": {
        status: 409,
        body: { error: "a workspace keeps one admin: make someone else admin first" },
      },
    });
    const onLeft = vi.fn();
    render(<LeaveCard me={base} onLeft={onLeft} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Leave Demo Travel" }));
    await user.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Leave Demo Travel" }));
    expect((await screen.findByRole("status")).textContent).toMatch(/make someone else admin first/);
    expect(onLeft).not.toHaveBeenCalled();
  });
});
