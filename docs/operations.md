# Operations

Last verified: 2026-10-31, commit b222954 plus uncommitted working tree.

Running the system after it is installed ([deployment.md](deployment.md)). Commands use the alias
`ssrs='docker compose -f docker-compose.prod.yml --env-file .env.production'`, run from the
installation directory.

## 1. Health and logs

| Check                | Command                                                   | Healthy result                                    |
| -------------------- | --------------------------------------------------------- | ------------------------------------------------- |
| Containers           | `ssrs ps -a`                                              | all `running` / `healthy`; `migrate` `exited (0)` |
| API and dependencies | `curl -fsS https://<SITE_ADDRESS>/api/v1/health/ready`    | HTTP 200                                          |
| Recent errors        | `ssrs logs --since 1h api worker \| grep -i '"level":50'` | nothing                                           |
| Sync failures        | Admin portal → Dashboard → _Failed syncs_                 | 0 in the last 7 days                              |

Logs are JSON, one line per event, with `req.id` (API) or `syncJobId` (worker). Passwords,
tokens, cookies and keys are redacted before logging. If `SENTRY_DSN` is set, unexpected errors also
appear in Sentry.

## 2. Backups and restore

**What is backed up:** the PostgreSQL database, which holds everything (accounts, results, audit
log). Redis holds the job queue, caches, rate limits, revoked sessions and the worker heartbeat, and needs
no backup. The Google key and
`.env.production` are configuration: keep a copy in the school's password manager.

**Automatic:** the `backup` service writes `BACKUP_DIR/<POSTGRES_DB>-YYYYmmdd-HHMMSS.dump` (+ `.sha256`) every
day at `BACKUP_TIME` (UTC) and deletes dumps older than `BACKUP_RETENTION_DAYS`.

**Off-server copy (required):** a backup on the same disk does not survive losing the server. Copy
`BACKUP_DIR` elsewhere daily, e.g. with `rclone`/`rsync` from a cron job on another machine.

**On demand** (before updates or risky changes):

```bash
ssrs exec backup sh /usr/local/bin/backup.sh --once
```

**Restore drill** (monthly, and after any change to backups). Restores the newest dump into a scratch
database, prints table row counts for you to compare with the live database, then removes the
scratch database. It fails only if the scratch database has no `_prisma_migrations` rows. The live
data is only read. It looks in `./backups`: `BACKUP_DIR` from the env file is not used to choose the
dump, so pass the file if you changed it:

```bash
bash scripts/restore-drill.sh            # or: bash scripts/restore-drill.sh backups/<file>.dump
```

It ends with `RESTORE DRILL PASSED`. Record the date below.

**Real restore** (data loss or corruption). This replaces the live database:

```bash
set -a; . ./.env.production; set +a
ssrs stop api worker web
ssrs exec -T postgres psql -U "$POSTGRES_USER" -d postgres \
  -c "DROP DATABASE \"$POSTGRES_DB\" WITH (FORCE)" -c "CREATE DATABASE \"$POSTGRES_DB\""
ssrs exec -T postgres pg_restore -U "$POSTGRES_USER" --no-owner --no-privileges -d "$POSTGRES_DB" < backups/<file>.dump
ssrs up -d
```

Everyone is signed out afterwards only if sessions changed; results reflect the backup's moment.
Re-run the sync for each spreadsheet to bring marks back up to date.

| Restore drill | Date | Backup file | Result | By  |
| ------------- | ---- | ----------- | ------ | --- |
|               |      |             |        |     |

## 3. Routine checklists

**Daily (automated, glance at it):** backups ran (`ls -lt backups | head -3`); no failed syncs on
the dashboard.

**Weekly:** `ssrs ps` all healthy; disk space (`df -h`, keep 20 % free); review the audit log for
unexpected `auth.account.locked`, `student.credentials.issued` or `scheme.published` activity.

**Monthly:** restore drill (above); `apt upgrade` and Docker updates on the server, then
`ssrs up -d --build` to pick up patched base images; confirm the certificate renews (Caddy logs).

**Every term:**

- Archive the generation of students who have left (Generations → Archive): its data becomes
  read-only.
- Check each term's release state on its generation page before telling students.
- Remove administrator accounts of staff who no longer need access.

## 4. Common tasks

| Task                             | How                                                                                                                                                                                      |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Add an administrator             | `ssrs run --rm api node dist/cli/create-admin.js --username <name>`                                                                                                                      |
| A student forgot their password  | Admin portal → Students → the student → _Reset password_                                                                                                                                 |
| Issue first passwords to a class | Students → _Issue credentials_ → by generation and class → CSV                                                                                                                           |
| Disable an account               | Students → the student → _Disable account_ (signs them out everywhere)                                                                                                                   |
| A sync failed                    | Sync center → the job: the failure code and every rejected row with its sheet location. Fix the sheet, then _Retry_                                                                      |
| Release results to students      | Generations → the generation → _Release scores_ on the term                                                                                                                              |
| Change a term's sheet            | Generations → the generation → _Edit_ on the term → _Replace_. Review the tabs, run and confirm the preview, then _Sync now_ ([google-sheets-template.md §5](google-sheets-template.md)) |
| Disconnect a term's sheet        | Same dialog → _Remove_. Scores stay. Blocked during a sync or while a new sheet is waiting                                                                                               |
| Rotate the Google key            | Replace `secrets/google-sa.json`, then `ssrs up -d --force-recreate api worker`                                                                                                          |
| Rotate `JWT_ACCESS_SECRET`       | Edit `.env.production`, `ssrs up -d api` (signs everyone out)                                                                                                                            |

## 5. Pilot plan (first deployment)

Start with **one generation** before moving the whole school onto the system.

1. **Prepare (week 0).** Install on the production server ([deployment.md](deployment.md)). Create
   one administrator per registrar. Take a backup and run the restore drill.
2. **Connect one generation.** Create the generation, connect each term's sheet, detect its tabs,
   confirm each subject and fix what is reported in the sheet. Then sync. Compare 10–20 students'
   final scores with the spreadsheet by hand.
3. **Keep results hidden** while checking: subjects stay hidden until their term is released. Review
   a few students in the admin view (it shows hidden subjects).
4. **Release to a small group.** Issue credentials to one class (CSV, distributed by the class
   teacher), release the term, and collect feedback for one to two weeks: sign-in problems,
   unclear results, wrong marks.
5. **Measure.** Track: students who signed in; support requests and their causes; sync failures; any
   result corrected after release. Agree a go/no-go with the registrar's office.
6. **Expand.** Remaining classes of the generation, then the other generations one at a time.

**Roll back the pilot** at any point with _Hide scores_ on the term (students then see nothing) or
disabling the accounts; the spreadsheets remain the source of truth throughout.
