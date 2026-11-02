---
"@bongsu/api": patch
---

A passkey only confirms its own user's action. Approving, resuming and moving a YouTube release in the app (and the
dashboard's fresh passkey check) now refuse another member's passkey registered on the same device, and the app only
offers the signed-in user's passkeys for them.
