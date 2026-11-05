// A fake outside world for the tests: Google tokens, Drive, Composio's MCP endpoint and YouTube, all behind one
// fetch function.

import { env } from "cloudflare:workers";
import { upsertAccount, upsertConnection } from "@bongsu/core/accounts";
import { clearTokenCache } from "@bongsu/core/clients/google";
import { encryptSecret } from "@bongsu/core/crypto";
import { addApproval, defaultTime } from "@bongsu/core/data";
import type { Env } from "@bongsu/core/env";
import { sha256Hex } from "@bongsu/core/formats/approved";
import { zoneToUnix } from "@bongsu/core/formats/time";
import { clearFolderCache } from "@bongsu/core/media/drive";
import { FakeS3 } from "@bongsu/core/media/fake-s3";
import { setWorkspaceNtfy } from "@bongsu/core/ntfy";
import { setWorkspaceSettings, workspaceZone } from "@bongsu/core/workspaces";

export interface Call {
  slug: string;
  args: Record<string, unknown>;
  account: string;
}

export class World {
  /** The scopes Google says it granted for a code (default: YouTube's two). */
  googleGrantScope: string | null = null;
  /** A bucket at https://s3.test (path style) or https://media.s3.test: the "s3" media store (seedS3Store). */
  s3 = new FakeS3({ host: "s3.test", bucket: "media", accessKeyId: TEST_S3_KEYS.accessKeyId });
  /** Resumable upload sessions opened, and folders shared (uploads from the app). */
  uploads: { name: string; parents: string[]; origin: string | null; type: string | null }[] = [];
  shares: { file: string; role: string; emailAddress: string }[] = [];
  /** YouTube comments to list (video id → comments) and replies sent. */
  ytThreads = new Map<string, { id: string; author: string; channel: string; text: string; at: string }[]>();
  ytReplies: { parent: string; text: string }[] = [];
  /** Drive list queries made (findPath walks one per path level). */
  driveQueries = 0;
  /** Drive's search lags a create: while true, a folder made now isn't found by a search for its name (listing a
   *  folder's contents still sees it). */
  driveSearchLag = false;
  private driveUnsearchable = new Set<string>();
  /** Drive answers every write with 403 (a service account without edit rights). */
  driveRefuses = false;
  drive = new Map<
    string,
    {
      md5: string;
      mimeType: string;
      trashed?: boolean;
      bytes?: string;
      name?: string;
      parent?: string;
      modified?: string;
    }
  >();

  /** Put a file at a Drive path under UPLOADS/ (folders created as needed); returns its id. */
  drivePut(path: string, file: { md5: string; mimeType: string; bytes?: string; modified?: string }): string {
    const parts = path.split("/");
    let parent: string | undefined;
    for (const [i, name] of parts.entries()) {
      const last = i === parts.length - 1;
      let id = [...this.drive.entries()].find(([, f]) => f.name === name && f.parent === parent)?.[0];
      if (!id) {
        id =
          `id_${parts
            .slice(0, i + 1)
            .join("_")
            .replace(/[^A-Za-z0-9]/g, "")}`.slice(0, 60) + "0000000000";
        this.drive.set(
          id,
          last ? { ...file, name, parent } : { md5: "", mimeType: "application/vnd.google-apps.folder", name, parent },
        );
      }
      parent = id;
    }
    return parent!;
  }
  calls: Call[] = [];
  /** Composio handlers by slug; return data, or throw to fail the tool. */
  composio: Record<string, (args: Record<string, unknown>, account: string) => Record<string, unknown>> = {};
  /** Raw Instagram calls through Composio's workbench (Composio.instagramRaw): what the cell would print. */
  workbench: (spec: { user: string; method: string; url: string; body: Record<string, unknown> | null }) => {
    data?: unknown;
    error?: string;
  } = () => ({ data: { id: `trial-container-${this.raw.length}` } });
  raw: { user: string; method: string; url: string; body: Record<string, unknown> | null }[] = [];
  ytPrivacy = new Map<string, string>();
  /** Times each media id's Graph insights (and each video's statistics) were read: the counts grow per read. */
  insightReads = new Map<string, number>();
  /** `playlistItems.list` calls: one per refresh of a channel's uploads list. */
  ytListCalls = 0;
  /** `videos.list?part=statistics` calls, each with the ids asked. */
  ytStatCalls: string[][] = [];
  /** `videos.list?part=statistics` answers 403 (a revoked grant, no quota left). */
  ytStatFail = false;
  /** The channel's subscriber count (channels.list part=statistics); null: hidden. */
  ytSubscribers: number | null = 1000;
  /** The Analytics API answers (the token holds the scope); false → 403. Each query's video ids are recorded. */
  ytAnalyticsScope = true;
  ytAnalyticsCalls: string[][] = [];
  /** Each Analytics query's parameters; a video id's subscribers gained (default 3 × reads); ids with no row yet. */
  ytAnalyticsQueries: URLSearchParams[] = [];
  ytAnalyticsGained = new Map<string, number>();
  ytAnalyticsNoRow = new Set<string>();
  /** Media ids whose type has no follow metrics: Graph insights 400 when `follows` is asked for. */
  graphNoFollows = new Set<string>();
  /** Statistics to answer for a video id instead of the growing counts (raw strings, as YouTube sends them). */
  ytStatOverride = new Map<string, Record<string, string>>();
  /** A channel's uploads for the calendar: id → {title, privacy, publishedAt, publishAt, duration}. */
  ytUploads: {
    id: string;
    title: string;
    privacy: string;
    publishedAt: string;
    publishAt?: string;
    duration: string;
  }[] = [];
  /** Every `videos.update` call the fake accepted or refused, for assertions. */
  ytUpdates: { id: string; status: Record<string, unknown> }[] = [];
  ytComments: { video: string; text: string }[] = [];
  notifications: { title: string; body: string; actions?: string }[] = [];
  /** Emails sent through the fake Resend API. */
  mails: { from: string; to: string[]; subject: string; text: string }[] = [];
  /** Instagram's own API (graph.instagram.com, instagram-graph): each call, the tokens it accepts, the container
   *  states to report in order (then FINISHED), comments to list, and an optional refusal per call. */
  graph: { method: string; path: string; params: Record<string, unknown>; token: string }[] = [];
  graphTokens = new Set(["ig-token-1"]);
  graphStates: string[] = [];
  graphComments = new Map<string, { id: string; text: string; username: string; timestamp: string }[]>();
  graphRefuse: (method: string, path: string, params: Record<string, unknown>) => string | null = () => null;
  /** Google refuses OAuth refresh tokens (a revoked grant); service-account tokens still work. */
  googleRefuse = false;
  /** The connect flows: the code exchanges each provider saw, the PKCE challenge the Google authorization carried
   *  (a test copies it from the authorize URL) and the refresh tokens revoked. */
  igCodes: Record<string, string>[] = [];
  googleCodes: Record<string, string>[] = [];
  googleChallenge = "";
  googleRevoked: string[] = [];

  private read(key: string) {
    const n = (this.insightReads.get(key) ?? 0) + 1;
    this.insightReads.set(key, n);
    return n;
  }

  /** The `status` part YouTube answers for an upload: the fields a `videos.update` must send back unchanged. */
  private videoStatus(u: { privacy: string; publishAt?: string }) {
    return {
      privacyStatus: u.privacy,
      ...(u.publishAt ? { publishAt: u.publishAt } : {}),
      license: "youtube",
      embeddable: true,
      publicStatsViewable: true,
      madeForKids: false,
    };
  }

  fetch: typeof fetch = async (input, init) => {
    const req = new Request(input as RequestInfo, init);
    const url = new URL(req.url);
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
    if (url.hostname === "s3.test" || url.hostname.endsWith(".s3.test")) return this.s3.fetch(req);

    if (url.hostname === "oauth2.googleapis.com" && url.pathname === "/revoke") {
      this.googleRevoked.push(url.searchParams.get("token") ?? "");
      return json({});
    }
    if (url.hostname === "oauth2.googleapis.com") {
      const form = new URLSearchParams(await req.text());
      const grant = form.get("grant_type");
      if (this.googleRefuse && grant === "refresh_token")
        return json({ error: "invalid_grant", error_description: "Token has been expired or revoked." }, 400);
      if (grant === "authorization_code") {
        this.googleCodes.push(Object.fromEntries(form));
        // PKCE: the verifier must hash to the challenge the authorization was started with
        const v = form.get("code_verifier") ?? "";
        const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(v)));
        const challenge = btoa(String.fromCharCode(...digest))
          .replace(/\+/g, "-")
          .replace(/\//g, "_")
          .replace(/=+$/, "");
        if (form.get("code") !== "g-code" || challenge !== this.googleChallenge)
          return json({ error: "invalid_grant", error_description: "Malformed auth code." }, 400);
        return json({
          access_token: "g-access",
          refresh_token: "g-refresh",
          expires_in: 3599,
          scope:
            this.googleGrantScope ??
            "https://www.googleapis.com/auth/youtube.force-ssl https://www.googleapis.com/auth/yt-analytics.readonly",
        });
      }
      return json({ access_token: "tok", expires_in: 3600 });
    }
    if (url.hostname === "api.instagram.com" && url.pathname === "/oauth/access_token") {
      const form = new URLSearchParams(await req.text());
      this.igCodes.push(Object.fromEntries(form));
      if (form.get("code") !== "ig-code")
        return json({ error_type: "OAuthException", code: 400, error_message: "Invalid authorization code" }, 400);
      this.graphTokens.add("ig-short");
      // (Instagram sends user_id as a number too big for a JS number: the connect step reads the id from /me instead)
      return json({
        access_token: "ig-short",
        user_id: "17841400000000003",
        permissions: ["instagram_business_basic"],
      });
    }
    if (url.hostname === "www.googleapis.com" && url.pathname === "/upload/drive/v3/files" && req.method === "POST") {
      const b = (await req.json()) as { name: string; parents: string[] };
      this.uploads.push({ ...b, origin: req.headers.get("Origin"), type: req.headers.get("X-Upload-Content-Type") });
      return new Response(null, {
        status: 200,
        headers: { Location: `https://www.googleapis.com/upload/drive/v3/files?upload_id=${this.uploads.length}` },
      });
    }
    const perm = url.pathname.match(/^\/drive\/v3\/files\/([^/]+)\/permissions$/);
    if (url.hostname === "www.googleapis.com" && perm && req.method === "POST") {
      this.shares.push({ file: perm[1], ...((await req.json()) as { role: string; emailAddress: string }) });
      return json({ id: "perm-1" });
    }
    if (url.hostname === "www.googleapis.com" && url.pathname === "/drive/v3/files" && req.method === "POST") {
      const b = (await req.json()) as { name: string; mimeType: string; parents?: string[] };
      const id = `id_new_${b.name.replace(/[^A-Za-z0-9]/g, "")}`;
      this.drive.set(id, { md5: "", mimeType: b.mimeType, name: b.name, parent: b.parents?.[0] });
      if (this.driveSearchLag) this.driveUnsearchable.add(id);
      return json({ id });
    }
    if (
      url.hostname === "www.googleapis.com" &&
      url.pathname.startsWith("/drive/v3/files/") &&
      req.method === "PATCH"
    ) {
      const f = this.drive.get(decodeURIComponent(url.pathname.split("/").pop()!));
      if (!f) return new Response("404", { status: 404 });
      if (this.driveRefuses) return new Response("403", { status: 403 });
      const add = url.searchParams.get("addParents");
      if (add) f.parent = add;
      return json({ id: url.pathname.split("/").pop() });
    }
    if (url.hostname === "www.googleapis.com" && url.pathname === "/drive/v3/files") {
      this.driveQueries++;
      const q = url.searchParams.get("q") ?? "";
      const name = /name='([^']+)'/.exec(q)?.[1];
      const parent = /'([^']+)' in parents/.exec(q)?.[1];
      const files = [...this.drive.entries()]
        .filter(
          ([id, f]) =>
            !f.trashed &&
            (parent ? f.parent === parent : !f.parent) &&
            (!name || (f.name === name && !this.driveUnsearchable.has(id))),
        )
        .map(([id, f]) => ({
          id,
          name: f.name,
          mimeType: f.mimeType,
          md5Checksum: f.md5 || undefined,
          size: String((f.bytes ?? "bytes").length),
          modifiedTime: f.modified ?? "2026-10-01T00:00:00Z",
          parents: f.parent ? [f.parent] : [],
        }));
      return json({ files });
    }
    if (url.hostname === "www.googleapis.com" && url.pathname.startsWith("/drive/v3/files/")) {
      const id = decodeURIComponent(url.pathname.split("/").pop()!);
      const f = this.drive.get(id);
      if (!f) return new Response("404", { status: 404 });
      if (url.searchParams.get("alt") === "media") {
        const all = f.bytes ?? "bytes";
        const r = /^bytes=(\d+)-(\d*)$/.exec(req.headers.get("Range") ?? "");
        if (!r) return new Response(all, { headers: { "Content-Length": String(all.length) } });
        const start = Number(r[1]);
        const end = Math.min(r[2] ? Number(r[2]) : all.length - 1, all.length - 1);
        return new Response(all.slice(start, end + 1), {
          status: 206,
          headers: {
            "Content-Length": String(end - start + 1),
            "Content-Range": `bytes ${start}-${end}/${all.length}`,
          },
        });
      }
      return json({
        id,
        name: f.name,
        modifiedTime: f.modified ?? "2026-10-01T00:00:00Z",
        md5Checksum: f.md5,
        size: String((f.bytes ?? "bytes").length),
        mimeType: f.mimeType,
        trashed: !!f.trashed,
        parents: f.parent ? [f.parent] : [],
      });
    }
    if (url.hostname === "youtubeanalytics.googleapis.com" && url.pathname === "/v2/reports") {
      // subscribers gained per video since publishing: one row per filtered video, growing per read
      const ids = (url.searchParams.get("filters") ?? "")
        .replace(/^video==/, "")
        .split(",")
        .filter(Boolean);
      this.ytAnalyticsCalls.push(ids);
      this.ytAnalyticsQueries.push(url.searchParams);
      if (!this.ytAnalyticsScope) return json({ error: { code: 403, message: "Insufficient Permission" } }, 403);
      return json({
        columnHeaders: [{ name: "video" }, { name: "subscribersGained" }, { name: "subscribersLost" }],
        rows: ids
          .filter((id) => !this.ytAnalyticsNoRow.has(id))
          .map((id) => [id, this.ytAnalyticsGained.get(id) ?? 3 * this.read(`yta:${id}`), 0]),
      });
    }
    if (url.hostname === "www.googleapis.com" && url.pathname === "/youtube/v3/channels") {
      return json({
        items: [
          {
            id: "UCours",
            snippet: { title: "Our Channel", customUrl: "@ourchannel" },
            contentDetails: { relatedPlaylists: { uploads: "UUtest" } },
            statistics:
              this.ytSubscribers === null
                ? { hiddenSubscriberCount: true }
                : { subscriberCount: String(this.ytSubscribers), hiddenSubscriberCount: false },
          },
        ],
      });
    }
    if (url.hostname === "www.googleapis.com" && url.pathname === "/youtube/v3/playlistItems") {
      this.ytListCalls++;
      return json({ items: this.ytUploads.map((u) => ({ contentDetails: { videoId: u.id } })) });
    }
    if (
      url.hostname === "www.googleapis.com" &&
      url.pathname === "/youtube/v3/videos" &&
      (url.searchParams.get("part") ?? "").includes("snippet")
    ) {
      return json({
        items: this.ytUploads.map((u) => ({
          id: u.id,
          snippet: { title: u.title, publishedAt: u.publishedAt },
          status: { privacyStatus: u.privacy, ...(u.publishAt ? { publishAt: u.publishAt } : {}) },
          contentDetails: { duration: u.duration },
        })),
      });
    }
    if (
      url.hostname === "www.googleapis.com" &&
      url.pathname === "/youtube/v3/videos" &&
      url.searchParams.get("part") === "statistics"
    ) {
      const ids = (url.searchParams.get("id") ?? "").split(",");
      this.ytStatCalls.push(ids);
      if (this.ytStatFail) return json({ error: { message: "quotaExceeded" } }, 403);
      return json({
        items: ids
          .filter((id) => this.ytUploads.some((u) => u.id === id))
          .map((id) => {
            const n = this.read(`yt:${id}`);
            return {
              id,
              statistics: this.ytStatOverride.get(id) ?? {
                viewCount: String(n * 100),
                likeCount: String(n * 10),
                commentCount: String(n),
              },
            };
          }),
      });
    }
    if (url.hostname === "www.googleapis.com" && url.pathname === "/youtube/v3/videos") {
      if (req.method === "PUT") {
        const b = (await req.json()) as { id: string; status: Record<string, unknown> };
        this.ytUpdates.push({ id: b.id, status: b.status });
        const up = this.ytUploads.find((u) => u.id === b.id);
        const bad = (message: string) => json({ error: { message } }, 400);
        if (!up) return bad("videoNotFound");
        if (up.privacy === "public") return bad("video is already public");
        const at = Date.parse(String(b.status.publishAt));
        if (!(at > Date.now())) return bad("publishAt must be in the future");
        const stored = this.videoStatus(up);
        for (const [k, v] of Object.entries(stored)) {
          if (k !== "publishAt" && b.status[k] !== v) return bad(`status.${k} changed`);
        }
        up.publishAt = String(b.status.publishAt);
        return json({ id: up.id, status: this.videoStatus(up) });
      }
      const ids = (url.searchParams.get("id") ?? "").split(",");
      return json({
        items: ids.flatMap((id) => {
          const up = this.ytUploads.find((u) => u.id === id);
          if (up) return [{ id, status: this.videoStatus(up) }];
          return this.ytPrivacy.has(id) ? [{ id, status: { privacyStatus: this.ytPrivacy.get(id) } }] : [];
        }),
      });
    }
    if (
      url.hostname === "www.googleapis.com" &&
      url.pathname === "/youtube/v3/commentThreads" &&
      req.method === "GET"
    ) {
      const v = url.searchParams.get("videoId") ?? "";
      return json({
        items: (this.ytThreads.get(v) ?? []).map((c) => ({
          id: `t-${c.id}`,
          snippet: {
            topLevelComment: {
              id: c.id,
              snippet: {
                authorDisplayName: c.author,
                authorChannelId: { value: c.channel },
                textDisplay: c.text,
                publishedAt: c.at,
              },
            },
          },
        })),
      });
    }
    if (url.hostname === "www.googleapis.com" && url.pathname === "/youtube/v3/comments" && req.method === "POST") {
      const b = (await req.json()) as { snippet: { parentId: string; textOriginal: string } };
      this.ytReplies.push({ parent: b.snippet.parentId, text: b.snippet.textOriginal });
      return json({ id: `reply-${this.ytReplies.length}` });
    }
    if (url.hostname === "www.googleapis.com" && url.pathname === "/youtube/v3/commentThreads") {
      const b = (await req.json()) as {
        snippet: { videoId: string; topLevelComment: { snippet: { textOriginal: string } } };
      };
      this.ytComments.push({ video: b.snippet.videoId, text: b.snippet.topLevelComment.snippet.textOriginal });
      return json({ id: `thread-${this.ytComments.length}` });
    }
    if (url.hostname === "graph.instagram.com") {
      const token = url.searchParams.get("access_token") ?? "";
      const path = url.pathname.replace(/^\/v[\d.]+/, "");
      const params: Record<string, unknown> =
        req.method === "POST"
          ? ((await req.json()) as Record<string, unknown>)
          : Object.fromEntries([...url.searchParams].filter(([k]) => k !== "access_token"));
      this.graph.push({ method: req.method, path, params, token });
      const fail = (message: string, code = 100) => json({ error: { message, type: "OAuthException", code } }, 400);
      if (!this.graphTokens.has(token)) return fail("Invalid OAuth access token", 190);
      const refused = this.graphRefuse(req.method, path, params);
      if (refused) return fail(refused);
      if (path === "/access_token" && params.grant_type === "ig_exchange_token") {
        this.graphTokens.add("ig-long");
        return json({ access_token: "ig-long", token_type: "bearer", expires_in: 5183944 });
      }
      if (path === "/refresh_access_token") {
        const fresh = `ig-token-${this.graphTokens.size + 1}`;
        this.graphTokens.add(fresh);
        return json({ access_token: fresh, token_type: "bearer", expires_in: 5184000 });
      }
      if (path === "/me")
        return json({ user_id: "17841400000000003", username: "demo_cycling", followers_count: 1200 });
      const comments = /^\/([^/]+)\/comments$/.exec(path);
      const node = /^\/([^/]+)$/.exec(path);
      if (req.method === "POST" && /^\/\d+\/media$/.test(path))
        return json({ id: `gcontainer-${this.graph.filter((g) => g.path === path && g.method === "POST").length}` });
      if (req.method === "POST" && /^\/\d+\/media_publish$/.test(path)) return json({ id: "gmedia-1" });
      if (req.method === "POST" && /\/(comments|replies)$/.test(path))
        return json({ id: `gcomment-${this.graph.length}` });
      if (req.method === "GET" && comments) return json({ data: this.graphComments.get(comments[1]) ?? [] });
      if (req.method === "GET" && /\/insights$/.test(path)) {
        const asked = String(params.metric ?? "").split(",");
        const follows = asked.includes("follows");
        if (follows && this.graphNoFollows.has(path.split("/")[1]))
          return fail(
            "(#100) metric[6] must be one of the following values: views, reach, likes, comments, saved, shares",
            100,
          );
        const n = this.read(`ig:${path.split("/")[1]}`);
        const names = [
          "views",
          "reach",
          "likes",
          "comments",
          "saved",
          "shares",
          ...(follows ? ["follows", "profile_visits"] : []),
        ];
        return json({ data: names.map((name, i) => ({ name, values: [{ value: (i + 1) * 10 * n }] })) });
      }
      if (req.method === "GET" && node) {
        if (String(params.fields).includes("status_code"))
          return json({ status_code: this.graphStates.shift() ?? "FINISHED" });
        return json({
          id: node[1],
          permalink: `https://www.instagram.com/reel/${node[1]}/`,
          timestamp: "2026-10-20T09:00:09+0000",
        });
      }
      return fail(`fake graph: no route ${req.method} ${path}`);
    }
    if (url.hostname === "connect.composio.dev") {
      const b = (await req.json()) as {
        params: {
          name: string;
          arguments: {
            tools: { tool_slug: string; arguments: Record<string, unknown>; account: string }[];
            code_to_execute?: string;
          };
        };
      };
      if (b.params.name === "COMPOSIO_REMOTE_WORKBENCH") {
        const lit = /^B = json\.loads\((".*")\)$/m.exec(b.params.arguments.code_to_execute ?? "")![1];
        const spec = JSON.parse(JSON.parse(lit));
        this.raw.push(spec);
        const out = this.workbench(spec);
        const text = JSON.stringify({
          successful: true,
          data: { results: "", stdout: `[INFO] noise\n__BONGSU__${JSON.stringify(out)}\n`, stderr: "", error: "" },
        });
        return new Response(
          `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text }] } })}\n\n`,
        );
      }
      const t = b.params.arguments.tools[0];
      this.calls.push({ slug: t.tool_slug, args: t.arguments, account: t.account });
      let response: Record<string, unknown>;
      try {
        const h = this.composio[t.tool_slug];
        if (!h) throw new Error(`no fake for ${t.tool_slug}`);
        response = { successful: true, data: h(t.arguments, t.account) };
      } catch (e) {
        response = { successful: false, error: String((e as Error).message) };
      }
      const text = JSON.stringify({
        data: { results: [{ tool_slug: t.tool_slug, response, error: response.successful ? null : response.error }] },
      });
      return new Response(
        `: connected\n\nevent: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text }] } })}\n\n`,
      );
    }
    if (url.hostname === "api.resend.com" && url.pathname === "/emails") {
      if (req.headers.get("Authorization") !== "Bearer re_test") return new Response("bad key", { status: 401 });
      this.mails.push(await req.json());
      return Response.json({ id: `mail-${this.mails.length}` });
    }
    if (url.hostname === "ntfy.test") {
      this.notifications.push({
        title: req.headers.get("Title") ?? "",
        body: await req.text(),
        actions: req.headers.get("Actions") ?? "",
      });
      return new Response("ok");
    }
    throw new Error(`unexpected fetch ${req.method} ${req.url}`);
  };
}

/** The Drive the tests use: the media store "drive", connected with an OAuth grant and the default. */
export const TEST_DRIVE_GRANT = JSON.stringify({
  client_id: "c",
  client_secret: "s",
  refresh_token: "r-drive",
  token_uri: "https://oauth2.googleapis.com/token",
});
export const TEST_S3_KEYS = { accessKeyId: "AKIDTEST", secretAccessKey: "test-secret-key" };
export const TEST_S3_SETTINGS = {
  endpoint: "https://s3.test",
  region: "auto",
  bucket: "media",
  prefix: "",
  pathStyle: true,
};
/** The bucket as a second store (not the default unless asked). */
export async function seedS3Store(o: { isDefault?: boolean } = {}, db: Env["DB"] = env.DB) {
  await db
    .prepare(
      "INSERT INTO media_store (id, kind, is_default, settings, credentials, status, updated_at) VALUES ('s3', 's3', ?1, ?2, ?3, 'ok', 0)",
    )
    .bind(
      o.isDefault ? 1 : 0,
      JSON.stringify(TEST_S3_SETTINGS),
      await encryptSecret(TEST_ENCRYPTION_KEY, JSON.stringify(TEST_S3_KEYS)),
    )
    .run();
  if (o.isDefault) await db.prepare("UPDATE media_store SET is_default = 0 WHERE kind != 's3'").run();
}

export async function seedMediaStore(db: Env["DB"] = env.DB, key = TEST_ENCRYPTION_KEY) {
  const grant = TEST_DRIVE_GRANT;
  await db.prepare("DELETE FROM media_store").run();
  await db
    .prepare(
      "INSERT INTO media_store (id, kind, is_default, settings, credentials, status, updated_at) VALUES ('drive', 'drive', 1, '{}', ?1, 'ok', 0)",
    )
    .bind(await encryptSecret(key, grant))
    .run();
}

/** A channel's stored OAuth credentials, granted both scopes (a channel connected before the Analytics scope was
 *  asked for has no `scope` key: a test overrides the variable). */
const ytOauth = (refresh: string) =>
  JSON.stringify({
    client_id: "c",
    client_secret: "s",
    refresh_token: refresh,
    token_uri: "https://oauth2.googleapis.com/token",
    scope: "https://www.googleapis.com/auth/youtube.force-ssl https://www.googleapis.com/auth/yt-analytics.readonly",
  });

/** The demo accounts every test starts with: three Instagram accounts through Composio, two YouTube channels whose
 *  OAuth comes from environment variables (YT_MAIN_OAUTH, YT_VLOGS_OAUTH). Settings start empty. */
export async function seedAccounts(db: Env["DB"] = env.DB) {
  const at = 0;
  const ig = [
    ["demo_travel", "17841400000000001", "instagram_conn-a", {}],
    ["demo_running", "17841400000000002", "instagram_conn-b", { trialReels: true }],
    ["demo_cycling", "17841400000000003", "instagram_conn-c", {}],
  ] as const;
  for (const [i, [id, igId, ref, caps]] of ig.entries()) {
    await upsertConnection(
      db,
      { workspaceId: "default", id: `c_${id}`, provider: "composio", kind: "composio", externalRef: ref },
      at,
    );
    await upsertAccount(
      db,
      {
        workspaceId: "default",
        id,
        platform: "instagram",
        handle: id,
        externalId: igId,
        connectionId: `c_${id}`,
        capabilities: caps,
        sort: i,
      },
      at,
    );
  }
  for (const [i, [id, name, secret]] of [
    ["main", "Main", "YT_MAIN_OAUTH"],
    ["vlogs", "Vlogs", "YT_VLOGS_OAUTH"],
  ].entries()) {
    await upsertConnection(
      db,
      { workspaceId: "default", id: `c_${id}`, provider: "youtube", kind: "oauth", secretName: secret },
      at,
    );
    await upsertAccount(
      db,
      {
        workspaceId: "default",
        id,
        platform: "youtube",
        handle: id,
        displayName: name,
        connectionId: `c_${id}`,
        sort: i,
      },
      at,
    );
  }
  await db.prepare("UPDATE accounts SET settings = '{}', status = 'active'").run();
  // The tests' plan dates and times are Korean wall time (as the deployment they come from).
  await setWorkspaceSettings(db, "default", { timezone: "Asia/Seoul", digestHour: 8 }, at);
}

export const TEST_ENCRYPTION_KEY = "test-encryption-key-0123456789";

/** The tests' environment. `NOTIFY_URL` (test-only: the Worker reads topics from the database) sets the default
 *  workspace's ntfy topic, https://ntfy.test/topic unless given (undefined: none), where `w.notifications` collects. */
export async function testEnv(base: Env, overrides: Partial<Env> & Record<string, unknown> = {}): Promise<Env> {
  clearTokenCache();
  clearFolderCache();
  await seedAccounts(base.DB);
  await seedMediaStore(base.DB, (overrides.ENCRYPTION_KEY as string | undefined) ?? TEST_ENCRYPTION_KEY);
  const { NOTIFY_URL, ...rest } = overrides;
  const e = await baseEnv(base, rest);
  const topic = "NOTIFY_URL" in overrides ? (NOTIFY_URL as string | undefined) : "https://ntfy.test/topic";
  await setWorkspaceNtfy(e, "default", topic && e.ENCRYPTION_KEY ? topic : null, 0);
  return e;
}

async function baseEnv(base: Env, overrides: Partial<Env> & Record<string, unknown>): Promise<Env> {
  return {
    ...base,
    DRY_RUN: "0",
    PUBLIC_URL: "https://scheduler.test",
    COMPOSIO_CONSUMER_KEY: "ck_test",
    MEDIA_SIGNING_KEY: "signing-key",
    YT_MAIN_OAUTH: ytOauth("r-main"),
    YT_VLOGS_OAUTH: ytOauth("r-vlogs"),
    IG_TOKEN_DEMO: "ig-token-1",
    ENCRYPTION_KEY: TEST_ENCRYPTION_KEY,
    ...overrides,
  } as Env;
}

export const Q = "channels/vlogs/INSTAGRAM";
export const MD5 = "0123456789abcdef0123456789abcdef";
export const PLAN_TABLES = ["plan_items", "approvals", "posted", "shorts_comments", "shorts_commented", "settings"];

/** The dashboard's bootstrap makes an instance admin in no workspace (the first run, first-run.test.ts): the tests'
 *  bootstrapped user also works in `default`, as its admin. Their id. */
export async function joinDefault(email = "owner@example.com"): Promise<string> {
  const id = await env.DB.prepare("SELECT id FROM users WHERE email = ?1").bind(email).first<string>("id");
  if (!id) throw new Error(`no user ${email}`);
  await env.DB.prepare(
    "INSERT INTO memberships (workspace_id, user_id, role, created_at) VALUES ('default', ?1, 'admin', 0) ON CONFLICT (workspace_id, user_id) DO UPDATE SET role = 'admin'",
  )
    .bind(id)
    .run();
  return id;
}

/** What a test's bootstrap leaves behind for the next: the users it made (not the seeded owner) and their sign-ins. */
export const UNBOOTSTRAP = [
  "DELETE FROM passkeys",
  "DELETE FROM sessions",
  "DELETE FROM challenges",
  "DELETE FROM setup_codes",
  "DELETE FROM recovery_codes",
  "DELETE FROM api_keys",
  "DELETE FROM audit",
  "DELETE FROM settings WHERE key = 'bootstrap_done'",
  "DELETE FROM memberships WHERE user_id != 'owner'",
  "DELETE FROM users WHERE id != 'owner'",
  "UPDATE users SET email = NULL, name = 'Owner' WHERE id = 'owner'",
];

export async function clearPlan() {
  await env.DB.batch([
    ...PLAN_TABLES.map((t) => env.DB.prepare(`DELETE FROM ${t}`)),
    env.DB.prepare("UPDATE workspace_settings SET paused = NULL"), // every workspace runs again
  ]);
}

/** Unix seconds of a local "YYYY-MM-DD" + "HH:MM" in a workspace's zone: the tests describe times as people do. */
export async function localToUnix(date: string, time: string, workspaceId = "default") {
  return zoneToUnix(date, time, await workspaceZone(env.DB, workspaceId));
}

export async function planItem(o: {
  kind?: "reel" | "post";
  account?: string;
  folder: string;
  name: string;
  date?: string | null;
  time?: string | null;
  location?: string | null;
  hold?: boolean;
  workspaceId?: string;
}) {
  const kind = o.kind ?? "reel"; // the tests' shorthand: a reel is a video, a post's media decide its format
  const format = kind === "reel" ? "video" : null;
  const key = `${kind}:${o.folder.split("/").pop()}/${o.name.split("/").pop()}`;
  const date = o.date === undefined ? "2026-10-20" : o.date;
  const due = date === null ? null : await localToUnix(date, o.time ?? defaultTime(format));
  await env.DB.prepare(
    "INSERT INTO plan_items (item_key, format, account, folder, name, due_at, options, hold, sort, created_at, updated_at, workspace_id) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, (SELECT COALESCE(MAX(sort),0)+1 FROM plan_items), 0, 0, ?9)",
  )
    .bind(
      key,
      format,
      o.account ?? "demo_travel",
      o.folder,
      o.name,
      due,
      JSON.stringify(o.location ? { location: o.location } : {}),
      o.hold ? 1 : 0,
      o.workspaceId ?? "default",
    )
    .run();
  return key;
}

export async function approve(
  key: string,
  o: {
    due: string;
    caption: string;
    comment: string | null;
    comment2?: string | null;
    alt?: string | null;
    /** Drive ids and md5s (the store "drive"). */
    media: { driveId: string; md5: string }[];
    approvedAt?: string;
    /** The account approved for (default: the item's). */
    account?: string;
  },
) {
  const [d, t] = o.due.split(" ");
  const item = await env.DB.prepare("SELECT account FROM plan_items WHERE item_key = ?1")
    .bind(key)
    .first<{ account: string }>();
  await addApproval(env.DB, {
    key,
    account: o.account ?? item?.account ?? "demo_travel",
    dueAt: o.due ? await localToUnix(d, t) : null,
    captionSha256: await sha256Hex(o.caption),
    commentSha256: o.comment ? await sha256Hex(o.comment) : null,
    comment2Sha256: o.comment2 ? await sha256Hex(o.comment2) : null,
    altSha256: o.alt ? await sha256Hex(o.alt) : null,
    media: o.media.map((m) => ({ store: "drive", id: m.driveId, checksum: m.md5 })),
    approvedAt: o.approvedAt ?? "2026-10-17T01:00:00Z",
    approvedBy: "owner@test",
  });
}

/** The owner's approval of a Shorts comment: exactly this text, for this channel. */
export async function approveShort(video: string, text: string, channel = "main") {
  await addApproval(env.DB, {
    key: `comment:${video}`,
    account: channel,
    dueAt: 0,
    captionSha256: await sha256Hex(text.trim()),
    commentSha256: null,
    altSha256: null,
    media: [],
    approvedAt: "2026-10-17T01:00:00Z",
    approvedBy: "owner@test",
  });
}

/** A repo text file's content, as an importer copies it into the item's D1 column (the scheduler reads
 *  nothing from the repo): a Reel's shorts/instagram/<base>[.comment|.comment2].txt or a post's caption/comment/
 *  comment2/alt.txt, or a Shorts comment's file (shorts_comments.text). */
export async function copyText(path: string, text: string) {
  const reel = /^channels\/(.+\/CONTENT\/[^/]+)\/shorts\/instagram\/([^/]+?)(\.comment2|\.comment)?\.txt$/.exec(path);
  const post = /^channels\/([^/]+\/CONTENT\/[^/]+)\/(.+)\/(caption|comment2|comment|alt)\.txt$/.exec(path);
  if (reel) {
    const field = reel[3] === ".comment2" ? "comment2" : reel[3] === ".comment" ? "comment" : "caption";
    await env.DB.prepare(`UPDATE plan_items SET ${field} = ?1, texts_by = 'repo' WHERE item_key = ?2`)
      .bind(text, `reel:${reel[1].split("/").pop()}/${reel[2]}`)
      .run();
  } else if (post) {
    await env.DB.prepare(`UPDATE plan_items SET ${post[3]} = ?1, texts_by = 'repo' WHERE item_key = ?2`)
      .bind(text, `post:${post[1].split("/").pop()}/${post[2].split("/").pop()}`)
      .run();
  } else {
    await env.DB.prepare("UPDATE shorts_comments SET text = ?1 WHERE file = ?2").bind(text.trim(), path).run();
  }
}

export const postedRows = async () =>
  (
    await env.DB.prepare(
      "SELECT item_key, account, published_at, media_id, permalink, source FROM posted ORDER BY at, item_key",
    ).all()
  ).results;

/** A planned Reel with its caption/comment files (repo), Drive file and (optionally) an approval matching all of it. */
export async function seedReel(
  w: World,
  o: {
    base?: string;
    date?: string;
    time?: string;
    location?: string;
    approve?: boolean;
    caption?: string;
    comment?: string;
    comment2?: string;
    account?: string;
  } = {},
) {
  const base = o.base ?? "short1_x",
    folder = "vlogs/CONTENT/20260823_LISBON";
  const caption = o.caption ?? "A caption\n\nWhere next?\n\n#travel";
  const comment = o.comment ?? "📍 Somewhere. Have you been?";
  const key = await planItem({
    folder,
    name: base,
    account: o.account,
    date: o.date ?? "2026-10-20",
    time: o.time ?? null,
    location: o.location ?? "111",
  });
  await copyText(`channels/${folder}/shorts/instagram/${base}.txt`, caption + "\n");
  await copyText(`channels/${folder}/shorts/instagram/${base}.comment.txt`, comment + "\n");
  if (o.comment2) await copyText(`channels/${folder}/shorts/instagram/${base}.comment2.txt`, o.comment2 + "\n");
  const driveId = `drive_${base}_000000`;
  w.drive.set(driveId, { md5: MD5, mimeType: "video/mp4" });
  if (o.approve !== false) {
    await approve(key, {
      due: `${o.date ?? "2026-10-20"} ${o.time ?? "18:00"}`,
      caption,
      comment,
      comment2: o.comment2 ?? null,
      media: [{ driveId, md5: MD5 }],
    });
  }
  return { base, driveId, folder, key };
}

/** Composio fakes for a Reel's happy path; container status from `states` in order (then FINISHED). */
/** demo_cycling posts through instagram-graph instead of Composio: its token in the secret IG_TOKEN_DEMO (testEnv sets
 *  "ig-token-1"). Call after testEnv, which seeds the Composio connections again. */
export async function connectGraph(accountId = "demo_cycling", igUserId = "17841400000000003") {
  await upsertConnection(
    env.DB,
    {
      workspaceId: "default",
      id: `g_${accountId}`,
      provider: "instagram",
      kind: "oauth",
      label: `@${accountId}`,
      secretName: "IG_TOKEN_DEMO",
    },
    0,
  );
  await env.DB.prepare(
    "UPDATE connections SET credentials = NULL, status = 'ok', expires_at = NULL, last_error = NULL, last_checked_at = NULL WHERE id = ?1",
  )
    .bind(`g_${accountId}`)
    .run();
  await env.DB.prepare("UPDATE accounts SET connection_id = ?1, external_id = ?2 WHERE id = ?3")
    .bind(`g_${accountId}`, igUserId, accountId)
    .run();
}

export function igHappyPath(w: World, states: string[] = ["FINISHED"]) {
  let n = 0;
  w.composio.INSTAGRAM_POST_IG_USER_MEDIA = () => ({ id: `container-${++n}` });
  w.composio.INSTAGRAM_GET_IG_MEDIA = (a) => {
    if (String(a.fields).includes("status_code")) return { status_code: states.shift() ?? "FINISHED" };
    return {
      id: a.ig_media_id,
      permalink: `https://www.instagram.com/reel/${a.ig_media_id}/`,
      timestamp: "2026-10-20T09:00:07+0000",
    };
  };
  w.composio.INSTAGRAM_POST_IG_USER_MEDIA_PUBLISH = () => ({ id: "media-1" });
  w.composio.INSTAGRAM_POST_IG_MEDIA_COMMENTS = () => ({ id: "comment-1" });
}
