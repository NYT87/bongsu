// One registry for the agent API: each tool is exposed as an MCP tool and as a REST route, with the scope it needs.
import type { Scope } from "./auth";
import * as ops from "./ops";

export interface Tool {
  name: string;
  scope: Scope;
  description: string;
  inputSchema: Record<string, unknown>;
  run: (c: ops.OpCtx, args: Record<string, unknown>) => Promise<unknown>;
}

const obj = (props: Record<string, unknown> = {}, required: string[] = []) => ({
  type: "object",
  properties: props,
  required,
  additionalProperties: false,
});

const YOUTUBE_TEXTS = {
  type: ["object", "null"],
  description:
    "a YouTube video's own texts: title (1-100 characters; may be empty while editing, a person needs it at approval), language and audioLanguage (like en or pt-BR), tags (a list, at most 500 characters as YouTube counts them) and translations ({ es: { title, description } }). The description is the caption (at most 5000 characters). Replaces what was set; null clears it. Instagram has none.",
  properties: {
    title: { type: "string" },
    language: { type: "string" },
    audioLanguage: { type: "string" },
    tags: { type: "array", items: { type: "string" } },
    translations: {
      type: "object",
      additionalProperties: {
        type: "object",
        properties: { title: { type: "string" }, description: { type: "string" } },
        required: ["title"],
      },
    },
  },
} as const;

export const TOOLS: Tool[] = [
  {
    name: "get_status",
    scope: "read",
    description:
      "Scheduler state: dry-run or live, paused or not, today's date and your time zone (the workspace's), job counts of the last 7 days.",
    inputSchema: obj(),
    run: (c) => ops.status(c),
  },
  {
    name: "list_accounts",
    scope: "read",
    description:
      "The workspace's accounts: Instagram profiles (for plan_add and drafts) and YouTube channels (for shorts_add), with what each allows (e.g. Trial Reels) and whether it's connected.",
    inputSchema: obj(),
    run: (c) => ops.listAccountsOp(c),
  },
  {
    name: "list_queue",
    scope: "read",
    description:
      "Upcoming Instagram Reels and photo/carousel posts not posted yet, per account, with due time (due: your time zone; due_at: ISO 8601 UTC), hold and approval state.",
    inputSchema: obj({
      days: { type: "integer", minimum: 1, maximum: 120, description: "how far ahead (default 14)" },
      account: { type: "string", description: "an Instagram account id (list_accounts)" },
      channel: { type: "string", description: "the folder's first part (a content grouping, not an account)" },
      group: { type: "string", description: "project folder, e.g. 20260923_JAPAN" },
      from: { type: "string", description: "only items due on or after this date (YYYY-MM-DD, your time zone)" },
    }),
    run: (c, a) =>
      ops.queue(c, {
        days: a.days as number | undefined,
        account: a.account as string | undefined,
        channel: a.channel as string | undefined,
        group: a.group as string | undefined,
        from: a.from as string | undefined,
      }),
  },
  {
    name: "queue_groups",
    scope: "read",
    description: "The channels and project groups that have upcoming items, with counts (to filter list_queue).",
    inputSchema: obj({ days: { type: "integer", minimum: 1, maximum: 120 } }),
    run: (c, a) => ops.queueFacets(c, { days: a.days as number | undefined }),
  },
  {
    name: "get_item",
    scope: "read",
    description:
      'One queued item as it would be published: caption, self-comment, alt texts, approval and posted state. key: "reel:<project>/<base>" or "post:<project>/<post dir>".',
    inputSchema: obj({ key: { type: "string" } }, ["key"]),
    run: (c, a) => ops.item(c, String(a.key)),
  },
  {
    name: "get_metrics",
    scope: "read",
    description:
      "One post's or video's metrics series (key: a plan key, or video:<id>), with its 24 h numbers (results) and its Trial Reel copy's (trial). Lifetime counts as the platform reported them at at (unix seconds); with daily, each day's growth since the previous sampled day on your clock, null for a day without a sample (not 0). reach, saves and the follow metrics only where the platform reports them; a video's follows (subscribers gained) only for a channel connected with the analytics scope. Bongsu does no analysis: compare and rank from these numbers.",
    inputSchema: obj(
      {
        key: { type: "string" },
        daily: { type: "boolean", description: "each day's growth instead of the totals" },
        from: { type: "string", description: "YYYY-MM-DD, your time zone, inclusive" },
        to: { type: "string", description: "YYYY-MM-DD, your time zone, inclusive" },
        metrics: {
          type: "array",
          items: { type: "string", enum: [...ops.STAT_FIELDS] },
          description: "only these counts in each point",
        },
      },
      ["key"],
    ),
    run: (c, a) =>
      ops.agentItemMetrics(c, {
        key: String(a.key),
        daily: a.daily === true,
        from: a.from as string | undefined,
        to: a.to as string | undefined,
        metrics: a.metrics,
      }),
  },
  {
    name: "get_account_metrics",
    scope: "read",
    description:
      "An account's followers over time (Instagram followers, YouTube subscribers: YouTube rounds them above 1,000), sampled once a day, and the views its posts added per day. from/to default to the last 30 days. With daily, followers are each day's growth since the previous sampled day, null for a day without a sample.",
    inputSchema: obj(
      {
        account: { type: "string", description: "an account id (list_accounts)" },
        daily: { type: "boolean" },
        from: { type: "string", description: "YYYY-MM-DD, your time zone, inclusive" },
        to: { type: "string", description: "YYYY-MM-DD, your time zone, inclusive" },
      },
      ["account"],
    ),
    run: (c, a) =>
      ops.accountMetrics(c, {
        account: String(a.account),
        daily: a.daily === true,
        from: a.from as string | undefined,
        to: a.to as string | undefined,
      }),
  },
  {
    name: "list_performance",
    scope: "read",
    description:
      "The workspace's posts and videos published in a window (default the last 30 days), one row each with its latest lifetime totals (as of at), its 24 h views (views_24h) and the followers it brought (follows), sorted by one of them, highest first (rows without it last). A Trial Reel copy's row follows its Reel's. The one call to rank and compare posts; get_metrics then gives one post's series. Bongsu does no analysis.",
    inputSchema: obj({
      account: { type: "string", description: "an account id (list_accounts)" },
      platform: { type: "string", enum: ["instagram", "youtube"] },
      from: { type: "string", description: "published on or after (YYYY-MM-DD, your time zone)" },
      to: { type: "string", description: "published on or before (YYYY-MM-DD, your time zone)" },
      sort: {
        type: "string",
        enum: [
          "views",
          "reach",
          "likes",
          "comments",
          "saves",
          "shares",
          "follows",
          "profile_visits",
          "views_24h",
          "published_at",
        ],
      },
      limit: { type: "integer", minimum: 1, maximum: 200, description: "rows (default 50)" },
    }),
    run: (c, a) =>
      ops.performanceList(c, {
        account: a.account as string | undefined,
        platform: a.platform as string | undefined,
        from: a.from as string | undefined,
        to: a.to as string | undefined,
        sort: a.sort as string | undefined,
        limit: a.limit as number | undefined,
      }),
  },
  {
    name: "ingest_metrics",
    scope: "metrics",
    description:
      "Upload metrics samples collected outside Bongsu into the same series the sampler fills: posts by key (a plan key that went out, its trial: copy, or video:<id>) with lifetime counts at a time, accounts by id with their follower count. at: ISO 8601 with a zone, not in the future. At most 500 rows a call. Every row is checked first: one bad row writes nothing and the error names each problem. A sample already there (same key or account and time) is skipped, so a file can be sent again. Never touches the plan, texts or approvals.",
    inputSchema: obj({
      posts: {
        type: "array",
        items: {
          type: "object",
          properties: {
            key: { type: "string" },
            at: { type: "string" },
            ...Object.fromEntries(ops.STAT_FIELDS.map((f) => [f, { type: "integer", minimum: 0 }])),
          },
          required: ["key", "at"],
        },
      },
      accounts: {
        type: "array",
        items: {
          type: "object",
          properties: {
            account: { type: "string" },
            at: { type: "string" },
            followers: { type: "integer", minimum: 0 },
          },
          required: ["account", "at"],
        },
      },
    }),
    run: (c, a) => ops.ingestMetrics(c, a),
  },
  {
    name: "list_jobs",
    scope: "read",
    description: "What the scheduler did: its jobs (dry or live, state, error or permalink).",
    inputSchema: obj({ days: { type: "integer", minimum: 1, maximum: 90 } }),
    run: (c, a) => ops.jobs(c, { days: a.days as number | undefined }),
  },
  {
    name: "list_notifications",
    scope: "read",
    description: "The scheduler's latest notifications (published, refused, failed, would publish).",
    inputSchema: obj({ limit: { type: "integer", minimum: 1, maximum: 100 } }),
    run: (c, a) => ops.notifications(c, { limit: a.limit as number | undefined }),
  },
  {
    name: "list_drafts",
    scope: "read",
    description:
      "Drafts proposed by agents, waiting for a person to review them (status draft, or withdrawn/approved/refused).",
    inputSchema: obj({ status: { type: "string", enum: ["draft", "withdrawn", "approved", "refused"] } }),
    run: (c, a) => ops.listDrafts(c, { status: a.status as string | undefined }),
  },
  {
    name: "create_draft",
    scope: "draft",
    description:
      "Propose a Reel, photo, carousel, YouTube video (kind reel, with a YouTube channel: its title, translations and options in texts / options) or Shorts comment for a person to review. A draft is never published by itself: only a person with a passkey (an admin or creator of the workspace) approves.",
    inputSchema: obj(
      {
        kind: { type: "string", enum: ["reel", "photo", "carousel", "shorts_comment"] },
        account: {
          type: "string",
          description:
            "an account id from list_accounts: Instagram for reels and posts, YouTube for videos and Shorts comments",
        },
        title: { type: "string" },
        caption: { type: "string", description: "for a YouTube video: its description" },
        comment: { type: "string" },
        comment2: { type: "string", description: "a second comment, posted right after the first (optional)" },
        texts: YOUTUBE_TEXTS,
        options: {
          type: "object",
          description:
            "the platform's options for the post (YouTube: privacy, madeForKids, category; see list_accounts)",
        },
        date: { type: "string", description: "YYYY-MM-DD, in your time zone (get_status)" },
        time: { type: "string", description: "HH:MM, in your time zone" },
        location: { type: "string", description: "facebook_places_id" },
        folder: { type: "string", description: "project folder under channels/" },
        video_id: { type: "string", description: "YouTube video id (Shorts comments)" },
        media: {
          type: "array",
          items: { type: "string" },
          description: "file ids in the instance's media store (Google Drive by default), in slide order",
        },
        note: { type: "string" },
      },
      ["kind", "account"],
    ),
    run: (c, a) => ops.createDraft(c, a),
  },
  {
    name: "withdraw_draft",
    scope: "draft",
    description: "Withdraw an open draft of this workspace (any, not only the ones this key created).",
    inputSchema: obj({ id: { type: "string" } }, ["id"]),
    run: (c, a) => ops.withdrawDraft(c, String(a.id)),
  },
  {
    name: "plan_add",
    scope: "plan",
    description:
      "Add a post to the plan (not approved: a person approves it). format is one of the account's platform formats (list_accounts shows them; Instagram: video, image, carousel, story); leave it out for a post whose media decide (one image, several = carousel, one video). The older kind (reel / post) still works. Pass its texts (caption, comment, comment2, alt; for a YouTube channel also texts: title, translations, tags) to put them straight into the scheduler, which posts only its own copy; without them, a person adds them in the app or with bongsu texts set. One item per account per hour: a date/time in an hour the account already uses is refused (409); several a day at different hours are fine. folder: project under channels/ (vlogs/CONTENT/20260823_LISBON); name: the Reel's base or the post dir (posts/carousel3_green).",
    inputSchema: obj(
      {
        format: {
          type: "string",
          enum: ["video", "image", "carousel", "story", "text"],
          description:
            "one of the platform's formats; story = an Instagram Story (one image/video, no caption; takes no hour slot)",
        },
        options: {
          type: "object",
          description:
            "the platform's options for this post (list_accounts shows them; Instagram: location, coverMs, trial)",
        },
        kind: {
          type: "string",
          enum: ["reel", "post"],
          description: "older form: reel = a video, post = by its media",
        },
        account: { type: "string" },
        folder: { type: "string" },
        name: { type: "string" },
        at: {
          type: ["string", "null"],
          description: "when, as ISO 8601 with Z or an offset (2026-11-01T09:00:00Z); or use date/time",
        },
        date: {
          type: ["string", "null"],
          description: "YYYY-MM-DD in your time zone (get_status), null = unscheduled",
        },
        time: {
          type: ["string", "null"],
          description: "HH:MM in your time zone, null = default (Reels 18:00, posts 19:00)",
        },
        location: { type: "string", description: "older form of options.location" },
        hold: { type: "boolean" },
        note: { type: "string" },
        caption: {
          type: ["string", "null"],
          description:
            "the caption exactly as posted (the scheduler posts its own copy of the texts, not the repo files)",
        },
        comment: { type: ["string", "null"], description: "our first comment; empty = the caption's question line" },
        comment2: { type: ["string", "null"], description: "the optional second comment" },
        alt: { type: ["string", "null"], description: "posts only: one alt text per image, a line each" },
        texts: YOUTUBE_TEXTS,
      },
      ["account", "folder", "name"],
    ),
    run: (c, a) => ops.planAdd(c, a),
  },
  {
    name: "plan_update",
    scope: "plan",
    description:
      "Reschedule, hold/unhold, change the options (location…) or note, or set the texts (caption, comment, comment2, alt, and for a YouTube video texts: the copy the scheduler posts) of a planned item. Moving an approved item, or changing an approved text, makes it need a new approval. Moving it into an hour the account already uses is refused (one item per account per hour).",
    inputSchema: obj(
      {
        key: { type: "string" },
        at: { type: ["string", "null"], description: "ISO 8601 with Z or an offset; or use date/time" },
        date: {
          type: ["string", "null"],
          description: "YYYY-MM-DD in your time zone; null = unschedule; alone keeps the time",
        },
        time: { type: ["string", "null"], description: "HH:MM in your time zone; alone keeps the date" },
        hold: { type: "boolean" },
        options: {
          type: "object",
          description: "options to change (null removes one); the platform's, see list_accounts",
        },
        location: { type: ["string", "null"], description: "older form of options.location" },
        note: { type: ["string", "null"] },
        caption: {
          type: ["string", "null"],
          description:
            "the caption exactly as posted (the scheduler posts its own copy of the texts, not the repo files)",
        },
        comment: { type: ["string", "null"], description: "our first comment; empty = the caption's question line" },
        comment2: { type: ["string", "null"], description: "the optional second comment" },
        alt: { type: ["string", "null"], description: "posts only: one alt text per image, a line each" },
        texts: YOUTUBE_TEXTS,
      },
      ["key"],
    ),
    run: (c, a) => ops.planUpdate(c, a),
  },
  {
    name: "plan_remove",
    scope: "plan",
    description: "Remove a planned item that hasn't been published.",
    inputSchema: obj({ key: { type: "string" } }, ["key"]),
    run: (c, a) => ops.planRemove(c, String(a.key)),
  },
  {
    name: "record_posted",
    scope: "plan",
    description: "Record an item that was posted by hand, so the scheduler never publishes it again.",
    inputSchema: obj(
      {
        key: { type: "string" },
        account: { type: "string" },
        date: { type: "string" },
        media_id: { type: "string" },
        permalink: { type: "string" },
        published_at: {
          type: "string",
          description: "when it went live: Instagram's timestamp (ISO 8601); defaults to now for today's date",
        },
      },
      ["key"],
    ),
    run: (c, a) => ops.recordManualPost(c, a),
  },
  {
    name: "shorts_add",
    scope: "plan",
    description:
      "Add a YouTube Short to the comment list: the scheduler comments with `text` once the Short is public. `file` optionally names where the comment's text came from (kept for reference).",
    inputSchema: obj(
      {
        video_id: { type: "string" },
        channel: { type: "string", description: "the YouTube account id (list_accounts)" },
        file: { type: "string" },
        label: { type: "string" },
        text: { type: "string", description: "the comment exactly as posted" },
      },
      ["video_id", "channel"],
    ),
    run: (c, a) => ops.shortsAdd(c, a),
  },
  {
    name: "record_commented",
    scope: "plan",
    description: "Record a Shorts comment posted by hand, so the scheduler doesn't comment again.",
    inputSchema: obj({ video_id: { type: "string" }, thread_id: { type: "string" }, date_pt: { type: "string" } }, [
      "video_id",
    ]),
    run: (c, a) => ops.recordManualComment(c, a),
  },
  {
    name: "youtube_reschedule",
    scope: "reschedule",
    description:
      "Move a scheduled (private, with a release time) YouTube video's release to a later time, at least 1 hour ahead. Never makes a video public now. A video Bongsu uploads (a plan item) also needs the plan scope, and its move voids the approval.",
    inputSchema: obj(
      {
        video: { type: "string" },
        at: { type: "string", description: "ISO 8601 with zone" },
        date: { type: "string" },
        time: { type: "string" },
      },
      ["video"],
    ),
    run: (c, a) => ops.youtubeReschedule(c, a),
  },
  {
    name: "pause_scheduler",
    scope: "pause",
    description:
      "Stop publishing in this workspace now (other workspaces go on). Only a person can resume, in the app.",
    inputSchema: obj({ reason: { type: "string" } }, ["reason"]),
    run: (c, a) => ops.pause(c, String(a.reason)),
  },
];

export const toolByName = new Map(TOOLS.map((t) => [t.name, t]));
