// @vitest-environment happy-dom
// The screens Phase 13 added, rendered with fetch faked at the API boundary (test/fake-api.ts).
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApprovedText, type Me, PausedBanner, TrialCopy, WorkspaceSheet, YouCard } from "../src/App";
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

  it("marks where the session is, and a click on another moves the session there", async () => {
    const calls = fakeApi({ "POST session/workspace": { body: { ok: true, id: "w2" } } });
    const onSwitched = vi.fn();
    render(<WorkspaceSheet me={me} onClose={() => {}} onSwitched={onSwitched} />);
    expect(row("Demo Travel").querySelector("button")?.getAttribute("aria-current")).toBe("true");
    await userEvent.setup().click(within(row("Demo Running")).getByRole("button"));
    await waitFor(() => expect(onSwitched).toHaveBeenCalledOnce());
    expect(calls).toEqual([{ method: "POST", path: "session/workspace", body: { id: "w2" } }]);
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
