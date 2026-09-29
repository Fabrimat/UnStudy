# Build context: repo root (needs the workspace manifests + apps/api, apps/web, packages/db).
FROM node:22-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

RUN corepack enable

WORKDIR /app

# Manifests first so `pnpm install` is cached unless a dependency changes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/db/package.json packages/db/package.json

RUN pnpm install --frozen-lockfile --filter @summarize/api... --filter @summarize/web...

COPY packages/db packages/db
COPY apps/web apps/web
COPY apps/api apps/api
# Served by the API as the start-from texts; the worker owns the files.
COPY apps/worker/summarize_worker/presets apps/worker/summarize_worker/presets

RUN pnpm --filter @summarize/db build \
 && pnpm --filter @summarize/web build \
 && pnpm --filter @summarize/api build

ENV NODE_ENV=production
WORKDIR /app/apps/api
EXPOSE 3000
CMD ["node", "dist/main.js"]
