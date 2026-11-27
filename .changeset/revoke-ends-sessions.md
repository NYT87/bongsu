---
"@bongsu/api": patch
---

Revoking a passkey now signs that person out everywhere else (a lost phone's app session no longer keeps working for 30 days), and a recovery-code sign-in ends every earlier session. Two revokes at once can no longer remove both of your last passkeys.
