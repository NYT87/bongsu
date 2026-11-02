# Changesets

Each change that users would notice gets a changeset: a small Markdown file in this folder saying which packages it
touches, how much (patch, minor, major) and one or two lines for the changelog.

```sh
pnpm changeset          # pick the packages, the bump and write the summary
```

Commit it with the change. Releasing applies them: new versions and each package's `CHANGELOG.md` (manual for now,
see `docs/development.md`, *Releases and changelogs*).

`@bongsu/core`, `@bongsu/api`, `@bongsu/web` and `@bongsu/cloudflare` share one version (the deployable product);
each still lists only its own changes.
