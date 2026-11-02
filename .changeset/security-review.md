---
"@bongsu/core": patch
"@bongsu/api": patch
"@bongsu/web": patch
"@bongsu/cloudflare": patch
"@bongsu/dashboard": patch
---

Security review fixes. Approvals now name the account they were given for (migration 0010 fills it in for existing
ones); a Shorts comment needs the owner's approval of its text, from the Short's page in the app, before the scheduler
posts it; the comments under a live post are hashed again before posting and skipped when they changed after
approval; the plan is asked again (still there, same time, same account, released, account enabled) before a container
made earlier is published (a job whose item is on hold is held, without taking one of the tick's slots, and goes on
once released), and dry run stops a job already under way. The comments inbox, replies, manual post records and Trial
Reel records stay within the caller's workspace; account ids are unique across the instance. A member's role now gates
approving, resuming, pausing and plan changes in the app, and instance changes in the dashboard take an owner or admin.
The local media store refuses symlinks leading outside its folder; an Instagram post whose permalink lookup fails
keeps its media id instead of being published again.
