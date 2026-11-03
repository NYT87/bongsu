# Contributing

Thanks for helping. The short version:

1. Node 22 and pnpm (`corepack enable`), then `pnpm install`. This also installs the git hooks.
   The hooks run `pnpm`; if your editor or git client can't find it (for example Node from nvm), add a git-ignored
   `lefthook-local.yml` with `rc: ./.lefthook.rc` and put the `export PATH=…` line for your Node in `.lefthook.rc`.
2. Make the change with tests. See [docs/development.md](docs/development.md) for the layout and commands.
3. Run `pnpm check && pnpm typecheck && pnpm test`.
4. Add a changeset if users would notice the change: `pnpm changeset`.
5. Commit with a [Conventional Commits](https://www.conventionalcommits.org) message and open a pull request.
6. Be kind: the [code of conduct](CODE_OF_CONDUCT.md) applies to everyone here.
7. Found a security problem? Report it privately as described in [SECURITY.md](SECURITY.md), not in a public issue.

## Commit messages

```
type(scope): summary in the imperative, at most 100 characters

Optional body: why the change, wrapped at 120 columns.

BREAKING CHANGE: what breaks and how to migrate (only for breaking changes; also add ! after the scope)
```

- **Types:** `feat`, `fix`, `docs`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, `revert`, `style`.
- **Scopes:** `core`, `api`, `web`, `dashboard`, `cloudflare`, `node`, `cli`, `schema`, `providers`, `docs`, `ci`,
  `deps`, `release`, `repo`. Use several with commas (`core,api`). The scope can be left out.
- Examples: `feat(core): add a catch-up window per account`, `fix(web): keep the queue scroll position`,
  `docs: explain the Drive inbox`.

The commit-msg hook checks this locally, and CI checks every commit of a pull request and its title (used when
squashing).

## Code style

[Biome](https://biomejs.dev) formats and lints the code (`biome.json`): 2 spaces, double quotes, semicolons, trailing
commas, 120 columns. The pre-commit hook formats what you stage; `pnpm fix` formats everything; CI runs `biome ci`.
Warnings are known debt: fix them when you touch the code nearby.

## Changesets

Each change users would notice needs a changeset: run `pnpm changeset`, pick the packages and the bump (patch for
fixes, minor for features, major for breaking changes), and write one or two lines for the changelog. Docs-only,
test-only and CI-only changes don't need one. Maintainers apply them when releasing.

## Ground rules

- Every post needs the owner's approval. Changes must never let an agent key approve, resume or publish.
- No real personal data (handles, ids, captions, emails) or secrets in code, tests or docs.
- `packages/core` and `packages/api` don't use Cloudflare or Node APIs; SQL stays portable between SQLite and Postgres.

More in [AGENTS.md](AGENTS.md), which AI coding agents follow and people may find useful too.
