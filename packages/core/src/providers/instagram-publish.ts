// Instagram as a Provider: its publishing steps (containers → status → publish) on top of either way to reach it
// (InstagramApi: instagram-graph or instagram-composio). Everything Instagram-specific about publishing lives here:
// Reels, photos, carousels (items, then the parent once they're processed), Stories, Trial Reels, cover frames, and a
// location dropped rather than losing the post when Instagram refuses it.
import { igTime } from "../data";
import { type ContainerParams, type InstagramApi, InstagramError } from "./instagram";
import type { OutgoingPost, Provider, Published, Step } from "./types";

const failed = (s: string) => s === "ERROR" || s === "EXPIRED";

export class InstagramProvider implements Provider {
  readonly platform = "instagram";
  readonly id: string;
  readonly trialNote: string | null;

  constructor(private ig: InstagramApi) {
    this.id = ig.id;
    this.trialNote = ig.trialNote;
  }

  /** A container with the post's location; without it when Instagram won't take that place (as ig.py does). */
  private async withLocation(p: ContainerParams, location: unknown, data: Record<string, unknown>) {
    if (typeof location !== "string" || !location) return this.ig.createContainer(p);
    try {
      return await this.ig.createContainer({ ...p, location_id: location });
    } catch (e) {
      if (!(e instanceof InstagramError)) throw e;
      data.locationDropped = true;
      return this.ig.createContainer(p);
    }
  }

  async start(post: OutgoingPost): Promise<Step> {
    const o = post.options;
    const data: Record<string, unknown> = {};
    const [first] = post.media;
    if (post.format === "story") {
      // a Story: one image or video, no caption; Instagram takes no location on it
      data.container = await this.ig.createContainer({
        media_type: "STORIES",
        ...(first.video ? { video_url: first.url } : { image_url: first.url }),
      });
    } else if (post.format === "video") {
      const reel: ContainerParams = {
        media_type: "REELS",
        video_url: first.url,
        caption: post.caption,
        share_to_feed: true,
        thumb_offset: typeof o.coverMs === "number" ? o.coverMs : 500,
        ...(o.trial === true ? { trial_params: { graduation_strategy: "SS_PERFORMANCE" as const } } : {}),
      };
      data.container = await this.withLocation(reel, o.location, data);
    } else if (post.format === "image") {
      const photo: ContainerParams = {
        image_url: first.url,
        caption: post.caption,
        ...(post.alts[0] ? { alt_text: post.alts[0] } : {}),
      };
      data.container = await this.withLocation(photo, o.location, data);
    } else if (post.format === "carousel") {
      // the items now; the parent once every item is processed (check). Alt texts go, in order, to the images.
      const children: string[] = [];
      let alt = 0;
      for (const m of post.media) {
        const item: ContainerParams = {
          is_carousel_item: true,
          ...(m.video ? { video_url: m.url } : { image_url: m.url }),
        };
        if (!m.video && post.alts[alt]) item.alt_text = post.alts[alt];
        if (!m.video) alt++;
        children.push(await this.ig.createContainer(item));
      }
      Object.assign(data, { children, caption: post.caption, location: o.location ?? null });
    } else throw new Error(`Instagram can't publish a ${post.format}`);
    return { state: "processing", data };
  }

  async check(step: Step): Promise<Step> {
    const d = step.data;
    if (Array.isArray(d.children) && !d.container) {
      const states = await Promise.all((d.children as string[]).map((id) => this.ig.status(id)));
      if (states.some(failed)) return { ...step, state: "failed", error: `carousel item failed: ${states.join(",")}` };
      if (!states.every((s) => s === "FINISHED")) return step;
      const parent: ContainerParams = {
        media_type: "CAROUSEL",
        children: d.children as string[],
        caption: String(d.caption ?? ""),
      };
      const loc = d.locationDropped ? null : d.location;
      return { state: "processing", data: { ...d, container: await this.withLocation(parent, loc, d) } };
    }
    const s = await this.ig.status(String(d.container));
    if (failed(s)) return { ...step, state: "failed", error: `container ${s}` };
    return s === "FINISHED" ? { ...step, state: "ready" } : step;
  }

  /** Publishes the container. The post is live once Instagram answers with its media id: the permalink and timestamp
   *  are a second call whose failure must not lose that id (the job would publish again). */
  async finish(step: Step): Promise<Published> {
    const mediaId = await this.ig.publish(String(step.data.container));
    try {
      const got = await this.ig.media(mediaId);
      return { mediaId, permalink: got.permalink ?? null, publishedAt: igTime(got.timestamp) };
    } catch {
      return { mediaId, permalink: null, publishedAt: null };
    }
  }

  comment(mediaId: string, text: string) {
    return this.ig.comment(mediaId, text);
  }
  reply(commentId: string, text: string) {
    return this.ig.reply(commentId, text);
  }
  async comments(mediaId: string) {
    return (await this.ig.comments(mediaId)).map((c) => ({
      id: c.id,
      text: c.text,
      author: c.username,
      at: c.timestamp,
    }));
  }
  results(mediaId: string, metrics: string[]) {
    return this.ig.insights(mediaId, metrics);
  }
  verify() {
    return this.ig.verify();
  }
}
