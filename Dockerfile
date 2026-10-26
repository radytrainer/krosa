# syntax=docker/dockerfile:1.7
#
# Production images for the Student Score Record System (docs/deployment.md).
#
#   docker build --target api     -t ssrs-api .
#   docker build --target worker  -t ssrs-worker .
#   docker build --target web     -t ssrs-web .
#   docker build --target migrate -t ssrs-migrate .
#
# One build stage compiles the whole workspace; each runtime image gets only its own production
# dependencies (`pnpm deploy`) and runs as the unprivileged `node` user.

ARG NODE_IMAGE=node:22.17.0-bookworm-slim

# ------------------------------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS build
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true NEXT_TELEMETRY_DISABLED=1
RUN corepack enable
WORKDIR /repo

# Dependencies first, so source changes don't invalidate the install layer.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc* ./
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY apps/web/package.json apps/web/
COPY packages/config/package.json packages/config/
COPY packages/database/package.json packages/database/
COPY packages/sheets/package.json packages/sheets/
COPY packages/shared/package.json packages/shared/
COPY packages/sync/package.json packages/sync/
COPY e2e/package.json e2e/
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm install --frozen-lockfile

COPY . .
RUN pnpm build

# Per-service production dependency trees. Workspace packages are injected (copied with their
# dist/ and dependencies) so each tree is self-contained; `--legacy` would leave symlinks into
# /repo, which does not exist in the runtime images.
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm --filter=@ssrs/api deploy --prod --config.inject-workspace-packages=true /out/api && \
    pnpm --filter=@ssrs/worker deploy --prod --config.inject-workspace-packages=true /out/worker && \
    pnpm --filter=@ssrs/database deploy --config.inject-workspace-packages=true /out/migrate
# The Google Sheets test fakes must not exist in production images: without them the
# end-to-end test mode (SHEETS_TEST_MODE) cannot start even if someone sets it. The checks
# prove the package is present, the fakes are gone, and Node can no longer load them.
RUN for app in api worker; do \
      cd /out/$app && \
      node -e "import('@ssrs/sheets').then(()=>0,e=>{console.error(e);process.exit(1)})" && \
      find node_modules -type d -path '*@ssrs/sheets/dist/testing' -prune -exec rm -rf {} + && \
      node -e "import('@ssrs/sheets/testing').then(()=>process.exit(1),()=>process.exit(0))" \
      || exit 1; \
    done

# Next.js standalone server plus its static assets.
RUN mkdir -p /out/web && \
    cp -r apps/web/.next/standalone/. /out/web/ && \
    mkdir -p /out/web/apps/web/.next && \
    cp -r apps/web/.next/static /out/web/apps/web/.next/static && \
    if [ -d apps/web/public ]; then cp -r apps/web/public /out/web/apps/web/public; fi

# ------------------------------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
# Prisma's engines need OpenSSL; CA certificates for Google and Sentry over TLS.
RUN apt-get update &&     apt-get install -y --no-install-recommends openssl ca-certificates &&     rm -rf /var/lib/apt/lists/*
WORKDIR /app
USER node

# ------------------------------------------------------------------------------------------------
FROM runtime AS api
COPY --from=build --chown=node:node /out/api /app
EXPOSE 4000
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.API_PORT||4000)+'/api/v1/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "dist/main.js"]

# ------------------------------------------------------------------------------------------------
FROM runtime AS worker
COPY --from=build --chown=node:node /out/worker /app
CMD ["node", "dist/main.js"]

# ------------------------------------------------------------------------------------------------
FROM runtime AS web
ENV PORT=3000 HOSTNAME=0.0.0.0
COPY --from=build --chown=node:node /out/web /app
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/login').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "apps/web/server.js"]

# ------------------------------------------------------------------------------------------------
# One-shot job: applies pending migrations, then exits (docker-compose.prod.yml runs it first).
FROM runtime AS migrate
COPY --from=build --chown=node:node /out/migrate /app
CMD ["node", "node_modules/prisma/build/index.js", "migrate", "deploy"]
