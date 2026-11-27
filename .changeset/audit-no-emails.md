---
"@bongsu/api": minor
"@bongsu/core": minor
"@bongsu/dashboard": minor
---

The audit log no longer stores emails: invites are named `invite:<id>` and people `user:<id>`, the Audit page shows their name or email from the live rows, and every audit write masks anything shaped like an email. Migration 0028 rewrites the old rows.
