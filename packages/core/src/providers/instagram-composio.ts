// Instagram through Composio (a connected account per Instagram login): the scheduler's original way, kept for people
// who already use Composio. A Trial Reel needs trial_params, which Composio's tools don't take, so it goes through the
// raw Graph call in Composio's workbench, which only reaches the default Instagram connection (clients/composio.ts).
import { Composio, ComposioError, idOf } from "../clients/composio";
import { type ContainerParams, type IgComment, type InstagramApi, InstagramError } from "./instagram";
import { TRIAL_MIN_FOLLOWERS } from "./instagram-graph";
import type { Grant } from "./types";

export class ComposioInstagram implements InstagramApi {
  readonly id = "instagram-composio";
  readonly trialNote = "Trial Reels through Composio only work for its default Instagram connection";
  private c: Composio;

  constructor(
    key: string,
    private account: string,
    private igUserId: string,
    fetcher: typeof fetch,
  ) {
    this.c = new Composio(key, fetcher);
  }

  private async exec<T = Record<string, unknown>>(slug: string, args: Record<string, unknown>): Promise<T> {
    try {
      return await this.c.exec<T>(slug, args, this.account);
    } catch (e) {
      throw e instanceof ComposioError ? new InstagramError(e.message) : e;
    }
  }

  async createContainer(p: ContainerParams) {
    let box: Record<string, unknown>;
    if (p.trial_params) {
      try {
        box = await this.c.instagramRaw(this.igUserId, "POST", `${this.igUserId}/media`, { ...p });
      } catch (e) {
        throw e instanceof ComposioError ? new InstagramError(e.message) : e;
      }
    } else box = await this.exec("INSTAGRAM_POST_IG_USER_MEDIA", { ig_user_id: this.igUserId, ...p });
    const id = idOf(box);
    if (!id) throw new InstagramError(`no container id: ${JSON.stringify(box).slice(0, 200)}`);
    return id;
  }

  async status(containerId: string) {
    const d = await this.exec<{ status_code?: string }>("INSTAGRAM_GET_IG_MEDIA", {
      ig_media_id: containerId,
      fields: "status_code",
    });
    return d.status_code ?? "UNKNOWN";
  }

  async publish(containerId: string) {
    const pub = await this.exec("INSTAGRAM_POST_IG_USER_MEDIA_PUBLISH", {
      ig_user_id: this.igUserId,
      creation_id: containerId,
      max_wait_seconds: 60,
      poll_interval_seconds: 10,
    });
    const id = idOf(pub);
    if (!id) throw new Error(`publish returned no media id: ${JSON.stringify(pub).slice(0, 200)}`);
    return id;
  }

  media(mediaId: string) {
    return this.exec<{ permalink?: string; timestamp?: string }>("INSTAGRAM_GET_IG_MEDIA", {
      ig_media_id: mediaId,
      fields: "id,permalink,timestamp",
    });
  }

  async comment(mediaId: string, text: string) {
    await this.exec("INSTAGRAM_POST_IG_MEDIA_COMMENTS", { ig_media_id: mediaId, message: text });
  }

  async reply(commentId: string, text: string) {
    await this.exec("INSTAGRAM_POST_IG_COMMENT_REPLIES", { ig_comment_id: commentId, message: text });
  }

  async comments(mediaId: string): Promise<IgComment[]> {
    const d = await this.exec<{ data?: IgComment[] }>("INSTAGRAM_GET_IG_MEDIA_COMMENTS", {
      ig_media_id: mediaId,
      fields: "id,text,username,timestamp",
    });
    return d.data ?? [];
  }

  async insights(mediaId: string, metrics: string[]) {
    const d = await this.exec<{ data?: { name: string; values?: { value: number }[] }[] }>(
      "INSTAGRAM_GET_IG_MEDIA_INSIGHTS",
      { ig_media_id: mediaId, metric: metrics },
    );
    return Object.fromEntries((d.data ?? []).map((x) => [x.name, x.values?.[0]?.value ?? null]));
  }

  async verify() {
    const d = await this.exec<{ id?: string; username?: string; followers_count?: number }>("INSTAGRAM_GET_USER_INFO", {
      ig_user_id: this.igUserId,
      fields: "id,username,followers_count",
    });
    return { id: d.id ?? this.igUserId, username: d.username ?? "", followers: d.followers_count ?? null };
  }
}

/** A Composio connected account as a connection's grant: who it posts as (only its id is stored, no credentials). */
export async function composioGrant(
  key: string,
  connectedAccount: string,
  fetcher: typeof fetch,
  igUserId = "me",
): Promise<Grant> {
  const me = await new ComposioInstagram(key, connectedAccount, igUserId, fetcher).verify();
  if (!me.id || me.id === "me" || !me.username)
    throw new InstagramError("Composio didn't say which Instagram account this connection is for");
  return {
    credentials: null,
    externalRef: connectedAccount,
    label: `@${me.username} (Composio)`,
    accounts: [
      {
        platform: "instagram",
        handle: me.username,
        externalId: me.id,
        capabilities: { trialReels: (me.followers ?? 0) >= TRIAL_MIN_FOLLOWERS },
      },
    ],
  };
}
