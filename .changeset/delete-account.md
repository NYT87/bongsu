---
"@bongsu/core": minor
---

People can delete their account once they belong to no workspace: on the dashboard's You page (or the "not in a workspace yet" screen), with their email typed again and a fresh passkey check. Their personal data, passkeys, sessions, devices and recovery codes go and their CLI tokens and sent invites are revoked; the account stays as a nameless tombstone (`users.deleted_at`, migration 0031), so audit rows read "deleted user". The email can be used again. The last instance admin is refused.
