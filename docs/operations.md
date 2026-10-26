# Operations

Running the system after it is installed ([deployment.md](deployment.md)). Commands use the alias
`ssrs='docker compose -f docker-compose.prod.yml --env-file .env.production'`, run from the
installation directory.

## 1. Health and logs

| Check | Command | Healthy result |
| --- | --- | --- |
| Containers | `ssrs ps` | all `running` / `healthy`; `migrate` `exited (0)` |
| API and dependencies | `curl -fsS https://<SITE_ADDRESS>/api/v1/health/ready` | HTTP 200 |
| Recent errors | `ssrs logs --since 1h api worker \| grep -i '"level":50'` | nothing |
| Sync failures | Admin portal → Dashboard → *Failed syncs* | 0 in the last 7 days |

Logs are JSON, one line per event, with a `requestId` (API) or `syncJobId` (worker). Passwords,
tokens, cookies and keys are redacted before logging. If `SENTRY_DSN` is set, unexpected errors also
appear in Sentry.

## 2. Backups and restore

**What is backed up:** the PostgreSQL database, which holds everything (accounts, results, audit
log). Redis holds only the job queue and caches and needs no backup. The Google key and
`.env.production` are configuration: keep a copy in the school's password manager.

**Automatic:** the `backup` service writes `BACKUP_DIR/ssrs-YYYYmmdd-HHMMSS.dump` (+ `.sha256`) every
day at `BACKUP_TIME` (UTC) and deletes dumps older than `BACKUP_RETENTION_DAYS`.

**Off-server copy (required):** a backup on the same disk does not survive losing the server. Copy
`BACKUP_DIR` elsewhere daily, e.g. with `rclone`/`rsync` from a cron job on another machine.

**On demand** (before updates or risky changes):

```bash
ssrs exec backup /usr/local/bin/backup.sh --once
```

**Restore drill** (monthly, and after any change to backups). Restores the newest dump into a scratch
database, compares row counts with the live database, then removes the scratch database. The live
data is only read:

```bash
scripts/restore-drill.sh                 # or: scripts/restore-drill.sh backups/<file>.dump
```

It ends with `RESTORE DRILL PASSED`. Record the date below.

**Real restore** (data loss or corruption). This replaces the live database:

```bash
ssrs stop api worker web
ssrs exec -T postgres psql -U "$POSTGRES_USER" -d postgres \
  -c "DROP DATABASE ssrs WITH (FORCE)" -c "CREATE DATABASE ssrs"
ssrs exec -T postgres pg_restore -U "$POSTGRES_USER" --no-owner --no-privileges -d ssrs < backups/<file>.dump
ssrs up -d
```

Everyone is signed out afterwards only if sessions changed; results reflect the backup's moment.
Re-run the sync for each spreadsheet to bring marks back up to date.

| Restore drill | Date | Backup file | Result | By |
| --- | --- | --- | --- | --- |
| | | | | |

## 3. Routine checklists

**Daily (automated, glance at it):** backups ran (`ls -lt backups | head -3`); no failed syncs on
the dashboard.

**Weekly:** `ssrs ps` all healthy; disk space (`df -h`, keep 20 % free); review the audit log for
unexpected `auth.login.locked`, `student.credentials.issued` or `scheme.published` activity.

**Monthly:** restore drill (above); `apt upgrade` and Docker updates on the server, then
`ssrs up -d --build` to pick up patched base images; confirm the certificate renews (Caddy logs).

**Every term:**

- Archive the generation of students who have left (Generations → Archive): its data becomes
  read-only.
- Check that every published course has the right visibility before releasing results.
- Remove administrator accounts of staff who no longer need access.

## 4. Common tasks

| Task | How |
| --- | --- |
| Add an administrator | `ssrs run --rm api node dist/cli/create-admin.js --username <name>` |
| A student forgot their password | Admin portal → Students → the student → *Reset password* |
| Issue first passwords to a class | Students → *Issue credentials* → by generation and class → CSV |
| Disable an account | Students → the student → *Disable account* (signs them out everywhere) |
| A sync failed | Sync center → the job: the failure code and every rejected row with its sheet location. Fix the sheet, then *Retry* |
| Release results to students | Course offerings → the course → *Visible to students* (needs a published grading scheme) |
| Rotate the Google key | Replace `secrets/google-sa.json`, then `ssrs up -d --force-recreate api worker` |
| Rotate `JWT_ACCESS_SECRET` | Edit `.env.production`, `ssrs up -d api` (signs everyone out) |

## 5. Pilot plan (first deployment)

Start with **one generation** before moving the whole school onto the system.

1. **Prepare (week 0).** Install on the production server ([deployment.md](deployment.md)). Create
   one administrator per registrar. Take a backup and run the restore drill.
2. **Connect one generation.** Create the generation, connect its spreadsheet, run *Preview* and fix
   every error it reports in the sheet. Then sync. Compare 10–20 students' final scores with the
   spreadsheet by hand.
3. **Keep results hidden** while checking: courses start hidden unless the sheet's `visible` column
   says otherwise. Publish grading schemes, review a few students in the admin view (it shows hidden
   courses).
4. **Release to a small group.** Issue credentials to one class (CSV, distributed by the class
   teacher), make the courses visible, and collect feedback for one to two weeks: sign-in problems,
   unclear results, wrong marks.
5. **Measure.** Track: students who signed in; support requests and their causes; sync failures; any
   result corrected after release. Agree a go/no-go with the registrar's office.
6. **Expand.** Remaining classes of the generation, then the other generations one at a time.

**Roll back the pilot** at any point by hiding the courses again (students then see nothing) or
disabling the accounts; the spreadsheets remain the source of truth throughout.
