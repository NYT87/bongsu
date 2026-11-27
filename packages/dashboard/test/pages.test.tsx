// The screens Phase 13 added, rendered through the dashboard itself with fetch faked at the API boundary: the Icon card
// and Edit name on Members, and the sidebar that shows both.
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App";
import { fakeApi } from "./fake-api";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** The workspace as the server has it now: what the tests change, and the sidebar reads back. */
let ws: { name: string; iconUrl: string | null };
let people: { userId: string; email: string; name: string; displayName: string | null; role: string }[];
beforeEach(() => {
  ws = { name: "Demo Travel", iconUrl: null };
  people = [{ userId: "u1", email: "ada@example.com", name: "Ada", displayName: null, role: "admin" }];
});

const state = () => ({
  bootstrapNeeded: false,
  setupTokenSet: false,
  signedIn: true,
  user: { id: "u1", email: "ada@example.com", name: people[0].name },
  instanceAdmin: false,
  role: "admin",
  noWorkspace: false,
  anyWorkspace: true,
  workspace: { id: "w1", ...ws },
  workspaces: [{ id: "w1", name: ws.name, role: "admin", iconUrl: ws.iconUrl }],
  dryRun: false,
  publicUrl: "https://bongsu.example.com",
});

const open = (path: string) => {
  history.replaceState(null, "", `/dashboard/${path}`);
  return render(<App />);
};
const sidebar = () => document.querySelector("aside.sidebar") as HTMLElement;
const png = () => new File([new Uint8Array([137, 80, 78, 71])], "mark.png", { type: "image/png" });

describe("Settings: the Icon card", () => {
  const settings = () => ({
    body: {
      name: ws.name,
      timezone: "UTC",
      digestHour: 8,
      dryRun: false,
      publicUrl: "https://bongsu.example.com",
      ntfy: { set: false, host: null },
      encryptionKeySet: true,
      iconUrl: ws.iconUrl,
      server: { version: "0.7.0", commit: null },
    },
  });

  it("shows the app's version and commit beside the server's", async () => {
    fakeApi({ "GET state": () => ({ body: state() }), "GET settings": settings });
    open("settings");
    const card = (await screen.findByRole("heading", { name: "Version" })).closest(".card") as HTMLElement;
    expect(within(card).getByText(__APP_VERSION__.commit)).toBeTruthy();
    expect(within(card).getByText("unknown commit")).toBeTruthy();
    expect(card.textContent).toContain("0.7.0");
  });

  it("uploads a PNG, then the card and the sidebar both show the new icon", async () => {
    const calls = fakeApi({
      "GET state": () => ({ body: state() }),
      "GET settings": settings,
      "PUT settings/icon": () => {
        ws.iconUrl = "/icons/w1.png";
        return { body: { ok: true } };
      },
    });
    open("settings");
    const user = userEvent.setup();
    expect(await screen.findByText("No icon: the app's own is used.")).toBeTruthy();
    expect(sidebar().querySelector("img.workspace-icon")).toBeNull();
    await user.upload(screen.getByLabelText("Upload an icon"), png());
    expect(await screen.findByText("Icon saved.")).toBeTruthy();
    await waitFor(() =>
      expect(sidebar().querySelector("img.workspace-icon")?.getAttribute("src")).toBe("/icons/w1.png"),
    );
    expect(document.querySelector("img.icon-preview")?.getAttribute("src")).toBe("/icons/w1.png");
    expect(calls.find((c) => c.method === "PUT")?.body).toEqual({ type: "image/png", name: "mark.png" });
  });

  it("shows the server's refusal in the card, and changes nothing", async () => {
    fakeApi({
      "GET state": () => ({ body: state() }),
      "GET settings": settings,
      "PUT settings/icon": { status: 400, body: { error: "The icon must be square." } },
    });
    open("settings");
    await userEvent.setup().upload(await screen.findByLabelText("Upload an icon"), png());
    const card = (await screen.findByText("The icon must be square.")).closest(".card") as HTMLElement;
    expect(within(card).getByRole("heading", { name: "Icon" })).toBeTruthy();
    expect(screen.queryByText("Icon saved.")).toBeNull();
    expect(sidebar().querySelector("img.workspace-icon")).toBeNull();
  });

  it("removes the icon, and the sidebar drops it", async () => {
    ws.iconUrl = "/icons/w1.png";
    const calls = fakeApi({
      "GET state": () => ({ body: state() }),
      "GET settings": settings,
      "DELETE settings/icon": () => {
        ws.iconUrl = null;
        return { body: { ok: true } };
      },
    });
    open("settings");
    await waitFor(() => expect(sidebar().querySelector("img.workspace-icon")).not.toBeNull());
    await userEvent.setup().click(await screen.findByRole("button", { name: "Remove" }));
    expect(await screen.findByText("Icon removed.")).toBeTruthy();
    await waitFor(() => expect(sidebar().querySelector("img.workspace-icon")).toBeNull());
    expect(calls.some((c) => c.method === "DELETE" && c.path === "settings/icon")).toBe(true);
  });
});

describe("Members: Edit name", () => {
  const routes = (rename: (name: string) => void = () => {}) => ({
    "GET state": () => ({ body: state() }),
    "GET members": () => ({ body: { members: people, invites: [] } }),
    "POST members/u1/name": (b: unknown) => {
      rename((b as { name: string }).name);
      return { body: { ok: true } };
    },
  });

  it("saves the name shown in this workspace, and the sidebar shows the new name for the signed-in person", async () => {
    const calls = fakeApi(
      routes((name) => {
        people[0].displayName = name;
        people[0].name = name;
      }),
    );
    open("members");
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Edit name" }));
    await user.type(screen.getByLabelText("Name in this workspace"), "Captain");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(within(sidebar()).getByText("Captain")).toBeTruthy());
    expect(calls.find((c) => c.method === "POST")).toMatchObject({
      path: "members/u1/name",
      body: { name: "Captain" },
    });
    expect(screen.queryByLabelText("Name in this workspace")).toBeNull(); // the form closes
  });

  it("shows the refusal beside the form and keeps it open", async () => {
    const calls = fakeApi({
      ...routes(),
      "POST members/u1/name": { status: 400, body: { error: "A name is at most 60 characters." } },
    });
    open("members");
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Edit name" }));
    await user.type(screen.getByLabelText("Name in this workspace"), "x");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect((await screen.findByRole("alert")).textContent).toBe("A name is at most 60 characters.");
    expect(screen.getByLabelText("Name in this workspace")).toBeTruthy();
    expect(calls.filter((c) => c.path === "state")).toHaveLength(1); // nothing changed: no refresh
  });
});

describe("Connections: a Bluesky app password", () => {
  it("asks for the handle and an app password, not a token", async () => {
    const calls = fakeApi({
      "GET state": () => ({ body: state() }),
      "GET connections": () => ({
        body: {
          connections: [],
          appsReady: [],
          kinds: [
            {
              provider: "bluesky-atproto",
              kind: "token",
              label: "Bluesky (app password)",
              platform: "bluesky",
              pasteToken: true,
              docs: "site/docs/bluesky.md",
              canPaste: true,
            },
          ],
        },
      }),
      "POST connect/bluesky-atproto/paste": () => ({
        body: { label: "@demo_travel.bsky.social", accounts: [{ id: "demo_travel-bsky-social", created: true }] },
      }),
    });
    open("connections");
    const user = userEvent.setup();
    expect(await screen.findByText("Paste the handle and an app password.")).toBeTruthy();
    expect(screen.queryByText("Sign in with the account and allow access.")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Paste the app password" }));
    const field = screen.getByLabelText(/handle:app-password/);
    expect(screen.queryByText(/60 days/)).toBeNull();
    await user.type(field, "demo_travel.bsky.social:aaaa-bbbb-cccc-dddd");
    await user.click(screen.getByRole("button", { name: "Connect" }));
    expect(await screen.findByText(/Connected @demo_travel.bsky.social/)).toBeTruthy();
    expect(calls.find((c) => c.method === "POST")?.body).toEqual({
      value: "demo_travel.bsky.social:aaaa-bbbb-cccc-dddd",
    });
  });
});
