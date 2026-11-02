# Bongsu on Node (site/docs/self-hosting.md): one container serves the app, the dashboard and the APIs and runs the
# schedules; the SQLite file lives on the /data volume, or the database is Postgres (DATABASE_URL).

# ---- build: the PWA, the dashboard and the server bundle
FROM node:22.23.2-bookworm-slim AS build
WORKDIR /src
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages packages
COPY apps apps
# the dashboard shows the guides, bundled from site/docs/*.md
COPY site site
RUN pnpm install --frozen-lockfile --ignore-scripts --filter "@bongsu/node..." --filter "@bongsu/web" --filter "@bongsu/dashboard" \
 && pnpm rebuild better-sqlite3 esbuild
# The app's name and theme colour are build inputs (site/docs/configuration.md, Branding).
ARG BONGSU_APP_NAME
ARG BONGSU_THEME_COLOR
RUN pnpm --filter @bongsu/web build \
 && pnpm --filter @bongsu/dashboard build \
 && pnpm --filter @bongsu/node build
# The runtime's only installed package: the native SQLite driver, at the version apps/node/package.json pins.
RUN mkdir /out && cd /out \
 && node -e 'const v=require("/src/apps/node/package.json").dependencies["better-sqlite3"];require("fs").writeFileSync("package.json",JSON.stringify({private:true,type:"module",dependencies:{"better-sqlite3":v}}))' \
 && npm install --omit=dev --no-audit --no-fund

# ---- runtime
FROM node:22.23.2-bookworm-slim
ENV NODE_ENV=production \
    PORT=8787 \
    DATABASE_PATH=/data/bongsu.db \
    MIGRATIONS_DIR=/app/migrations \
    WEB_DIR=/app/web \
    MEDIA_DIR=/media
WORKDIR /app
COPY --from=build /out/node_modules ./node_modules
COPY --from=build /out/package.json ./package.json
COPY --from=build /src/apps/node/dist/server.mjs ./server.mjs
COPY --from=build /src/packages/web/dist ./web
COPY migrations/sqlite ./migrations/sqlite
COPY migrations/postgres ./migrations/postgres
RUN mkdir -p /data /media && chown node:node /data /media
USER node
VOLUME ["/data", "/media"]
EXPOSE 8787
# /health: the database is migrated and the settings the instance needs are set (503 otherwise).
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "server.mjs"]
