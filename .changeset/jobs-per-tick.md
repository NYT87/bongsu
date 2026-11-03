---
"@bongsu/core": minor
"@bongsu/node": minor
---

How many publishing jobs a run advances is now a setting, `JOBS_PER_TICK`: Cloudflare keeps 4 (the free plan's subrequest limit), Node and Docker default to 20 since they have no such limit, and either can set it (up to 100). The configuration guide explains how items due at the same minute go out.
