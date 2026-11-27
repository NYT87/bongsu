---
"@bongsu/core": patch
---

Removing a member, or a member leaving, now also revokes the agent keys they made in that workspace, not only their CLI
tokens: a removed admin can't keep using a key they copied.
