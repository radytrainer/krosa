# Operations

Last verified: 2026-11-18 (beta setup, not yet run on a server).

Running the system after it is installed ([deployment.md](deployment.md)). Server procedures
(deploy, roll back, restore, rotate secrets, logs, low memory or disk) are in
[runbook.md](runbook.md). Server commands run as root in a Session Manager shell (`sudo -i`);
`ssrs` is `docker compose` for the live release (installed by `scripts/server/bootstrap.sh`).

## 1. Health and logs

| Check            | Command                                                      | Healthy result                    |
| ---------------- | ------------------------------------------------------------ | --------------------------------- |
| Containers       | `ssrs ps`                                                    | every service `running (healthy)` |
| Public check     | `curl -fsS https://<BETA_DOMAIN>/health`                     | `OK`                              |
| Recent errors    | `ssrs logs --since 1h api worker \| grep -i '"level":50'`    | nothing                           |
| Backups and disk | `systemctl list-timers 'ssrs-*'`; `journalctl -t ssrs-alert` | both timers scheduled; no lines   |
| Sync failures    | Admin portal → Dashboard → _Failed syncs_                    | 0 in the last 7 days              |

Logs are JSON, one line per event, with `req.id` (API) or `syncJobId` (worker). Passwords,
tokens, cookies and keys are redacted before logging. If `SENTRY_DSN` is set, unexpected errors also
appear in Sentry (api and worker; the web app has no Sentry yet, [backlog.md](backlog.md)).

## 2. Backups and restore

**What is backed up:** the PostgreSQL database, which holds everything (accounts, results, audit
log). Redis holds the job queue, caches, rate limits, revoked sessions and the worker heartbeat, and
needs no backup. The Google key and `/opt/ssrs/.env` are configuration: keep a copy in the school's
password manager. The age **private** key that decrypts backups is kept there too, never on the
server.

**Automatic:** `ssrs-backup.timer` runs `backup.sh` daily at 19:30 UTC (02:30 Phnom Penh): an
encrypted `pg_dump` uploaded to `s3://<bucket>/beta/daily/` (kept 14 days), plus `beta/weekly/` on
Sundays (kept 8 weeks). Every deploy takes one first. A failure fails the systemd unit, logs to
`journalctl -t ssrs-alert`, and pings healthchecks.io (email).

**On demand, restore drill and real restore:** [runbook.md](runbook.md) "Backups" and "Restore a
backup". `restore.sh` always restores into a new database first; replacing the live one needs a flag
and the typed database name.

| Restore drill | Date | Backup file | Result | By  |
| ------------- | ---- | ----------- | ------ | --- |
|               |      |             |        |     |

## 3. Routine checklists

**Daily (automated, glance at it):** no healthchecks.io email; no failed syncs on the dashboard.

**Weekly:** `ssrs ps` all healthy; `journalctl -u ssrs-disk -n 5` (disk under 80 %, swap under
500 MB); review the audit log for
unexpected `auth.account.locked`, `student.credentials.issued` or `scheme.published` activity.

**Monthly:** restore drill ([runbook.md](runbook.md)); security updates install themselves
(unattended-upgrades): reboot in a quiet hour when `/var/run/reboot-required` exists; update the
pinned base images in a pull request; confirm the certificate renews (Caddy logs).

**Every term:**

- Archive the generation of students who have left (Generations → Archive): its data becomes
  read-only.
- Check each term's release state on its generation page before telling students.
- Remove administrator accounts of staff who no longer need access.

## 4. Common tasks

| Task                             | How                                                                                                                                                                                      |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Add an administrator             | `ssrs run --rm --no-deps api node dist/cli/create-admin.js --username <name>`                                                                                                            |
| A student forgot their password  | Admin portal → Students → the student → _Reset password_                                                                                                                                 |
| Issue first passwords to a class | Students → _Issue credentials_ → by generation and class → CSV                                                                                                                           |
| Disable an account               | Students → the student → _Disable account_ (signs them out everywhere)                                                                                                                   |
| A sync failed                    | Sync center → the job: the failure code and every rejected row with its sheet location. Fix the sheet, then _Retry_                                                                      |
| Release results to students      | Generations → the generation → _Release scores_ on the term                                                                                                                              |
| Change a term's sheet            | Generations → the generation → _Edit_ on the term → _Replace_. Review the tabs, run and confirm the preview, then _Sync now_ ([google-sheets-template.md §6](google-sheets-template.md)) |
| Disconnect a term's sheet        | Same dialog → _Remove_. Scores stay. Blocked during a sync or while a new sheet is waiting                                                                                               |
| Rotate the Google key            | [runbook.md](runbook.md) "Rotate a secret"                                                                                                                                               |
| Rotate `JWT_ACCESS_SECRET`       | [runbook.md](runbook.md) "Rotate a secret" (signs everyone out)                                                                                                                          |

## 5. Pilot plan (first deployment)

Start with **one generation** before moving the whole school onto the system.

1. **Prepare (week 0).** Install on the server ([beta-checklist.md](beta-checklist.md)). Create
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
