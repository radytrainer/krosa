# Deployment

Last verified: 2026-10-31, commit b222954 plus uncommitted working tree.

How to run the Student Score Record System on a single Linux server with Docker. Day-to-day
running (backups, monitoring, routine checks) is in [operations.md](operations.md).

## 1. What runs where

```text
Internet ──443/80──▶ caddy ──/api/*──▶ api ──▶ postgres
                       │                 └───▶ redis ◀── worker ──▶ Google Sheets API
                       └──────other────▶ web
                                         backup ──▶ postgres (nightly pg_dump → BACKUP_DIR)
```

| Service    | Image / target           | Notes                                                                 |
| ---------- | ------------------------ | --------------------------------------------------------------------- |
| `caddy`    | `caddy:2.10-alpine`      | The only service with published ports. TLS via Let's Encrypt, HSTS    |
| `web`      | `Dockerfile` → `web`     | Next.js standalone server                                             |
| `api`      | `Dockerfile` → `api`     | REST API under `/api/v1`                                              |
| `worker`   | `Dockerfile` → `worker`  | Runs spreadsheet syncs                                                |
| `migrate`  | `Dockerfile` → `migrate` | One-shot: applies database migrations before `api` and `worker` start |
| `postgres` | `postgres:17-alpine`     | Internal network only                                                 |
| `redis`    | `redis:7.4-alpine`       | Internal network only; queue + cache                                  |
| `backup`   | `postgres:17-alpine`     | Daily `pg_dump` into `BACKUP_DIR`, checksummed, pruned                |

All application containers run as the unprivileged `node` user. `api`, `worker` and `web` have
`init: true` so signals reach Node and shutdowns are graceful (the worker gets 120 s to finish a
running sync). The one-shot `migrate` does not need it.

## 2. Server requirements

- Linux (Ubuntu 24.04 LTS or similar), 2 vCPU, 4 GB RAM, 40 GB disk for a school of a few thousand
  students. Docker Engine 27+ with the Compose plugin.
- A DNS name (A/AAAA record) pointing at the server, and ports **80 and 443** open to the internet
  (80 is needed for certificate issuance and the redirect to HTTPS). Nothing else needs to be open.
- A Google Cloud **service account** with the Google Sheets API enabled, and its JSON key
  ([google-sheets-template.md §7](google-sheets-template.md)).

## 3. First installation

```bash
git clone <repository> /opt/ssrs && cd /opt/ssrs

# Settings: create the file with the variables in section 6.
# Generate secrets with `openssl rand -base64 33`.
# There is no template yet: .env.production.example does not exist.
touch .env.production
chmod 600 .env.production
nano .env.production

# Google key, readable only by root (it is mounted into the containers as a Docker secret).
install -d -m 700 secrets
install -m 600 /path/to/downloaded-key.json secrets/google-sa.json

# Build and start. The first start takes a few minutes (image build, certificate issuance).
docker compose -f docker-compose.prod.yml --env-file .env.production up -d --build
docker compose -f docker-compose.prod.yml --env-file .env.production ps -a
```

Every service should report `running` (and `healthy` where a health check exists); `migrate` shows
`exited (0)`. Then create the first administrator (there are no default accounts):

```bash
docker compose -f docker-compose.prod.yml --env-file .env.production \
  run --rm api node dist/cli/create-admin.js --username registrar --display-name "Registrar"
```

Open `https://<SITE_ADDRESS>` and sign in. Tip: put the long compose prefix in a shell alias,
e.g. `alias ssrs='docker compose -f docker-compose.prod.yml --env-file .env.production'`; the rest of
this document uses `ssrs`.

**Never** run `pnpm demo:seed` or set `SHEETS_TEST_MODE` on a server: the demo data has published
passwords, and test mode is refused in production builds (the test fakes are not in the images).

## 4. Checks after installing

- `curl -fsS https://<SITE_ADDRESS>/api/v1/health/ready` → `{"status":"ok",...}`
- The browser shows a valid certificate; `curl -sI https://<SITE_ADDRESS>` includes
  `strict-transport-security` and `content-security-policy`.
- `ssrs exec postgres sh -c 'exit 0'` works but PostgreSQL and Redis are **not** reachable from
  another machine (`nc -vz <server> 5432` must fail).
- Take a first backup and run the restore drill ([operations.md §2](operations.md#2-backups-and-restore)).

## 5. Updating

```bash
cd /opt/ssrs
git pull
ssrs up -d --build        # builds new images, runs migrations, restarts changed services
ssrs ps -a
```

Migrations run automatically (`migrate` must finish before `api` and `worker` start). They are
forward-only; take a backup first when the release notes mention a migration:
`ssrs exec backup sh /usr/local/bin/backup.sh --once`.

**Rollback:** check out the previous release (`git checkout <tag>`) and `ssrs up -d --build`. If the
newer release ran a migration that the older code cannot use, restore the backup taken before the
update ([operations.md §2](operations.md#2-backups-and-restore)).

## 6. Configuration reference

Settings come from `.env.production`, but only variables listed in the compose file reach the
containers. `ACCESS_TOKEN_TTL_SECONDS`, `SESSION_TTL_HOURS`, `CORS_ORIGINS`, `DATABASE_POOL_MAX`,
`SYNC_JOBS_PER_MINUTE`, `ORPHAN_SWEEP_INTERVAL_MS` and `WORKER_HEARTBEAT_INTERVAL_MS` are not passed,
so setting them has no effect in production.

The compose file fixes the security-relevant ones so they cannot be forgotten: `NODE_ENV=production`,
`WEB_ORIGIN=https://$SITE_ADDRESS`, `TRUST_PROXY_HOPS=1` (Caddy), `SWAGGER_ENABLED=false`. The API
refuses to start in production without `https` and secure cookies.

| Variable                                             | Required                        | Purpose                                                                 |
| ---------------------------------------------------- | ------------------------------- | ----------------------------------------------------------------------- |
| `SITE_ADDRESS`, `ACME_EMAIL`                         | yes                             | Public host name; email for certificate notices                         |
| `POSTGRES_DB`, `POSTGRES_USER`, `POSTGRES_PASSWORD`  | yes                             | Database                                                                |
| `REDIS_PASSWORD`                                     | yes                             | Redis                                                                   |
| `JWT_ACCESS_SECRET`                                  | yes                             | Signs sessions (≥ 32 random characters); changing it signs everyone out |
| `GOOGLE_SA_FILE`                                     | no (`./secrets/google-sa.json`) | Path of the service-account key on the server                           |
| `TEMP_PASSWORD_TTL_DAYS`                             | no (14)                         | Lifetime of issued temporary passwords                                  |
| `RATE_LIMIT_PER_MINUTE`                              | no (300)                        | Requests per minute per client IP                                       |
| `WORKER_CONCURRENCY`                                 | no (2)                          | Syncs processed at the same time                                        |
| `LOG_LEVEL`                                          | no (`info`)                     | Log level of the API and worker                                         |
| `SENTRY_DSN`, `SENTRY_ENVIRONMENT`                   | no                              | Error reporting (scrubbed; see [security.md §8](security.md))           |
| `BACKUP_TIME`, `BACKUP_RETENTION_DAYS`, `BACKUP_DIR` | no                              | Nightly backups (02:30 UTC, 14 days, `./backups`)                       |
| `IMAGE_PREFIX`, `IMAGE_TAG`                          | no                              | Use prebuilt images from a registry instead of building on the server   |

## 7. Continuous integration

`.github/workflows/ci.yml` runs on pushes to `main` and on pull requests: lint, typecheck, format and unit
tests; integration tests and the Playwright end-to-end scenario against PostgreSQL and Redis
service containers; and a build of all four production images. Images are built but not pushed:
publishing to a registry is a per-school decision (set `IMAGE_PREFIX` / `IMAGE_TAG` to pull instead
of building on the server).
