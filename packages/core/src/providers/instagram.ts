// What the scheduler asks of Instagram, whichever way an account is connected (docs/PLAN.md 2.3):
//   instagram-graph     the Instagram API with Instagram Login, called directly with the account's own token
//   instagram-composio  the same calls through a Composio connected account
// The tick, the comments inbox and the 24 h results only use this interface; instagramFor picks the implementation
// from the account's connection.
import { type Account, composioRef, connectionSecret } from "../accounts";
import type { Env } from "../env";
import { ComposioInstagram } from "./instagram-composio";
import { GraphInstagram, graphToken } from "./instagram-graph";

/** Instagram (or the way to it) refused a call. The tick retries a container without its location on one. */
export class InstagramError extends Error {}

/** A media container, as Instagram's POST /<ig user>/media takes it. */
export interface ContainerParams {
  media_type?: "REELS" | "STORIES" | "CAROUSEL";
  image_url?: string;
  video_url?: string;
  caption?: string;
  location_id?: string;
  alt_text?: string;
  is_carousel_item?: boolean;
  children?: string[];
  share_to_feed?: boolean;
  thumb_offset?: number;
  /** A Trial Reel: shown to non-followers first. */
  trial_params?: { graduation_strategy: "MANUAL" | "SS_PERFORMANCE" };
}

export interface IgComment {
  id: string;
  text: string;
  username: string;
  timestamp: string;
}

export interface InstagramApi {
  readonly id: "instagram-graph" | "instagram-composio";
  /** Whether a Trial Reel can go out this way (Composio: only for its default Instagram connection). */
  readonly trialNote: string | null;
  /** Creates a container; returns its id. */
  createContainer(p: ContainerParams): Promise<string>;
  /** IN_PROGRESS, FINISHED, ERROR, EXPIRED, PUBLISHED. */
  status(containerId: string): Promise<string>;
  /** Publishes a FINISHED container; returns the media id. */
  publish(containerId: string): Promise<string>;
  media(mediaId: string): Promise<{ permalink?: string; timestamp?: string }>;
  comment(mediaId: string, text: string): Promise<void>;
  reply(commentId: string, text: string): Promise<void>;
  comments(mediaId: string): Promise<IgComment[]>;
  /** metric name → value (views, reach, likes, comments, saved, shares). */
  insights(mediaId: string, metrics: string[]): Promise<Record<string, number | null>>;
  /** Who the connection posts as. */
  verify(): Promise<{ id: string; username: string; followers: number | null }>;
}

/** The way to post for an Instagram account, or null when it isn't connected (no connection, no user id). */
export async function instagramFor(env: Env, fetcher: typeof fetch, a: Account): Promise<InstagramApi | null> {
  if (!a.externalId || !a.connection || a.connection.status === "broken") return null;
  if (a.connection.provider === "instagram") {
    const token = graphToken(await connectionSecret(env, a.connection));
    return token ? new GraphInstagram(token, a.externalId, fetcher) : null;
  }
  const ref = composioRef(a);
  return ref && env.COMPOSIO_CONSUMER_KEY
    ? new ComposioInstagram(env.COMPOSIO_CONSUMER_KEY, ref, a.externalId, fetcher)
    : null;
}
