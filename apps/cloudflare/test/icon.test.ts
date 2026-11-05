// The workspace icon on real SQL (D1): stored as base64, served publicly at /icon/<hash>.png, gone after removal,
// and shared bytes surviving one workspace's removal.
import { env } from "cloudflare:workers";
import { createApp } from "@bongsu/api/app";
import { iconByHash, iconHashes, removeIcon, setIcon } from "@bongsu/core/icon";
import { beforeEach, describe, expect, it } from "vitest";
import { png } from "./icon-png";

const get = (path: string) => createApp(fetch).request(`https://scheduler.test${path}`, {}, env);

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM workspace_icons").run();
  await env.DB.prepare(
    "INSERT INTO workspaces (id, name, created_at) VALUES ('b', 'Workspace B', 0) ON CONFLICT (id) DO NOTHING",
  ).run();
});

describe("/icon/<hash>.png", () => {
  it("serves the stored PNG to anyone, cached for good", async () => {
    const bytes = png(256);
    const hash = await setIcon(env.DB, "default", bytes, 1);
    const res = await get(`/icon/${hash}.png`);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/png");
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes);
    expect((await iconHashes(env.DB, ["default", "b"])).get("default")).toBe(hash);
  });

  it("is 404 for an unknown hash and for anything that isn't 64 hex characters", async () => {
    expect((await get(`/icon/${"a".repeat(64)}.png`)).status).toBe(404);
    expect((await get("/icon/xyz.png")).status).toBe(404);
  });

  it("is 404 after the icon is removed", async () => {
    const hash = await setIcon(env.DB, "default", png(256), 1);
    expect(await removeIcon(env.DB, "default")).toBe(true);
    expect(await removeIcon(env.DB, "default")).toBe(false);
    expect((await get(`/icon/${hash}.png`)).status).toBe(404);
    expect(await iconByHash(env.DB, hash)).toBeNull();
  });

  it("keeps working for a workspace that shares the bytes when another one's icon is removed", async () => {
    const bytes = png(256);
    const hash = await setIcon(env.DB, "default", bytes, 1);
    expect(await setIcon(env.DB, "b", bytes, 2)).toBe(hash);
    await removeIcon(env.DB, "default");
    expect((await get(`/icon/${hash}.png`)).status).toBe(200);
  });

  it("replacing an icon changes its URL and retires the old one", async () => {
    const old = await setIcon(env.DB, "default", png(256), 1);
    const next = await setIcon(env.DB, "default", png(300, 1), 2);
    expect(next).not.toBe(old);
    expect((await get(`/icon/${old}.png`)).status).toBe(404);
    expect((await get(`/icon/${next}.png`)).status).toBe(200);
  });
});
