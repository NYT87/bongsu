# Bongsu documentation

Running Bongsu (what it is, installing it, connecting accounts, settings, security, agents and the CLI): the guides in
[site/docs/README.md](../site/docs/README.md). The pages below are for people working on the code.

| Page | What it covers |
|---|---|
| [Architecture](architecture.md) | The two Workers, the cron runs, the database, how a post goes out |
| [Databases](databases.md) | Which database, backups, how the schema is generated and changed |
| [Database schema](schema.md) | Every table and column, generated from `packages/schema` |
| [Platforms and providers](platforms.md) | How a post goes out on any network, and how to add one |
| [Media stores](media-stores.md) | Where the media lives, the store interface, writing a new store |
| [Development](development.md) | Repository layout, tests, CI, releases, pre-push checks |
| [Brand guidelines](brand-guidelines.md) | The name, the mark, brand colours, type, voice and imagery |
| [Contributing](../CONTRIBUTING.md) | Commit messages, code style, changesets, ground rules |
| [AGENTS.md](../AGENTS.md) | Instructions for AI coding agents working on this repository |
| [Roadmap](PLAN.md) | The implementation plan toward the public release |

Changelogs, one per package: [core](../packages/core/CHANGELOG.md), [api](../packages/api/CHANGELOG.md),
[web](../packages/web/CHANGELOG.md), [cloudflare](../apps/cloudflare/CHANGELOG.md), [node](../apps/node/CHANGELOG.md).
