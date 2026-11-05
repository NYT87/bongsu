// A demo instance for the documentation screenshots: a fresh SQLite database (migrated by apps/node's own
// `server.mjs migrate`) filled with demo-only rows, the demo media under a local media folder, and one signed-in
// session per app. Everything lives in the scratch folder it is given; nothing real is read or written, and
// running it again starts over. Dates are relative to `now`, so the plan always looks current.
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const root = fileURLToPath(new URL("../..", import.meta.url));
const demo = fileURLToPath(new URL("./demo/", import.meta.url));
const Database = createRequire(join(root, "apps/node/package.json"))("better-sqlite3");

const ZONE = "Asia/Seoul";
const sha256 = (data) => createHash("sha256").update(data).digest("hex");
const token = () => randomBytes(32).toString("base64url");

// ---- time: Seoul wall time -> unix seconds. Seoul has no daylight saving (always UTC+9), which is the only
// reason a fixed offset is acceptable in this script; the app itself always goes through formats/time.ts.
const KST_S = 9 * 3600;
const seoulDate = (now) => new Date(now.getTime() + KST_S * 1000).toISOString().slice(0, 10);
const addDays = (ymd, n) => new Date(Date.parse(`${ymd}T00:00:00Z`) + n * 86400_000).toISOString().slice(0, 10);
const unixAt = (ymd, hhmm) => Date.parse(`${ymd}T${hhmm}:00Z`) / 1000 - KST_S;
const iso = (unix) => new Date(unix * 1000).toISOString().replace(".000Z", "Z");

/** A post's metrics samples as the sampler takes them (every 6 h for 3 days, then daily) up to `nowS`: lifetime
 *  counts that rise fast and then level off, equal to `at24` at the 24 h sample. */
export function demoSamples(publishedAt, nowS, at24) {
  const rise = (h) => 1 - Math.exp(-h / 18);
  const hours = [];
  for (let h = 6; h <= 72; h += 6) hours.push(h);
  for (let h = 96; h <= 90 * 24; h += 24) hours.push(h);
  return hours
    .map((h) => ({ h, at: publishedAt + h * 3600 + 240 }))
    .filter((x) => x.at <= nowS)
    .map(({ h, at }) => ({
      taken_at: at,
      ...Object.fromEntries(Object.entries(at24).map(([k, v]) => [k, Math.round((v * rise(h)) / rise(24))])),
    }));
}

// ---- the demo content, data first: the seed turns these into rows ----------------------------------------------

// `day` is days from today (Seoul), `at` the wall time; `media` the files under demo/ (a Reel is one video, a post a
// folder of images); `state` how the item stands: approved, re-approve (approved for another time), pending (waits
// for the owner), hold, posted (went out five days ago, with its metrics series and a Trial Reel copy).
const ITEMS = [
  {
    account: "demo_travel",
    folder: "travel",
    name: "lisbon-tram",
    format: "video",
    day: 0,
    at: "18:00",
    state: "approved",
    title: "Lisbon tram 28",
    caption:
      "Tram 28 at golden hour: the rattle of the old wooden carriages, the climb through the steep hills of the old town and the wide view over the river at the top.\n\nWhich city has your favourite tram line?\n\n#lisbon #travel",
    comment: "Stops worth a detour: Graca, Alfama, Estrela. Which one would you pick?",
    options: { location: "demo-place-lisbon" },
  },
  {
    account: "demo_running",
    folder: "running",
    name: "sunrise-intervals",
    format: "video",
    day: 1,
    at: "07:30",
    state: "pending",
    title: "Sunrise intervals",
    caption:
      "Six by 800 m before the city wakes up. The last one always hurts, and it is always worth it.\n\nWhat is your favourite early-morning workout?\n\n#running #intervals",
    comment: "The session: 6 x 800 m, 90 s jog between. Easy week next.",
    comment2: "Shoes in the first comment of the next post.",
    key: true,
  },
  {
    account: "demo_travel",
    folder: "travel",
    name: "porto-tiles",
    format: "carousel",
    day: 2,
    at: "12:00",
    state: "approved",
    title: "Porto in four tiles",
    stills: [1, 2, 3, 4],
    caption:
      "Porto, one azulejo at a time. Swipe for the four we could not walk past.\n\nWhich one is your favourite?\n\n#porto #azulejo",
    comment: "Start at Sao Bento station, then walk down to the river.",
    alt: "Blue and white tile panel of a street scene\nGreen tiled facade with a floral border\nOrange tiles around a doorway\nNavy tile mosaic with a white star",
  },
  {
    account: "demo_travel",
    folder: "travel",
    name: "alfama-sunset",
    format: "video",
    day: 2,
    at: "18:30",
    state: "re-approve",
    approvedAt: "18:00",
    title: "Alfama sunset",
    caption:
      "Alfama after the last tour group leaves. Narrow streets, loud fado, orange light.\n\nDo you walk or take the tram up?\n\n#alfama #lisbon",
    comment: "Miradouro das Portas do Sol is the easy first stop.",
  },
  {
    account: "demo_travel",
    folder: "travel",
    name: "tram-photo",
    format: "image",
    day: 3,
    at: "19:00",
    state: "approved",
    title: "Tram, close up",
    stills: [2],
    caption: "The yellow tram, close up.\n\nWhat colour would you paint it?\n\n#lisbon",
    comment: "Shot on a phone, no edit.",
    alt: "A yellow tram on a steep street",
  },
  {
    account: "demo_running",
    folder: "running",
    name: "finish-line",
    format: "story",
    day: 1,
    at: "20:00",
    state: "approved",
    title: "Finish line",
    stills: [4],
  },
  {
    account: "demo_running",
    folder: "running",
    name: "hill-repeats",
    format: "video",
    day: 4,
    at: "07:00",
    state: "hold",
    title: "Hill repeats",
    note: "Waiting for the weather",
    caption: "Hill repeats until the legs say stop.\n\nHow many reps is too many?\n\n#running #hills",
    comment: "Eight reps on a 6 percent grade.",
  },
  {
    account: "demo_running",
    folder: "running",
    name: "race-week-plan",
    format: "carousel",
    day: 5,
    at: "12:00",
    state: "pending",
    title: "Race week plan",
    stills: [1, 2, 3],
    caption: "Race week in three slides: taper, fuel, sleep.\n\nWhat is your pre-race ritual?\n\n#running #racing",
    comment: "Save this for your next start line.",
    alt: "Plan slide one: taper\nPlan slide two: fuel\nPlan slide three: sleep",
  },
  {
    account: "demo_running",
    folder: "running",
    name: "park-run-recap",
    format: "video",
    day: 6,
    at: "09:00",
    state: "approved",
    title: "Park run recap",
    caption:
      "Saturday park run: a new personal best by eleven seconds.\n\nWhat was your last personal best?\n\n#parkrun #running",
    comment: "Splits are in the next post.",
  },
  {
    account: "demo_running",
    folder: "travel",
    name: "ferry-morning",
    format: "video",
    day: -5,
    at: "18:00",
    state: "posted",
    title: "Ferry morning",
    caption:
      "The first ferry across the river, empty and quiet.\n\nWhere do you go to be alone in a city?\n\n#travel #ferry",
    comment: "Departs every 20 minutes before 8.",
    // the counts 24 h after publishing; the metrics series grows towards and past them
    result: {
      views: 18400,
      reach: 14200,
      likes: 1260,
      comments: 3,
      saves: 410,
      shares: 188,
      follows: 12,
      profile_visits: 85,
      median: 9100,
    },
    trial: { views: 7600, reach: 7100, likes: 310, comments: 1, saves: 95, shares: 40, follows: 9, profile_visits: 40 },
  },
];

const DRAFTS = [
  // from the Drive inbox: a still waiting for an account and a time
  {
    kind: "photo",
    account: "demo_travel",
    source: "drive",
    createdBy: "drive-inbox",
    inboxFile: { path: "INBOX/travel/market-morning.png", still: 3 },
    payload: {
      title: "travel/market-morning",
      folder: "travel",
      name: "market-morning",
      caption: "Market morning: oranges, fish and one very patient cat.\n\nWhat do you buy first at a market?",
    },
  },
  // from an agent (an API key)
  {
    kind: "reel",
    account: "demo_running",
    source: "api",
    createdBy: "key:k_demo",
    payload: {
      title: "Recovery run",
      caption:
        "Recovery runs are slow on purpose. Ten kilometres at a conversation pace.\n\nDo you run with music?\n\n#running",
      comment: "Pace: 6:10 per km, heart rate under 140.",
      date: "+3",
      time: "08:00",
      note: "Drafted from last week's training log",
    },
  },
];

const COMMENTS = [
  { id: "ig:demo_c1", author: "demo_viewer_one", text: "Is the ferry run every day?", ago: 5 * 3600 },
  { id: "ig:demo_c2", author: "demo_viewer_two", text: "Saving this for our trip!", ago: 3 * 3600 },
];

const SHORTS = {
  channel: "main",
  public: { id: "demoShort00", title: "Three days in Lisbon in 60 seconds", daysAgo: 7 },
  scheduled: { id: "demoShort01", title: "Sunrise run: my easy-week routine", daysAhead: 7, at: "18:00" },
  comment: "Which stop would you add to this route? Tell me below and I will pin the best one.",
};

// ---- the seed ---------------------------------------------------------------------------------------------------

/** The environment the demo's node processes get: an allowlist, never the caller's whole environment, so a
 *  DATABASE_URL, NOTIFY_URL, SMTP or Composio setting in the developer's shell can't reach the demo. */
export function baseEnv() {
  const keep = ["PATH", "HOME", "TMPDIR", "LANG"];
  return Object.fromEntries(Object.entries(process.env).filter(([k]) => keep.includes(k) || k.startsWith("NODE_")));
}

function run(cmd, args, opts) {
  const r = spawnSync(cmd, args, { encoding: "utf8", ...opts });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed:\n${r.stdout}${r.stderr}`);
  return r.stdout;
}

/** The node server's bundle: built on first use. */
export function ensureServerBuilt() {
  const built = join(root, "apps/node/dist/server.mjs");
  // a build older than the sources may lack what the demo needs (SCHEDULES=off, say)
  const src = join(root, "apps/node/src");
  const stale =
    existsSync(built) &&
    readdirSync(src).some((f) => f.endsWith(".ts") && statSync(join(src, f)).mtimeMs > statSync(built).mtimeMs);
  if (existsSync(built) && !stale) return;
  run("pnpm", ["--filter", "@bongsu/node", "build"], { cwd: root });
}

/** Copies a demo file into the media folder; returns what an approval and a draft need: the file's id (its inode, as
 *  the local store names it) and its sha256. */
function place(mediaDir, rel, demoFile) {
  const to = join(mediaDir, ...rel.split("/"));
  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(join(demo, demoFile), to);
  return { id: String(statSync(to).ino), checksum: sha256(readFileSync(to)), name: rel.split("/").pop() };
}

/** The media an item has in the store, in slide order, as contentPaths (packages/core/src/data.ts) lays it out. */
function placeItem(mediaDir, i) {
  if (i.format === "video")
    return [place(mediaDir, `UPLOADS/${i.folder}/exports/shorts/instagram/${i.name}.mp4`, "reel.mp4")];
  return (i.stills ?? [1]).map((n, k) =>
    place(mediaDir, `UPLOADS/${i.folder}/${i.name}/${String(k + 1).padStart(2, "0")}.png`, `still-${n}.png`),
  );
}

export async function seedDemo(scratchDir, now = new Date()) {
  ensureServerBuilt();
  const dbPath = join(scratchDir, "bongsu.sqlite");
  const mediaDir = join(scratchDir, "media");
  mkdirSync(scratchDir, { recursive: true });
  for (const f of readdirSync(scratchDir)) if (f.startsWith("bongsu.sqlite")) rmSync(join(scratchDir, f));
  rmSync(mediaDir, { recursive: true, force: true });
  mkdirSync(mediaDir, { recursive: true });

  run("node", [join(root, "apps/node/dist/server.mjs"), "migrate"], {
    cwd: join(root, "apps/node"),
    env: { ...baseEnv(), DATABASE_PATH: dbPath, MIGRATIONS_DIR: join(root, "migrations") },
  });

  const nowS = Math.floor(now.getTime() / 1000);
  const today = seoulDate(now);
  const out = {
    dbPath,
    mediaDir,
    pwaToken: token(),
    dashboardToken: token(),
    itemKey: "",
    approvedKey: "",
    postedKey: "",
    videoId: "",
    videoDate: "",
  };
  const db = new Database(dbPath);
  db.pragma("foreign_keys = ON");
  const tx = db.transaction(() => {
    const ins = (table, row) =>
      db
        .prepare(
          `INSERT INTO ${table} (${Object.keys(row).join(", ")}) VALUES (${Object.keys(row)
            .map((k) => `@${k}`)
            .join(", ")})`,
        )
        .run(row);

    // ---- the workspace and its people: a fresh database has none (the setup token makes the instance admin, who
    // creates workspaces), so the demo creates its own `default` workspace and its owner, an instance admin
    db.prepare("INSERT INTO workspaces (id, name, created_at) VALUES ('default', 'Demo Studio', ?)").run(nowS);
    db.prepare(
      "INSERT INTO workspace_settings (workspace_id, timezone, digest_hour, locale, media_folder, updated_at) VALUES ('default', ?, 8, 'en', 'UPLOADS', ?)",
    ).run(ZONE, nowS);
    db.prepare(
      "INSERT INTO users (id, email, name, created_at, instance_admin) VALUES ('owner', 'owner@example.com', 'Demo Owner', ?, 1)",
    ).run(nowS);
    db.prepare(
      "INSERT INTO memberships (workspace_id, user_id, role, created_at) VALUES ('default', 'owner', 'admin', ?)",
    ).run(nowS);
    // the media: the demo folder on the server's disk (MEDIA_DIR), the instance's only store
    db.prepare(
      "INSERT INTO media_store (id, kind, is_default, settings, status, updated_at) VALUES ('local', 'local', 1, '{}', 'ok', ?)",
    ).run(nowS);

    // ---- accounts and how they are reached (no credentials: DRY_RUN never publishes, and the YouTube list is cached below)
    const conn = (id, provider, kind, label, extra) =>
      ins("connections", {
        id,
        workspace_id: "default",
        provider,
        kind,
        label,
        status: "ok",
        created_at: nowS,
        updated_at: nowS,
        last_checked_at: nowS,
        ...extra,
      });
    const account = (a) =>
      ins("accounts", {
        workspace_id: "default",
        status: "active",
        capabilities: "{}",
        settings: "{}",
        created_at: nowS,
        updated_at: nowS,
        ...a,
      });
    conn("c_demo_travel", "composio", "composio", "demo_travel", { external_ref: "ca_demo_travel" });
    conn("c_demo_running", "composio", "composio", "demo_running", { external_ref: "ca_demo_running" });
    conn("c_main", "youtube", "oauth", "Demo Vlogs", { secret_name: "YT_MAIN_OAUTH" });
    account({
      id: "demo_travel",
      platform: "instagram",
      handle: "demo_travel",
      display_name: "Demo Travel",
      external_id: "17841400000000001",
      connection_id: "c_demo_travel",
      sort: 0,
    });
    account({
      id: "demo_running",
      platform: "instagram",
      handle: "demo_running",
      display_name: "Demo Running",
      external_id: "17841400000000002",
      connection_id: "c_demo_running",
      capabilities: JSON.stringify({ trialReels: true }),
      sort: 1,
    });
    account({
      id: "main",
      platform: "youtube",
      handle: "main",
      display_name: "Demo Vlogs",
      connection_id: "c_main",
      sort: 2,
    });

    // ---- the plan
    ITEMS.forEach((i, n) => {
      const key = `${i.format === "video" ? "reel" : "post"}:${i.folder}/${i.name}`;
      const media = placeItem(mediaDir, i);
      const dueAt = unixAt(addDays(today, i.day), i.at);
      const text = (v) => (v ? v : null);
      ins("plan_items", {
        item_key: key,
        account: i.account,
        folder: i.folder,
        name: i.name,
        format: i.format,
        options: JSON.stringify(i.options ?? {}),
        due_at: dueAt,
        hold: i.state === "hold" ? 1 : 0,
        note: i.note ?? null,
        sort: n + 1,
        created_at: nowS - 86400,
        updated_at: nowS - 3600,
        updated_by: "owner",
        content: "repo",
        caption: text(i.caption),
        comment: text(i.comment),
        comment2: text(i.comment2),
        alt: text(i.alt),
        title: i.title,
        texts_at: nowS - 86400,
        texts_by: "owner@app",
        workspace_id: "default",
      });
      if (i.key) out.itemKey = key;
      if (i.name === "lisbon-tram") out.approvedKey = key;

      // An approval hashes the texts as published (trimmed) and lists the media as the store names them; the item
      // shows as approved while all of it still matches (packages/api/src/pwa/approve.ts).
      if (["approved", "re-approve", "hold", "posted"].includes(i.state)) {
        const caption = (i.caption ?? "").trim();
        const question =
          caption
            .split(/\r\n|\n|\r/)
            .map((l) => l.trim())
            .find((l) => l.endsWith("?")) ?? null;
        const comment = (i.comment ?? "").trim() || question;
        const alt = (i.alt ?? "").trim();
        ins("approvals", {
          item_key: key,
          account: i.account,
          due_at: i.state === "re-approve" ? unixAt(addDays(today, i.day), i.approvedAt) : dueAt,
          caption_sha: sha256(caption),
          comment_sha: i.format === "story" || !comment ? null : sha256(comment),
          comment2_sha: i.comment2 ? sha256(i.comment2.trim()) : null,
          alt_sha: alt ? sha256(alt) : null,
          media: JSON.stringify(media.map((m) => ({ store: "local", id: m.id, checksum: m.checksum }))),
          approved_at: iso(nowS - 7200),
          approved_by: "owner@app",
          user_id: "owner",
        });
      }

      if (i.state === "posted") {
        const at = dueAt;
        ins("posted", {
          item_key: key,
          account: i.account,
          media_id: "ig_demo_media_1",
          permalink: "https://www.instagram.com/reel/demo/",
          source: "scheduler",
          at,
          published_at: at,
          workspace_id: "default",
        });
        ins("trial_posts", {
          item_key: key,
          account: i.account,
          media_id: "ig_demo_media_2",
          permalink: "https://www.instagram.com/reel/demo-trial/",
          published_at: at + 600,
          at: at + 600,
          workspace_id: "default",
        });
        // the series (the 24 h numbers are its sample nearest 24 h), then the 24 h markers with their medians; the
        // copy went out minutes after the Reel, so the sampler's runs take both at the same times
        const { median, ...counts } = i.result;
        const series = [
          [key, "ig_demo_media_1", counts],
          [`trial:${key}`, "ig_demo_media_2", i.trial],
        ];
        for (const [itemKey, mediaId, at24] of series) {
          for (const sample of demoSamples(at, nowS, at24))
            ins("post_metrics", {
              item_key: itemKey,
              account: i.account,
              platform: "instagram",
              media_id: mediaId,
              ...sample,
              workspace_id: "default",
            });
          ins("post_results", {
            item_key: itemKey,
            account: i.account,
            media_id: mediaId,
            median_views: itemKey === key ? median : counts.views,
            fetched_at: at + 24 * 3600 + 300,
            workspace_id: "default",
          });
        }
        out.postedKey = key;
        for (const c of COMMENTS)
          ins("comments", {
            id: c.id,
            platform: "ig",
            account: i.account,
            media_id: "ig_demo_media_1",
            item_key: key,
            author: c.author,
            text: c.text,
            at: nowS - c.ago,
            own: 0,
            seen: 0,
            workspace_id: "default",
          });
        ins("comments", {
          id: "ig:demo_own",
          platform: "ig",
          account: i.account,
          media_id: "ig_demo_media_1",
          item_key: key,
          author: i.account,
          text: i.comment,
          at,
          own: 1,
          seen: 1,
          workspace_id: "default",
        });
      }
    });

    // ---- drafts
    DRAFTS.forEach((d, n) => {
      const payload = { ...d.payload };
      if (payload.date?.startsWith("+")) payload.date = addDays(today, Number(payload.date.slice(1)));
      if (d.inboxFile) {
        const m = place(mediaDir, d.inboxFile.path, `still-${d.inboxFile.still}.png`);
        payload.media = [{ store: "local", id: m.id }];
        payload.files = [{ store: "local", id: m.id, name: m.name, mime: "image/png", checksum: m.checksum }];
      }
      ins("drafts", {
        id: `d_demo_${n + 1}`,
        kind: d.kind,
        account: d.account,
        payload: JSON.stringify(payload),
        source: d.source,
        created_by: d.createdBy,
        status: "draft",
        created_at: nowS - (n + 1) * 5400,
        updated_at: nowS - (n + 1) * 5400,
        workspace_id: "default",
      });
    });

    // ---- YouTube: the channel's uploads come from YouTube's API and are cached for an hour in settings. Seeding the
    // cache with a far-future updated_at means it is never refreshed, so the calendar and the video page work
    // without YouTube (or any credentials).
    const when = (days, hhmm) => iso(unixAt(addDays(today, days), hhmm));
    const uploads = [
      {
        id: SHORTS.public.id,
        title: SHORTS.public.title,
        privacy: "public",
        when: when(-SHORTS.public.daysAgo, "18:00"),
        short: true,
      },
      {
        id: SHORTS.scheduled.id,
        title: SHORTS.scheduled.title,
        privacy: "private",
        when: when(SHORTS.scheduled.daysAhead, SHORTS.scheduled.at),
        publishAt: when(SHORTS.scheduled.daysAhead, SHORTS.scheduled.at),
        short: true,
      },
    ];
    ins("settings", { key: `yt_uploads:${SHORTS.channel}`, value: JSON.stringify(uploads), updated_at: 4102444800 });
    out.videoId = SHORTS.scheduled.id;
    out.videoDate = addDays(today, SHORTS.scheduled.daysAhead);
    ins("shorts_comments", {
      video_id: SHORTS.scheduled.id,
      channel: SHORTS.channel,
      file: "",
      label: SHORTS.scheduled.title,
      sort: 1,
      created_at: nowS - 7200,
      text: SHORTS.comment,
      workspace_id: "default",
    });
    ins("comments", {
      id: "yt:demo_c1",
      platform: "yt",
      account: SHORTS.channel,
      media_id: SHORTS.public.id,
      item_key: `comment:${SHORTS.public.id}`,
      author: "Demo Viewer",
      text: "Which tram was that?",
      at: nowS - 4 * 3600,
      own: 0,
      seen: 0,
      workspace_id: "default",
    });

    // ---- keys: an agent key and a CLI token (only their hashes are stored)
    ins("api_keys", {
      id: "k_demo",
      name: "claude-code",
      key_hash: sha256(token()),
      scopes: JSON.stringify(["read", "draft", "plan"]),
      created_at: nowS - 5 * 86400,
      last_used_at: nowS - 2 * 3600,
      workspace_id: "default",
      created_by: "owner",
    });
    ins("api_keys", {
      id: "cli_demo",
      name: "bongsu login (laptop)",
      key_hash: sha256(token()),
      scopes: "[]",
      created_at: nowS - 86400,
      workspace_id: "default",
      created_by: "owner",
      user_id: "owner",
      expires_at: nowS + 29 * 86400,
    });
    for (const [n, a] of [
      ["key_create", "k_demo"],
      ["approve", "reel:travel/ferry-morning"],
      ["token_create", "cli_demo"],
    ].entries())
      ins("audit", {
        at: nowS - (n + 1) * 7200,
        actor: "owner",
        action: a[0],
        target: a[1],
        detail: "{}",
        user_id: "owner",
        workspace_id: "default",
      });

    // ---- the instance is set up: a passkey (a placeholder, nobody can sign in with it) and the bootstrap flag
    ins("passkeys", {
      id: "demo-credential-id",
      public_key: "ZGVtby1wdWJsaWMta2V5",
      counter: 0,
      name: "Demo phone",
      created_at: nowS - 30 * 86400,
      last_used_at: nowS - 3600,
      user_id: "owner",
    });
    ins("settings", {
      key: "bootstrap_done",
      value: JSON.stringify({ email: "owner@example.com" }),
      updated_at: nowS - 30 * 86400,
    });

    // ---- recovery codes, hashed like the dashboard makes them, so the overview has nothing to ask for
    for (let n = 0; n < 8; n++)
      ins("recovery_codes", {
        code_hash: sha256(`demo-recovery-code-${n}`),
        user_id: "owner",
        created_at: nowS - 20 * 86400,
      });

    // ---- one session per app; verified now, so approving needs no extra check
    for (const [app, tok, ttl] of [
      ["pwa", out.pwaToken, 30 * 86400],
      ["dashboard", out.dashboardToken, 12 * 3600],
    ])
      ins("sessions", {
        token_hash: sha256(tok),
        created_at: nowS,
        expires_at: nowS + ttl,
        user_id: "owner",
        app,
        verified_at: nowS,
        workspace_id: "default",
      });
  });
  try {
    tx();
  } finally {
    db.close();
  }
  return out;
}
