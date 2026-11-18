# syntax=docker/dockerfile:1.7
#
# Production images for the Student Score Record System (docs/deployment.md).
#
#   docker build --target api    -t ssrs-api .
#   docker build --target worker -t ssrs-worker .
#   docker build --target web    -t ssrs-web .
#
# One build stage compiles the whole workspace; each runtime image gets only its own production
# dependencies (`pnpm deploy --prod`) and runs as the unprivileged `node` user. No secrets or env
# files enter any layer: .dockerignore excludes them, and every setting comes from the server at
# run time.
#
# The api image also carries:
#   /app/migrate   the Prisma CLI and migrations, run as a one-off container before a release starts
#   /app/deploy    the server bundle (compose file, Caddyfile, scripts, systemd units) of the same
#                  commit, which the server extracts on each deploy (docs/deployment.md §3-§4)

# Pinned by digest: a re-tagged base image cannot slip into a build.
ARG NODE_IMAGE=node:22.17.0-bookworm-slim@sha256:b04ce4ae4e95b522112c2e5c52f781471a5cbc3b594527bcddedee9bc48c03a0

# ------------------------------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS build
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true NEXT_TELEMETRY_DISABLED=1
# The runtime is Debian bookworm with OpenSSL 3: fetch exactly that Prisma engine.
ENV PRISMA_CLI_BINARY_TARGETS=debian-openssl-3.0.x
# OpenSSL must be present when Prisma installs its engines: Prisma picks the engine build from the
# OpenSSL it finds. Without it, it fetches the OpenSSL 1.1 engine, the runtime (OpenSSL 3) does
# not match, and `migrate deploy` tries to download another engine into the read-only image.
RUN apt-get update && \
    apt-get install -y --no-install-recommends openssl ca-certificates && \
    rm -rf /var/lib/apt/lists/*
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
# No side-effects cache: postinstall results (Prisma engines) must come from this build.
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --config.side-effects-cache=false

COPY . .
RUN pnpm build

# Per-service production dependency trees. Workspace packages are injected (copied with their
# dist/ and dependencies) so each tree is self-contained; `--legacy` would leave symlinks into
# /repo, which does not exist in the runtime images. The migrate tree keeps the Prisma CLI
# (a dev dependency of @ssrs/database), so it is not --prod.
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm --filter=@ssrs/api deploy --prod --config.inject-workspace-packages=true /out/api && \
    pnpm --filter=@ssrs/worker deploy --prod --config.inject-workspace-packages=true /out/worker && \
    pnpm --filter=@ssrs/database deploy --config.side-effects-cache=false --config.inject-workspace-packages=true /out/migrate
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

# Server bundle: everything the host needs to run this exact commit (docs/deployment.md §4).
RUN mkdir -p /out/deploy/bin /out/deploy/systemd && \
    cp deploy/compose.yml deploy/Caddyfile /out/deploy/ && \
    cp scripts/server/deploy.sh scripts/server/backup.sh scripts/server/restore.sh \
       scripts/server/check-disk.sh scripts/server/alert.sh /out/deploy/bin/ && \
    cp deploy/systemd/* /out/deploy/systemd/ && \
    chmod 0755 /out/deploy/bin/*.sh && chmod 0644 /out/deploy/compose.yml /out/deploy/Caddyfile /out/deploy/systemd/*

# ------------------------------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 TZ=UTC
# Prisma's engines need OpenSSL; CA certificates for Google and Sentry over TLS.
RUN apt-get update && \
    apt-get install -y --no-install-recommends openssl ca-certificates && \
    rm -rf /var/lib/apt/lists/*
WORKDIR /app
USER node

# ------------------------------------------------------------------------------------------------
FROM runtime AS api
COPY --from=build --chown=root:root /out/api /app
COPY --from=build --chown=root:root /out/migrate /app/migrate
COPY --from=build --chown=root:root /out/deploy /app/deploy
EXPOSE 4000
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.API_PORT||4000)+'/api/v1/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "dist/main.js"]

# ------------------------------------------------------------------------------------------------
FROM runtime AS worker
COPY --from=build --chown=root:root /out/worker /app
COPY --chown=root:root docker/healthcheck/worker.mjs /app/healthcheck.mjs
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD ["node", "/app/healthcheck.mjs"]
CMD ["node", "dist/main.js"]

# ------------------------------------------------------------------------------------------------
FROM runtime AS web
ENV PORT=3000 HOSTNAME=0.0.0.0
COPY --from=build --chown=root:root /out/web /app
# Application files are root-owned and read-only to `node`; only Next.js's cache is writable.
USER root
RUN install -d -o node -g node -m 0755 /app/apps/web/.next/cache
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/login').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "apps/web/server.js"]
