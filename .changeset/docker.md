---
"@bongsu/node": minor
---

Docker: a multi-stage, non-root image with the SQLite file on a volume and a health check on `/health`;
`docker-compose.yml` with optional Caddy (HTTPS, profile `https`) and Mailpit (profile `mail`); `.env.example`;
`node server.mjs backup <file>` for a consistent copy while it runs. Guide: `site/docs/self-hosting.md`.
