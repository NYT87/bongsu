# Platforms and providers

Bongsu publishes to Instagram and comments on YouTube today, but no social network is built into the scheduler. Each
one is two small pieces:

- a **platform** (`packages/core/src/platforms/<id>.ts`): what the network allows, as data;
- a **provider** (`packages/core/src/providers/<id>.ts`): one way to reach it (an official API, a third party like
  Composio), chosen per account by its connection.

The tick, the approval page, the agent API and the caption check read the platform's capabilities and call the
provider; none of them name a network. `apps/cloudflare/test/fakenet.test.ts` proves it: a made-up network with text
and image posts goes through the real API, approval page and tick without any change to them.

## How a post goes out

1. A planned item is a post to one account: its **format** (one of the platform's: `video`, `image`, `carousel`,
   `story`, `text`; or empty, decided by its media at approval), its texts (caption, first and second comment, alt
   texts), its media (references into the [media store](media-stores.md)) and its **options** (the platform's own
   choices, JSON).
2. The owner approves it with a passkey. The approval fingerprints the texts, the media and the time, whatever the
   network.
3. At its time the tick turns it into a job and asks the account's provider to publish, one step per cron run:
   - `start(post)`: create a container, begin an upload, or post at once. The post carries the format, caption, alt
     texts, options and, for each media file, a URL the network can fetch (a signed `/m/` link or the store's own).
   - `check(step)`: run by run until the network has processed it (`processing` → `ready`, or `failed`).
   - `finish(step)`: publish; returns the post's id, link and time.
   A network that posts in one call returns `ready` from `start`, and the tick publishes in the same run.
4. On the next run the first and second comments go out (when the platform has them) and the post is recorded.

The provider's step (`Step.data`) is kept with the job between runs, so a provider stores whatever it needs there
(container ids, an upload id).

## Adding a network

1. **The platform:** `platforms/<id>.ts`, registered in `platforms/index.ts`:

   ```ts
   export const mynet: Platform = {
     id: "mynet",
     name: "MyNet",
     formats: ["text", "image", "video"],
     limits: { mediaMax: 4, videoSecondsMax: 140, captionMax: 500 },
     features: { ...NO_FEATURES, firstComment: true, comments: true, insights: true },
     options: [{ key: "audience", type: "string", label: "Who sees it", maxLength: 20 }],
     lint: (caption) => (caption.length > 500 ? [{ check: "LENGTH", status: "FAIL", detail: `${caption.length}/500` }] : []),
     lintDefaults: NO_LINT,
   };
   ```

   - `formats`: what Bongsu can publish there (empty: it only comments on posts made elsewhere, as YouTube today).
   - `features`: first/second comment, alt text, location, cover frame, trial posts, reading comments, results,
     commenting on posts made elsewhere. The app shows a control only when the platform has its feature.
   - `options`: each platform-specific choice, with its type and limits; `plan_add` refuses unknown options and bad
     values.
   - `lint`: the caption check, given the rules to apply (`LintRules`: hashtag cap, fold length, language checks); a
     `FAIL` blocks approval. `lintDefaults` is where an account starts (`NO_LINT` when the check ignores them); an
     owner overrides fields per account in the dashboard ([configuration.md](../site/docs/configuration.md), "Caption rules").

2. **The provider:** `providers/<id>.ts`, a class implementing `Provider` (`providers/types.ts`): `start`, `check`,
   `finish` and `verify`, plus `comment`, `reply`, `comments`, `results` and `isPublic` when the network has them.
   Register its factory in `providers/index.ts` under the connection's `provider` value:

   ```ts
   registerProvider("mynet", async (env, fetcher, account) => {
     const token = await connectionSecret(env, account.connection);
     return token ? new MyNetProvider(token, account.externalId!, fetcher) : null;
   });
   ```

   Use only web-standard APIs (`fetch`, `crypto.subtle`): providers run on Workers and Node. Throw for errors worth
   retrying (the tick retries a step three times); return a `failed` step for a final refusal.

3. **The fake:** add the network's endpoints to `apps/cloudflare/test/world.ts` (as `graph.instagram.com` is there)
   and test the full tick against it, as `providers.test.ts` does for Instagram and `fakenet.test.ts` for a made-up
   network.

4. **The docs:** a page like [instagram-graph.md](../site/docs/instagram-graph.md): what to create on the network's side, which
   permissions, how the token is obtained and renewed, the limits, and anything that costs money or needs a review.

5. **Connections:** the account's `connections.provider` is your provider's value; `accounts.platform` your
   platform's id. Tokens go in `connections.credentials` (encrypted) or a secret named by `connections.secret_name`;
   renewals belong in the inbox cron next to Instagram's (`providers/refresh.ts`).

## Today's

| Platform | Formats | Providers |
|---|---|---|
| `instagram` | video (Reels), image, carousel, story | `instagram-graph` (Instagram's API, a token per account), `instagram-composio` |
| `youtube` | none yet: comments on videos published elsewhere (the Shorts comments) | `youtube-data` (Data API, OAuth per channel) |

Planned after v1 (roadmap, Phase 14): Threads, Bluesky, TikTok, X, LinkedIn, and YouTube uploads.
