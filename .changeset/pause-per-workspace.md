---
"@bongsu/core": minor
"@bongsu/api": minor
---

**Pause everything** and **Resume with passkey** act on one workspace: a pause holds that workspace's Reels, posts and
Shorts comments while the instance's other workspaces go on publishing, and resuming (still with a passkey) releases
only it. An agent key's `pause_scheduler` pauses its own workspace, `get_status` says whether that workspace is paused,
and a paused workspace's daily digest says so.
