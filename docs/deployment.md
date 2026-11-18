# Deployment

Last verified: 2026-11-18, branch feature/beta-deploy (local production-like run; not yet on a
server).

How the system runs on the **beta server**: one AWS EC2 instance with Docker Compose, deployed by
GitHub Actions through AWS Systems Manager. Beta holds real student data and is treated as
production for security and backups. Production later reuses the same files with its own server,
environment and branch (`main`).

- First installation, step by step: [beta-checklist.md](beta-checklist.md)
- Deploy, roll back, restore, rotate secrets, logs, low memory or disk: [runbook.md](runbook.md)
- Day-to-day checks and admin tasks: [operations.md](operations.md)

## 1. What runs where

```text
                          GitHub                                     AWS
 feature/* → development → beta ──push──▶ deploy-beta.yml
                                         ├ CI (lint, types, unit, build, audit, integration)
                                         ├ build + push 3 images ─▶ GHCR  ghcr.io/<owner>/<repo>-{api,worker,web}:<sha>
                                         ├ wait for approval (environment "beta")
                                         └ OIDC → IAM role ─ssm:SendCommand─▶ SSRS-Beta-Deploy(<sha>)
                                                                               │
 EC2 (Ubuntu 24.04, t3.micro)                                                  ▼
   /usr/local/sbin/ssrs-deploy <sha>: pull api:<sha>, extract its bundle → releases/<sha>/
   releases/<sha>/bin/deploy.sh: pull → backup to S3 → migrate → start → health → (roll back)

 Users ──443/80──▶ caddy ──/api/*, /health──▶ api ──▶ postgres, redis   (network "data": no internet)
                     └──────── other ──────▶ web          worker ──▶ postgres, redis, Google Sheets
 ssrs-backup.timer (daily 19:30 UTC) ─▶ backup.sh ─▶ age-encrypted pg_dump ─▶ S3 (instance role)
```

| Service    | Image                          | Memory limit | Notes                                                                 |
| ---------- | ------------------------------ | ------------ | --------------------------------------------------------------------- |
| `caddy`    | `caddy:2.10.2-alpine` digest   | 64 MB        | The only service with published ports (80, 443). TLS, HSTS, `/health` |
| `web`      | `…-web:<sha>`                  | 256 MB       | Next.js standalone; heap 160 MB                                       |
| `api`      | `…-api:<sha>`                  | 320 MB       | REST API `/api/v1`; heap 192 MB; pool 8                               |
| `worker`   | `…-worker:<sha>`               | 320 MB       | Syncs; heap 192 MB; concurrency 1; pool 4                             |
| `migrate`  | `…-api:<sha>` (one-off)        | 256 MB       | `prisma migrate deploy` before a release starts                       |
| `postgres` | `postgres:17.12-alpine` digest | 288 MB       | `shared_buffers=128MB`, `max_connections=30`; volume `postgres-data`  |
| `redis`    | `redis:7.4.12-alpine` digest   | 80 MB        | `maxmemory 48mb`, `noeviction` (BullMQ), AOF; password                |

Every service has a health check and `restart: unless-stopped` (except the one-off `migrate`).
Every container runs with `no-new-privileges`; the Node containers also drop all capabilities, run
as the unprivileged `node` user on a read-only root file system, and have `init: true`. Times are
UTC on the server and in every container; the web app formats times in the browser, so users see
Phnom Penh time. `NODE_ENV=production` everywhere, so the demo seed refuses to run and the Sheets
test mode cannot start (its fakes are also removed from the images).

Networks: `edge` (caddy, web, api), `data` (internal, no route out: api, worker, postgres, redis),
`egress` (worker → Google and Sentry). PostgreSQL and Redis are never reachable from outside Docker.

## 2. Server and memory

AWS free tier: **t3.micro** (2 vCPU burstable, 1 GB RAM), 30 GB gp3 (encrypted), Ubuntu 24.04 LTS
x86, Elastic IP, a 2 GB swap file. Region `ap-southeast-2` (Sydney), Availability Zone
`ap-southeast-2c`.

Memory measured locally on 2026-11-18 (production images and limits, empty test database, after
180 requests), and what to expect on the server with real data:

| Item                                   | Measured | Expected on the server                     |
| -------------------------------------- | -------- | ------------------------------------------ |
| Ubuntu, dockerd, containerd, SSM agent | —        | ~250 MB                                    |
| api                                    | 222 MiB  | 220–260 MB                                 |
| worker                                 | 156 MiB  | 160–220 MB (sync peaks)                    |
| web                                    | 74 MiB   | 80–120 MB                                  |
| postgres                               | 47 MiB   | 100–180 MB (grows into its 128 MB buffers) |
| redis + caddy                          | 41 MiB   | 40–60 MB                                   |
| **Total**                              | 540 MiB  | **~0.85–1.1 GB of ~0.95 GB usable**        |

The limits add up to 1.3 GB, but they are ceilings, not reservations. RAM headroom is small (0–100
MB), so expect some swap use; the swap file absorbs peaks (a sync while many students are signed in), at the cost of speed.
**Move to t3.small (2 GB) when swap use stays above 500 MB** (the hourly disk check logs it;
[runbook.md](runbook.md) "Out of memory"). Images are always built in CI, never on the server.

## 3. Images

`Dockerfile`, three targets, built once per commit in `deploy-beta.yml` and pushed to GHCR
(private packages) as `:<commit sha>` plus the moving tag `:beta`. The server always deploys by
sha; nothing ever runs `latest`.

- Multi-stage: one build stage compiles the workspace; each runtime image gets only its own
  production dependencies (`pnpm deploy --prod`). Base `node:22.17.0-bookworm-slim`, pinned by
  digest. Runs as `node`; application files are root-owned and read-only.
- `web`: Next.js standalone output. `worker`: plus `/app/healthcheck.mjs` (heartbeat in Redis).
- `api`: plus `/app/migrate` (only the Prisma CLI and its own dependencies, with the schema and
  migrations; about 280 MB of the 1.46 GB image) and `/app/deploy`, the server bundle of
  the same commit (compose file, Caddyfile, scripts, systemd units). The server takes its
  configuration from the image it deploys, so code and configuration can never drift and the
  server needs no git checkout or deploy key.
- No secrets, env files, dumps, keys or test output can enter a layer (`.dockerignore`); all
  settings come from `/opt/ssrs/.env` at run time.

## 4. Server layout

| Path                                  | Owner / mode          | What                                                              |
| ------------------------------------- | --------------------- | ----------------------------------------------------------------- |
| `/opt/ssrs/.env`                      | root, 600             | Every setting and secret (from `deploy/.env.beta.example`)        |
| `/opt/ssrs/secrets/google-sa.json`    | root:ssrs-secrets 440 | Google service-account key, mounted read-only into api and worker |
| `/opt/ssrs/backup/age-recipients.txt` | root, 644             | age **public** key(s) for backups                                 |
| `/opt/ssrs/releases/<sha>/`           | root                  | Bundle extracted from `api:<sha>` (last 3 kept)                   |
| `/opt/ssrs/current`                   | symlink               | The live release (systemd timers run its scripts)                 |
| `/opt/ssrs/state/`                    | root, 700             | `deployed-tag`, `previous-tag`, `history`                         |
| `/root/.docker/config.json`           | root                  | GHCR read-only token (`docker login`, checklist step 13)          |
| `/usr/local/sbin/ssrs-deploy`, `ssrs` | root                  | Deploy entry point (SSM); compose wrapper for the live release    |

Created by [`scripts/server/bootstrap.sh`](../scripts/server/bootstrap.sh), which also sets up
security updates, swap, UTC, Docker from Docker's repository with log rotation (10 MB × 3),
ufw (80/443 only), hardened and disabled SSH, the SSM agent, the AWS CLI and age. It creates no
secret and starts nothing.

## 5. How a deploy works

Trigger: a push to `beta` (normally a merged pull request from `development`), or **Actions →
Deploy beta → Run workflow** on `beta` with an image tag (rollback).

1. **CI** (`ci.yml`, called by `deploy-beta.yml`): lint, typecheck, format, unit tests, build,
   dependency audit (fails on high or critical), integration tests against throwaway PostgreSQL and
   Redis.
2. **Images**: build and push `api`, `worker`, `web` tagged with the commit sha (and `beta`).
3. **Approval**: the `deploy` job uses the GitHub Environment `beta` with required reviewers; it
   waits until you approve. Nothing touches the server before that.
4. **AWS**: GitHub OIDC → the deploy role (no AWS keys in GitHub). The role can only send the
   `SSRS-Beta-Deploy` document to this one instance and read its result. The document accepts only a
   40-character sha plus the three `sha256:` image digests the images job produced (or `stored` for
   a rollback), and runs `ssrs-deploy`. The server pulls and runs images **by digest** and checks
   the api image's revision label, so overwriting a tag in GHCR cannot change what is deployed; a
   rollback uses the digests the server recorded when it first deployed that release.
5. **On the server** (`scripts/server/deploy.sh`), stopping at the first failure:
   1. pull the three images;
   2. back up the database (`backup.sh`, the daily script) and confirm the upload in S3;
   3. run the migrations from the **new** api image as a one-off container. If they fail, stop:
      the old release keeps running;
   4. start the new containers and wait for every health check (5 minutes);
   5. if a health check fails: start the previous release again and fail the job;
   6. record the tag (`/opt/ssrs/state`), point `current` at it, install the release's timers.
6. **Summary**: the job prints the server output and writes the requested tag, the result, the
   live tag and the previous tag to the job summary. Container logs of a failed release stay on the
   server (`/opt/ssrs/state/last-failure.log`), never in the job log.

Database commands on the server (migrations, backups, restores) run only through these scripts,
which name the target database and refuse anything else; they are the server's equivalent of
`scripts/db-guard.sh`, which is for development machines.

**What a rollback can and cannot undo.** It brings back the previous **images** and configuration.
It does not undo **migrations**: they only go forward. A release whose migration damaged data, or
whose old code cannot run on the new schema, needs the database restored from the backup taken in
step 5.2 ([runbook.md](runbook.md) "Restore a backup"). Migrations run while the old release still
serves requests, so they must stay backwards compatible (add, then remove in a later release).

## 6. Configuration

All settings live in `/opt/ssrs/.env` (template with a comment per variable:
[`deploy/.env.beta.example`](../deploy/.env.beta.example)). Only variables used in
`deploy/compose.yml` reach the containers. The compose file fixes the security-relevant ones:
`NODE_ENV=production`, `WEB_ORIGIN=https://$BETA_DOMAIN`, `TRUST_PROXY_HOPS=1` (Caddy),
`SWAGGER_ENABLED=false`; the API refuses to start in production without https and secure cookies.

Secrets: `POSTGRES_PASSWORD`, `REDIS_PASSWORD`, `JWT_ACCESS_SECRET` (also derives the CSRF key),
`SENTRY_DSN`, the healthchecks.io ping URLs, and the Google key file. They exist only on the server
(and in the school's password manager). GitHub holds only `AWS_ROLE_ARN`, `AWS_REGION` and
`EC2_INSTANCE_ID` in the `beta` environment.

Caddy does not compress `/api/v1/auth/live` and proxies the API with `flush_interval -1`, so live
session events reach the browser at once. A proxy added in front later must not buffer
`text/event-stream` and must allow 25 s idle between pings. `/health` answers `OK` or 503 from the
API's readiness check (PostgreSQL and Redis), with no other detail, for an external uptime monitor.

## 7. Checking the setup locally

Production-like run on a developer machine (Docker Desktop), with test values and a throwaway
database, never the dev database:

```bash
docker build --target api -t ssrs-local-api .          # also worker, web
docker compose -p ssrs -f deploy/compose.yml -f <override with localhost ports> \
  --env-file <test env> config                          # validates the file
```

The verification run of 2026-11-18 (first deploy, redeploy with backup, automatic rollback,
failed migration, backup and restore, login over HTTPS) is in [progress.md](progress.md).

## 8. AWS resources

[`deploy/aws/beta.yml`](../deploy/aws/beta.yml) (CloudFormation, created by hand in checklist step
10): the GitHub OIDC provider and deploy role, the instance role and profile (SSM managed policy;
`s3:PutObject`/`GetObject` on the backup prefix and `ListBucket` on it; **no delete**), the backup
bucket (private, Block Public Access, SSE-S3, versioning, TLS only, lifecycle: `daily/` 14 days,
`weekly/` 56 days, old versions 30 days), the security group (80/443 only; no 22, 5432 or 6379) and
the `SSRS-Beta-Deploy` SSM document.
