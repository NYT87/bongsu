---
"@bongsu/core": minor
"@bongsu/api": minor
"@bongsu/dashboard": minor
---

The instance admin's Workspaces page: list every workspace, create one, rename it, add an admin (an invite link), open
it to work in it as its admin, and archive or restore it. An archived workspace stops completely: nothing in it
publishes, its agent keys and CLI tokens are refused, its members can't open it and it gets no digest; restoring it
brings it back as it was. A workspace's own admins rename it from Settings.
