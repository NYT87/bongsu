import { chmod, mkdir, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { describe, expect, it } from "vitest";
import { CliError } from "../src/client";
import { profileFor, readConfig, writeConfig } from "../src/config";
import { fakeCtx } from "./fake";

const travel = { url: "https://travel.example.com", token: "bongsu_cli_travel" };
const running = { url: "https://running.example.com", token: "bongsu_cli_running" };

describe("config file", () => {
  it("is written with mode 0600 in a 0700 folder", async () => {
    const { ctx } = fakeCtx();
    await writeConfig(ctx.configPath, { default: "travel", profiles: { travel } });
    expect((await stat(ctx.configPath)).mode & 0o777).toBe(0o600);
    expect((await stat(dirname(ctx.configPath))).mode & 0o777).toBe(0o700);
    expect(await readConfig(ctx.configPath)).toEqual({ default: "travel", profiles: { travel } });
  });

  it("refuses a damaged file without echoing its contents", async () => {
    const { ctx } = fakeCtx();
    await mkdir(dirname(ctx.configPath), { recursive: true });
    await writeFile(ctx.configPath, "tok bongsu_cli_secret");
    const error = await readConfig(ctx.configPath).catch((e: Error) => e);
    expect(error).toBeInstanceOf(CliError);
    expect((error as Error).message).toBe(`can't read ${ctx.configPath}: not valid JSON; fix or delete it`);
    expect((error as Error).message).not.toContain("bongsu_cli_secret");
  });

  it.skipIf(process.getuid?.() === 0)("refuses an unreadable file with a CliError", async () => {
    const { ctx } = fakeCtx({ config: { profiles: {} } });
    await chmod(ctx.configPath, 0o000);
    await expect(readConfig(ctx.configPath)).rejects.toThrow(
      new CliError(`can't read ${ctx.configPath}: permission denied; check its owner and mode`),
    );
  });

  it("reads as no profiles when missing", async () => {
    const { ctx } = fakeCtx();
    expect(await readConfig(ctx.configPath)).toEqual({ profiles: {} });
  });
});

describe("profileFor", () => {
  const config = { default: "travel", profiles: { travel, running } };

  it("refuses one of BONGSU_URL and BONGSU_TOKEN alone", async () => {
    for (const env of [{ BONGSU_URL: "https://env.example.com" }, { BONGSU_TOKEN: "bongsu_cli_env" }]) {
      const { ctx } = fakeCtx({ config, env });
      await expect(profileFor(ctx)).rejects.toThrow("set both BONGSU_URL and BONGSU_TOKEN, or neither");
    }
  });

  it("prefers BONGSU_URL and BONGSU_TOKEN", async () => {
    const { ctx } = fakeCtx({ config, env: { BONGSU_URL: "https://env.example.com", BONGSU_TOKEN: "bongsu_cli_env" } });
    ctx.workspace = "running";
    expect(await profileFor(ctx)).toEqual({ url: "https://env.example.com", token: "bongsu_cli_env" });
  });

  it("then --workspace", async () => {
    const { ctx } = fakeCtx({ config });
    ctx.workspace = "running";
    expect(await profileFor(ctx)).toEqual(running);
  });

  it("then the default", async () => {
    const { ctx } = fakeCtx({ config });
    expect(await profileFor(ctx)).toEqual(travel);
  });

  it("asks for a login when there is none", async () => {
    const { ctx } = fakeCtx();
    await expect(profileFor(ctx)).rejects.toThrow("run bongsu login first");
  });

  it("asks for a login when --workspace names no profile", async () => {
    const { ctx } = fakeCtx({ config });
    ctx.workspace = "other";
    await expect(profileFor(ctx)).rejects.toThrow("run bongsu login first");
  });
});
