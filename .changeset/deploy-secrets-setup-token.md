---
"bongsu": patch
---

`bongsu deploy-secrets` prints the `SETUP_TOKEN` it generates, once, since the dashboard's first sign-up asks for it;
a token already set is kept and not printed. The other secrets are still never printed.
