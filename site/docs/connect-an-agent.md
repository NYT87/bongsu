# Connect an agent

An AI agent can plan your posts, write their captions and propose drafts through Bongsu: Claude, Codex, or any other
client that speaks MCP, and anything that can call a REST API. It can't approve or publish anything: you approve each
post with your passkey, as always. Bongsu enforces that on the server, whatever the agent.

## 1. Create a key

In the dashboard, open **Keys & tokens** → **Agent keys** → **Create a key** (see [The dashboard](the-dashboard.md#keys--tokens)).
Name it after the agent or machine that will use it, and tick its scopes. Start with `read`, `draft` and `plan`:
that is enough to look at the queue, propose drafts and plan posts. `pause` and `reschedule` can wait until you need
them. The key looks like `bongsu_…` and is shown once, so copy it into the agent's secret store right away.

`<your instance>` below is the address of your Bongsu, the one you open the app on. Keep the key out of your shell
history: put it in an environment variable (here `BONGSU_KEY`, set in your shell profile or the agent's secret store)
and refer to that.

## 2. Add Bongsu to your agent

### Claude Code

```sh
claude mcp add --transport http bongsu https://<your instance>/mcp --header "Authorization: Bearer $BONGSU_KEY"
```

### Codex

```sh
codex mcp add bongsu --url https://<your instance>/mcp --bearer-token-env-var BONGSU_KEY
```

Codex keeps the variable's name, not the key, and reads it each time it starts, so `BONGSU_KEY` must be set wherever
Codex runs. The same in `~/.codex/config.toml` (or a trusted project's `.codex/config.toml`):

```toml
[mcp_servers.bongsu]
url = "https://<your instance>/mcp"
bearer_token_env_var = "BONGSU_KEY"
```

### Any other MCP client

Bongsu's MCP endpoint is `POST /mcp` on your instance: streamable HTTP without sessions, with the header
`Authorization: Bearer bongsu_…`. Any client that can add a remote HTTP server with a header (or a bearer token) uses
that URL and that header.

A client that only starts local commands (stdio) can use the `bongsu` command as a bridge to `/mcp`, with your own CLI
token instead of an agent key:

```sh
npx bongsu login --url https://<your instance>
claude mcp add bongsu -- npx -y bongsu mcp      # Claude Code
codex mcp add bongsu -- npx -y bongsu mcp       # Codex
```

Other clients take the same command (`npx -y bongsu mcp`) in their own configuration. The CLI is
[`bongsu` on npm](https://www.npmjs.com/package/bongsu); see [the CLI](cli.md#install) to run it from a checkout
instead. A CLI token acts as you, so the bridge has your rights, not an agent key's: see
[The command line](cli.md#mcp). Use an agent key for agents, and keep the bridge for yourself.

A client that connects only by signing in with OAuth, with no way to send a header, can't use an agent key yet.

### Without MCP: the REST API

Everything the MCP tools do is also at `/v1/…` on your instance, with the same `Authorization: Bearer bongsu_…`
header and the same scopes: for scripts, your own agents and automation tools. The endpoints are in the
[API reference](api-reference.md#tools-and-rest-endpoints).

## 3. Ask it to look around

Start with a question that only reads:

> Use Bongsu to list my accounts and tell me what is planned this week.

The agent calls `get_status` (today's date, your time zone, whether publishing is paused) and `list_accounts` (the
Instagram accounts and YouTube channels, and what each allows), then `list_queue`. If it answers with your own
accounts and posts, the connection works.

## 4. Plan something

> Add a Reel for demo_travel next Friday at 18:00 with this caption: ...

The agent uses `plan_add`. The post appears in your queue, **not approved**. In the phone app it shows under **Needs
you** with the approve bar ([The phone app](the-app.md#approving)): read the texts, check the media, approve with your
passkey. Until then nothing goes out. If the agent changes the caption afterwards, the post needs your approval again
(see [What agents can do](what-agents-can-do.md#why-a-change-needs-a-new-approval)).

Reading the first answers also tells the agent the rules: an account can't have two posts in the same hour (it gets the
free hours back), and `format` and `options` must fit the account's platform.

## If it doesn't work

- **401:** the key is wrong, revoked or has a typo, or (Codex) `BONGSU_KEY` isn't set where Codex runs. Make a new
  key if it's the key.
- **A tool is missing:** the key lacks its scope. The agent only sees the tools its key allows, and a call without the
  scope is refused ("this key lacks the ... scope"; 403 over REST). Make a key that has it.
- **403 or a refusal on approve or resume:** by design. Do those in the app.
- **429:** the key made more than 60 requests in a minute. Wait a moment.

## What Bongsu tells the agent

When a client connects, Bongsu sends it instructions: start with `list_accounts` and `get_status`, dates and times are
in the workspace's zone and stored in UTC, every post needs a person's approval, and approving and resuming are for
people with a passkey (admins and creators), never an agent. A client shows or uses them as it likes, so it is still
worth saying in your own prompt what you want.

## Good habits

- One key per agent or machine, named after it, so the Audit page and each key's last use tell you who did what.
- Give a key only the scopes it needs, and revoke the ones you stopped using.
- Review every post in the app before you approve it: the agent's work is a proposal, and the approval is yours.

## Taking access away

**Revoke** the key in **Keys & tokens**: it stops working at once. The tools, scopes and REST endpoints are in the
[API reference](api-reference.md).
