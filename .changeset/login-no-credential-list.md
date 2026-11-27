---
"@bongsu/api": patch
---

The app's sign-in no longer lists the instance's passkeys to someone signed out: the device offers its own. New passkeys are always discoverable (a passkey on a phone or a computer always is; an old hardware key that can't store one is refused when it's added).
