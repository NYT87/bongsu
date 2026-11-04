# Connect Claude

Claude, or any other MCP client, can plan your posts, write their captions and propose drafts through Bongsu. It can't
approve or publish anything: you approve each post with your passkey, as always.

## 1. Create a key

In the dashboard, open **Keys & tokens** → **Agent keys** → **Create a key** (see [The dashboard](the-dashboard.md#keys--tokens)).
Name it after the agent or machine that will use it, and tick its scopes. Start with `read`, `draft` and `plan`:
that is enough to look at the queue, propose drafts and plan posts. `pause` and `reschedule` can wait until you need
them. The key looks like `bongsu_…` and is shown once, so copy it into the agent's secret store right away.

## 2. Add Bongsu to Claude Code

```sh
claude mcp add --transport http bongsu https://<your instance>/mcp --header "Authorization: Bearer bongsu_…"
```

`<your instance>` is the address of your Bongsu, the one you open the app on. Keep the key out of your shell history
if you can, for example by putting it in an environment variable first and writing `Bearer $KEY`.

## 3. Ask it to look around

Start with a question that only reads:

> Use Bongsu to list my accounts and tell me what is planned this week.

Claude calls `get_status` (today's date, your time zone, whether publishing is paused) and `list_accounts` (the
Instagram accounts and YouTube channels, and what each allows), then `list_queue`. If it answers with your own
accounts and posts, the connection works.

## 4. Plan something

> Add a Reel for demo_travel next Friday at 18:00 with this caption: ...

Claude uses `plan_add`. The post appears in your queue, **not approved**. In the phone app it shows under **Needs you**
with the approve bar ([The phone app](the-app.md#approving)): read the texts, check the media, approve with your
passkey. Until then nothing goes out. If Claude changes the caption afterwards, the post needs your approval again
(see [What agents can do](what-agents-can-do.md#why-a-change-needs-a-new-approval)).

Reading the first answers also tells Claude the rules: an account can't have two posts in the same hour (it gets the
free hours back), and `format` and `options` must fit the account's platform.

## If it doesn't work

- **401:** the key is wrong, revoked or has a typo. Make a new one.
- **A tool is missing:** the key lacks its scope. Claude only sees the tools its key allows, and a call without the scope is
  refused ("this key lacks the ... scope"; 403 over REST). Make a key that has it.
- **403 or a refusal on approve or resume:** by design. Do those in the app.
- **429:** the key made more than 60 requests in a minute. Wait a moment.

## Other MCP clients

Bongsu's MCP endpoint is `POST /mcp` on your instance, streamable HTTP without sessions, with the same
`Authorization: Bearer bongsu_…` header. Any client that supports remote HTTP servers can use it with the same URL and
header.

For a client that only speaks stdio, the `bongsu` command bridges to `/mcp` with your own CLI token:

```sh
npx bongsu login --url https://<your instance>
claude mcp add bongsu -- npx -y bongsu mcp
```

The CLI is [`bongsu` on npm](https://www.npmjs.com/package/bongsu); see [the CLI](cli.md#install) to run it from a
checkout instead.

A CLI token acts as you, so the bridge has your rights, not an agent key's: see [The command line](cli.md#mcp). Use an
agent key for agents, and keep the bridge for yourself.

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
