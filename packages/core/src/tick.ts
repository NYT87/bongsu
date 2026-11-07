// The scheduler's tick, run by the cron every 5 minutes.
//
//   lock → held workspaces (paused, archived) → discover due items → advance active jobs one step each → Shorts comments
//   → prune audit
//
// A platform with an upload lead (YouTube: Platform.uploadLeadS) has its items discovered and its jobs started that
// long before they are due: the video is uploaded private and processed, waits unseen (those runs count no attempt),
// and goes public at its due time after the usual checks. Each run advances the other jobs first and the upload steps
// last, so a long upload never delays an Instagram post.
//
// A held workspace's (paused or archived) accounts aren't discovered, its jobs aren't advanced and its Shorts comments
// wait; the other workspaces go on as usual.
//
// Everything it reads is in D1 (src/data.ts): the plan, approvals, posted log, Shorts comments and the texts
// (captions, comments, alt texts; a repo item's are copied there by an importer); the media is in the media store. Nothing
// is read from the repo, so nothing has to be pushed for a post to go out. Only approved items are
// published, exactly as approved, for the account they were approved for: every fingerprint is checked again just
// before the container is created, the comments' again before they're posted, and the plan's word on the job (still
// there, same time, same account, released, the account enabled) before each step that reaches the platform. In
// dry-run (DRY_RUN != "0") nothing is written outside the jobs/audit tables: each item ends as a done job with
// dry_run = 1 and a "would publish" note, and a job that was under way keeps its container unpublished.

import { type Account, findAccount, listAccounts } from "./accounts";
import { QuotaExceeded, SessionGone } from "./clients/youtube";
import { AUDIT_KEEP_S, CATCH_UP_S, JOBS_PER_TICK, JOBS_PER_TICK_MAX, LINK_TTL_S, MAX_POLLS } from "./constants";
import {
  contentPaths,
  dueItems,
  getItem,
  type Held,
  heldWorkspaces,
  isPosted,
  itemDue,
  itemOptions,
  latestApprovals,
  pendingShorts,
  readText,
  recordCommented,
  recordPosted,
  type ShortRow,
  shortKey,
  trialFor,
} from "./data";
import type { Env } from "./env";
import { type Approval, type MediaRef, settingsApproved, sha256Hex, youtubeSha } from "./formats/approved";
import { altLines, captionText, comment2Text, commentText } from "./formats/texts";
import { nextPacificMidnight, zoneDate } from "./formats/time";
import { parseTexts, type YouTubeTexts } from "./formats/youtube-texts";
import { acquire, release } from "./lock";
import { mediaUrl } from "./media";
import { type MediaStores, mediaStores } from "./media/index";
import { isVideo, type MediaStore } from "./media/store";
import { audit, type Notifier, notifier } from "./notify";
import { leadOf, MAX_LEAD_S, platform } from "./platforms/index";
import type { Format } from "./platforms/types";
import { MediaRolesError, mediaRoles, roleKeys, type YouTubeSettings, youtubeSettings } from "./platforms/youtube";
import { providerFor } from "./providers/index";
import { ComposioInstagram } from "./providers/instagram-composio";
import { InstagramProvider } from "./providers/instagram-publish";
import type { OutgoingMedia, OutgoingPost, Provider, Step } from "./providers/types";
import { YouTubeLocked } from "./providers/youtube";
import { jsonList } from "./sql";
import * as N from "./texts/notifications";
import { workspaceSettings, workspaceZone } from "./workspaces";

export interface Deps {
  fetch: typeof fetch;
  now: Date;
}

/** Which part of the work this invocation does (one per cron trigger). */
export type Part = "instagram" | "shorts";

/** A job is a post in one of the platform formats, or a comment on a post published elsewhere (Shorts comments). */
type Kind = Format | "comment";
type State = "pending" | "container_created" | "published" | "done" | "refused" | "failed" | "held";

export interface Payload {
  queueDir: string;
  /** The workspace of the item (jobs.workspace_id). */
  workspaceId?: string;
  /** Instagram username (posted.account); `account` is the Composio connection id. */
  username?: string;
  account: string;
  igUserId: string;
  postedKey: string;
  location: string;
  captionPath: string;
  commentPath: string;
  /** The second comment's text (posted after the first); absent on jobs queued before it existed. */
  comment2Path?: string;
  altPath?: string;
  /** A YouTube video's texts (title, translations): the item's `texts` column. */
  textsPath?: string;
  approvedAt?: string;
  approval?: {
    captionSha256: string;
    commentSha256: string | null;
    comment2Sha256?: string | null;
    altSha256: string | null;
    /** sha256 of the approved YouTube texts; absent/null: the item has none. */
    textsSha256?: string | null;
    media: MediaRef[];
  };
  children?: string[];
  childKinds?: ("image" | "video")[];
  locationDropped?: boolean;
  commented?: boolean;
  commented2?: boolean;
  /** An Instagram Story: no caption, no comments. */
  story?: boolean;
  /** The item's format (null: decided by the media) and its platform options, as planned. Jobs queued before these
   *  existed carry story / location / coverMs instead. */
  format?: Format | null;
  options?: Record<string, unknown>;
  /** The video's chosen cover frame, ms (thumb_offset); absent = 500. */
  coverMs?: number;
  /** It went out as a Reel (a queue Reel, or a single-video post). */
  reel?: boolean;
  /** The Trial Reel copy (job 'trial:<key>'): the same approved Reel, shown to non-followers first. */
  trial?: boolean;
  /** Held because its item is on hold: it goes on (a new container) once the item is released. */
  onHold?: boolean;
  /** The publishing call was made (set just before it): the post may be live even if the job then failed, so a new
   *  approval never reopens it (#148). */
  publishing?: boolean;
  /** The provider's publishing state between runs (providers/types.ts Step). */
  step?: Step;
  /** A job waiting out the platform's quota before its first step (unix seconds); with a step, step.data.notBefore. */
  notBefore?: number;
  mediaId?: string;
  permalink?: string;
  publishedAt?: number; // unix seconds, Instagram's timestamp
  // Shorts comments
  video?: string;
  file?: string;
  label?: string;
  log?: string;
  /** The YouTube account's connection that commented. */
  connectionId?: string;
}

interface JobRow {
  id: number;
  item_key: string;
  kind: Kind;
  account: string;
  due_at: number;
  state: State;
  container_id: string | null;
  attempts: number;
  dry_run: number;
  payload: string;
  workspace_id: string;
  media_id?: string | null;
  updated_at?: number;
}

class Ctx {
  private storeSets = new Map<string, MediaStores>();
  /** The workspaces this run leaves alone (data.ts heldWorkspaces), read once at its start. */
  held = new Map<string, Held>();
  note: Notifier;
  dry: boolean;
  nowS: number;
  private zones = new Map<string, string>();
  private providers = new Map<string, Provider>();
  private accounts = new Map<string, Promise<Account | null>>();
  constructor(
    public env: Env,
    public deps: Deps,
  ) {
    this.nowS = Math.floor(deps.now.getTime() / 1000);
    this.dry = env.DRY_RUN !== "0";
    this.note = notifier(env, deps.fetch, this.nowS);
  }
  /** The media stores of a workspace (the instance's and its own), built once per run. */
  async storesFor(workspaceId: string): Promise<MediaStores> {
    let s = this.storeSets.get(workspaceId);
    if (!s) {
      s = await mediaStores(this.env, this.deps.fetch, workspaceId);
      this.storeSets.set(workspaceId, s);
    }
    return s;
  }
  /** The provider that reaches the job's account (its connection, in the job's workspace), looked up once per run.
   *  Jobs queued before the providers name only a Composio connection. */
  async provider(p: Payload, workspaceId: string): Promise<Provider> {
    const k = `${workspaceId}/${p.username ?? p.account}`;
    let pr = this.providers.get(k);
    if (!pr) {
      const a = await this.account(p, workspaceId);
      pr =
        (a && (await providerFor(this.env, this.deps.fetch, a))) ??
        new InstagramProvider(
          new ComposioInstagram(this.env.COMPOSIO_CONSUMER_KEY ?? "", p.account, p.igUserId, this.deps.fetch),
        );
      this.providers.set(k, pr);
    }
    return pr;
  }
  /** The job's account (payload.username, in the job's workspace), looked up once per run. */
  account(p: Payload, workspaceId: string): Promise<Account | null> {
    if (!p.username) return Promise.resolve(null);
    const k = `${workspaceId}/${p.username}`;
    let a = this.accounts.get(k);
    if (!a) {
      a = findAccount(this.env.DB, p.username, workspaceId);
      this.accounts.set(k, a);
    }
    return a;
  }
  /** The workspace's time zone (for the messages), looked up once per run. */
  async zone(workspaceId: string): Promise<string> {
    let tz = this.zones.get(workspaceId);
    if (!tz) {
      tz = await workspaceZone(this.env.DB, workspaceId);
      this.zones.set(workspaceId, tz);
    }
    return tz;
  }
  /** A text by its contentPaths path ("db:<field>:<key>", the item's D1 column). */
  read(path: string) {
    return readText(this.env.DB, path);
  }
  async setJob(
    id: number,
    fields: Partial<Pick<JobRow, "state" | "container_id" | "attempts" | "dry_run">> & {
      last_error?: string | null;
      payload?: Payload;
      notified?: boolean;
    },
  ) {
    const sets: string[] = ["updated_at = ?1"];
    const vals: unknown[] = [this.nowS];
    const add = (col: string, v: unknown) => {
      vals.push(v);
      sets.push(`${col} = ?${vals.length}`);
    };
    if (fields.state !== undefined) add("state", fields.state);
    if (fields.container_id !== undefined) add("container_id", fields.container_id);
    if (fields.attempts !== undefined) add("attempts", fields.attempts);
    if (fields.dry_run !== undefined) add("dry_run", fields.dry_run);
    if (fields.last_error !== undefined) add("last_error", fields.last_error);
    if (fields.payload !== undefined) add("payload", JSON.stringify(fields.payload));
    if (fields.notified) add("notified_at", this.nowS);
    vals.push(id);
    await this.env.DB.prepare(`UPDATE jobs SET ${sets.join(", ")} WHERE id = ?${vals.length}`)
      .bind(...vals)
      .run();
  }
}

export async function tick(
  env: Env,
  deps: Deps,
  part: Part = "instagram",
): Promise<{ status: string; detail?: unknown }> {
  const nowS = Math.floor(deps.now.getTime() / 1000);
  const holder = crypto.randomUUID();
  const lock = `tick:${part}`;
  if (!(await acquire(env.DB, lock, holder, nowS, 240))) return { status: "locked" };
  try {
    // what this run was limited by: the dashboard reads it, since the variables live on this Worker, not the API's
    await env.DB.prepare("INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT (key) DO UPDATE SET value = ?2")
      .bind(`tick_last:${part}`, JSON.stringify({ at: nowS, jobsPerTick: jobsPerTick(env) }))
      .run();
    const c = new Ctx(env, deps);
    // a held workspace (paused or archived) is left alone; its pause was audited when it happened, not on every run
    c.held = await heldWorkspaces(env.DB);
    if (part === "shorts") {
      await shortsComments(c);
      await env.DB.prepare("DELETE FROM audit WHERE at < ?1")
        .bind(nowS - AUDIT_KEEP_S)
        .run();
      return { status: "ok", detail: { part, dry_run: c.dry } };
    }
    // disabled ones too: their jobs' leads (recheck then refuses them)
    const accounts = await listAccounts(env.DB, { all: true });
    // every active account on a platform Bongsu publishes to
    for (const a of accounts)
      if (a.status === "active" && platform(a.platform)?.formats.length && !c.held.has(a.workspaceId))
        await discover(c, a);
    const active = await activeJobs(c, accounts);
    for (const job of active) await advance(c, job);
    // a full run has spent its subrequests on the jobs: the sweep waits for a quieter one
    if (active.length < jobsPerTick(env)) await sweepRemoved(c);
    return {
      status: "ok",
      detail: { part, advanced: active.length, held: [...c.held.keys()], dry_run: c.dry },
    };
  } finally {
    await release(env.DB, lock, holder);
  }
}

/** The jobs this run advances: those due within their platform's lead, in three groups, each in due order: the
 *  ones with work to do, then the upload steps (one can take most of a run), then the videos waiting for their time
 *  (only a recheck until then); cut to jobsPerTick. A held workspace's jobs wait where they are, and don't take the
 *  run's share from the others. */
async function activeJobs(c: Ctx, accounts: Account[]): Promise<JobRow[]> {
  // no LIMIT here: everything within the longest lead comes back, and the cut is made below, after each job's own
  // lead (its account's platform) has filtered out the ones not yet started
  const r = await c.env.DB.prepare(
    `SELECT * FROM jobs WHERE state IN ('pending', 'container_created', 'published') AND kind != 'comment' AND due_at <= ?1
       AND workspace_id NOT IN ${jsonList(c.env.DB, 2)} ORDER BY due_at, id`,
  )
    .bind(c.nowS + MAX_LEAD_S, JSON.stringify([...c.held.keys()]))
    .all<JobRow>();
  const platforms = new Map(accounts.map((a) => [`${a.workspaceId}/${a.id}`, a.platform]));
  const jobs = r.results.map((job) => ({ job, p: JSON.parse(job.payload) as Payload }));
  return jobs
    .filter(({ job, p }) => job.due_at - leadOf(platforms.get(`${job.workspace_id}/${p.username}`)) <= c.nowS)
    .filter(({ p }) => notBefore(p) <= c.nowS) // waiting out a quota: no slot taken
    .sort((a, b) => group(c, a.job, a.p) - group(c, b.job, b.p)) // stable: due order kept within a group
    .slice(0, jobsPerTick(c.env))
    .map(({ job }) => job);
}

/** Until when a job waits out its platform's quota (0: it doesn't). */
const notBefore = (p: Payload): number => Number(p.step?.data.notBefore ?? p.notBefore ?? 0);

/** 0: work to do (anything due, a start, extras, processing), 1: an upload step, 2: a video waiting for its time. An
 *  upload goes after the rest even when late, so it never delays an Instagram post. */
function group(c: Ctx, job: JobRow, p: Payload): number {
  if (isUploadStep(job, p)) return 1;
  return job.state === "container_created" && p.step?.data.phase === "waiting" && job.due_at > c.nowS ? 2 : 0;
}

/** A job sending its file to the platform (YouTube's uploading phase): the run's longest step. */
export function isUploadStep(job: Pick<JobRow, "state">, p: Pick<Payload, "step">): boolean {
  return job.state === "container_created" && p.step?.data.phase === "uploading";
}

/** The jobs a tick advances: the JOBS_PER_TICK variable when it is a whole number from 1 (at most
 *  JOBS_PER_TICK_MAX), else the default for Cloudflare's free plan. Node sets its own default (apps/node/src/env.ts). */
export function jobsPerTick(env: Pick<Env, "JOBS_PER_TICK">): number {
  const n = Number(env.JOBS_PER_TICK);
  return Number.isInteger(n) && n >= 1 ? Math.min(n, JOBS_PER_TICK_MAX) : JOBS_PER_TICK;
}

// ---------------------------------------------------------------- discovery

interface Candidate {
  key: string;
  /** The item's format; null until the approval's media decide it. */
  format: Format | null;
  dueAt: number;
  payload: Payload;
  mediaCount: number;
  /** The account's workspace: the job's. */
  workspaceId: string;
}

async function discover(c: Ctx, a: Account) {
  if (!a.externalId || !a.connection || a.connection.status === "broken") return; // not connected: nothing can go out
  const base = {
    queueDir: "",
    username: a.id,
    account: a.connection.externalRef ?? a.connection.id,
    igUserId: a.externalId,
    workspaceId: a.workspaceId,
  };
  const cands: Candidate[] = [];
  const folder = (await workspaceSettings(c.env.DB, a.workspaceId)).mediaFolder;
  for (const i of await dueItems(c.env.DB, a.id, c.nowS, leadOf(a.platform))) {
    const at = i.due_at as number; // dueItems: due_at ≤ now + the platform's lead
    const paths = contentPaths(i, folder);
    cands.push({
      key: i.item_key,
      format: i.format ?? null,
      dueAt: at,
      mediaCount: i.format === "video" ? 1 : 0,
      workspaceId: a.workspaceId,
      payload: {
        ...base,
        postedKey: shortKey(i.item_key),
        location: "",
        captionPath: paths.caption,
        commentPath: paths.comment,
        comment2Path: paths.comment2,
        ...(paths.alt ? { altPath: paths.alt } : {}),
        textsPath: paths.texts,
        ...(i.format === "story" ? { story: true } : {}),
        format: i.format ?? null,
        options: itemOptions(i),
      },
    });
  }
  if (!cands.length) return;
  const approvals = await latestApprovals(
    c.env.DB,
    cands.map((x) => x.key),
  ); // only when something is due
  const existing = await c.env.DB.prepare(`SELECT * FROM jobs WHERE item_key IN ${jsonList(c.env.DB, 1)}`)
    .bind(JSON.stringify(cands.map((x) => x.key)))
    .all<JobRow>();
  const byKey = new Map(existing.results.map((j) => [j.item_key, j]));
  for (const cand of cands) {
    const a = approvals.get(cand.key);
    const job = byKey.get(cand.key);
    if (job) {
      const p = JSON.parse(job.payload) as Payload;
      if (a && reopens(job, p, a)) await reopen(c, job.id, cand, a, p);
      continue;
    }
    await create(c, cand, a);
  }
}

/** Whether an approval brings a closed job back (as a fresh job: no container, no attempts). A refused/held job comes
 *  back when you approve it again (a newer approval line); one held for its item's hold comes back when the item is
 *  released (it's due again, dueItems leaves out held ones). A failed job comes back on an approval made after it
 *  failed, unless the publishing call was ever made: the post may be live then (a timeout on Instagram's side), and
 *  posting again could double it; the owner checks the account and records it by hand (#148). */
export function reopens(
  job: { state: string; media_id?: string | null; updated_at?: number },
  p: Payload,
  a: Pick<Approval, "dueAt" | "approvedAt">,
): boolean {
  if (a.dueAt === null) return false;
  const newer = a.approvedAt !== p.approvedAt;
  if (job.state === "refused") return newer;
  // a private upload under way ahead of its time: a new approval revises it before its time (previousUpload);
  // Instagram's containers have neither, and stay as they are
  if (job.state === "container_created")
    return newer && !mayBeLive(job, p) && !!(p.step?.data.videoId || p.step?.data.session);
  if (job.state === "held") return newer || !!p.onHold;
  if (job.state !== "failed" || !newer || mayBeLive(job, p)) return false;
  return job.updated_at !== undefined && Date.parse(a.approvedAt) / 1000 > job.updated_at; // NaN: never
}

/** Whether a job's post may be live: it has a media id, or the publishing call was made (its answer may have been lost). */
export function mayBeLive(job: { media_id?: string | null }, p: Pick<Payload, "mediaId" | "publishing">): boolean {
  return !!(job.media_id || p.mediaId || p.publishing);
}

function withApproval(cand: Candidate, a: Approval): { payload: Payload; kind: Kind } {
  const payload: Payload = {
    ...cand.payload,
    approvedAt: a.approvedAt,
    approval: {
      captionSha256: a.captionSha256,
      commentSha256: a.commentSha256,
      comment2Sha256: a.comment2Sha256 ?? null,
      altSha256: a.altSha256,
      textsSha256: a.textsSha256 ?? null,
      media: a.media,
    },
  };
  // no format planned: the approved media decide (one file: an image, or a video once its type is known; several: a carousel)
  const kind: Kind = cand.format ?? (a.media.length === 1 ? "image" : "carousel");
  return { payload, kind };
}

function verdict(c: Ctx, cand: Candidate, a: Approval | undefined): { state: State; reason: string | null } {
  if (c.nowS - cand.dueAt > CATCH_UP_S)
    return {
      state: "held",
      reason: `missed by more than ${CATCH_UP_S / 3600} h: post it by hand or reschedule and approve again`,
    };
  if (!a || a.dueAt === null) return { state: "refused", reason: a ? "approval revoked" : "not approved" };
  if (a.account !== cand.payload.username)
    return {
      state: "refused",
      reason: a.account
        ? `approved for ${a.account}, now planned for ${cand.payload.username}: approve again`
        : "the approval names no account: approve again",
    };
  if (a.dueAt !== cand.dueAt) return { state: "refused", reason: "the schedule changed after approval: approve again" };
  return { state: "pending", reason: null };
}

async function create(c: Ctx, cand: Candidate, a: Approval | undefined) {
  const v = verdict(c, cand, a);
  const { payload, kind } =
    a && a.dueAt !== null ? withApproval(cand, a) : { payload: cand.payload, kind: cand.format ?? "carousel" };
  const r = await c.env.DB.prepare(
    `INSERT INTO jobs (item_key, kind, account, due_at, state, last_error, dry_run, payload, created_at, updated_at,
       workspace_id)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9, ?10) ON CONFLICT (item_key) DO NOTHING RETURNING id`,
  )
    .bind(
      cand.key,
      kind,
      cand.payload.account,
      cand.dueAt,
      v.state,
      v.reason,
      c.dry ? 1 : 0,
      JSON.stringify(payload),
      c.nowS,
      cand.workspaceId,
    )
    .first<{ id: number }>();
  if (r && v.state !== "pending") {
    await c.note.send(N.jobVerdict(cand.key, v.state, v.reason), cand.workspaceId);
    await c.setJob(r.id, { notified: true });
  }
}

async function reopen(c: Ctx, id: number, cand: Candidate, a: Approval, old: Payload) {
  const v = verdict(c, cand, a);
  const { payload, kind } = withApproval(cand, a);
  // a private video uploaded earlier stays with the job: the provider revises it rather than uploading again
  if (previousUpload(old)) payload.step = old.step;
  await c.env.DB.prepare(
    "UPDATE jobs SET state = ?1, last_error = ?2, kind = ?3, due_at = ?4, payload = ?5, attempts = 0, container_id = NULL, dry_run = ?6, updated_at = ?7 WHERE id = ?8",
  )
    .bind(v.state, v.reason, kind, cand.dueAt, JSON.stringify(payload), c.dry ? 1 : 0, c.nowS, id)
    .run();
}

// ---------------------------------------------------------------- one step per job

async function advance(c: Ctx, job: JobRow) {
  const p = JSON.parse(job.payload) as Payload;
  try {
    if (job.state === "pending") await stepPending(c, job, p);
    else if (job.state === "container_created") await stepContainer(c, job, p);
    else if (job.state === "published") await stepPublished(c, job, p);
  } catch (e) {
    const attempts = job.attempts + 1;
    const msg = String((e as Error).message ?? e).slice(0, 500);
    if (attempts >= 3) {
      await c.setJob(job.id, { state: "failed", attempts, last_error: msg });
      await c.note.send(await failedNote(c, job, p, msg), job.workspace_id);
    } else {
      await c.setJob(job.id, { attempts, last_error: msg });
    }
  }
}

/** A job that failed for good: a private video it uploaded is kept (never deleted on a failure), and the note says
 *  where it is. */
async function failedNote(c: Ctx, job: JobRow, p: Payload, msg: string) {
  if (!previousUpload(p)) return N.jobFailed(job.item_key, msg);
  const a = await c.account(p, job.workspace_id);
  return N.providerFailed(job.item_key, platform(a?.platform ?? "")?.name ?? "the platform", msg, "kept");
}

/** How long a day's quota-note marker is kept (a Pacific day, with room for the time zones). */
const QUOTA_NOTE_KEEP_S = 2 * 86400;

/** A platform's daily quota is used up (YouTube's resets at midnight Pacific time): the job waits until then without
 *  counting an attempt, its step (or, before the first one, the payload) carrying the time; one note per workspace
 *  per Pacific day. */
async function waitQuota(c: Ctx, job: JobRow, p: Payload) {
  const until = nextPacificMidnight(c.nowS);
  const payload: Payload = p.step
    ? { ...p, step: { ...p.step, data: { ...p.step.data, notBefore: until } } }
    : { ...p, notBefore: until };
  await c.setJob(job.id, { payload });
  const day = zoneDate(c.deps.now, "America/Los_Angeles");
  const first = await c.env.DB.prepare(
    "INSERT INTO settings (key, value, updated_at) VALUES (?1, '1', ?2) ON CONFLICT (key) DO NOTHING RETURNING key",
  )
    .bind(`youtube_quota:${job.workspace_id}:${day}`, c.nowS)
    .first();
  if (first) await c.note.send(N.youtubeQuota(), job.workspace_id);
  // the days before are done with
  await c.env.DB.prepare("DELETE FROM settings WHERE key LIKE ?1 AND updated_at < ?2")
    .bind("youtube_quota:%", c.nowS - QUOTA_NOTE_KEEP_S)
    .run();
}

/** `payload`: the job's state to keep with the refusal (a step that left a private video, for the next approval). */
async function refuse(c: Ctx, job: JobRow, reason: string, payload?: Payload) {
  await c.setJob(job.id, { state: "refused", last_error: reason, notified: true, ...(payload ? { payload } : {}) });
  await c.note.send(N.jobRefused(job.item_key, reason), job.workspace_id);
}

/** recheck's finding; `removed`: the item is gone from the plan, so nothing it left on the platform will be needed. */
type Recheck = { state: "done" | "refused" | "wait"; reason: string; removed?: boolean };

/** The plan's current word on a queued job, asked before each step that reaches the platform: the item is still
 *  there, at the same time, for the same account, released and not posted, and its account enabled (a Trial Reel
 *  copy: its Reel is still planned, with the trial switch on). Null when the job may go on. */
async function recheck(c: Ctx, job: JobRow, p: Payload): Promise<Recheck | null> {
  const key = p.trial ? job.item_key.replace(/^trial:/, "") : job.item_key;
  const item = await getItem(c.env.DB, key);
  if (!item) return { state: "refused", reason: "removed from the plan", removed: true };
  if (p.trial) {
    if (!(await trialFor(c.env.DB, item)).on) return { state: "done", reason: "trial copy switched off" };
  } else {
    if (await isPosted(c.env.DB, key))
      return { state: "done", reason: "already posted (published outside the scheduler)" };
    // Moved or removed after this job was queued: it must not go out at the old time (approve again for the new one).
    if (item.due_at !== job.due_at) {
      const tz = await c.zone(job.workspace_id);
      return {
        state: "refused",
        reason: `rescheduled to ${itemDue(item, tz) ?? "no date"} ${tz}: approve again for the new time`,
      };
    }
    if (item.hold) return { state: "wait", reason: "on hold: it goes out once released" };
  }
  if (item.account !== p.username)
    return { state: "refused", reason: `planned for ${item.account} now, approved for ${p.username}: approve again` };
  const a = await c.account(p, job.workspace_id);
  if (p.username && a?.status !== "active") return { state: "refused", reason: `${p.username} is disabled` };
  return null;
}

/** What recheck found: the job settles (done, refused), or is held until the item is released (discover brings it
 *  back; a held job doesn't take one of the tick's slots while it waits). A refusal keeps the step (a private video,
 *  for the next approval to revise), except when the item is gone: then the video is deleted. */
async function settle(c: Ctx, job: JobRow, p: Payload, r: Recheck) {
  if (r.state === "refused" && r.removed && previousUpload(p))
    return refuse(c, job, r.reason, await discard(c, job, p));
  if (r.state === "refused") return refuse(c, job, r.reason, p);
  if (r.state === "done") return c.setJob(job.id, { state: "done", last_error: r.reason });
  await c.setJob(job.id, { state: "held", last_error: r.reason, payload: { ...p, onHold: true } });
}

/** Deletes the private video a job uploaded for an item that is gone, best effort; the audit row records a video
 *  that is gone now. Returns the payload with the step's videoId dropped when it is (else kept: nothing claims it was
 *  deleted, and the sweep tries again). Dry run deletes nothing: it audits what it would delete and keeps the step. */
async function discard(c: Ctx, job: JobRow, p: Payload): Promise<Payload> {
  const step = p.step!;
  const videoId = step.data.videoId;
  if (c.dry) {
    await audit(c.env.DB, c.nowS, "would_delete", job.item_key, { videoId }, job.workspace_id);
    return p;
  }
  const pr = await c.provider(p, job.workspace_id);
  if (!(await pr.discard?.(step))) return p;
  await audit(c.env.DB, c.nowS, "youtube_video_deleted", job.item_key, { videoId }, job.workspace_id);
  const { videoId: _gone, ...data } = step.data;
  return { ...p, step: { ...step, data } };
}

/** Deletes per run at most, in the sweep below: each costs a token refresh and a videos.delete, on top of what the
 *  run's jobs spent of its subrequest budget; the rest go on the next runs. */
const SWEEP_PER_RUN = 1;

/**
 * A private video left by a job that is no longer active (refused, held or failed, keeping its video for a new
 * approval) whose item has since been removed: nothing would ever reach it, so it is deleted here, as the active path
 * does. Never one that may be live (the publishing call was made), never in dry run, nor in a held workspace. The
 * LIKE filters only narrow the rows; the payload decides.
 */
async function sweepRemoved(c: Ctx) {
  if (c.dry) return;
  const r = await c.env.DB.prepare(
    `SELECT * FROM jobs WHERE state IN ('refused', 'held', 'failed') AND kind != 'comment' AND media_id IS NULL
       AND payload LIKE '%"videoId"%' AND payload NOT LIKE '%"publishing":true%'
       AND NOT EXISTS (SELECT 1 FROM plan_items i WHERE i.item_key = jobs.item_key)
       AND workspace_id NOT IN ${jsonList(c.env.DB, 1)} ORDER BY updated_at, id LIMIT ?2`,
  )
    .bind(JSON.stringify([...c.held.keys()]), SWEEP_PER_RUN)
    .all<JobRow>();
  for (const job of r.results) {
    const p = JSON.parse(job.payload) as Payload;
    // a row the LIKE let through but the payload rules out, or a failed delete, still touches updated_at: the others
    // get their turn first next run
    if (!previousUpload(p) || mayBeLive(job, p)) {
      await c.setJob(job.id, {});
      continue;
    }
    try {
      await c.setJob(job.id, { payload: await discard(c, job, p) });
    } catch {
      await c.setJob(job.id, {});
    }
  }
}

/** Every fingerprint again, just before publishing: the texts and each media file's checksum in its store. */
async function verify(
  c: Ctx,
  p: Payload,
  workspaceId: string,
  itemKey: string,
): Promise<{
  problem: string | null;
  caption: string;
  comment: string | null;
  alts: string[];
  /** A YouTube video's texts as approved (null: the job has none). */
  texts: YouTubeTexts | null;
  /** A YouTube video's settings now, as checked (the item's options over the channel's defaults). */
  settings?: YouTubeSettings;
  /** Each media file's current name in its store, by id (when nothing is wrong). */
  names?: Record<string, string>;
}> {
  const ap = p.approval!;
  const captionRaw = p.story ? "" : await c.read(p.captionPath); // a Story has no caption or comments
  if (captionRaw === null) {
    const key = p.captionPath.replace(/^db:caption:/, "");
    return {
      problem: p.captionPath.startsWith("db:")
        ? `no caption in the scheduler: add one in the app or with \`bongsu texts set ${key}\``
        : "queued before the texts moved to the scheduler's database: approve it again",
      caption: "",
      comment: null,
      alts: [],
      texts: null,
    };
  }
  const caption = captionText(captionRaw);
  const comment = p.story ? null : commentText(caption, await c.read(p.commentPath));
  const alt = p.altPath ? ((await c.read(p.altPath)) ?? "").trim() : "";
  if ((await sha256Hex(caption)) !== ap.captionSha256)
    return { problem: "the caption changed after approval", caption, comment, alts: [], texts: null };
  if ((comment ? await sha256Hex(comment) : null) !== ap.commentSha256)
    return { problem: "the self-comment changed after approval", caption, comment, alts: [], texts: null };
  if ((alt ? await sha256Hex(alt) : null) !== ap.altSha256)
    return { problem: "the alt text changed after approval", caption, comment, alts: [], texts: null };
  const comment2 = p.comment2Path && !p.story ? comment2Text(await c.read(p.comment2Path)) : null;
  if ((comment2 ? await sha256Hex(comment2) : null) !== (ap.comment2Sha256 ?? null))
    return { problem: "the second comment changed after approval", caption, comment, alts: [], texts: null };
  // a YouTube video's title and translations: read when the approval covers them or the item has some now
  const textsRaw = p.textsPath ? await c.read(p.textsPath) : null;
  const texts = parseTexts(textsRaw);
  const youtube = !!(ap.textsSha256 || textsRaw);
  const entries: { name: string; mime: string; size: number; ref: MediaRef }[] = [];
  const stores = await c.storesFor(workspaceId);
  for (const m of ap.media) {
    const store = stores.for(m);
    if (!store)
      return {
        problem: `approved on the ${m.store} store, which isn't set up any more: approve again`,
        caption,
        comment,
        alts: [],
        texts: null,
      };
    const meta = await store.stat(m.id);
    if (!meta) return { problem: `media file ${m.id} is gone`, caption, comment, alts: [], texts: null };
    if (meta.checksum !== m.checksum)
      return { problem: `media file ${m.id} changed after approval`, caption, comment, alts: [], texts: null };
    entries.push({ name: meta.name, mime: meta.mime, size: meta.size, ref: m });
  }
  let settings: YouTubeSettings | undefined;
  if (youtube) {
    // the roles come from the files' current names: a rename (es.srt to fr.srt) changes what is uploaded
    let roles: string[];
    try {
      roles = roleKeys(mediaRoles(entries));
    } catch (e) {
      if (!(e instanceof MediaRolesError)) throw e;
      return { problem: e.message, caption, comment, alts: [], texts: null };
    }
    // the settings as they are now, read the way the app's approval reads them: the item's options (the job's copy
    // dates from when it was queued) over the channel's defaults, so a changed default voids an item that follows it
    const item = await getItem(c.env.DB, itemKey);
    const account = await c.account(p, workspaceId);
    settings = youtubeSettings(item ? itemOptions(item) : (p.options ?? {}), account?.settings ?? {});
    const sha = ap.textsSha256 ?? null;
    if ((await youtubeSha(texts, roles, settings)) !== sha) {
      // one hash covers the texts, the roles and the settings: the texts and roles matching it under other settings
      // means only the settings changed
      const only = await settingsApproved(texts, roles, sha);
      return {
        problem: only
          ? "the video's settings changed after approval"
          : "the title or translations changed after approval",
        caption,
        comment,
        alts: [],
        texts: null,
      };
    }
  }
  const names = Object.fromEntries(entries.map((e) => [e.ref.id, e.name]));
  return { problem: null, caption, comment, alts: altLines(alt), texts, names, ...(settings ? { settings } : {}) };
}

async function link(c: Ctx, m: MediaRef, video: boolean, workspaceId: string) {
  const store = (await c.storesFor(workspaceId)).for(m);
  if (!store) throw new Error(`the ${m.store} media store isn't set up`);
  return mediaUrl(store, {
    base: c.env.PUBLIC_URL,
    secret: c.env.MEDIA_SIGNING_KEY,
    id: m.id,
    video,
    nowS: c.nowS,
    ttlS: LINK_TTL_S,
  });
}
const isVideoRef = async (c: Ctx, m: MediaRef, workspaceId: string) =>
  isVideo((await (await c.storesFor(workspaceId)).for(m)?.stat(m.id)) ?? { mime: "" });

async function stepPending(c: Ctx, job: JobRow, p: Payload) {
  if (p.trial) return stepTrialPending(c, job, p);
  if (c.nowS - job.due_at > CATCH_UP_S) {
    await c.setJob(job.id, { state: "held", last_error: "missed the catch-up window", notified: true });
    await c.note.send(N.jobHeld(job.item_key, CATCH_UP_S / 3600), job.workspace_id);
    return;
  }
  const r = await recheck(c, job, p);
  if (r) return settle(c, job, p, r);

  const v = await verify(c, p, job.workspace_id, job.item_key);
  if (v.problem) return refuse(c, job, v.problem);
  const media = p.approval!.media;

  if (c.dry) {
    await c.setJob(job.id, { state: "done", dry_run: 1, last_error: "dry run: nothing published" });
    await audit(
      c.env.DB,
      c.nowS,
      "would_publish",
      job.item_key,
      {
        kind: job.kind,
        account: p.account,
        media: media.length,
        location: p.location,
      },
      job.workspace_id,
    );
    await c.note.send(
      N.dryRunPublish(
        job.item_key,
        job.kind,
        p.account,
        `${media.length} media, caption ${v.caption.length} chars${v.comment ? ", with self-comment" : ""}`,
      ),
      job.workspace_id,
    );
    return;
  }

  const kinds = await Promise.all(media.map((m) => isVideoRef(c, m, job.workspace_id)));
  // an "image" whose file is a video goes out as a video (a single-video post: the slideshow Reels in posts/reelN_<name>/)
  const format: Format = p.story ? "story" : job.kind === "image" && kinds[0] ? "video" : (job.kind as Format);
  const account = await c.account(p, job.workspace_id);
  // a YouTube video's title and translations, and its settings: the item's options over the channel's defaults
  const youtube =
    account?.platform === "youtube"
      ? { texts: v.texts, settings: v.settings ?? youtubeSettings(p.options ?? {}, account.settings) }
      : {};
  await startPublishing(c, job, p, {
    ...youtube,
    format,
    caption: v.caption,
    alts: v.alts,
    media: await Promise.all(
      media.map(async (m, i) => ({
        id: m.id,
        url: await link(c, m, kinds[i], job.workspace_id),
        video: kinds[i],
        name: v.names?.[m.id] ?? m.id,
        checksum: m.checksum,
      })),
    ),
    options: postOptions(p, format),
  });
}

/** The post's platform options: as planned, or (a job queued before options existed) from its own fields. The trial
 *  switch only matters on the trial copy's job (the regular Reel goes out without it). */
function postOptions(p: Payload, format: Format): Record<string, unknown> {
  const o: Record<string, unknown> = p.options
    ? { ...p.options }
    : { ...(p.location ? { location: p.location } : {}), ...(p.coverMs != null ? { coverMs: p.coverMs } : {}) };
  delete o.trial;
  if (format === "story") delete o.location;
  if (format !== "video") delete o.coverMs;
  if (format === "video" && p.trial) o.trial = true;
  if (p.locationDropped) delete o.location;
  return o;
}

/** The job's earlier step, when it left a private video on the platform (a job reopened by a new approval). */
const previousUpload = (p: Payload): Step | undefined => (p.step?.data.videoId ? p.step : undefined);

/** The provider's first step; its state goes with the job (payload.step) for check and finish on the next runs. */
async function startPublishing(c: Ctx, job: JobRow, p: Payload, post: OutgoingPost) {
  const pr = await c.provider(p, job.workspace_id);
  let step: Step;
  try {
    step = await pr.start(post, previousUpload(p));
  } catch (e) {
    if (e instanceof QuotaExceeded) return waitQuota(c, job, p);
    throw e;
  }
  const { notBefore: _waited, ...rest } = p;
  const next: Payload = {
    ...rest,
    step,
    ...(step.data.locationDropped ? { locationDropped: true } : {}),
    ...(post.format === "video" ? { reel: true } : {}),
  };
  if (step.state === "ready") return publish(c, job, next, pr, step); // a network that posts in one call
  if (step.state === "failed") return failStep(c, job, next, pr, step);
  await c.setJob(job.id, {
    state: "container_created",
    container_id: typeof step.data.container === "string" ? step.data.container : null,
    attempts: 0,
    payload: next,
  });
}

/** The Trial Reel copy: the approval checked again, then a REELS container with trial_params (through Composio, that's
 *  the raw workbench call: see providers/instagram-composio.ts). It graduates to followers on its own when
 *  non-followers respond well (SS_PERFORMANCE); then the usual container → publish → comments steps. */
async function stepTrialPending(c: Ctx, job: JobRow, p: Payload) {
  const regular = job.item_key.replace(/^trial:/, "");
  if (await c.env.DB.prepare("SELECT 1 FROM trial_posts WHERE item_key = ?1").bind(regular).first()) {
    await c.setJob(job.id, { state: "done", last_error: "trial copy already posted" });
    return;
  }
  if (c.nowS - job.due_at > CATCH_UP_S) {
    // the scheduler was paused or stuck: a late trial copy isn't worth it
    await c.setJob(job.id, { state: "held", last_error: "trial copy not posted within the catch-up window" });
    return;
  }
  const item = await getItem(c.env.DB, regular);
  if (!item || !(await trialFor(c.env.DB, item)).on) {
    // switched off after the Reel went out
    await c.setJob(job.id, { state: "done", last_error: "trial copy switched off" });
    return;
  }
  const v = await verify(c, p, job.workspace_id, job.item_key);
  if (v.problem) return refuse(c, job, `trial copy: ${v.problem}`);
  if (c.dry) {
    await c.setJob(job.id, { state: "done", dry_run: 1, last_error: "dry run: trial copy not posted" });
    await audit(
      c.env.DB,
      c.nowS,
      "would_publish",
      job.item_key,
      { kind: "trial", account: p.account, media: 1 },
      job.workspace_id,
    );
    return;
  }
  const m = p.approval!.media[0];
  await startPublishing(c, job, p, {
    format: "video",
    caption: v.caption,
    alts: [],
    media: [
      {
        id: m.id,
        url: await link(c, m, true, job.workspace_id),
        video: true,
        name: v.names?.[m.id] ?? m.id,
        checksum: m.checksum,
      },
    ],
    options: postOptions({ ...p, trial: true }, "video"),
  });
}

/** After a Reel whose trial switch is on (its own, or its account's default): its trial copy, as its own job, due now. */
async function queueTrial(c: Ctx, job: JobRow, p: Payload) {
  const { mediaId: _m, permalink: _l, publishedAt: _t, commented: _c, commented2: _c2, ...rest } = p;
  const payload: Payload = { ...rest, trial: true };
  await c.env.DB.prepare(
    `INSERT INTO jobs (item_key, kind, account, due_at, state, dry_run, payload, created_at, updated_at, workspace_id)
     VALUES (?1, 'video', ?2, ?3, 'pending', 0, ?4, ?3, ?3, ?5) ON CONFLICT (item_key) DO NOTHING`,
  )
    .bind(`trial:${job.item_key}`, p.account, c.nowS, JSON.stringify(payload), job.workspace_id)
    .run();
}

async function stepContainer(c: Ctx, job: JobRow, p: Payload) {
  const pr = await c.provider(p, job.workspace_id);
  const step = await withLinks(c, job, p, p.step ?? (await legacyStep(c, job, p)));
  let next: Step;
  try {
    next = await pr.check(step);
  } catch (e) {
    if (e instanceof QuotaExceeded) return waitQuota(c, job, p);
    if (e instanceof SessionGone) return restart(c, job, p);
    throw e;
  }
  if (next.data.thumbnailRefused && !step.data.thumbnailRefused)
    await c.note.send(N.youtubeThumbnailRefused(job.item_key), job.workspace_id);
  if (next.state === "failed") return failStep(c, job, p, pr, next);
  if (next.state === "processing") {
    const container = typeof next.data.container === "string" ? next.data.container : null;
    if (container !== job.container_id || progressed(step, next)) {
      // a new container to wait for (a carousel's parent), or a step forward: a fresh count of polls
      await c.setJob(job.id, { container_id: container, attempts: 0, payload: { ...p, step: next } });
      return;
    }
    return pollWait(c, job, pr, { ...p, step: next });
  }
  if (leadOf(pr.platform) > 0) return stepAhead(c, job, { ...p, step: next }, pr, next, progressed(step, next));
  const r = await recheck(c, job, p);
  if (r) return settle(c, job, p, r);
  return publish(c, job, p, pr, next);
}

/**
 * A step made ahead of its due time (a private upload) that is ready. Before the due time it waits, unseen: the plan
 * is asked again (a removed item settles), and the run counts no attempt. At the due time: the plan, then every
 * fingerprint again (the texts may have changed since the upload; a refusal keeps the video private, and the step for
 * a new approval to revise), then it goes public. Past the catch-up window it is held, still private.
 */
async function stepAhead(c: Ctx, job: JobRow, p: Payload, pr: Provider, step: Step, moved: boolean) {
  const r = await recheck(c, job, p);
  if (r) return settle(c, job, p, r);
  if (c.nowS < job.due_at) {
    // reaching the wait ends the polling: a fresh count for whatever comes after; a run that only waits writes nothing
    if (moved) await c.setJob(job.id, { payload: p, attempts: 0 });
    return;
  }
  if (c.nowS - job.due_at > CATCH_UP_S) {
    await c.setJob(job.id, { state: "held", last_error: "missed the catch-up window", notified: true, payload: p });
    await c.note.send(N.jobHeld(job.item_key, CATCH_UP_S / 3600), job.workspace_id);
    return;
  }
  const v = await verify(c, p, job.workspace_id, job.item_key);
  if (v.problem) return refuse(c, job, v.problem, p);
  return publish(c, job, p, pr, step);
}

/** The upload session is gone (expired, or YouTube forgot it): the job starts again from start on the next run, with
 *  no video yet (a session exists only before one) and no attempt counted. */
async function restart(c: Ctx, job: JobRow, p: Payload) {
  const { step: _gone, ...rest } = p;
  await c.setJob(job.id, { state: "pending", container_id: null, payload: rest });
}

/** Whether a provider's step moved on (a new phase, more bytes sent, extras landed): such a run is progress, not a poll. Instagram's
 *  steps have neither, so its polls count as before. */
const progressed = (a: Step, b: Step) =>
  a.data.phase !== b.data.phase || a.data.offset !== b.data.offset || pendingOf(a) !== pendingOf(b);

/** What a step's extras phase still has to do (YouTube's tracks and thumbnail): a run that lands some has moved on,
 *  even in the same phase. */
function pendingOf(s: Step): number {
  const p = s.data.pending as { captions?: unknown[]; dropCaptions?: unknown[]; thumbnail?: boolean } | undefined;
  return (p?.captions?.length ?? 0) + (p?.dropCaptions?.length ?? 0) + (p?.thumbnail ? 1 : 0);
}

/** A step that fetches its files on later runs keeps their links (YouTube's post.media); a link expires (LINK_TTL_S),
 *  so each run signs them again from the approval's media. */
async function withLinks(c: Ctx, job: JobRow, p: Payload, step: Step): Promise<Step> {
  const post = step.data.post as { media?: OutgoingMedia[] } | undefined;
  if (!post?.media?.length) return step;
  const refs = new Map((p.approval?.media ?? []).map((m) => [m.id, m]));
  const media = await Promise.all(
    post.media.map(async (m) => {
      const ref = refs.get(m.id);
      return ref ? { ...m, url: await link(c, ref, m.video, job.workspace_id) } : m;
    }),
  );
  return { ...step, data: { ...step.data, post: { ...post, media } } };
}

async function failStep(c: Ctx, job: JobRow, p: Payload, pr: Provider, step: Step) {
  await c.setJob(job.id, { state: "failed", last_error: step.error ?? "failed", payload: { ...p, step } });
  await c.note.send(
    N.providerFailed(job.item_key, platformName(pr), step.error ?? "failed", step.data.videoId ? "refused" : false),
    job.workspace_id,
  );
}

/** The provider's last step: the post goes live; comments and the record follow on the next run. In dry run (switched
 *  on while the job was under way) the container stays unpublished. */
async function publish(c: Ctx, job: JobRow, p: Payload, pr: Provider, step: Step) {
  if (c.dry) {
    await c.setJob(job.id, {
      state: "done",
      dry_run: 1,
      last_error: "dry run: nothing published (the container stays unpublished)",
      payload: { ...p, step },
    });
    await audit(
      c.env.DB,
      c.nowS,
      "would_publish",
      job.item_key,
      { kind: job.kind, account: p.account },
      job.workspace_id,
    );
    await c.note.send(N.dryRunPublish(job.item_key, job.kind, p.account), job.workspace_id);
    return;
  }
  // From here the post may go live even if the call fails: a failed job never reopens after this (reopens()), except
  // one YouTube read back as still private (YouTubeLocked below).
  await c.setJob(job.id, { payload: { ...p, step, publishing: true } });
  let got: Awaited<ReturnType<Provider["finish"]>>;
  try {
    got = await pr.finish(step);
  } catch (e) {
    // the quota: the call may have landed before the error (a read after the update), so it stays "publishing"
    if (e instanceof QuotaExceeded) return waitQuota(c, job, { ...p, step, publishing: true });
    if (!(e instanceof YouTubeLocked)) throw e;
    // read back still private, so not live: a new approval may reopen it once the project passes the audit
    await c.setJob(job.id, { state: "failed", last_error: e.message, payload: { ...p, step } });
    await c.note.send(N.youtubeLocked(job.item_key), job.workspace_id);
    return;
  }
  await c.setJob(job.id, {
    state: "published",
    attempts: 0,
    payload: {
      ...p,
      step,
      mediaId: got.mediaId,
      permalink: got.permalink ?? "",
      publishedAt: got.publishedAt ?? c.nowS,
    },
  });
  await c.env.DB.prepare("UPDATE jobs SET media_id = ?1, permalink = ?2 WHERE id = ?3")
    .bind(got.mediaId, got.permalink ?? "", job.id)
    .run();
}

/** A job queued before the providers had no payload.step: rebuilt from its container ids (Instagram's). */
async function legacyStep(c: Ctx, job: JobRow, p: Payload): Promise<Step> {
  if (job.container_id) return { state: "processing", data: { container: job.container_id } };
  return {
    state: "processing",
    data: {
      children: p.children ?? [],
      caption: captionText((await c.read(p.captionPath)) ?? ""),
      location: p.location && !p.locationDropped ? p.location : null,
    },
  };
}

const platformName = (pr: Provider) => platform(pr.platform)?.name ?? pr.platform;

/** A run without progress: one poll more. The step is kept (it carries a provider's state between runs). */
async function pollWait(c: Ctx, job: JobRow, pr: Provider, p: Payload) {
  const attempts = job.attempts + 1;
  if (attempts > MAX_POLLS) {
    const name = platformName(pr);
    await c.setJob(job.id, { state: "failed", attempts, last_error: `${name} never finished processing`, payload: p });
    await c.note.send(N.processingTimeout(job.item_key, name), job.workspace_id);
  } else {
    await c.setJob(job.id, { attempts, payload: p });
  }
}

/** A comment under the live post, exactly as approved: the text is read again and must still hash to the approval's
 *  (an agent can edit it between the post and this run); nothing goes out in dry run. Never fatal, the post is live:
 *  the note says what didn't happen, for the owner to do by hand. */
async function postComment(
  c: Ctx,
  job: JobRow,
  p: Payload,
  what: string,
  text: string | null,
  approvedSha: string | null,
) {
  if (!text && !approvedSha) return "";
  if ((text ? await sha256Hex(text) : null) !== approvedSha) return ` (the ${what} changed after approval: not posted)`;
  if (c.dry) return ` (dry run: ${what} not posted)`;
  try {
    await (await c.provider(p, job.workspace_id)).comment?.(p.mediaId!, text!);
    return "";
  } catch (e) {
    return ` (${what} failed: ${(e as Error).message}; post it by hand)`;
  }
}

async function stepPublished(c: Ctx, job: JobRow, p: Payload) {
  let firstNote = "";
  if (p.story) {
    p.commented = true;
    p.commented2 = true;
  } // Stories take no comments
  if (!p.commented) {
    const caption = captionText((await c.read(p.captionPath)) ?? "");
    const comment = commentText(caption, await c.read(p.commentPath));
    const note = await postComment(c, job, p, "self-comment", comment, p.approval?.commentSha256 ?? null);
    p.commented = true;
    firstNote = note;
    await c.setJob(job.id, { payload: p, last_error: note || null });
  }
  if (!p.commented2) {
    // the second comment, right after the first (only when it has text)
    const comment2 = p.comment2Path ? comment2Text(await c.read(p.comment2Path)) : null;
    const note = await postComment(c, job, p, "second comment", comment2, p.approval?.comment2Sha256 ?? null);
    p.commented2 = true;
    await c.setJob(job.id, { payload: p, ...(note ? { last_error: `${firstNote}${note}`.trim() } : {}) });
  }
  if (p.trial) {
    await c.env.DB.prepare(`INSERT INTO trial_posts (item_key, account, media_id, permalink, published_at, workspace_id)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6) ON CONFLICT (item_key) DO NOTHING`)
      .bind(
        job.item_key.replace(/^trial:/, ""),
        p.username ?? "",
        p.mediaId ?? null,
        p.permalink ?? null,
        p.publishedAt ?? c.nowS,
        job.workspace_id,
      )
      .run();
    await c.setJob(job.id, { state: "done" });
    await c.note.send(N.publishedTrial(job.item_key.replace(/^trial:/, ""), p.permalink ?? null), job.workspace_id);
    return;
  }
  await recordPosted(c.env.DB, {
    key: job.item_key,
    account: p.username ?? "",
    mediaId: p.mediaId ?? null,
    permalink: p.permalink ?? null,
    source: "scheduler",
    publishedAt: p.publishedAt ?? c.nowS,
    recordedAt: c.nowS,
    workspaceId: job.workspace_id,
  });
  await c.setJob(job.id, { state: "done" });
  if (p.reel && !p.story) {
    const item = await getItem(c.env.DB, job.item_key);
    if (item && (await trialFor(c.env.DB, item)).on) await queueTrial(c, job, p);
  }
  await c.note.send(
    N.published(job.item_key, p.permalink ?? null, { story: !!p.story, locationDropped: !!p.locationDropped }),
    job.workspace_id,
  );
}

// ---------------------------------------------------------------- Shorts comments

const ptDate = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(d);

/** Why a Shorts comment can't go out yet: no text, or no approval of exactly this text for this channel (the owner
 *  approves it in the app, like a post). Null when it may. */
async function shortsVerdict(r: ShortRow, channel: string, a: Approval | undefined): Promise<string | null> {
  const text = (r.text ?? "").trim();
  if (!text) return `no comment text in the scheduler: add one in the app or with \`bongsu texts set <key> --comment\``;
  if (!a || a.dueAt === null) return "not approved: approve the comment in the app";
  if (a.account !== channel) return `approved for ${a.account ?? "no account"}, listed for ${channel}: approve again`;
  if (a.captionSha256 !== (await sha256Hex(text))) return "the comment changed after approval: approve again";
  return null;
}

/** Comments on posts published outside Bongsu (the Shorts comments), for every account whose platform does that
 *  (Platform.features.commentOnExisting), through its provider. Each needs the owner's approval of its text, as a
 *  post does; one refused for the lack of it is taken up again once approved. */
async function shortsComments(c: Ctx) {
  let budget = 2; // comments per tick (each costs ~3 subrequests)
  const accounts = (await listAccounts(c.env.DB)).filter(
    (a) => platform(a.platform)?.features.commentOnExisting && !c.held.has(a.workspaceId),
  );
  for (const s of accounts) {
    if (budget <= 0) return;
    const pending = await pendingShorts(c.env.DB, s.id);
    if (!pending.length) continue;
    const keys = pending.map((r) => `comment:${r.video_id}`);
    const known = await c.env.DB.prepare(`SELECT item_key, state FROM jobs WHERE item_key IN ${jsonList(c.env.DB, 1)}`)
      .bind(JSON.stringify(keys))
      .all<{ item_key: string; state: string }>();
    const states = new Map(known.results.map((r) => [r.item_key, r.state]));
    const approvals = await latestApprovals(c.env.DB, keys);
    // new ones, and refused ones whose approval has arrived since
    const todo: { r: ShortRow; why: string | null }[] = [];
    for (const r of pending) {
      const state = states.get(`comment:${r.video_id}`);
      const why = await shortsVerdict(r, s.id, approvals.get(`comment:${r.video_id}`));
      if (state === undefined || (state === "refused" && why === null)) todo.push({ r, why });
    }
    if (!todo.length) continue;
    const pr = await providerFor(c.env, c.deps.fetch, s);
    if (!pr?.comment) {
      await c.note.send(N.shortsWaiting(s.handle, s.id), s.workspaceId);
      continue;
    }
    const ready = todo.filter((t) => t.why === null).map((t) => t.r.video_id);
    const visible = pr.isPublic && ready.length ? await pr.isPublic(ready) : null;
    for (const { r, why } of todo) {
      if (budget <= 0) return;
      if (why === null && visible && !visible.has(r.video_id)) continue; // not public yet (or gone): try again later
      const key = `comment:${r.video_id}`;
      const label = r.label ?? "";
      const text = (r.text ?? "").trim();
      const payload: Payload = {
        queueDir: "",
        workspaceId: s.workspaceId,
        account: s.id,
        igUserId: "",
        postedKey: r.video_id,
        location: "",
        captionPath: "",
        commentPath: "",
        video: r.video_id,
        file: r.file,
        label,
        connectionId: s.connection?.id,
      };
      // a refused job (no approval yet) comes back as pending once the approval is there
      const ins = await c.env.DB.prepare(
        `INSERT INTO jobs (item_key, kind, account, due_at, state, dry_run, payload, created_at, updated_at, workspace_id)
         VALUES (?1, 'comment', ?2, ?3, 'pending', ?4, ?5, ?3, ?3, ?6) ON CONFLICT (item_key) DO UPDATE
         SET state = 'pending', last_error = NULL, attempts = 0, dry_run = excluded.dry_run, payload = excluded.payload,
             updated_at = excluded.updated_at WHERE jobs.state = 'refused'
         RETURNING id`,
      )
        .bind(key, s.id, c.nowS, c.dry ? 1 : 0, JSON.stringify(payload), s.workspaceId)
        .first<{ id: number }>();
      if (!ins) continue;
      if (why !== null) {
        await c.setJob(ins.id, { state: "refused", last_error: why });
        await c.note.send(N.jobRefused(key, why), s.workspaceId);
        continue;
      }
      budget--;
      if (c.dry) {
        await c.setJob(ins.id, { state: "done", last_error: "dry run: nothing posted" });
        await c.note.send(N.dryRunComment(label || r.video_id, text.slice(0, 200), key), s.workspaceId);
        continue;
      }
      try {
        const thread = (await pr.comment(r.video_id, text)) || null;
        await recordCommented(c.env.DB, {
          video: r.video_id,
          channel: s.id,
          workspaceId: s.workspaceId,
          datePt: ptDate(c.deps.now),
          threadId: thread,
          label: r.label,
          source: "scheduler",
        });
        await c.setJob(ins.id, { state: "done" });
        await c.note.send(N.commented(label || r.video_id, key), s.workspaceId);
      } catch (e) {
        await c.setJob(ins.id, { state: "failed", last_error: String((e as Error).message).slice(0, 500) });
        await c.note.send(N.jobFailed(key, String((e as Error).message).slice(0, 300)), s.workspaceId);
      }
    }
  }
}
