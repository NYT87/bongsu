import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { postgresSchema } from "@bongsu/schema/postgres";
import { sqliteSchema } from "@bongsu/schema/sqlite";
import { describe, expect, it } from "vitest";
import { readConfig } from "../src/config";
import { main } from "../src/main";
import { fakeCtx } from "./fake";

const travel = { url: "https://travel.example.com", token: "bongsu_cli_travel" };
const running = { url: "https://running.example.com", token: "bongsu_cli_running" };
const config = { default: "travel", profiles: { travel, running } };

const statusAnswer = {
  dry_run: false,
  paused: false,
  today: "2026-10-29",
  timezone: "Europe/Madrid",
  jobs_last_7_days: [
    { state: "done", mode: "live", n: 4 },
    { state: "failed", mode: "live", n: 1 },
  ],
  accounts: ["demo_travel", "demo_running"],
};

const item = (key: string, extra: Record<string, unknown>) => ({
  key,
  platform: "instagram",
  label: "Reel",
  kind: "reel",
  account: "demo_travel",
  due: "2026-10-30 09:00 Europe/Madrid",
  due_at: "2026-10-30T08:00:00Z",
  hold: false,
  approved: false,
  approval_matches_schedule: false,
  note: null,
  ...extra,
});

const queueAnswer = {
  timezone: "Europe/Madrid",
  until: "2026-11-12",
  items: [
    item("reel:demo/one", { hold: true }),
    item("reel:demo/two", { approved: true, approval_matches_schedule: true }),
    item("reel:demo/three", { approved: true }),
    item("post:demo/four", { account: "demo_running", label: "Post", kind: "post" }),
  ],
};

describe("login", () => {
  it("login checks the token, saves the profile and names it after the host", async () => {
    const { ctx, out, calls } = fakeCtx({ responses: { "GET /v1/status": { paused: false } } });
    expect(await main(["login", "--url", "https://bongsu.example.com/", "--token", "bongsu_cli_abc"], ctx)).toBe(0);
    expect(calls[0].url).toBe("https://bongsu.example.com/v1/status");
    expect((await readConfig(ctx.configPath)).default).toBe("bongsu.example.com");
    expect(out.join("")).not.toContain("bongsu_cli_abc");
  });

  it("login prompts for the token without echo when --token is missing", async () => {
    const { ctx, prompts, calls } = fakeCtx({
      responses: { "GET /v1/status": { paused: false } },
      answers: ["bongsu_cli_typed"],
    });
    expect(await main(["login", "--url", "https://bongsu.example.com", "--workspace", "travel"], ctx)).toBe(0);
    expect(prompts).toHaveLength(1);
    expect(prompts[0].secret).toBe(true);
    expect(calls[0].url).toBe("https://bongsu.example.com/v1/status");
    const saved = await readConfig(ctx.configPath);
    expect(saved).toEqual({
      default: "travel",
      profiles: { travel: { url: "https://bongsu.example.com", token: "bongsu_cli_typed" } },
    });
  });

  it("login refuses a bad token and saves nothing", async () => {
    const { ctx, err } = fakeCtx({
      responses: { "GET /v1/status": { status: 401, body: { error: "missing or invalid API key" } } },
    });
    expect(await main(["login", "--url", "https://bongsu.example.com", "--token", "bongsu_cli_bad"], ctx)).toBe(1);
    expect(existsSync(ctx.configPath)).toBe(false);
    expect(err.join("")).toContain("bongsu: ");
    expect(err.join("")).not.toContain("bongsu_cli_bad");
  });

  it("login refuses a site that isn't a Bongsu instance and saves nothing", async () => {
    const { ctx, err } = fakeCtx({ responses: { "GET /v1/status": { status: 200, text: "<html>hello</html>" } } });
    expect(await main(["login", "--url", "https://wrong-site.example.com", "--token", "bongsu_cli_abc"], ctx)).toBe(1);
    expect(existsSync(ctx.configPath)).toBe(false);
    expect(err.join("")).toContain("bongsu: https://wrong-site.example.com didn't answer like a Bongsu instance");
  });

  it("login keeps the other profiles and makes the new one the default", async () => {
    const { ctx } = fakeCtx({ config, responses: { "GET /v1/status": statusAnswer } });
    expect(await main(["login", "--url", "https://bongsu.example.com", "--token", "bongsu_cli_new"], ctx)).toBe(0);
    const saved = await readConfig(ctx.configPath);
    expect(saved.default).toBe("bongsu.example.com");
    expect(Object.keys(saved.profiles).sort()).toEqual(["bongsu.example.com", "running", "travel"]);
  });

  it("login needs --url", async () => {
    const { ctx, err } = fakeCtx();
    expect(await main(["login", "--token", "bongsu_cli_abc"], ctx)).toBe(2);
    expect(err.join("")).toContain("--url");
  });
});

describe("logout", () => {
  it("logout removes a profile", async () => {
    const { ctx } = fakeCtx({ config });
    expect(await main(["logout", "--workspace", "running"], ctx)).toBe(0);
    expect(await readConfig(ctx.configPath)).toEqual({ default: "travel", profiles: { travel } });
  });

  it("logout of the default removes it and its default", async () => {
    const { ctx } = fakeCtx({ config });
    expect(await main(["logout"], ctx)).toBe(0);
    expect(await readConfig(ctx.configPath)).toEqual({ profiles: { running } });
  });

  it("logout of an unknown profile fails", async () => {
    const { ctx, err } = fakeCtx({ config });
    expect(await main(["logout", "--workspace", "other"], ctx)).toBe(1);
    expect(err.join("")).toContain("other");
  });
});

describe("status", () => {
  it("status prints a summary and --json the answer", async () => {
    const { ctx, out, calls } = fakeCtx({ config, responses: { "GET /v1/status": statusAnswer } });
    expect(await main(["status"], ctx)).toBe(0);
    expect(calls[0].url).toBe("https://travel.example.com/v1/status");
    const text = out.join("");
    expect(text).toContain("publishing");
    expect(text).toContain("2026-10-29");
    expect(text).toContain("Europe/Madrid");
    expect(text).toContain("demo_travel, demo_running");
    expect(text).toContain("done");

    const json = fakeCtx({ config, responses: { "GET /v1/status": statusAnswer } });
    expect(await main(["--json", "status"], json.ctx)).toBe(0);
    expect(JSON.parse(json.out.join(""))).toEqual(statusAnswer);
  });

  it("status says when publishing is paused", async () => {
    const { ctx, out } = fakeCtx({ config, responses: { "GET /v1/status": { ...statusAnswer, paused: true } } });
    expect(await main(["status"], ctx)).toBe(0);
    expect(out.join("")).toContain("paused");
  });

  it("sends the profile's token", async () => {
    const seen: string[] = [];
    const { ctx } = fakeCtx({ config, responses: { "GET /v1/status": statusAnswer } });
    const inner = ctx.fetch;
    ctx.fetch = ((input: string, init?: RequestInit) => {
      seen.push(new Headers(init?.headers).get("authorization") ?? "");
      return inner(input, init);
    }) as typeof fetch;
    await main(["--workspace", "running", "status"], ctx);
    expect(seen).toEqual(["Bearer bongsu_cli_running"]);
  });
});

describe("queue", () => {
  it("queue prints a table with due, account, key, state", async () => {
    const { ctx, out, calls } = fakeCtx({ config, responses: { "GET /v1/queue": queueAnswer } });
    expect(await main(["queue", "--days", "7", "--account", "demo_travel"], ctx)).toBe(0);
    const url = new URL(calls[0].url);
    expect(url.pathname).toBe("/v1/queue");
    expect(url.searchParams.get("days")).toBe("7");
    expect(url.searchParams.get("account")).toBe("demo_travel");
    const lines = out.join("").trimEnd().split("\n");
    expect(lines[0]).toMatch(/^due\s+account\s+key\s+state$/);
    expect(lines[1]).toMatch(/2026-10-30 09:00 Europe\/Madrid\s+demo_travel\s+reel:demo\/one\s+held/);
    expect(lines[2]).toMatch(/reel:demo\/two\s+approved$/);
    expect(lines[3]).toMatch(/reel:demo\/three\s+approved \(time changed\)$/);
    expect(lines[4]).toMatch(/demo_running\s+post:demo\/four\s+not approved$/);
  });

  it("queue --json prints the answer", async () => {
    const { ctx, out, calls } = fakeCtx({ config, responses: { "GET /v1/queue": queueAnswer } });
    expect(await main(["queue", "--json"], ctx)).toBe(0);
    expect(new URL(calls[0].url).search).toBe("");
    expect(JSON.parse(out.join(""))).toEqual(queueAnswer);
  });

  it("queue says when nothing is due", async () => {
    const { ctx, out } = fakeCtx({ config, responses: { "GET /v1/queue": { ...queueAnswer, items: [] } } });
    expect(await main(["queue"], ctx)).toBe(0);
    expect(out.join("")).toContain("nothing due until 2026-11-12");
  });
});

describe("environment and errors", () => {
  it("uses BONGSU_URL and BONGSU_TOKEN over the file", async () => {
    const { ctx, calls } = fakeCtx({
      config,
      env: { BONGSU_URL: "https://env.example.com/", BONGSU_TOKEN: "bongsu_cli_env" },
      responses: { "GET /v1/status": statusAnswer },
    });
    expect(await main(["status"], ctx)).toBe(0);
    expect(calls[0].url).toBe("https://env.example.com/v1/status");
  });

  it("explains a 429", async () => {
    const { ctx, err } = fakeCtx({
      config,
      responses: { "GET /v1/status": { status: 429, body: { error: "rate limit: 60 requests a minute" } } },
    });
    expect(await main(["status"], ctx)).toBe(1);
    expect(err.join("")).toContain("bongsu: rate limit: 60 requests a minute, wait and retry");
  });

  it("explains a 401", async () => {
    const { ctx, err } = fakeCtx({
      config,
      responses: { "GET /v1/status": { status: 401, body: { error: "missing or invalid API key" } } },
    });
    expect(await main(["status"], ctx)).toBe(1);
    expect(err.join("")).toContain("bongsu: the token isn't valid any more: run bongsu login");
  });

  it("refuses a 200 answer that isn't JSON", async () => {
    const { ctx, err } = fakeCtx({ config, responses: { "GET /v1/status": { status: 200, text: "<html></html>" } } });
    expect(await main(["status"], ctx)).toBe(1);
    expect(err.join("")).toBe("bongsu: https://travel.example.com didn't answer like a Bongsu instance\n");
  });

  it("passes the API's error through", async () => {
    const { ctx, err } = fakeCtx({
      config,
      responses: { "GET /v1/queue": { status: 400, body: { error: "bad account" } } },
    });
    expect(await main(["queue", "--account", "x"], ctx)).toBe(1);
    expect(err.join("")).toContain("bongsu: bad account");
  });

  it("asks for a login without a profile", async () => {
    const { ctx, err } = fakeCtx();
    expect(await main(["status"], ctx)).toBe(1);
    expect(err.join("")).toContain("bongsu: run bongsu login first");
  });
});

describe("global options", () => {
  it("prints the usage with --help and without a command", async () => {
    for (const argv of [["--help"], []]) {
      const { ctx, out } = fakeCtx();
      expect(await main(argv, ctx)).toBe(0);
      expect(out.join("")).toContain("usage: bongsu");
      expect(out.join("")).toContain("queue");
    }
  });

  it("prints the version", async () => {
    const { ctx, out } = fakeCtx();
    expect(await main(["--version"], ctx)).toBe(0);
    expect(out.join("")).toMatch(/^\d+\.\d+\.\d+\n$/);
  });

  it("refuses an unknown command with the usage", async () => {
    const { ctx, err } = fakeCtx();
    expect(await main(["frobnicate"], ctx)).toBe(2);
    expect(err.join("")).toContain("unknown command: frobnicate");
    expect(err.join("")).toContain("usage: bongsu");
  });
});

describe("texts", () => {
  const key = "reel:demo/one";
  const path = `/v1/items/${encodeURIComponent(key)}`;
  const textItem = { key, caption: "A caption", comment: null, comment2: "", alt: ["first", "second"] };

  it("get prints caption, comment, comment2 and alt, empty ones as (none)", async () => {
    const { ctx, out } = fakeCtx({ config, responses: { [`GET ${path}`]: textItem } });
    expect(await main(["texts", "get", key], ctx)).toBe(0);
    expect(out.join("")).toBe(
      "== caption\nA caption\n\n== comment\n(none)\n\n== comment2\n(none)\n\n== alt\nfirst\nsecond\n",
    );
  });

  it("get shows an empty alt list as (none)", async () => {
    const { ctx, out } = fakeCtx({ config, responses: { [`GET ${path}`]: { ...textItem, alt: [] } } });
    expect(await main(["texts", "get", key], ctx)).toBe(0);
    expect(out.join("")).toMatch(/== alt\n\(none\)\n$/);
  });

  it("get --json prints the item", async () => {
    const { ctx, out } = fakeCtx({ config, responses: { [`GET ${path}`]: textItem } });
    expect(await main(["texts", "get", key, "--json"], ctx)).toBe(0);
    expect(JSON.parse(out.join(""))).toEqual(textItem);
  });

  it("set reads a file from the working directory and stdin and posts only those fields", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bongsu-texts-"));
    writeFileSync(join(dir, "c.txt"), "From file");
    const { ctx, calls } = fakeCtx({
      config,
      stdin: "From stdin",
      responses: { "POST /v1/plan/update": textItem },
    });
    ctx.cwd = dir;
    expect(await main(["texts", "set", key, "--caption", "c.txt", "--comment", "-"], ctx)).toBe(0);
    expect(calls[0].body).toEqual({ key, caption: "From file", comment: "From stdin" });
  });

  it("set without a field fails", async () => {
    const { ctx, err, calls } = fakeCtx({ config });
    expect(await main(["texts", "set", key], ctx)).toBe(1);
    expect(err.join("")).toContain("give at least one of --caption, --comment, --comment2, --alt");
    expect(calls).toHaveLength(0);
  });

  it("set refuses stdin twice", async () => {
    const { ctx, err, calls } = fakeCtx({ config, stdin: "x" });
    expect(await main(["texts", "set", key, "--caption", "-", "--alt", "-"], ctx)).toBe(1);
    expect(err.join("")).toContain("stdin can be used once");
    expect(calls).toHaveLength(0);
  });

  describe("youtube", () => {
    const yt = {
      key: "video:demo/one",
      caption: null,
      comment: null,
      comment2: null,
      texts: { title: "Old", translations: { es: { title: "Viejo", description: "Desc" } }, tags: ["a"] },
      texts_source: { at: 1, by: "app" },
    };
    const ytPath = `/v1/items/${encodeURIComponent(yt.key)}`;

    it("texts set --title sends the title", async () => {
      const { ctx, calls } = fakeCtx({
        config,
        responses: { [`GET ${ytPath}`]: yt, "POST /v1/plan/update": yt },
      });
      expect(await main(["texts", "set", yt.key, "--title", "New"], ctx)).toBe(0);
      const post = calls.find((c) => c.url.endsWith("/v1/plan/update"));
      expect(post?.body).toEqual({ key: yt.key, texts: { ...yt.texts, title: "New" } });
    });

    it("--title after --translation belongs to the translation, merged into the current texts", async () => {
      const dir = mkdtempSync(join(tmpdir(), "bongsu-texts-"));
      writeFileSync(join(dir, "d.txt"), "Descripcion");
      const { ctx, calls } = fakeCtx({
        config,
        responses: { [`GET ${ytPath}`]: yt, "POST /v1/plan/update": yt },
      });
      ctx.cwd = dir;
      const args = ["texts", "set", yt.key, "--translation", "fr", "--title", "Titre", "--description", "d.txt"];
      expect(await main(args, ctx)).toBe(0);
      const post = calls.find((c) => c.url.endsWith("/v1/plan/update"));
      expect(post?.body).toEqual({
        key: yt.key,
        texts: {
          ...yt.texts,
          translations: { ...yt.texts.translations, fr: { title: "Titre", description: "Descripcion" } },
        },
      });
    });

    it("a translation needs both a title and a description", async () => {
      const { ctx, err, calls } = fakeCtx({ config, stdin: "d" });
      expect(await main(["texts", "set", yt.key, "--translation", "fr", "--title", "Titre"], ctx)).toBe(2);
      expect(err.join("")).toContain("needs both a --title and a --description");
      expect(await main(["texts", "set", yt.key, "--translation", "fr", "--description", "-"], ctx)).toBe(2);
      expect(calls).toHaveLength(0);
    });

    it("a malformed language tag is refused locally", async () => {
      const { ctx, calls } = fakeCtx({ config, stdin: "d" });
      const args = ["texts", "set", yt.key, "--translation", "French!", "--title", "T", "--description", "-"];
      expect(await main(args, ctx)).toBe(2);
      expect(calls).toHaveLength(0);
    });

    it("texts get prints the title and translations", async () => {
      const { ctx, out } = fakeCtx({ config, responses: { [`GET ${ytPath}`]: yt } });
      expect(await main(["texts", "get", yt.key], ctx)).toBe(0);
      const text = out.join("");
      expect(text).toContain("== title\nOld\n");
      expect(text).toContain("== translation es\nViejo\n\nDesc\n");
      expect(text).not.toContain("== caption");
    });
  });
});

describe("approve", () => {
  const key = "reel:demo/one";
  const route = `GET /v1/approve/${encodeURIComponent(key)}`;
  const snapshot = { key: "reel:demo/first_reel", captionSha256: "abc" };
  const summary = {
    key,
    account: "demo_travel",
    platform: "instagram",
    label: "Reel",
    due: "2026-10-30 09:00 Europe/Madrid",
    due_at: "2026-10-30T08:00:00Z",
    hold: false,
    caption: "A caption",
    comment: "First comment",
    comment2: null,
    alt: null,
    media: [{ name: "one.mp4", checksum: "abc123", mime: "video/mp4" }],
    lint: [
      { check: "length", status: "PASS", detail: "fine" },
      { check: "hashtags", status: "WARN", detail: "too many hashtags" },
    ],
    approved: false,
    snapshot,
  };
  const done = { approved: true, key, due: summary.due };

  it("shows the summary, asks, and posts the snapshot it showed on y", async () => {
    const { ctx, out, prompts, calls } = fakeCtx({
      config,
      answers: ["y"],
      responses: { [route]: summary, "POST /v1/approve": done },
    });
    expect(await main(["approve", key], ctx)).toBe(0);
    const text = out.join("");
    for (const s of ["demo_travel", summary.due, "A caption", "First comment", "one.mp4  abc123", "too many hashtags"])
      expect(text).toContain(s);
    expect(text).not.toContain("fine");
    expect(prompts[0].q).toBe("approve? [y/N] ");
    expect(calls[1].body).toEqual({ key, snapshot });
    expect(text).toContain(`approved ${key} for ${summary.due}`);
  });

  it("with --json the summary goes to stderr before the prompt and the answer to stdout", async () => {
    const { ctx, out, err, prompts } = fakeCtx({
      config,
      answers: ["y"],
      responses: { [route]: summary, "POST /v1/approve": done },
    });
    expect(await main(["approve", key, "--json"], ctx)).toBe(0);
    expect(err.join("")).toContain("A caption");
    expect(prompts).toHaveLength(1);
    expect(JSON.parse(out.join(""))).toEqual(done);
  });

  it("a wrong number of keys is a usage error", async () => {
    const { ctx, calls } = fakeCtx({ config });
    expect(await main(["approve"], ctx)).toBe(2);
    expect(await main(["approve", key, "reel:demo/two", "--yes"], ctx)).toBe(2);
    expect(calls).toHaveLength(0);
  });

  it("an n answer approves nothing", async () => {
    const { ctx, calls } = fakeCtx({ config, answers: ["n"], responses: { [route]: summary } });
    expect(await main(["approve", key], ctx)).toBe(1);
    expect(calls.map((c) => c.method)).toEqual(["GET"]);
  });

  it("--yes skips the prompt", async () => {
    const { ctx, prompts, out } = fakeCtx({ config, responses: { [route]: summary, "POST /v1/approve": done } });
    expect(await main(["approve", key, "--yes"], ctx)).toBe(0);
    expect(prompts).toHaveLength(0);
    expect(out.join("")).toContain(`approved ${key} for`);
  });

  it("without a terminal and without --yes it refuses before any request", async () => {
    const { ctx, err, calls } = fakeCtx({ config, isTTY: false, responses: { [route]: summary } });
    expect(await main(["approve", key], ctx)).toBe(1);
    expect(err.join("")).toContain("not a terminal: add --yes to approve without the prompt");
    expect(calls).toHaveLength(0);
  });

  it("a 409 with problems lists them", async () => {
    const { ctx, err, calls } = fakeCtx({
      config,
      responses: {
        [route]: { status: 409, body: { error: "can't be approved", problems: ["no media", "no caption"] } },
      },
    });
    expect(await main(["approve", key, "--yes"], ctx)).toBe(1);
    expect(err.join("")).toMatch(/can't be approved\n {2}- no media\n {2}- no caption/);
    expect(calls).toHaveLength(1);
  });

  it("a 409 changed shows the server's message", async () => {
    const { ctx, err } = fakeCtx({
      config,
      responses: {
        [route]: summary,
        "POST /v1/approve": {
          status: 409,
          body: { error: "it changed since you looked: run approve again", changed: true },
        },
      },
    });
    expect(await main(["approve", key, "--yes"], ctx)).toBe(1);
    expect(err.join("")).toContain("bongsu: it changed since you looked: run approve again");
  });

  it("a Shorts comment key uses the same routes", async () => {
    const ckey = "comment:vid123";
    const { ctx, calls } = fakeCtx({
      config,
      responses: {
        [`GET /v1/approve/${encodeURIComponent(ckey)}`]: { ...summary, key: ckey },
        "POST /v1/approve": { ...done, key: ckey },
      },
    });
    expect(await main(["approve", ckey, "--yes"], ctx)).toBe(0);
    expect(new URL(calls[0].url).pathname).toBe("/v1/approve/comment%3Avid123");
    expect(calls[1].body).toEqual({ key: ckey, snapshot });
  });
});

describe("export", () => {
  const row = {
    key: "reel:demo/one",
    account: "demo_travel",
    platform: "instagram",
    format: "reel",
    due: "2026-10-30 09:00 Europe/Madrid",
    due_at: "2026-10-30T08:00:00Z",
    hold: false,
    approved: true,
    approval_matches: true,
    approved_at: "2026-10-29T10:00:00Z",
    posted_media_id: null,
    posted_permalink: null,
    published_at: null,
    note: "a, b",
    caption: "Hello",
  };
  const answer = { timezone: "Europe/Madrid", items: [row] };

  it("--format csv writes the header and the rows", async () => {
    const { ctx, out, calls } = fakeCtx({ config, responses: { "GET /v1/export": answer } });
    expect(await main(["export", "--format", "csv"], ctx)).toBe(0);
    expect(out.join("")).toBe(
      "key,account,platform,format,due,due_at,hold,approved,approval_matches,approved_at,posted_media_id," +
        "posted_permalink,published_at,note\r\n" +
        'reel:demo/one,demo_travel,instagram,reel,2026-10-30 09:00 Europe/Madrid,2026-10-30T08:00:00Z,false,true,true,2026-10-29T10:00:00Z,,,,"a, b"\r\n',
    );
    expect(new URL(calls[0].url).search).toBe("");
  });

  it("--format json writes the array", async () => {
    const { ctx, out } = fakeCtx({ config, responses: { "GET /v1/export": answer } });
    expect(await main(["export", "--format", "json"], ctx)).toBe(0);
    expect(JSON.parse(out.join(""))).toEqual([row]);
  });

  it("--texts asks for the texts and appends their columns", async () => {
    const { ctx, out, calls } = fakeCtx({ config, responses: { "GET /v1/export": answer } });
    expect(await main(["export", "--format", "csv", "--texts"], ctx)).toBe(0);
    expect(new URL(calls[0].url).searchParams.get("texts")).toBe("1");
    expect(out.join("").split("\r\n")[0]).toMatch(/,note,caption,comment,comment2,alt$/);
  });

  it("--texts joins the alt lines in one quoted cell and JSON keeps the array", async () => {
    const withAlt = {
      timezone: "Europe/Madrid",
      items: [
        { ...row, alt: ["first", "second"] },
        { ...row, alt: [] },
      ],
    };
    const { ctx, out } = fakeCtx({ config, responses: { "GET /v1/export": withAlt } });
    expect(await main(["export", "--format", "csv", "--texts"], ctx)).toBe(0);
    const rows = out.join("").split("\r\n");
    expect(rows[1]).toMatch(/,Hello,,,"first\nsecond"$/);
    expect(rows[2]).toMatch(/,Hello,,,$/);
    out.length = 0;
    expect(await main(["export", "--texts"], ctx)).toBe(0);
    expect(JSON.parse(out.join(""))[0].alt).toEqual(["first", "second"]);
  });

  it("another format is a usage error", async () => {
    const { ctx, calls } = fakeCtx({ config });
    expect(await main(["export", "--format", "xml"], ctx)).toBe(2);
    expect(calls).toHaveLength(0);
  });
});

describe("schema", () => {
  it("prints the sqlite DDL", async () => {
    const { ctx, out } = fakeCtx();
    expect(await main(["schema", "--dialect", "sqlite"], ctx)).toBe(0);
    expect(out.join("")).toContain("CREATE TABLE plan_items");
    expect(out.join("")).toBe(sqliteSchema());
  });

  it("prints the postgres DDL", async () => {
    const { ctx, out } = fakeCtx();
    expect(await main(["schema", "--dialect", "postgres"], ctx)).toBe(0);
    expect(out.join("")).toBe(postgresSchema());
  });

  it("a missing or other dialect is a usage error", async () => {
    for (const args of [["schema"], ["schema", "--dialect", "mysql"]]) {
      const { ctx } = fakeCtx();
      expect(await main(args, ctx)).toBe(2);
    }
  });
});

describe("stats", () => {
  const series = {
    item: { key: "reel:demo/one", platform: "instagram", account: "demo_travel" },
    samples: [
      {
        at: 1761400800,
        views: 500,
        reach: 400,
        likes: 40,
        comments: 3,
        saves: 5,
        shares: 2,
        follows: 7,
        profile_visits: 9,
      },
      {
        at: 1761487200,
        views: 900,
        reach: 700,
        likes: 60,
        comments: 4,
        saves: 6,
        shares: 3,
        follows: 9,
        profile_visits: null,
      },
    ],
    results: { views: 500 },
  };
  it("stats <key> prints the series as a table; --daily and the dates go to the API", async () => {
    const { ctx, out, calls } = fakeCtx({ config, responses: { "GET /v1/items/reel%3Ademo%2Fone/metrics": series } });
    expect(await main(["stats", "reel:demo/one", "--daily", "--from", "2026-10-20", "--to", "2026-10-27"], ctx)).toBe(
      0,
    );
    const url = new URL(calls[0].url);
    expect(url.pathname).toBe("/v1/items/reel%3Ademo%2Fone/metrics");
    expect(Object.fromEntries(url.searchParams)).toEqual({ daily: "1", from: "2026-10-20", to: "2026-10-27" });
    const lines = out.join("").trimEnd().split("\n");
    expect(lines[0]).toMatch(/^at\s+views\s+reach\s+likes\s+comments\s+saves\s+shares\s+follows\s+profile_visits$/);
    expect(lines[1]).toMatch(/^2025-10-25 14:00Z\s+500\s+400\s+40\s+3\s+5\s+2\s+7\s+9$/);
  });

  it("stats --account prints followers and views per day; --json prints the answer", async () => {
    const answer = {
      account: { id: "demo_travel", platform: "instagram", title: "demo_travel" },
      followers: [{ at: 1761400800, value: 120 }],
      views: [{ at: 1761400800, value: 300 }],
    };
    const { ctx, out } = fakeCtx({ config, responses: { "GET /v1/accounts/demo_travel/metrics": answer } });
    expect(await main(["stats", "--account", "demo_travel"], ctx)).toBe(0);
    expect(out.join("")).toMatch(/followers\n.*at\s+value\n2025-10-25 14:00Z\s+120/s);
    expect(out.join("")).toMatch(/views per day\n.*2025-10-25 14:00Z\s+300/s);
    const j = fakeCtx({ config, responses: { "GET /v1/accounts/demo_travel/metrics": answer } });
    expect(await main(["stats", "--account", "demo_travel", "--json"], j.ctx)).toBe(0);
    expect(JSON.parse(j.out.join(""))).toEqual(answer);
  });

  it("stats needs a key or --account", async () => {
    const { ctx } = fakeCtx({ config });
    expect(await main(["stats"], ctx)).toBe(2);
  });
});

describe("ingest", () => {
  it("ingest sends a file's samples and says what was added", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bongsu-ingest-"));
    const body = { accounts: [{ account: "demo_travel", at: "2026-10-21T03:00:00Z", followers: 120 }] };
    writeFileSync(join(dir, "samples.json"), JSON.stringify(body));
    const { ctx, out, calls } = fakeCtx({
      config,
      responses: { "POST /v1/metrics": { posts: { added: 0, skipped: 0 }, accounts: { added: 1, skipped: 0 } } },
    });
    ctx.cwd = dir;
    expect(await main(["ingest", "samples.json"], ctx)).toBe(0);
    expect(calls[0].body).toEqual(body);
    expect(out.join("")).toContain("0 post samples added (0 already there), 1 account sample added (0 already there)");
  });

  it("ingest refuses a file that isn't JSON", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bongsu-ingest-"));
    writeFileSync(join(dir, "bad.json"), "not json");
    const { ctx, err } = fakeCtx({ config });
    ctx.cwd = dir;
    expect(await main(["ingest", "bad.json"], ctx)).toBe(1);
    expect(err.join("")).toContain("isn't JSON");
  });
});
