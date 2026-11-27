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

describe("Media: Google Drive's root folder", () => {
  const stores = (drive?: { root?: { id: string; name: string } }) => ({
    body: {
      stores: drive
        ? [
            {
              kind: "drive",
              default: true,
              settings: drive.root ? { root: drive.root } : {},
              hasCredentials: true,
              status: "ok",
              lastError: null,
              lastCheckedAt: null,
              waitingApprovals: 0,
            },
          ]
        : [],
      offered: ["drive", "s3"],
      googleApp: true,
      encryptionKeySet: true,
    },
  });
  const admin = () => ({ body: { ...state(), instanceAdmin: true } });
  // the start's answer is where the browser goes: Google, which a test doesn't visit
  const assign = vi.fn();
  beforeEach(() => {
    assign.mockReset();
    vi.spyOn(window.location, "assign").mockImplementation(assign);
  });

  it("connects a new Drive with the root folder typed", async () => {
    const calls = fakeApi({
      "GET state": admin,
      "GET media-stores": stores(),
      "POST media-stores/drive/start": { body: { url: "https://accounts.google.com/o/oauth2/v2/auth?x=1" } },
    });
    open("media");
    await userEvent.type(await screen.findByLabelText(/^Root folder/), "bongsu-media");
    await userEvent.click(screen.getByRole("button", { name: "Connect Google Drive" }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith("https://accounts.google.com/o/oauth2/v2/auth?x=1"));
    expect(calls.find((c) => c.path === "media-stores/drive/start")?.body).toEqual({ root: "bongsu-media" });
  });

  it("asks for the root folder before connecting: an empty field says why and sends nothing", async () => {
    const calls = fakeApi({ "GET state": admin, "GET media-stores": stores() });
    open("media");
    const field = await screen.findByLabelText(/^Root folder \(required\)/);
    expect(field.getAttribute("placeholder")).toBeNull(); // no grey example that reads like a value
    const connect = screen.getByRole("button", { name: "Connect Google Drive" });
    expect(connect.getAttribute("aria-disabled")).toBe("true");
    await userEvent.click(connect);
    expect((await screen.findByRole("alert")).textContent).toMatch(/Type the root folder first/);
    expect(calls.some((c) => c.path === "media-stores/drive/start")).toBe(false);
    expect(assign).not.toHaveBeenCalled();
    await userEvent.type(field, "bongsu-media");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(connect.getAttribute("aria-disabled")).toBe("false");
  });

  it("shows a connected Drive's root, saves another, and connects again keeping it", async () => {
    const calls = fakeApi({
      "GET state": admin,
      "GET media-stores": stores({ root: { id: "f1", name: "bongsu-media" } }),
      "POST media-stores/drive/root": { body: { saved: true, settings: { root: { id: "f2", name: "other" } } } },
      "POST media-stores/drive/start": { body: { url: "https://accounts.google.com/o/oauth2/v2/auth?x=2" } },
    });
    open("media");
    const field = await screen.findByLabelText(/^Root folder/);
    expect(field).toHaveProperty("value", "bongsu-media");
    expect(screen.getByText(/each workspace's folder in bongsu-media/)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Connect again" }));
    await waitFor(() => expect(assign).toHaveBeenCalled());
    expect(calls.find((c) => c.path === "media-stores/drive/start")?.body).toEqual({}); // the saved root stays
    await userEvent.clear(field);
    await userEvent.type(field, "other");
    await userEvent.click(screen.getByRole("button", { name: "Save the root folder" }));
    await waitFor(() =>
      expect(calls.find((c) => c.path === "media-stores/drive/root")?.body).toEqual({ root: "other" }),
    );
  });
});

describe("Workspaces: a new workspace's admin", () => {
  const routes = (made: (body: unknown) => { body: unknown }) => ({
    "GET state": () => ({ body: { ...state(), instanceAdmin: true } }),
    "GET workspaces": { body: { workspaces: [] } },
    "GET scheduler": { status: 500, body: { error: "not needed here" } },
    "GET users": {
      body: {
        users: [
          { id: "u1", email: "ada@example.com", name: "Ada" },
          { id: "u2", email: "ben@example.com", name: "Ben" },
        ],
      },
    },
    "POST workspaces": made,
  });

  it("picks an account on the instance: no radios, the account is sent, and it's its admin right away", async () => {
    const calls = fakeApi(routes(() => ({ body: { id: "w2", admin: "u2" } })));
    open("workspaces");
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Create a workspace" }));
    expect(screen.queryByRole("radio")).toBeNull();
    const picker = screen.getByLabelText("Its admin") as HTMLSelectElement;
    // me first, then the other accounts (not me twice), then someone new
    await waitFor(() =>
      expect([...picker.options].map((o) => o.textContent)).toEqual([
        "Me",
        "Ben (ben@example.com)",
        "Someone new: invite them by email",
      ]),
    );
    await user.type(screen.getByLabelText("Name"), "Demo Running");
    await user.selectOptions(picker, "ben@example.com");
    await user.click(screen.getByRole("button", { name: "Create the workspace" }));
    expect(await screen.findByText("Demo Running is ready: ben@example.com is its admin.")).toBeTruthy();
    expect(calls.find((c) => c.method === "POST")?.body).toMatchObject({
      name: "Demo Running",
      admin: "ben@example.com",
    });
  });

  it("invites someone new by email and shows their link", async () => {
    const calls = fakeApi(routes(() => ({ body: { id: "w2", invite: { url: "https://bongsu.example.com/i/x" } } })));
    open("workspaces");
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Create a workspace" }));
    await user.type(screen.getByLabelText("Name"), "Client");
    await user.selectOptions(screen.getByLabelText("Its admin"), "new");
    await user.type(screen.getByLabelText("Their email"), " New@Example.com ");
    await user.click(screen.getByRole("button", { name: "Create the workspace" }));
    expect(await screen.findByText("Invite link for new@example.com")).toBeTruthy();
    expect(calls.find((c) => c.method === "POST")?.body).toMatchObject({ admin: "new@example.com" });
  });
});

describe("the admin dashboard", () => {
  const routes = (s: object) => ({
    "GET state": { body: { ...state(), ...s } },
    "GET overview": { status: 500, body: { error: "not needed here" } },
    "GET workspaces": { body: { workspaces: [] } },
    "GET scheduler": { status: 500, body: { error: "not needed here" } },
    "GET oauth-apps": { body: { apps: [], encryptionKeySet: true } },
  });
  const nav = () => within(sidebar().querySelector("nav[aria-label='Sections']") as HTMLElement);
  const heading = (name: string) => screen.findByRole("heading", { level: 1, name });

  it("is a link at the bottom of an instance admin's sidebar, and the way back returns to the workspace", async () => {
    fakeApi(routes({ instanceAdmin: true }));
    open("");
    const user = userEvent.setup();
    await heading("Overview");
    // the workspace's sidebar has none of the instance's pages
    expect(nav().queryByRole("link", { name: "Workspaces" })).toBeNull();
    expect(nav().queryByRole("link", { name: "OAuth apps" })).toBeNull();
    await user.click(within(sidebar()).getByRole("link", { name: "Admin dashboard" }));
    await heading("Workspaces");
    expect(location.pathname).toBe("/dashboard/admin/workspaces");
    expect(
      nav()
        .getAllByRole("link")
        .map((a) => a.textContent),
    ).toEqual(["Workspaces", "Media", "OAuth apps", "Audit"]);
    await user.click(within(sidebar()).getByRole("link", { name: "Back to Demo Travel" }));
    await heading("Overview");
    expect(location.pathname).toBe("/dashboard/");
  });

  it("sends anyone else who opens one of its pages back to their workspace, with no link to it", async () => {
    fakeApi(routes({ instanceAdmin: false }));
    open("admin/workspaces");
    await heading("Overview");
    expect(location.pathname).toBe("/dashboard/");
    expect(within(sidebar()).queryByRole("link", { name: "Admin dashboard" })).toBeNull();
  });

  it("moves a page's old path (a link already sent) to the admin dashboard's", async () => {
    fakeApi(routes({ instanceAdmin: true }));
    open("apps");
    await heading("OAuth apps");
    expect(location.pathname).toBe("/dashboard/admin/apps");
  });

  it("is where an instance admin in no workspace is, with their devices", async () => {
    fakeApi(routes({ instanceAdmin: true, noWorkspace: true, workspace: null, workspaces: [], role: null }));
    open("");
    await heading("Workspaces");
    expect(
      nav()
        .getAllByRole("link")
        .map((a) => a.textContent),
    ).toEqual(["Workspaces", "Media", "OAuth apps", "Audit", "Devices & passkeys"]);
    // no workspace to go back to
    expect(within(sidebar()).queryByRole("navigation", { name: "Dashboards" })).toBeNull();
  });
});

describe("Audit", () => {
  const entry = (id: number, action: string) => ({
    id,
    at: 0,
    actor: "user:u1",
    action,
    target: null,
    detail: null,
    who: "Ada",
  });
  const routes = (s: object) => ({
    "GET state": { body: { ...state(), ...s } },
    "GET workspaces": {
      body: {
        workspaces: [
          { id: "w1", name: "Demo Travel" },
          { id: "w2", name: "Demo Running" },
        ],
      },
    },
    "GET audit": { body: { entries: [entry(3, "settings_save")] } },
    "GET audit?instance=1": { body: { entries: [entry(2, "workspace_create")] } },
    "GET audit?workspace=w2": { body: { entries: [entry(1, "invite_create")] } },
  });

  it("is the workspace's own log in the workspace, with no switch to another", async () => {
    const calls = fakeApi(routes({ instanceAdmin: true }));
    open("audit");
    expect(await screen.findByText("settings save")).toBeTruthy();
    expect(screen.queryByLabelText("Which log")).toBeNull();
    expect(calls.filter((c) => c.path.startsWith("audit")).map((c) => c.path)).toEqual(["audit"]);
  });

  it("reads the instance's log in the admin dashboard, then any workspace's picked there", async () => {
    const calls = fakeApi(routes({ instanceAdmin: true }));
    open("admin/audit");
    // no workspace picked at first: the instance's own log
    expect(await screen.findByText("workspace create")).toBeTruthy();
    const pick = screen.getByLabelText("Workspace") as HTMLSelectElement;
    expect(pick.value).toBe("");
    await waitFor(() => expect(pick.options.length).toBe(3));
    await userEvent.setup().selectOptions(pick, "w2");
    expect(await screen.findByText("invite create")).toBeTruthy();
    expect(screen.queryByText("workspace create")).toBeNull();
    expect(calls.filter((c) => c.path.startsWith("audit")).map((c) => c.path)).toEqual([
      "audit?instance=1",
      "audit?workspace=w2",
    ]);
  });
});

describe("Settings → Media: the workspace's folder", () => {
  const media = (folder: string) => ({
    body: {
      folder,
      stores: [
        {
          id: "drive",
          kind: "drive",
          own: false,
          default: true,
          status: "ok",
          lastError: null,
          lastCheckedAt: null,
          settings: {},
          waitingApprovals: 0,
        },
        {
          id: "s3",
          kind: "s3",
          own: false,
          default: false,
          status: "ok",
          lastError: null,
          lastCheckedAt: null,
          settings: {},
          waitingApprovals: 0,
        },
      ],
      offered: ["drive", "s3"],
      googleApp: true,
      encryptionKeySet: true,
    },
  });

  it("renames it, and says where it was renamed and where a new one was made", async () => {
    let folder = "demo-travel";
    const calls = fakeApi({
      "GET state": () => ({ body: state() }),
      "GET settings/media": () => media(folder),
      "PUT settings/media/folder": (b) => {
        folder = (b as { folder: string }).folder;
        return { body: { folder, renamed: ["drive"], made: ["s3"], failed: [] } };
      },
    });
    open("settings/media");
    const field = await screen.findByLabelText("Folder");
    await waitFor(() => expect(field).toHaveProperty("value", "demo-travel")); // the saved name, filled in
    expect(screen.getByText(/renames the folder in Google Drive/)).toBeTruthy();
    await userEvent.clear(field);
    await userEvent.type(field, "demo-trips");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(
      await screen.findByText(
        "The media folder is demo-trips. Renamed in Google Drive: its files stay in it. Made new in S3-compatible bucket: files in the old folder stay there.",
      ),
    ).toBeTruthy();
    expect(calls.find((c) => c.path === "settings/media/folder")?.body).toEqual({ folder: "demo-trips" });
  });

  it("shows the refusal of a name a store already has, and keeps the field", async () => {
    fakeApi({
      "GET state": () => ({ body: state() }),
      "GET settings/media": () => media("demo-travel"),
      "PUT settings/media/folder": {
        status: 400,
        body: { error: "Google Drive already has a folder named taken: pick a name it doesn't use" },
      },
    });
    open("settings/media");
    const field = await screen.findByLabelText("Folder");
    await waitFor(() => expect(field).toHaveProperty("value", "demo-travel"));
    await userEvent.clear(field);
    await userEvent.type(field, "taken");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/already has a folder named taken/);
    expect(field).toHaveProperty("value", "taken");
  });
});
