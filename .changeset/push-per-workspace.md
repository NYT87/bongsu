---
"@bongsu/core": patch
"@bongsu/api": patch
---

Push notifications go only to the members of the workspace they're about: a device belongs to the user who turned
notifications on and the workspace they did it in, and stops getting them when that user leaves it. **Send a test**
reaches only your own devices. Push subscriptions are only taken for the browsers' push services, and Bongsu sends to
them without following redirects and with a time limit. A device subscribed before this update keeps working for the
default workspace's owner; others turn notifications on again in Settings.
