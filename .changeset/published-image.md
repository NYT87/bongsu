---
"@bongsu/node": patch
---

The Docker guide can run the published image: set `BONGSU_IMAGE=ghcr.io/nyt87/bongsu:<version>` in `.env`, then `docker compose pull bongsu` and `up -d`. Without it, compose builds from the checkout as before.
