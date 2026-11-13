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
  ([google-sheets-template.md §8](google-sheets-template.md)).

## 3. First installation

```bash
git clone <repository> /opt/ssrs && cd /opt/ssrs

# Settings: start from the template and replace every placeholder (section 6).
# Generate secrets with `openssl rand -hex 32` (hex is safe inside connection URLs).
cp .env.production.example .env.production
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

With CI/CD set up (§8.7), releases are automatic: merge into the branch and the pipeline deploys
it (§8.8). Without it, update by hand on the server:

```bash
cd /opt/ssrs
git pull
ssrs up -d --build        # builds new images, runs migrations, restarts changed services
ssrs ps -a
```

Migrations run automatically (`migrate` must finish before `api` and `worker` start). They are
forward-only; take a backup first when the release notes mention a migration:
`ssrs exec backup sh /usr/local/bin/backup.sh --once`.

**Before releasing the `_meta` check (decisions.md K1):** every ACTIVE source's workbook must have
a `_meta` tab whose `generation_code` and `education_term` match its generation and term, or its
next sync fails with `META_MISSING` / `WORKBOOK_MISMATCH` (nothing is written). Check each one
(read-only; needs `pnpm build` and the Google credentials):

```bash
node scripts/verify-term-workbook.mjs --sheet "<spreadsheet URL>" --generation <code> --term <n>
```

On 2026-11-13 both live workbooks (GEN2026 Term 1, GEN2027 Term 1) were verified correct.

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
| `IMAGE_PREFIX`, `IMAGE_TAG`                          | no                              | Prebuilt images; kept in `.env.deploy` by `deploy.sh` (§8.6)            |

## 7. Continuous integration and delivery

`.github/workflows/ci.yml` runs on every pull request and on pushes to `main` and `development`:

```text
push / PR ─▶ checks (lint, typecheck, format, unit) ─▶ images (build api, worker, web, migrate)
          ├▶ integration (PostgreSQL + Redis)                │ push only: publish to GHCR
          └▶ e2e (Playwright)                                ▼
                         all green + push to development ─▶ deploy → staging server
                         all green + push to main        ─▶ deploy → production server
```

- **Pull requests** build the images but never publish or deploy.
- **Pushes** publish `ghcr.io/<owner>/<repo>-<target>:<commit sha>` to GitHub Container Registry,
  then the `deploy` job connects to the server over SSH and runs
  [`scripts/deploy.sh`](../scripts/deploy.sh) with that sha. Images are tagged by commit only, so
  any release can be redeployed exactly.
- Branch pushes queue instead of cancelling each other, so a deploy is never cut off halfway.
- Until a GitHub environment has its `DEPLOY_*` secrets (§8.7), `deploy` reports "not configured"
  and does nothing.

## 8. Hosting on AWS EC2

One EC2 instance runs the whole stack of §1; nothing else in AWS is required. The closest region to
Cambodia is **ap-southeast-1 (Singapore)**. Do every step once per server: a **staging** server for
`development` and a **production** server for `main` (§8.11).

```text
 Developer ──git push──▶ GitHub ──CI green──▶ GHCR (images :sha)
                            │                      │ docker pull
                            └──SSH (CI key)─────▶ EC2: /opt/ssrs/scripts/deploy.sh <sha>
                                                     ├ git checkout <sha>  (compose file, Caddyfile)
                                                     ├ backup → pull → migrate → restart
                                                     └ healthy? keep it : put previous sha back
 Users ──HTTPS 443──▶ Elastic IP ──▶ caddy ──▶ web / api ──▶ postgres, redis  (Docker network only)
```

### 8.1 Launch the instance

AWS console → EC2 → **Launch instance**:

| Setting                | Value                                                                                     |
| ---------------------- | ----------------------------------------------------------------------------------------- |
| Name                   | `krosa-staging` or `krosa-production`                                                     |
| AMI                    | Ubuntu Server 24.04 LTS, 64-bit (x86); the images are built for x86                       |
| Instance type          | `t3.medium` (2 vCPU, 4 GB), the minimum in §2                                             |
| Key pair               | Create one (`krosa-admin`, ED25519, `.pem`), kept by the IT admin only                    |
| Security group         | New, `krosa-web-ssh` (rules below)                                                        |
| Storage                | 40 GB `gp3`; under Advanced: **Delete on termination: No**, **Encrypted: Yes**            |
| Termination protection | Advanced details → Enable                                                                 |
| User data              | Advanced details → paste [`scripts/ec2-bootstrap.sh`](../scripts/ec2-bootstrap.sh) (§8.3) |

Security group inbound rules:

| Type       | Port | Source      | Why                                                                |
| ---------- | ---- | ----------- | ------------------------------------------------------------------ |
| HTTP       | 80   | `0.0.0.0/0` | Certificate issuance; Caddy redirects to HTTPS                     |
| HTTPS      | 443  | `0.0.0.0/0` | The site                                                           |
| Custom UDP | 443  | `0.0.0.0/0` | HTTP/3 (optional)                                                  |
| SSH        | 22   | `0.0.0.0/0` | GitHub's runners deploy from changing addresses; keys only (below) |

Never open 5432 (PostgreSQL) or 6379 (Redis). Open SSH is acceptable here because password login is
off, fail2ban bans repeated failures, and the CI key can run only the deploy script (§8.7). If you
want SSH from the office only, restrict port 22 and deploy by hand (§8.8), or run a self-hosted
GitHub runner on the server.

### 8.2 Elastic IP and DNS

1. EC2 → **Elastic IPs** → Allocate → Associate with the instance. The address now survives a
   stop and start.
2. At the DNS provider (or Route 53), add an **A record**: `krosa.<school-domain>` (production) or
   `krosa-staging.<school-domain>` → the Elastic IP.
3. Wait until `dig +short krosa.<school-domain>` returns the Elastic IP. Caddy needs it before the
   first start to obtain the certificate.

### 8.3 Prepare Ubuntu

If you pasted the bootstrap script as user data, it has already run: check that
`/var/log/cloud-init-output.log` ends with `ec2-bootstrap: done`. Otherwise run it by hand:

```bash
ssh -i krosa-admin.pem ubuntu@<elastic-ip>
git clone --depth 1 https://github.com/<owner>/<repo>.git /tmp/krosa   # private repo: copy the file with scp instead
sudo bash /tmp/krosa/scripts/ec2-bootstrap.sh
exit   # log in again so the docker group applies
```

It installs Docker Engine and Compose, git, automatic security updates and fail2ban; adds 2 GB of
swap; caps container logs at 60 MB each; turns off SSH passwords; and creates `/opt/ssrs`. Check
that `docker compose version` works without `sudo`.

### 8.4 Get the code onto the server

Public repository: `git clone -b development https://github.com/<owner>/<repo>.git /opt/ssrs`
(`-b main` on production).

Private repository: give the server a read-only **deploy key** first.

```bash
ssh-keygen -t ed25519 -N '' -C krosa-server-read -f ~/.ssh/github_read
cat ~/.ssh/github_read.pub   # GitHub → repo → Settings → Deploy keys → Add key (leave write off)
printf 'Host github.com\n  IdentityFile ~/.ssh/github_read\n  IdentitiesOnly yes\n' >> ~/.ssh/config
ssh-keyscan github.com >> ~/.ssh/known_hosts
git clone -b development git@github.com:<owner>/<repo>.git /opt/ssrs
```

Never edit tracked files in `/opt/ssrs`: every deploy checks out the released commit, and a local
change would block it.

### 8.5 Settings and the Google key

```bash
cd /opt/ssrs
cp .env.production.example .env.production && chmod 600 .env.production
nano .env.production   # SITE_ADDRESS, ACME_EMAIL; three secrets from `openssl rand -hex 32`
install -d -m 700 secrets
```

From your own computer: `scp -i krosa-admin.pem google-sa.json ubuntu@<elastic-ip>:/opt/ssrs/secrets/`;
then on the server `chmod 600 /opt/ssrs/secrets/google-sa.json`. Share each term sheet with the
service account's address ([google-sheets-template.md §8](google-sheets-template.md)).

### 8.6 Point the server at the published images

```bash
cd /opt/ssrs
echo 'IMAGE_PREFIX=ghcr.io/<owner>/<repo>' > .env.deploy   # lower case, e.g. ghcr.io/radytrainer/krosa
echo "alias ssrs='cd /opt/ssrs && docker compose -f docker-compose.prod.yml --env-file .env.production --env-file .env.deploy'" >> ~/.bashrc
source ~/.bashrc
```

`deploy.sh` writes `IMAGE_TAG=<sha>` into `.env.deploy` on each release, so `ssrs ps`, `ssrs logs`
and a reboot always use the live release. (Without `.env.deploy`, §3 still works: the server builds
the images itself, which is slow on a `t3.medium`.)

### 8.7 Connect GitHub Actions (CD)

**1. A CI key**, made on your own computer, one per server:

```bash
ssh-keygen -t ed25519 -N '' -C krosa-ci-staging -f krosa-ci-staging
```

**2. Allow that key to run only the deploy script.** On the server, add one line to
`~/.ssh/authorized_keys` (leave the admin key's line as it is):

```text
command="bash /opt/ssrs/scripts/deploy.sh",restrict ssh-ed25519 AAAA…(contents of krosa-ci-staging.pub)… krosa-ci-staging
```

`restrict` turns off shells, terminals and forwarding for that key. Whatever the client asks for,
the server runs `deploy.sh`, which accepts only `deploy <40-character commit sha>`.

**3. The server's host key**, so CI refuses an impostor: run `ssh-keyscan -t ed25519 <elastic-ip>`
on your computer and compare its fingerprint with
`ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` on the server.

**4. GitHub environments.** Repo → Settings → Environments → create `staging` and `production`, each
with:

| Kind     | Name                 | Value                                                      |
| -------- | -------------------- | ---------------------------------------------------------- |
| Secret   | `DEPLOY_HOST`        | The Elastic IP (or host name)                              |
| Secret   | `DEPLOY_SSH_KEY`     | The whole **private** key file (`krosa-ci-staging`)        |
| Secret   | `DEPLOY_KNOWN_HOSTS` | The line printed by `ssh-keyscan` in step 3                |
| Variable | `SITE_URL`           | `https://krosa-staging.<school-domain>` (smoke test, link) |
| Variable | `DEPLOY_USER`        | Optional; default `ubuntu`                                 |

On `production`, also tick **Required reviewers** (the IT admin) and limit **Deployment branches**
to `main`: each production release then waits for an approval in the Actions tab.

Delete the private key from your computer once it is stored in GitHub. To revoke it, remove its line
from `authorized_keys`.

**5. First release.** Push or merge to `development`. When CI is green, `deploy` pulls the images,
runs migrations, starts everything and checks `/api/v1/health/ready`. Then create the first
administrator, once:

```bash
ssrs run --rm api node dist/cli/create-admin.js --username registrar --display-name "Registrar"
```

and run the checks in §4.

### 8.8 Releasing, rolling back, looking around

| Task                          | How                                                                                        |
| ----------------------------- | ------------------------------------------------------------------------------------------ |
| Release to staging            | Merge into `development`                                                                   |
| Release to production         | Merge `development` into `main`, then approve the `production` deployment in Actions       |
| Redeploy an earlier commit    | Actions → the run of that commit → **Re-run all jobs**                                     |
| Roll back to the last release | On the server: `bash /opt/ssrs/scripts/deploy.sh --rollback`                               |
| Deploy by hand                | `docker login ghcr.io` (a token with `read:packages`), then `bash scripts/deploy.sh <sha>` |
| Which release is live         | `grep IMAGE_TAG /opt/ssrs/.env.deploy`; history in `/opt/ssrs/.deploy-history`             |
| Status and logs               | `ssrs ps -a`; `ssrs logs -f --tail 100 api worker`                                         |

Every deploy takes a backup first. If `api` or `web` is not healthy within 3 minutes, or `migrate`
fails, it starts the previous release again by itself. Migrations are forward-only: if a failed
release had already migrated and the old release cannot start, restore the backup taken just before
([operations.md §2](operations.md#2-backups-and-restore)).

### 8.9 Backups off the server

The nightly backups land in `BACKUP_DIR` on the same disk. Also keep copies elsewhere:

- **EBS snapshots:** EC2 → Lifecycle Manager → a policy on the instance's volume, daily, kept 7 days.
- **S3:** a private bucket with versioning and Block Public Access; an IAM role on the instance that
  allows only `s3:PutObject` on that bucket; `sudo snap install aws-cli --classic`; and a cron job
  (`crontab -e`): `15 3 * * * aws s3 sync /opt/ssrs/backups s3://<bucket>/ssrs-backups/ --only-show-errors`.

Run the restore drill once on the new server ([operations.md §2](operations.md#2-backups-and-restore)).

### 8.10 Monitoring

- **Instance:** CloudWatch alarm on `StatusCheckFailed_System` with the **Recover** action and an
  e-mail notification (SNS).
- **Disk:** `df -h /` monthly, or the CloudWatch agent with an alarm at 80 %.
- **Site:** any uptime checker on `https://<SITE_ADDRESS>/api/v1/health/ready`.
- **Errors:** `SENTRY_DSN` in `.env.production` ([security.md §8](security.md)).
- **Cost:** Billing → Budgets → a monthly budget with an e-mail alert.

### 8.11 Branches and servers

| Branch        | GitHub environment | Server                          | Released by                   |
| ------------- | ------------------ | ------------------------------- | ----------------------------- |
| `development` | `staging`          | Its own EC2, host name and data | CI, on every green push       |
| `main`        | `production`       | The live EC2                    | CI, after a reviewer approves |

A staging server has its own database and its own copies of the term sheets; never point it at live
data. Cost guide: one `t3.medium` with 40 GB gp3 and an Elastic IP is roughly US$35–40 a month in
Singapore; GHCR is free at this size (check the AWS pricing calculator).
