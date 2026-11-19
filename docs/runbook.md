# Runbook (beta server)

What to do on the beta server, by task. Setup: [deployment.md](deployment.md). First install:
[beta-checklist.md](beta-checklist.md). Admin-portal tasks: [operations.md](operations.md).

**Getting a shell.** AWS console → Systems Manager → Session Manager → Start session → the instance
→ `sudo -i`. There is no SSH. `ssrs` is `docker compose` for the live release (`ssrs ps`,
`ssrs logs …`, `ssrs run …`). Never paste a secret as a command argument: read it with
`read -rsp` or edit the file with `nano`.

## Deploy

1. Merge into `development`, then open a pull request `development` → `beta` (CI and e2e run) and
   merge it.
2. GitHub → Actions → **Deploy beta** → the run → **Review deployments** → `beta` → Approve.
3. The job summary shows the result and the live tag. On the server: `cat /opt/ssrs/state/deployed-tag`,
   `ssrs ps`.

Deploy outside class hours. Before a release with a migration, read its notes: a migration that
the old code cannot run against needs a restore to undo ("Roll back" below).

**The first deploy of the beta signs every user out once**: the beta has its own new
`JWT_ACCESS_SECRET`, and the session-rules migration starts every session's inactivity clock
afresh, so every existing session ends at its next request and open pages go to the login page.
Tell users beforehand. Later deploys do not sign anyone out (unless the JWT secret is rotated).

## Roll back to a tag

- **Automatic:** if the new release fails its health checks, `deploy.sh` starts the previous
  release again and the job fails with `ROLLED_BACK`.
- **By hand:** GitHub → Actions → Deploy beta → **Run workflow** → branch `beta` → `image_tag` = the
  sha to go back to (from `/opt/ssrs/state/history` or an earlier job summary) → approve. It runs
  the normal deploy for that tag, including a fresh backup first. Without GitHub: on the server,
  `ssrs-deploy <sha> stored`.
- Only releases the server still has can be rolled back to (the last three, listed in
  `/opt/ssrs/releases/`): a rollback uses the image digests the server recorded when it first
  deployed them, never a tag looked up again in the registry. For an older commit, push it to
  `beta` again (a revert pull request), which builds and deploys it normally.
- A failed deploy keeps the containers' logs on the server only: `/opt/ssrs/state/last-failure.log`.

What a rollback **can** undo: images, compose file, Caddyfile, scripts and timers (all come from
the release). What it **cannot** undo: database migrations (forward only) and data written since.
If the new release's migration damaged data, or the old code cannot run on the new schema, restore
the backup taken just before the deploy (`ssrs-…-predeploy-<sha>.dump.age`, below).

Rolling back to a release from before the restricted application role (before commit "feat(db):
restricted application role") runs the api and worker as the database owner again, because that
release's compose file does; prefer rolling forward with a fix.

A deploy restarts api, worker and web on the one server: expect up to about a minute of errors
while the new containers start (longer if a rollback follows). Deploy outside class hours.

## A migration failed

The job ends with `FAILED_MIGRATION`; the old release is still running. Prisma has recorded the
failed migration and refuses every later deploy (`P3009`) until it is resolved.

1. Read the error in the job log. Prisma does not wrap a migration in one transaction: part of it
   may have been applied. Check the schema (`ssrs exec postgres psql -U ssrs -d ssrs -c '\d <table>'`).
2. If part of it was applied and cannot be cleanly reversed by hand, restore the pre-deploy backup
   ("Restore a backup", `--replace-live`) instead of the steps below.
3. Otherwise mark it rolled back, with the failed release's own image (`<sha>` from the job):

   ```bash
   s=<sha>; (set -a; . /opt/ssrs/releases/$s/digests.env; set +a
     IMAGE_TAG=$s docker compose -p ssrs --env-file /opt/ssrs/.env -f /opt/ssrs/releases/$s/compose.yml \
       run --rm --no-deps migrate node node_modules/prisma/build/index.js migrate resolve --rolled-back <migration name>)
   ```

4. Fix the migration in a new commit and deploy again.

## Backups

Daily at 19:30 UTC (02:30 Phnom Penh) by `ssrs-backup.timer`, and before every deploy. Encrypted
with age to the public key in `/opt/ssrs/backup/age-recipients.txt`; the private key is only in the
password manager. In S3: `beta/daily/` (14 days), `beta/weekly/` (Sundays, 8 weeks).

| Task                  | How                                                                            |
| --------------------- | ------------------------------------------------------------------------------ |
| Take one now          | `systemctl start ssrs-backup.service`                                          |
| Did the last run work | `journalctl -u ssrs-backup -n 20 --no-pager`; `systemctl list-timers 'ssrs-*'` |
| List backups          | `aws s3 ls s3://<BUCKET>/beta/daily/` (also `weekly/`)                         |
| Failures              | `journalctl -t ssrs-alert`; healthchecks.io emails you                         |

The instance cannot delete backups (its role has no delete permission). Old versions of overwritten
objects stay 30 days (bucket versioning).

## Restore a backup

Always first into a **new** database; the live one is not touched.

```bash
aws s3 ls s3://<BUCKET>/beta/daily/                                   # choose the file
install -m 600 /dev/null /dev/shm/age.key && nano /dev/shm/age.key    # paste the age private key
/opt/ssrs/current/bin/restore.sh --identity /dev/shm/age.key --s3-key beta/daily/<file>.dump.age
```

It prints row counts of the restored copy next to the live ones and shreds `/dev/shm/age.key`
(memory only, never on disk). Inspect the copy if needed
(`ssrs exec postgres psql -U ssrs -d ssrs_restore_…`), then drop it with the command it prints.

A backup taken before the application role existed (before migration
`20261118120000_app_role`) cannot serve the current release: `--replace-live` refuses it and
keeps the restored copy. After a replace, the kept old database is closed to the application role.

**Restore drill:** the same, monthly, and after any change to backups; record it in
[operations.md §2](operations.md).

**Replace the live database** (data loss or corruption only): add `--replace-live`. It asks you to
type the live database name, stops api, worker and web, renames the live database to
`ssrs_before_restore_<time>` (kept, not deleted), puts the restored copy in its place and starts the
app. Afterwards re-run each term's sync to bring marks up to date. When the old copy is no longer
needed: `ssrs exec postgres dropdb -U ssrs ssrs_before_restore_<time>`.

## Rotate a secret

Edit `/opt/ssrs/.env` with `nano`, or generate in place without printing:
`sed -i "s|^NAME=.*|NAME=$(openssl rand -hex 32)|" /opt/ssrs/.env`. Update the password manager.

| Secret                          | Steps                                                                                                                                                                                                                          | Effect                                |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------- |
| `JWT_ACCESS_SECRET`             | generate; `ssrs up -d --force-recreate api`                                                                                                                                                                                    | Everyone is signed out                |
| `REDIS_PASSWORD`                | generate; `ssrs up -d --force-recreate redis api worker`                                                                                                                                                                       | ~30 s of errors; queue kept (AOF)     |
| `POSTGRES_PASSWORD`             | generate; then `p=$(sed -n 's/^POSTGRES_PASSWORD=//p' /opt/ssrs/.env); printf "ALTER USER ssrs PASSWORD '%s';\n" "$p" \| ssrs exec -T postgres psql -U ssrs -d postgres -q; unset p`; `ssrs up -d --force-recreate api worker` | Brief errors while api/worker restart |
| `APP_DB_PASSWORD`               | generate; `ssrs run --rm --no-deps migrate node node_modules/@ssrs/database/dist/cli/app-role.js`; `ssrs up -d --force-recreate api worker`                                                                                    | Brief errors while api/worker restart |
| Google key                      | new key in Google Cloud; `nano /opt/ssrs/secrets/google-sa.json` (keep root:ssrs-secrets 0440); `ssrs up -d --force-recreate api worker`; delete the old key in Google Cloud                                                   | None                                  |
| GHCR token                      | new classic token (`read:packages`); `docker login` as in checklist step 13; revoke the old one                                                                                                                                | None                                  |
| `SENTRY_DSN`, healthchecks URLs | edit; `ssrs up -d --force-recreate api worker` (Sentry) — the URLs are read on each run                                                                                                                                        | None                                  |
| Backup age key                  | new key pair (checklist step 16); replace `age-recipients.txt`. Keep the OLD private key until every backup made with it has expired (8 weeks)                                                                                 | New backups use the new key           |

## Read logs

| What                         | Command                                                                   |
| ---------------------------- | ------------------------------------------------------------------------- |
| Containers and health        | `ssrs ps`                                                                 |
| One service                  | `ssrs logs -f --tail 100 api` (also `worker`, `web`, `caddy`, `postgres`) |
| API errors in the last hour  | `ssrs logs --since 1h api \| grep '"level":50'`                           |
| One request                  | `ssrs logs api \| grep '<X-Request-Id>'`                                  |
| Deploys                      | `cat /opt/ssrs/state/history`; the GitHub job log                         |
| Backups, disk checks, alerts | `journalctl -u ssrs-backup -u ssrs-disk -t ssrs-alert`                    |
| Memory now                   | `docker stats --no-stream`; `free -m`                                     |

Container logs rotate at 10 MB × 3 per container. API and worker logs are JSON with passwords,
tokens, cookies and keys redacted; never paste log lines with student names into tickets or chat.

## Out of memory

Signs: slow pages, `ssrs ps` shows restarts, `dmesg -T | grep -i oom` or
`docker inspect -f '{{.State.OOMKilled}}' <container>` is true, the disk check logs swap above
500 MB.

1. `docker stats --no-stream` and `free -m`: which container is near its limit, how much swap is
   used.
2. A container killed at its limit restarts by itself (`unless-stopped`). If the worker is the one
   (large sheet), keep `WORKER_CONCURRENCY=1`.
3. Short term: `ssrs restart <service>`.
4. **Move to t3.small** when swap use stays above 500 MB (the hourly `ssrs-disk` log line shows it)
   or OOM kills repeat: EC2 → the instance → Instance state → Stop → Actions → Instance settings →
   Change instance type → `t3.small` → Start. The Elastic IP, disk and data stay; Docker starts the
   stack again on boot. About 2 minutes of downtime. Then raise the limits in `deploy/compose.yml`
   in a pull request if needed.

## Out of disk

Signs: the disk check fails (healthchecks.io email, `journalctl -u ssrs-disk`), writes fail.

1. `df -h /` and `docker system df`.
2. Old images: `docker image prune -af --filter until=168h` (the last 3 releases' images are
   pulled again if a rollback needs them).
3. Build cache and stopped containers: `docker builder prune -af`; `docker container prune -f`.
4. Journal: `journalctl --vacuum-size=200M`.
5. Database growth: `ssrs exec postgres psql -U ssrs -d ssrs -c "SELECT pg_size_pretty(pg_database_size('ssrs'))"`.
6. Still full: grow the volume (EC2 → Volumes → Modify → larger size), then on the server
   `growpart /dev/nvme0n1 1 && resize2fs /dev/nvme0n1p1` (check the device with `lsblk`).

## Server lost

Launch a new instance (checklist steps 6, 11–16) and move the Elastic IP to it (EC2 → Elastic IPs
→ Associate, tick "Allow this Elastic IP address to be reassociated"). Update the stack's
`InstanceId` parameter (CloudFormation → the stack → Update → Use current template) and the `beta`
environment secret `EC2_INSTANCE_ID`. The new server has no recorded releases, so deploy by pushing
the last good commit to `beta` again (for example an empty commit through a pull request), then
restore the newest backup with `--replace-live`.
