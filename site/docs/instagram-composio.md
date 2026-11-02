# Instagram through Composio (instagram-composio)

The other way to post to Instagram: through a [Composio](https://composio.dev) connected account instead of
Instagram's own API with your token. Choose it if you already use Composio for your Instagram accounts; otherwise
[instagram-graph](instagram-graph.md) is simpler (no third party) and does more.

| | instagram-composio |
|---|---|
| Posts | Reels, photos, carousels, Stories, first and second comments, replies, 24 h results: the same as instagram-graph |
| Trial Reels | **only for Composio's default Instagram connection** (below) |
| Tokens | Composio's: nothing for Bongsu to renew |
| Needs | a Composio account, its consumer key, one connected account per Instagram account |

## 1. Connect the Instagram account in Composio

1. In Composio's dashboard, add the **Instagram** toolkit and connect your Instagram professional account (Business or
   Creator) through its login flow.
2. Note the connected account's id (it starts with `ca_`): the connection's `external_ref` below.
3. The account's Instagram user id (17 digits): Composio's `INSTAGRAM_GET_USER_INFO` tool shows it, or ask Instagram
   with any token for that account (see [instagram-graph.md](instagram-graph.md#or-paste-a-token)).

## 2. Give Bongsu the consumer key

Bongsu calls Composio's consumer endpoint with your consumer key (it starts with `ck_`, from your Composio account's
settings). It's one secret for the whole instance, on both Workers:

```sh
cd apps/cloudflare
pnpm exec wrangler secret put COMPOSIO_CONSUMER_KEY
pnpm exec wrangler secret put COMPOSIO_CONSUMER_KEY -c wrangler.cron.toml
```

## 3. The connection and the account

Dashboard → **Connections** → Instagram (through Composio) → **Paste the id**: the connected account's id (`ca_…`, on
Composio's dashboard). Bongsu asks Composio which Instagram account it posts as and creates that account (or finds
the one it has, by its Instagram user id). Only the id is stored: the login stays with Composio.

Or by hand:

```sql
INSERT INTO connections (id, workspace_id, provider, kind, label, external_ref, created_at, updated_at)
  VALUES ('c_youraccount', 'default', 'composio', 'composio', '@your_account', 'ca_…', unixepoch(), unixepoch());
INSERT INTO accounts (id, workspace_id, platform, handle, external_id, connection_id, capabilities, created_at, updated_at)
  VALUES ('your_account', 'default', 'instagram', 'your_account', '<Instagram user id>', 'c_youraccount', '{}',
          unixepoch(), unixepoch());
```

`/health` asks for `COMPOSIO_CONSUMER_KEY` as soon as a Composio connection exists.

## Trial Reels through Composio

Composio's Instagram tools don't take `trial_params`, so Bongsu sends a Trial Reel's container through Composio's
remote workbench, which can only use **Composio's default Instagram connection**. Before it posts, Bongsu checks that the
default connection is the account the Trial Reel is for and refuses otherwise. With several Instagram accounts, only
one can have Trial Reels this way; switch the others to [instagram-graph](instagram-graph.md) (each account can use
either way, and switching keeps its plan, approvals and history: point its `connection_id` at the new connection).

## Limits

The same as Instagram's API (100 API-published posts per 24 hours per account), plus Composio's own rate limits and
plan. Composio errors show in the job's note on the app's item page and in `GET /v1/jobs`.
