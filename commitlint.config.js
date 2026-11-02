// Conventional Commits (https://www.conventionalcommits.org): `type(scope): summary`, e.g. `fix(core): retry a failed
// container poll`. Checked by the commit-msg hook (lefthook.yml) and in CI on every merge request and push.
export default {
  extends: ["@commitlint/config-conventional"],
  rules: {
    "scope-enum": [
      2,
      "always",
      [
        "core",
        "api",
        "web",
        "dashboard",
        "cloudflare",
        "node",
        "cli",
        "schema",
        "providers",
        "docs",
        "ci",
        "deps",
        "release",
        "repo",
      ],
    ],
    "header-max-length": [2, "always", 100],
    "body-max-line-length": [2, "always", 120],
    "footer-max-line-length": [2, "always", 120],
  },
};
