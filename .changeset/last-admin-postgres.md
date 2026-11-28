---
"@bongsu/core": patch
---

On Postgres, two admins removing or demoting each other at the same moment can no longer leave a workspace without an admin, nor the instance without an instance admin: the change now locks the workspace (or the instance admins) first, in one transaction.
