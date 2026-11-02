import { describe, expect, it } from "vitest";
import { main } from "../src/main";
import { generateSecrets } from "../src/secrets";
import { fakeCtx } from "./fake";

describe("generateSecrets", () => {
  it("makes keys of the documented shapes", async () => {
    const s = await generateSecrets();
    expect(s.SETUP_TOKEN).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(s.ENCRYPTION_KEY).toMatch(/^[0-9a-f]{64}$/);
    expect(s.MEDIA_SIGNING_KEY).toMatch(/^[0-9a-f]{64}$/);
    expect(s.VAPID_PRIVATE_KEY).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(s.vapidPublicKey).toMatch(/^B[A-Za-z0-9_-]{86}$/);
  });

  it("is different every time", async () => {
    expect((await generateSecrets()).ENCRYPTION_KEY).not.toBe((await generateSecrets()).ENCRYPTION_KEY);
  });
});

const NAMES = ["SETUP_TOKEN", "ENCRYPTION_KEY", "MEDIA_SIGNING_KEY", "VAPID_PRIVATE_KEY"];

/** A fake wrangler: `existing` is what `secret list` answers per config file name. It rejects any call the real
 *  wrangler would not understand, so a wrong flag fails here and not on the owner's machine. */
function fakeWrangler(existing: Record<string, string[]> = {}, opts: { listFails?: boolean; putFails?: string } = {}) {
  const calls: { args: string[]; input?: string; cwd?: string }[] = [];
  const exec = async (cmd: string, args: string[], input?: string, cwd?: string) => {
    calls.push({ args, input, cwd });
    expect(cmd).toBe("npx");
    expect(args.slice(0, 2)).toEqual(["wrangler", "secret"]);
    const FILES = ["wrangler.toml", "wrangler.cron.toml"];
    if (args[2] === "list") {
      // secret list --config FILE --format json: nothing else exists.
      expect(args.slice(3, 4)).toEqual(["--config"]);
      expect(FILES).toContain(args[4]);
      expect(args.slice(5)).toEqual(["--format", "json"]);
      if (opts.listFails) return { code: 1, stdout: "", stderr: "not logged in" };
      const list = (existing[args[4]] ?? []).map((name) => ({ name, type: "secret_text" }));
      return { code: 0, stdout: JSON.stringify(list), stderr: "" };
    }
    // secret put NAME --config FILE
    expect(args[2]).toBe("put");
    expect(args).toHaveLength(6);
    expect(args[4]).toBe("--config");
    expect(FILES).toContain(args[5]);
    if (args[3] === opts.putFails && args[5] === "wrangler.cron.toml") return { code: 1, stdout: "", stderr: "boom" };
    return { code: 0, stdout: "", stderr: "" };
  };
  return { exec, calls };
}

const puts = (calls: { args: string[]; input?: string }[]) => calls.filter((c) => c.args[2] === "put");
const everything = (t: { out: string[]; err: string[] }) => [...t.out, ...t.err].join("");

describe("deploy-secrets", () => {
  it("lists both configs first, then puts each name with the value on stdin", async () => {
    const w = fakeWrangler();
    const t = fakeCtx({ exec: w.exec });
    expect(await main(["deploy-secrets"], t.ctx)).toBe(0);
    expect(w.calls.slice(0, 2).map((c) => c.args[2])).toEqual(["list", "list"]);
    expect(w.calls.every((c) => c.cwd === `${process.cwd()}/apps/cloudflare`)).toBe(true);
    const put = puts(w.calls);
    expect(put).toHaveLength(8);
    expect(put.map((c) => c.args[3])).toEqual([...NAMES, ...NAMES]);
    for (const c of put) expect(c.input).toMatch(/^[A-Za-z0-9_-]{32,87}$|^[0-9a-f]{64}$/);
    expect(put[0].args.at(-1)).toBe("wrangler.toml");
    expect(put[4].args.at(-1)).toBe("wrangler.cron.toml");
    // The same value goes to both Workers.
    expect(put[1].input).toBe(put[5].input);
    const text = everything(t);
    expect(text).toContain("set SETUP_TOKEN, ENCRYPTION_KEY, MEDIA_SIGNING_KEY, VAPID_PRIVATE_KEY in wrangler.toml");
    expect(text).toContain("in wrangler.cron.toml");
    expect(text.match(/VAPID_PUBLIC_KEY = "B[\w-]{86}"/g)).toHaveLength(1);
    // SETUP_TOKEN is printed once, for the first sign-up; the other secrets never.
    expect(text.split(put[0].input as string)).toHaveLength(2);
    expect(text).toContain("first sign-up");
    for (const c of put.filter((c) => c.args[3] !== "SETUP_TOKEN")) expect(text).not.toContain(c.input);
  });

  it("keeps names that both configs have", async () => {
    const both = ["MEDIA_SIGNING_KEY"];
    const w = fakeWrangler({ "wrangler.toml": both, "wrangler.cron.toml": both });
    const t = fakeCtx({ exec: w.exec });
    expect(await main(["deploy-secrets"], t.ctx)).toBe(0);
    expect(puts(w.calls)).toHaveLength(6);
    expect(everything(t)).toContain("kept MEDIA_SIGNING_KEY in wrangler.toml");
    expect(everything(t)).toContain("kept MEDIA_SIGNING_KEY in wrangler.cron.toml");
  });

  it("doesn't print a SETUP_TOKEN it kept", async () => {
    const both = ["SETUP_TOKEN"];
    const w = fakeWrangler({ "wrangler.toml": both, "wrangler.cron.toml": both });
    const t = fakeCtx({ exec: w.exec });
    expect(await main(["deploy-secrets"], t.ctx)).toBe(0);
    expect(puts(w.calls).map((c) => c.args[3])).not.toContain("SETUP_TOKEN");
    expect(everything(t)).toContain("kept SETUP_TOKEN in wrangler.toml");
    expect(everything(t)).not.toContain("first sign-up");
  });

  it("refuses a secret that only one config has, before any put", async () => {
    const w = fakeWrangler({ "wrangler.toml": ["ENCRYPTION_KEY"] });
    const t = fakeCtx({ exec: w.exec });
    expect(await main(["deploy-secrets"], t.ctx)).toBe(1);
    expect(t.err.join("")).toContain("ENCRYPTION_KEY is set in wrangler.toml but not in wrangler.cron.toml");
    expect(t.err.join("")).toContain("run again with --rotate --only ENCRYPTION_KEY");
    expect(puts(w.calls)).toHaveLength(0);
  });

  it("--rotate fixes a secret that only one config has, with one value for both", async () => {
    const w = fakeWrangler({ "wrangler.toml": ["ENCRYPTION_KEY"] });
    const t = fakeCtx({ exec: w.exec });
    expect(await main(["deploy-secrets", "--rotate", "--only", "ENCRYPTION_KEY"], t.ctx)).toBe(0);
    const put = puts(w.calls);
    expect(put).toHaveLength(2);
    expect(put[0].input).toBe(put[1].input);
  });

  it("prints what went out when a put fails", async () => {
    const w = fakeWrangler({}, { putFails: "VAPID_PRIVATE_KEY" });
    const t = fakeCtx({ exec: w.exec });
    expect(await main(["deploy-secrets"], t.ctx)).toBe(1);
    const text = everything(t);
    expect(text).toContain("wrangler secret put VAPID_PRIVATE_KEY failed: boom");
    expect(text).toContain("set SETUP_TOKEN, ENCRYPTION_KEY, MEDIA_SIGNING_KEY, VAPID_PRIVATE_KEY in wrangler.toml");
    expect(text).toContain("set SETUP_TOKEN, ENCRYPTION_KEY, MEDIA_SIGNING_KEY in wrangler.cron.toml");
    expect(text).toMatch(/VAPID_PUBLIC_KEY = "B[\w-]{86}"/);
  });

  it("--rotate replaces them", async () => {
    const w = fakeWrangler({ "wrangler.toml": NAMES, "wrangler.cron.toml": NAMES });
    const t = fakeCtx({ exec: w.exec });
    expect(await main(["deploy-secrets", "--rotate"], t.ctx)).toBe(0);
    expect(puts(w.calls)).toHaveLength(8);
  });

  it("--only limits the names, and no key is printed when the private one is not set", async () => {
    const w = fakeWrangler();
    const t = fakeCtx({ exec: w.exec });
    expect(await main(["deploy-secrets", "--only", "ENCRYPTION_KEY"], t.ctx)).toBe(0);
    expect(puts(w.calls).map((c) => c.args[3])).toEqual(["ENCRYPTION_KEY", "ENCRYPTION_KEY"]);
    expect(everything(t)).not.toContain("VAPID_PUBLIC_KEY");
    expect(everything(t)).not.toContain("SETUP_TOKEN");

    const v = fakeWrangler();
    const u = fakeCtx({ exec: v.exec });
    expect(await main(["deploy-secrets", "--only=VAPID_PRIVATE_KEY"], u.ctx)).toBe(0);
    expect(puts(v.calls).map((c) => c.args[3])).toEqual(["VAPID_PRIVATE_KEY", "VAPID_PRIVATE_KEY"]);
    expect(everything(u)).toContain('VAPID_PUBLIC_KEY = "B');
  });

  it("rejects an unknown name in --only", async () => {
    const t = fakeCtx({ exec: fakeWrangler().exec });
    expect(await main(["deploy-secrets", "--only", "NOPE"], t.ctx)).toBe(2);
  });

  it("reads the configs from --config-dir", async () => {
    const w = fakeWrangler();
    const t = fakeCtx({ exec: w.exec });
    await main(["deploy-secrets", "--config-dir", "/srv/cf"], t.ctx);
    expect(w.calls.every((c) => c.cwd === "/srv/cf")).toBe(true);
  });

  it("stops with wrangler's error when secret list fails, before any put", async () => {
    const w = fakeWrangler({}, { listFails: true });
    const t = fakeCtx({ exec: w.exec });
    expect(await main(["deploy-secrets"], t.ctx)).toBe(1);
    expect(t.err.join("")).toContain("not logged in");
    expect(puts(w.calls)).toHaveLength(0);
  });
});
