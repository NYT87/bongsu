// A provider is one way to reach a platform (docs/PLAN.md 2.10): instagram-graph, instagram-composio, later x-api,
// tiktok-content… Publishing is a resumable state machine the tick drives one step per run, so a slow network never
// blocks a run: start (create a container, begin an upload, or post at once) → check (until ready) → finish (publish).
import type { YouTubeTexts } from "../formats/youtube-texts";
import type { Format } from "../platforms/types";
import type { YouTubeSettings } from "../platforms/youtube";

/** One media file of a post, at a URL the platform can fetch for a while (a signed /m/ link or the store's own). */
export interface OutgoingMedia {
  id: string;
  url: string;
  video: boolean;
  /** The file's name in its store (YouTube tells the video, subtitles and thumbnail apart by it). */
  name: string;
  /** The store's checksum, as approved (YouTube compares it to replace only what changed). */
  checksum: string;
}

/** A post as approved, ready to go out. */
export interface OutgoingPost {
  format: Format;
  caption: string;
  /** Alt texts, in order, for the images. */
  alts: string[];
  media: OutgoingMedia[];
  /** The platform's options for this post (platforms/<id>.ts OptionSpec), already validated. */
  options: Record<string, unknown>;
  /** A YouTube video's title, languages, tags and translations. */
  texts?: YouTubeTexts | null;
  /** A YouTube video's settings: the post's options over the channel's defaults. */
  settings?: YouTubeSettings;
}

/** What one scheduler run (one invocation) leaves for long transfers, shared by every job it advances, so uploads one
 *  after another never outlast the run's lock or its subrequests. */
export interface RunBudget {
  /** Aborts at the run's one deadline for transfers. */
  signal: AbortSignal;
  /** Subrequests the run can still spend. */
  requestsLeft(): number;
}

/** Where a publication stands; `data` is the provider's own and is stored with the job between runs. */
export interface Step {
  state: "processing" | "ready" | "failed";
  data: Record<string, unknown>;
  /** Why it failed (state failed). */
  error?: string;
}

export interface Published {
  mediaId: string;
  permalink: string | null;
  /** When it went live (unix seconds), as the platform reports it. */
  publishedAt: number | null;
}

export interface RemoteComment {
  id: string;
  text: string;
  author: string;
  /** The author's account id on the platform, when it says (to tell the account's own comments apart). */
  authorId?: string | null;
  /** ISO 8601. */
  at: string;
}

/** How an account gets connected through a provider (for the dashboard's Connect flows, Phase 4b, and the docs). */
export interface ConnectSpec {
  /** "token": a long-lived token pasted in; "oauth2": an authorization flow; "composio": a Composio connected account. */
  kind: "token" | "oauth2" | "composio";
  /** What the owner sees: "Instagram (Instagram Login)". */
  label: string;
  platform: string;
  /** The owner's OAuth app it uses (oauth_apps.id): "meta", "google". One app can serve several providers. */
  app?: string;
  authorizeUrl?: string;
  tokenUrl?: string;
  scopes?: string[];
  /** How the scopes are joined in the authorize URL (Instagram: ","; OAuth's default: " "). */
  scopeSeparator?: string;
  /** Sends a PKCE challenge (S256) with the authorization and the verifier with the code. */
  pkce?: boolean;
  /** Extra authorize parameters, e.g. Google's access_type=offline. */
  authorizeParams?: Record<string, string>;
  /** A long-lived token can be pasted instead (an app still in development, a token made elsewhere). */
  pasteToken?: boolean;
  /** The setup guide in docs/. */
  docs: string;
}

/** An account a grant reaches, as the platform describes it (the connect flow creates or updates its row). */
export interface DiscoveredAccount {
  platform: string;
  /** The username / channel handle (without "@"). */
  handle: string;
  displayName?: string | null;
  /** The platform's id for it (Instagram user id, YouTube channel id): how a reconnect finds the same row. */
  externalId: string;
  capabilities?: Record<string, unknown>;
}

/** What a finished connect flow gives: the credentials to store (encrypted), when they run out, a label for the
 *  connection and the accounts it reaches. */
export interface Grant {
  /** Null for a Composio connection (it's reached through its connected-account id, externalRef). */
  credentials: string | null;
  expiresAt?: number | null;
  label: string;
  externalRef?: string;
  accounts: DiscoveredAccount[];
}

/** The owner's OAuth app, decrypted, and where the provider sends the browser back. */
export interface OAuthContext {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

/** What keeping a connection alive returns: renewed credentials (stored encrypted) and when they run out. */
export interface KeptAlive {
  credentials?: string;
  expiresAt?: number;
}

/** A connection that can't work any more until the owner reconnects it (a revoked or expired grant). */
export class ConnectionBroken extends Error {}

/** What `Provider.discard` did with a step's leftover. */
export type Discarded = "gone" | "kept" | "failed";

export interface Provider {
  readonly id: string;
  /** The platform it reaches (platforms/index.ts). */
  readonly platform: string;
  /** A limitation worth telling the owner about Trial posts this way (null: none). */
  readonly trialNote?: string | null;
  /** `previous`: the job's earlier step, when it left something on the platform to revise (a private video). */
  start(post: OutgoingPost, previous?: Step): Promise<Step>;
  /** `run`: the tick's budget for the run, which a long step (an upload) spends from. */
  check(step: Step, run?: RunBudget): Promise<Step>;
  finish(step: Step): Promise<Published>;
  /** Removes what a step left on the platform and won't publish (an uploaded private video); best effort. "gone" when
   *  it is gone now, "kept" when it is public (published by hand: never deleted), "failed" otherwise. */
  discard?(step: Step): Promise<Discarded>;
  /** Optional features, present when the platform has them (Platform.features). */
  /** A comment as the account on a post; returns its id when the platform gives one. */
  comment?(mediaId: string, text: string): Promise<string | null | undefined | void>;
  reply?(commentId: string, text: string): Promise<void>;
  comments?(mediaId: string): Promise<RemoteComment[]>;
  results?(mediaId: string, metrics: string[]): Promise<Record<string, number | null>>;
  /** Which of these posts are publicly visible now (posts made elsewhere, e.g. a Short still private). */
  isPublic?(mediaIds: string[]): Promise<Set<string>>;
  /** Who the connection acts as. */
  verify(): Promise<{ id: string; username: string; followers: number | null }>;
}
