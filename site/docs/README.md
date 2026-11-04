# Bongsu guides

Guides for people who run Bongsu: install it, connect your accounts, use it, give agents access.

| Page | What it covers |
|---|---|
| **Get started** | |
| [What is Bongsu](what-is-bongsu.md) | What Bongsu does and the main ideas: plan items, approval, drafts, comments |
| [How it works](how-it-works.md) | Approval, the schedule, how a post goes out, drafts, notifications, results |
| **Install** | |
| [Deploy on Cloudflare](deploy-cloudflare.md) | From an empty Cloudflare account to a running instance |
| [Self-hosting with Docker](self-hosting.md) | One container on your own server: settings, HTTPS with Caddy, email, updates, backups |
| **Connect your accounts** | |
| [Instagram](instagram-graph.md) | Creating the Meta app, the token, connecting an account, renewals |
| [Instagram through Composio](instagram-composio.md) | The other way to post to Instagram, and its Trial Reels limit |
| [YouTube](youtube.md) | The OAuth client and refresh token per channel, for the Shorts comments |
| [Google Drive](drive.md) | Connecting your Drive as a media store, the folders, uploads from the app |
| [S3-compatible buckets](s3.md) | AWS S3, R2, B2 or MinIO as a media store: the key, the CORS rule, the folders |
| **Use Bongsu** | |
| [The phone app](the-app.md) | Installing it, Today, approving, holding, pausing, notifications, comments |
| [Captions and checks](captions-and-checks.md) | The texts of a post, what the caption check catches, what blocks approval |
| [The dashboard](the-dashboard.md) | Connections, accounts, devices and passkeys, keys and tokens, settings |
| **Agents** | |
| [Connect Claude](connect-claude.md) | Create a key, add Bongsu to Claude Code, a first plan, other MCP clients |
| [What agents can do](what-agents-can-do.md) | Scopes, what an agent never does, why a change needs approval, times, limits |
| [API reference](api-reference.md) | Keys and scopes, MCP, the tools and REST endpoints |
| [The command line](cli.md) | The `bongsu` command: login, queue, texts, approve, export, MCP bridge, secrets |
| **Reference** | |
| [Configuration](configuration.md) | Accounts, variables, secrets, tunable limits |
| [Security](security.md) | Passkeys, approvals, keys, signed media links |
| [Platform terms](platform-terms.md) | Official APIs only, rate limits, no scraping, your responsibility |
| [Updating](updating.md) | Updating on Cloudflare and Docker, reading the changelogs, breaking changes |
| [Backups and restore](backups.md) | D1, SQLite and Postgres backups, the media, restoring, what a backup doesn't hold |
| [Changelog](changelog.md) | What changed in each release, the packages it published and their versions |
| [FAQ and troubleshooting](faq.md) | A post that didn't go out, expired tokens, limits, missing media, time zones, passkeys |
