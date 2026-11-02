---
"@bongsu/core": minor
"@bongsu/api": minor
"@bongsu/cloudflare": minor
---

Platform-neutral content: a planned item has a `format` (one of its platform's formats, or none: decided by its media) and `options` (Instagram's location, cover frame and trial switch moved there; migration 0006). Platforms and providers are registries (`platforms/`, `providers/`): the tick publishes through any provider with resumable start/check/finish steps. `plan_add` / `plan_update` take `format` and `options` (the older `kind` and `location` still work); queue items carry `format` and `options`. Item keys are opaque ids.
