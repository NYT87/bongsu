# Security policy

Bongsu posts to your accounts once you approve, so a flaw in how it checks that approval matters. Thank you for
reporting one privately.

## Supported versions

Only the latest release gets security fixes. Update to it before reporting, if you can.

## Reporting

Please don't open a public issue. On the project's GitLab, open **Issues → New issue**, tick **This issue is
confidential**, and give it a title that names the area (for example "Approval bypass in the agent API").

Include:

- the steps to reproduce it, as short as you can make them;
- the runtime (Cloudflare or Docker) and the Bongsu version;
- what you expected and what happened instead.

Don't include secrets: no tokens, API keys, passkeys or session cookies, and no real account handles. If a secret is
needed to show the problem, say which kind and say so in the confidential issue and we'll agree there how to share it.

You'll get a first answer within 7 days. Please don't disclose the problem publicly before a fix is released; once it
is, you're welcome to be credited in the release notes.

## Scope

In scope, because the owner's approval depends on them:

- passkeys and sessions (sign-in, recovery, expiry);
- approvals: anything that lets an agent approve, resume or publish, or that lets changed texts or media go out
  without a new approval;
- API keys and their scopes;
- signed media links (forging, reusing after they expire, reading other files);
- workspace isolation: one workspace reading or changing another's data.

Problems in the platforms themselves (Instagram, YouTube, Cloudflare) belong with their own programs. How Bongsu
protects each of these is described in the public [security page](site/docs/security.md).
