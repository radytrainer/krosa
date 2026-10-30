# Documentation review

Reviewed: 2026-10-31. Baseline: commit `b222954` plus the uncommitted working tree (99 changed
paths). The code on disk is the source of truth. Phase 1 only: no other file was changed.

Phase 2 was approved with the recommendations in section 12 and applied on 2026-10-31. Decisions and
follow-up tasks are in [delivery-plan-2027.md](delivery-plan-2027.md). Line numbers below refer to the
docs before Phase 2.

## 1. Scope and mapping

The brief named files and folders that do not exist. Agreed mapping:

| Brief                                | This repo                                                             |
| ------------------------------------ | --------------------------------------------------------------------- |
| `backend/`, `frontend/`              | `apps/api`, `apps/worker`, `packages/*`; `apps/web`                   |
| `CLAUDE.md`, `.claude/rules/*.md`    | Do not exist. Not reviewed                                            |
| `docs/decisions.md` (hard rules)     | `docs/delivery-plan-2027.md` D1–D29, plus rules in the other docs     |
| backlog                              | `docs/delivery-plan-2027.md`, `docs/implementation-plan.md`           |
| `docs/sheet-import-format`           | `docs/google-sheets-template.md`                                      |
| `docs/existing-code-audit.md`        | Does not exist                                                        |
| `docs/api.md`                        | `docs/api-specification.md`                                           |
| `baseline` tag, `git log baseline..` | No tag. `b222954` plus working tree. All new features are uncommitted |
| `codebase-auditor` subagent          | Not available. Four read-only `Explore` agents did the scan           |

Docs reviewed: `README.md` and all 12 existing files in `docs/`.

Evidence level: the four agents read the code statically. I checked these claims myself: the
confirm-time writes in DEV-01 (the `results.service.ts` read was not re-checked), DEV-03, DEV-08,
DEV-09, DEV-10, the missing `.env.production.example`, script file modes, and the stray `prisma/`
folder. Other rows carry the agents' file and line, not a second check. Doc line numbers are from
the working tree on 2026-10-31.

## 2. Command results

Run on 2026-10-31 on Windows, with Docker Postgres and Redis running. No required service was
missing.

| Command                                | Result                                                                   |
| -------------------------------------- | ------------------------------------------------------------------------ |
| `pnpm lint`                            | Pass                                                                     |
| `pnpm typecheck`                       | Pass                                                                     |
| `pnpm test`                            | Pass, 217: shared 51, sheets 114, sync 3, worker 3, api 46               |
| `pnpm build`                           | Pass, 8 of 8 tasks                                                       |
| `pnpm test:integration`                | Pass, 178: database 25, sync 31, api 119, worker 3                       |
| `pnpm test:e2e` (`E2E_CHANNEL=msedge`) | Pass, 12 of 12                                                           |
| `pnpm format:check`                    | **Fail**, 241 files. Expected cause: CRLF checkout on Windows (see F-06) |

Not run: the real workbook check, any production container, a restore drill, a live Google Sheet,
`migrate diff`.

## 3. Summary

Counts are approximate. One row can cover several statements.

| Doc                             | Accurate | Outdated | Wrong | Unverifiable | Missing |
| ------------------------------- | -------- | -------- | ----- | ------------ | ------- |
| `README.md`                     | ~75      | 9        | 0     | 0            | 4       |
| `docs/api-specification.md`     | ~170     | 9        | 4     | 1            | 18      |
| `docs/architecture.md`          | ~75      | 14       | 17    | 3            | 4       |
| `docs/database-design.md`       | ~120     | 14       | 9     | 1            | 2       |
| `docs/delivery-plan-2027.md`    | Most     | 12       | 4     | 4            | 6       |
| `docs/deployment.md`            | ~35      | 0        | 5     | 3            | 1       |
| `docs/google-sheets-template`   | ~57      | 1        | 6     | 5            | 7       |
| `docs/implementation-plan.md`   | Most     | 6        | 2     | 0            | 1       |
| `docs/operations.md`            | ~30      | 6        | 8     | 2            | 1       |
| `docs/progress.md`              | Most     | 10       | 1     | 2            | 1       |
| `docs/requirements.md`          | 75       | 18       | 1     | 2            | 0       |
| `docs/security.md`              | ~85      | 5        | 12    | 5            | 4       |
| `docs/verifying-term-workbooks` | ~27      | 0        | 1     | 5            | 4       |

Route check: all 53 routes in the 10 controllers are in `docs/api-specification.md` with the right
method and path. No missing routes and no stale routes. RabbitMQ and WebSocket claims: none, apart
from the plan rejecting RabbitMQ. BullMQ settings match the docs.

## 4. Deviations

The code contradicts a stated rule. Rules are not rewritten here. Each needs a decision: change the
code, or change the rule on purpose.

### Decisions and sheet rules

| ID     | Rule (doc:line)                                                                                                                                         | What the code does                                                                                                                                                                                                                                                                                       | Evidence                                                                                                                   |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| DEV-01 | Student data stays identical until a sync completes (`verifying-term-workbooks.md:53-54`; the service comment says "Nothing that students see changes") | **Most serious.** Confirming a tab on a pending sheet writes the subject title, `sourceId`, `sheetTab`, and criterion name, category and order at once. Results read those live, so students can see new names before the sync. Marks do not change. A new subject also creates its offering at confirm. | `apps/api/src/sheet-mappings/sheet-mappings.service.ts:267-270,309-315`; `apps/api/src/results/results.service.ts:154,312` |
| DEV-02 | D28: a sync needs a confirmed preview of exactly what it imports                                                                                        | Required only for PENDING sheets. First sheets and every re-sync of an active sheet have no preview. Preview of a non-pending sheet is refused.                                                                                                                                                          | `apps/api/src/sync/sync.service.ts:237`; `packages/sync/src/engine.ts:319`; `sheet-mappings.service.ts:478`                |
| DEV-03 | D22: totals always match the rows shown                                                                                                                 | Stores at most 20,000 issues per job but counts all of them. Above the cap, totals exceed the rows. Parent jobs inherit it.                                                                                                                                                                              | `packages/sync/src/engine.ts:34,64,195-196`; `packages/sync/src/parent.ts:67-68`                                           |
| DEV-04 | D7: an admin releases the subject or term                                                                                                               | Term release only. D16 supersedes D7, so the plan contradicts itself. D6 and plan line 602 share this.                                                                                                                                                                                                   | `apps/api/src/generations/generations.service.ts:144`                                                                      |
| DEV-05 | Rule A1 and "drafts require admin publish" (`architecture.md:112`, `database-design.md:342-345`, `requirements.md:170`)                                 | Sync publishes a new scheme version with no separate publish step. This follows D17, so the older rule looks superseded, not broken.                                                                                                                                                                     | `packages/sync/src/apply-course.ts:206-230`                                                                                |
| DEV-06 | Template: `TOTAL` read only to check weights (`google-sheets-template.md:29`)                                                                           | Stored in `enrollments.sheet_total` on each sync. No API reads it.                                                                                                                                                                                                                                       | `packages/sync/src/apply-course.ts:270-277,291`                                                                            |
| DEV-07 | Template: non-`_` tabs can be marked "Not a subject" (`:15`, `:61`)                                                                                     | A tab with no STUDENT ID header gets no mapping row, so no button, and warns forever.                                                                                                                                                                                                                    | `sheet-mappings.service.ts:596-598`; `packages/sheets/src/term-workbook/read.ts:298-306`                                   |

### Security rules

| ID     | Rule (doc:line)                                                                   | What the code does                                                                                                                                                                                   | Evidence                                                                                                       |
| ------ | --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| DEV-08 | Audit metadata uses an allowlist (`security.md:14,126`; `database-design.md:299`) | Key denylist regex. Unlisted keys pass, including raw `changes: dto`.                                                                                                                                | `apps/api/src/audit/audit.service.ts:17,33`; `generations.service.ts:266,351`; `sheets-sources.service.ts:543` |
| DEV-09 | Revocation fails closed (`security.md:36-38`)                                     | If the denylist write fails it is only logged. Once Redis is back, a miss means "not revoked" without checking `revoked_at`. A revoked access token works until expiry, up to 15 minutes by default. | `apps/api/src/auth/session.service.ts:213-217,241-245`                                                         |
| DEV-10 | Audit `audit_logs` role has INSERT and SELECT only (`database-design.md:303`)     | Production connects as the bootstrap role, which also runs migrations. No GRANT or REVOKE exists anywhere. The only protection is a trigger a privileged role can disable.                           | `docker-compose.prod.yml:13,94`; init migration trigger `audit_logs_append_only`                               |
| DEV-11 | Student services accept the `AuthUser` principal (`security.md:72`)               | They take `userId: string`. The value comes from the session, so no IDOR path was found. The literal rule is still false.                                                                            | `apps/api/src/results/results.service.ts:103,134,138,147,163`                                                  |
| DEV-12 | Exactly one Google mechanism, enforced at startup (`security.md:78-79`)           | Zero is accepted. The app runs and reports `GOOGLE_NOT_CONFIGURED`.                                                                                                                                  | `apps/api/src/config/env.ts:59-60`; `apps/worker/src/config/env.ts:27-29`                                      |
| DEV-13 | Audit kept 3 years, configurable (`security.md:126`)                              | No setting and no purge job. Rows stay forever.                                                                                                                                                      | No match in code; `ssrs.allow_append_only_purge` only in the migration and a test                              |
| DEV-14 | Sync errors kept 1 year (`security.md:133`)                                       | No purge. The only delete is on redelivery.                                                                                                                                                          | `packages/sync/src/engine.ts:221`                                                                              |
| DEV-15 | Backups: 30 daily and 12 monthly (`security.md:133`)                              | 14 daily, no monthly tier. `deployment.md:116` already says 14.                                                                                                                                      | `docker/backup/backup.sh:12,27`; `docker-compose.prod.yml:148`                                                 |
| DEV-16 | Redis dangerous commands disabled (`security.md:135-136`)                         | `requirepass` only. No `rename-command`.                                                                                                                                                             | `docker-compose.prod.yml:118-126`                                                                              |
| DEV-17 | Secret rotation: users silently refresh (`security.md:172`)                       | The CSRF key derives from the same secret. The old cookie fails at `/auth/refresh` with 403 `CSRF_INVALID`, so users must sign in again.                                                             | `apps/api/src/auth/token.service.ts:31`; `session.service.ts:111`; `auth.controller.ts:97`                     |
| DEV-18 | Admin CLI revokes all sessions (`security.md:173`)                                | Does not exist. `apps/api/src/cli/` has only `create-admin`, `read-secret`, `seed-demo`.                                                                                                             | `apps/api/src/cli/`                                                                                            |

### Architecture and deployment rules

| ID     | Rule (doc:line)                                                                             | What the code does                                                                                                                  | Evidence                                                                                 |
| ------ | ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| DEV-19 | A source is not one giant transaction (`architecture.md:127`), short transactions (SYNC-12) | A sheet change is one transaction, up to 300 s. The global roster lock is held throughout, blocking every other sync's roster step. | `packages/sync/src/engine.ts:36,331-406`; `packages/sync/src/apply-roster.ts:49`         |
| DEV-20 | API never runs long sync work (`architecture.md:22`)                                        | Detect and preview read the whole workbook inside the request. Neither uses the queue.                                              | `sheet-mappings.service.ts:486,574`; `packages/sync/src/preview.ts`                      |
| DEV-21 | Sources are never deleted (`database-design.md:331`)                                        | A migration runs a hard `DELETE FROM "google_sheet_sources"`. It runs on `db:deploy`.                                               | `packages/database/prisma/migrations/20261030130000_term_workbooks_only/migration.sql:3` |
| DEV-22 | No client-side copy of the rules (`architecture.md:183`)                                    | The 100% weight rule is recomputed in the browser and disables a button.                                                            | `apps/web/src/components/admin/term-mappings.tsx:46-51,204-222`                          |
| DEV-23 | All app containers have `init: true` (`deployment.md:26`)                                   | `migrate` does not.                                                                                                                 | `docker-compose.prod.yml:92-100`                                                         |

## 5. Decisions D1–D29

| ID  | Status              | Evidence or note                                                                              |
| --- | ------------------- | --------------------------------------------------------------------------------------------- |
| D1  | Accurate            | `apps/api/src/auth/auth.service.ts:45`                                                        |
| D2  | Accurate            | `packages/sheets/src/term-workbook/read.ts:340-348`                                           |
| D3  | Accurate            | `packages/sheets/src/term-workbook/subject-rows.ts:105`                                       |
| D4  | Accurate            | `layout.ts:316-353`. Cross-check runs at detection only, not after an override                |
| D5  | NOT BUILT           | Tables only, `schema.prisma:599-628`. Honest in Sprint 3                                      |
| D6  | NOT BUILT           | Comments stored, not returned. Doc's present tense reads as done                              |
| D7  | DEVIATION           | DEV-04                                                                                        |
| D8  | NOT BUILT           | Tables only, `schema.prisma:199-224`                                                          |
| D9  | Accurate            | `packages/sheets/src/term-workbook/roster.ts:34`                                              |
| D10 | Accurate            | `generations.service.ts:24`                                                                   |
| D11 | Unverifiable        | Deployment scope                                                                              |
| D12 | Accurate            | Files only. No server checked                                                                 |
| D13 | Accurate            | `schema.prisma:24-27`. Printing is process                                                    |
| D14 | Accurate            | Migration `20261030130000_term_workbooks_only`                                                |
| D15 | Accurate            | `apps/api/src/app.module.ts:25-38`                                                            |
| D16 | Accurate            | `generations.service.ts:144-180`. Also hides                                                  |
| D17 | Accurate            | `apply-course.ts:189-241`                                                                     |
| D18 | Unverifiable        | Dev database not inspected for this check                                                     |
| D19 | Accurate            | `sync.service.ts:166-170`; `sync/page.tsx:33-43`                                              |
| D20 | Accurate            | `sync.service.ts:140,273,290`                                                                 |
| D21 | Accurate            | `sync.service.ts:452-500`                                                                     |
| D22 | DEVIATION           | DEV-03                                                                                        |
| D23 | Accurate for scores | `engine.ts:366-379`. See DEV-01 for names                                                     |
| D24 | Accurate            | `engine.ts:319-423`                                                                           |
| D25 | Accurate            | `sheet-mappings.service.ts:439-456`. Also prefills from the last synced sheet after a removal |
| D26 | Accurate            | `read.ts:58-84`                                                                               |
| D27 | Accurate            | No cancel route                                                                               |
| D28 | DEVIATION           | DEV-02                                                                                        |
| D29 | Accurate            | `sheets-sources.service.ts:468-479`. Omits Remove. UI label is now Replace                    |

## 6. Backlog and done tasks

"VERIFIED" means the code or a test that passed in section 2 covers the "Done when" line.

| Doc                      | Verified | Unverified | Note                                |
| ------------------------ | -------- | ---------- | ----------------------------------- |
| `delivery-plan-2027.md`  | 13       | 0          | 1 more is school process (`:650`)   |
| `implementation-plan.md` | 26       | 10         | Sub-tasks in ✅ phases              |
| `progress.md` phases     | 16       | 5          | Phases and requirement groups       |
| `progress.md` run log    | 0        | 7          | 53 historical rows cannot be re-run |

UNVERIFIED tasks:

| Doc:line                                | Task                                        | Why                                                     |
| --------------------------------------- | ------------------------------------------- | ------------------------------------------------------- |
| `implementation-plan.md:15`             | `packages/config` holds ESLint, Prettier    | Only tsconfig files there                               |
| `implementation-plan.md:30`             | `pnpm --filter @ssrs/database admin:create` | No such script. It is `pnpm admin:create` (`@ssrs/api`) |
| `implementation-plan.md:39`             | Catalog, offerings, visibility              | Removed by D15                                          |
| `implementation-plan.md:40`             | Criteria CRUD, scheme drafts and publish    | Removed by D15                                          |
| `implementation-plan.md:42`             | Integration tests per endpoint              | `academic.integration-spec.ts` deleted                  |
| `implementation-plan.md:49-50`          | Template parser and fixtures                | Removed by D14, replaced by `term-workbook/`            |
| `implementation-plan.md:57`             | Batch jobs via BullMQ flows                 | No FlowProducer. Plain child jobs                       |
| `implementation-plan.md:62`             | Scheme draft on weight change test          | Replaced by publish                                     |
| `implementation-plan.md:68`             | EXPLAIN on seeded data                      | No artifact                                             |
| `implementation-plan.md:73-74`          | Offerings, criteria, scheme editor pages    | Pages deleted                                           |
| `progress.md:14,15,18`                  | Phases 3, 4, 7                              | Scope later removed by D14, D15                         |
| `progress.md:29,30,32,36`               | ACAD, CRIT, GS, ADM groups                  | Parts removed                                           |
| `progress.md:70,74,102,111,112,113,123` | Run-log rows                                | Pages, specs or `docs/templates/` deleted               |

Not marked done, but finished:

| Doc:line                                         | Task                                                             | Evidence                                                            |
| ------------------------------------------------ | ---------------------------------------------------------------- | ------------------------------------------------------------------- |
| `delivery-plan-2027.md:582`                      | Anonymized fixture                                               | `packages/sheets/src/testing/term-workbook-fixture.ts`              |
| `delivery-plan-2027.md:583`                      | Sprint 1                                                         | `term-workbook/*`; `read.spec.ts`                                   |
| `delivery-plan-2027.md:584`                      | Sprint 2, except `content_hash`                                  | `sheet-mappings.*`; `term-mappings.tsx`; engine spec                |
| `delivery-plan-2027.md:585`                      | Sprint 3 part: term release, Playwright, template doc            | `e2e/tests/scenario.spec.ts`                                        |
| `implementation-plan.md:87-93`, `progress.md:21` | Phase 10 artifacts. Files only: nothing shows it ran on a server | `Dockerfile`; `docker-compose.prod.yml`; `.github/workflows/ci.yml` |

**Lost test coverage.** Deleting `apps/api/test/academic.integration-spec.ts` removed the only tests
for: disabling revokes sessions and blocks login, activating PENDING accounts only by issuing
credentials, the password-reset behaviour (shown once, revokes), audit-log listing, generation
pagination, and 404 and 400 handling. The code is still there. `sources.integration-spec.ts` was
also deleted, and its behaviour is covered by the term-workbook specs.

Built outside the backlog, to add as tasks: removing a sheet, Discard, sheet history and going back
to an earlier sheet, Workbooks by term, Reopen tab, TERM scope, `sync/targets`, one running sync per
term, issues filters, and the sheet controls in Edit term.

## 7. Findings by doc

### `README.md`

| Line    | Claim                               | Status   | Evidence                                                                        | Proposed edit                                        |
| ------- | ----------------------------------- | -------- | ------------------------------------------------------------------------------- | ---------------------------------------------------- |
| 7-8     | Phase 10 is next                    | OUTDATED | `Dockerfile`, `docker-compose.prod.yml`, `ci.yml`, `e2e/tests/scenario.spec.ts` | Restate status                                       |
| 29      | Dry-run preview, then sync          | OUTDATED | `sheet-mappings.service.ts:476-481`                                             | Connect, detect, confirm, sync; preview for changes  |
| 30      | Offerings with criteria and schemes | OUTDATED | `app.module.ts:24-39`                                                           | Subject tabs, weights on mapping, term release       |
| 142     | Dashboard text                      | OUTDATED | `apps/web/src/app/admin/page.tsx:118-124`                                       | Update                                               |
| 144-145 | Edit scheme, Publish                | OUTDATED | Pages deleted                                                                   | Delete. Demo Art & Design has no UI path to a scheme |
| 146     | Offerings, Visible to students      | OUTDATED | `generations/[id]/page.tsx:338`                                                 | Release scores on the term                           |
| 147     | Audit log lists scheme publication  | OUTDATED | `apply-course.ts:234`                                                           | Say `term.released`                                  |
| 214,230 | "Google not configured"             | OUTDATED | `generations/[id]/page.tsx:262`                                                 | "Google access is not configured"                    |
| 247     | `scripts/`: load test               | OUTDATED | `scripts/`                                                                      | List all four                                        |
| 24-39   | Features                            | MISSING  | Tab mapping, term release, sheet change                                         | Add                                                  |
| 189-195 | Automated checks                    | MISSING  | `package.json:24`                                                               | Add `pnpm test:e2e`                                  |
| 237-248 | Repo layout                         | MISSING  | `e2e/`, `docker/`, compose files                                                | Add                                                  |
| 252-259 | Doc list                            | MISSING  | 4 docs unlisted                                                                 | Add                                                  |

### `docs/api-specification.md`

| Line     | Claim                                     | Status       | Evidence                                                                                     | Proposed edit                             |
| -------- | ----------------------------------------- | ------------ | -------------------------------------------------------------------------------------------- | ----------------------------------------- |
| 3-4      | Swagger on outside production             | OUTDATED     | `apps/api/src/bootstrap.ts:53`; `config/env.ts:15`                                           | Only when `SWAGGER_ENABLED=true`          |
| 4        | Swagger behind admin network rules        | UNVERIFIABLE | `docker/caddy/Caddyfile:17`                                                                  | Remove the phrase or add the rule         |
| 11-13    | Cookies always Secure                     | OUTDATED     | `auth/cookies.ts:22`                                                                         | Secure when `COOKIE_SECURE`               |
| 16       | Origin must match `WEB_ORIGIN`            | OUTDATED     | `auth/guards/csrf.guard.ts:18-30,46-48`                                                      | Add `CORS_ORIGINS`, Referer fallback      |
| 25       | Validation `details` carry `field`        | WRONG        | `common/http-exception.filter.ts:81-83`                                                      | `field` optional                          |
| 33       | Status code list                          | MISSING      | `sheets-sources/sheets-errors.ts:22-29`                                                      | Add 502                                   |
| 56-57    | Rounded values beside exact decimals      | OUTDATED     | `packages/shared/src/results.ts:4-5`                                                         | State 3dp and 2dp                         |
| 67       | Refresh errors                            | MISSING      | `auth/session.service.ts:29,124-126`                                                         | Add `ACCOUNT_NOT_ACTIVE`                  |
| 70       | `student?:` optional                      | WRONG        | `auth/auth.service.ts:335`                                                                   | Always present, may be null               |
| 75       | Unknown offerings give the same 404       | WRONG        | `results/student-results.controller.ts:39`                                                   | "Well-formed unknown IDs"                 |
| 81,91-95 | Profile fields                            | MISSING      | `results.ts:7-14`                                                                            | Add                                       |
| 108-139  | `invalidMark` only on bad marks           | MISSING      | `results.ts:27,32`                                                                           | Update example                            |
| 164      | Generation detail fields                  | MISSING      | `generations.service.ts:45-49,134-138`                                                       | Add `subjects`, `visibleSubjects`         |
| 165,169  | PATCH errors                              | MISSING      | `generations.service.ts:251,337`                                                             | Add `INVALID_DATE_RANGE`                  |
| 166      | Archive makes criteria, schemes read-only | OUTDATED     | `academic/academic-guard.service.ts:8-9`. Discard, preview and confirm preview have no guard | Reword. Decide on the 3 unguarded actions |
| 177      | Create source errors                      | MISSING      | `sheets-sources.service.ts:374-387`                                                          | Add codes; removed sheet can return       |
| 179      | PATCH source errors                       | MISSING      | `sheets-sources.service.ts:506-528`                                                          | Add `NOT_PENDING` and others              |
| 181      | Detect effects and errors                 | MISSING      | `sheet-mappings.service.ts:564-570,664-670`                                                  | Add                                       |
| 183      | Check errors                              | MISSING      | `sheets-sources.service.ts:224`                                                              | Add `SOURCE_EXISTS`                       |
| 190      | Confirm errors                            | MISSING      | `packages/shared/src/grading/grading.ts:38-44`                                               | Add                                       |
| 193      | Release errors                            | MISSING      | `generations.service.ts:152`                                                                 | Add                                       |
| 204      | Issue audit action                        | WRONG        | `students/students.service.ts:262,318`                                                       | State all three actions                   |
| 204      | Over 500 IDs, row layout                  | MISSING      | `students/students.dto.ts:52`                                                                | 400; escape the pipe                      |
| 210      | POST sync errors                          | MISSING      | `sync.service.ts:237-240`                                                                    | Add `PREVIEW_*`                           |
| 210      | One child per active source               | OUTDATED     | `sync.service.ts:268-273`                                                                    | Needs a confirmed tab; `termNumber`       |
| 212      | Job fields                                | MISSING      | `sync.service.ts:66,89`                                                                      | Add `termNumber`                          |
| 217      | Status, phase, failure codes              | MISSING      | `schema.prisma:706`; `engine.ts:192,236,322,325`                                             | Add                                       |
| 219      | `schemes.drafted`, `skipped`              | OUTDATED     | `apply-course.ts:206-240`                                                                    | Mark always 0, or remove                  |
| 221      | 9 apply-time codes                        | OUTDATED     | 0 hits in code. Live `OFFERING_NOT_FOUND` absent                                             | Delete 9, add 1 (listed in section 9)     |
| 223      | Heading "Admin accounts & audit"          | OUTDATED     | Only audit and dashboard routes                                                              | Rename                                    |

### `docs/architecture.md`

| Line        | Claim                                   | Status       | Evidence                                                          | Proposed edit                             |
| ----------- | --------------------------------------- | ------------ | ----------------------------------------------------------------- | ----------------------------------------- |
| 16,21-22    | Only worker touches Google              | OUTDATED     | `sheet-mappings.service.ts:486,574`                               | Update (DEV-20)                           |
| 20          | Next.js rewrites proxy                  | OUTDATED     | `apps/web/src/proxy.ts:34,52-54`                                  | `proxy.ts` forwards to `API_INTERNAL_URL` |
| 41          | database holds seed and admin CLI       | WRONG        | `apps/api/src/cli/`                                               | Point to apps/api                         |
| 43          | shared has enums, Zod shared with web   | WRONG        | `packages/shared/src/env.ts`                                      | Describe real contents                    |
| 44          | sheets: template parser                 | OUTDATED     | `term-workbook/`                                                  | Update                                    |
| 47          | config: ESLint, Prettier                | WRONG        | `packages/config/package.json:5-11`                               | "tsconfig bases"                          |
| 49          | scripts list                            | OUTDATED     | `docker/backup/backup.sh`; `scripts/`                             | Correct                                   |
| 51          | docker/ has Dockerfiles                 | WRONG        | Root `Dockerfile`                                                 | Correct                                   |
| 52          | compose runs api, worker, web           | WRONG        | `docker-compose.yml`                                              | postgres, redis                           |
| 53          | prod compose is overrides               | WRONG        | `docker-compose.prod.yml`                                         | Complete stack                            |
| 66-68       | ConfigModule, PrismaModule, RedisModule | WRONG        | `app.module.ts:25,27`                                             | EnvModule, InfraModule                    |
| 69          | JWT strategy                            | WRONG        | `auth/guards/auth.guard.ts:16`                                    | AuthGuard with `jose`                     |
| 70          | UsersModule                             | WRONG        | `students.controller.ts:51,93`                                    | Remove                                    |
| 71          | StudentsModule has self-profile         | WRONG        | `results/student-results.controller.ts:12-19`                     | Move to ResultsModule                     |
| 73          | TermsModule                             | WRONG        | `generations.controller.ts:80-97`                                 | Remove                                    |
| 74          | EnrollmentModule                        | WRONG        | No module                                                         | Remove                                    |
| 75          | AssessmentCriteriaModule                | OUTDATED     | `app.module.ts`                                                   | Remove                                    |
| 77          | GoogleSheetsModule                      | OUTDATED     | `app.module.ts:35`                                                | SheetsSourcesModule                       |
| 81          | Terminus                                | WRONG        | `health.controller.ts:11-28`                                      | Hand-written probes                       |
| 64-81       | Module table                            | MISSING      | `app.module.ts:30,38`                                             | Add AcademicModule, DashboardModule       |
| 89-90       | `sync.batch`, BullMQ flows              | WRONG        | `packages/shared/src/sync.ts:6`                                   | Parent is a DB row                        |
| 103         | Guard: source ACTIVE                    | OUTDATED     | `engine.ts:240`                                                   | "Not DISABLED"                            |
| 104         | 1 metadata + 2 batched requests         | OUTDATED     | `read.ts:253,313`                                                 | 1 + 1                                     |
| 112         | Offering and scheme, A1                 | OUTDATED     | `sheet-mappings.service.ts:271`; `apply-course.ts:202-230`        | See DEV-05                                |
| 119-120     | Per-source index                        | MISSING      | `schema.prisma:752`                                               | Add per-term index                        |
| 127         | Source is not one transaction           | OUTDATED     | `engine.ts:331-406`                                               | See DEV-19                                |
| 134         | One child per active source             | OUTDATED     | `sync.service.ts:267-311`                                         | Add conditions                            |
| 147-148     | Sweep ignores jobs under 2 min          | WRONG        | `sync.processor.ts:70,86`                                         | Periodic only                             |
| 165-167     | Cache bumps                             | OUTDATED     | `generations.service.ts:165,259,344`; `engine.ts:386,505`         | Update                                    |
| 171-174     | Routes include offerings, schemes       | OUTDATED     | `apps/web/src/app/admin/`                                         | Remove                                    |
| 180-181     | `/admin/offerings` example              | OUTDATED     | No such route                                                     | Use another path                          |
| 183         | No client-side rules                    | WRONG        | `term-mappings.tsx:46-51,204-222`                                 | See DEV-22                                |
| 214         | Apps via all-in-compose                 | WRONG        | `docker-compose.yml`                                              | Remove                                    |
| §4-5        | Worker and pipeline                     | MISSING      | `engine.ts:319-423`; `confirmed.ts`; `apps/worker/src/heartbeat/` | Add sheet-change flow                     |
| 57          | No root `prisma/` folder                | MISSING      | See F-05                                                          | Delete folder, no doc change              |
| 160,198,202 | Query count, TS 7, Prisma 8             | UNVERIFIABLE | Query log or external                                             | Leave                                     |

### `docs/database-design.md`

| Line    | Claim                            | Status       | Evidence                                           | Proposed edit                        |
| ------- | -------------------------------- | ------------ | -------------------------------------------------- | ------------------------------------ |
| 5       | `@default(uuid())`               | OUTDATED     | `schema.prisma:46`                                 | `uuid(7)`, note exceptions           |
| 11      | Partial uniques in raw SQL       | OUTDATED     | `schema.prisma:96,315,575`                         | CHECKs and triggers only             |
| 17-27   | ER diagram                       | OUTDATED     | Eight tables and terms→sources absent              | Redraw                               |
| 38-39   | enums `user_role`, `user_status` | WRONG        | Init migration lines 8, 11                         | `"UserRole"`, `"UserStatus"`         |
| 61      | `revoke_reason` text             | WRONG        | `schema.prisma:36-43,89`                           | Enum `SessionRevokeReason`           |
| 122     | `visibility_overridden` effect   | OUTDATED     | `apply-course.ts:45`; `generations.service.ts:157` | Mark vestigial                       |
| 123     | NULL means created manually      | OUTDATED     | `sheet-mappings.service.ts:271-279`                | Correct                              |
| 129-143 | google_sheet_sources             | OUTDATED     | `schema.prisma:286-318`                            | Add term, roster, ignored, PENDING   |
| 147-159 | students                         | OUTDATED     | `schema.prisma:445-464`                            | Add columns                          |
| 161-172 | enrollments                      | OUTDATED     | `schema.prisma:482-484`                            | Add columns                          |
| 186     | `sheet_column_key` default       | WRONG        | `schema.prisma:526`                                | Mark unused                          |
| 199     | `total_weight` maintained by app | OUTDATED     | `apply-course.ts:222`                              | Correct                              |
| 207-233 | Items, scores; trigger           | WRONG        | Init migration                                     | Add `offering_id`; blocks INSERT     |
| 255-273 | sync_jobs                        | OUTDATED     | `schema.prisma:715,729,731,752,756`                | Add                                  |
| 263     | Phases                           | WRONG        | `engine.ts:192,227,286,316`                        | FETCH, WAITING_RETRY, APPLY, DONE    |
| 299     | Allowlist                        | WRONG        | `audit.service.ts:17,33`                           | See DEV-08                           |
| 303     | INSERT and SELECT only           | WRONG        | No GRANT                                           | See DEV-10                           |
| 315     | CHECKs in init only              | OUTDATED     | Two later migrations                               | "In migrations"                      |
| 330     | Optional FKs use SET NULL        | WRONG        | `schema.prisma:352,418`                            | Note exceptions                      |
| 331     | Sources never deleted            | WRONG        | Migration                                          | See DEV-21                           |
| 336     | Quiz 4 adds a draft item         | OUTDATED     | `apply-course.ts:216-230`                          | Correct                              |
| 340     | Sheet references `key`           | OUTDATED     | `schema.prisma:402-423`                            | By column index                      |
| 342-345 | Mark validation                  | OUTDATED     | `layout.ts:20`; `subject-rows.ts:103`              | Fixed max 100                        |
| §2      | Tables and enums                 | MISSING      | 8 tables, 2 enums                                  | Add. Flag programs and grades unused |
| §2      | Indexes and CHECKs               | MISSING      | 4 indexes, 6 CHECKs                                | Add                                  |
| 316     | `migrate diff` empty             | UNVERIFIABLE | Not run in this review                             | Re-run                               |

### `docs/delivery-plan-2027.md`

| Line            | Claim                                                                                                             | Status           | Evidence                                         | Proposed edit               |
| --------------- | ----------------------------------------------------------------------------------------------------------------- | ---------------- | ------------------------------------------------ | --------------------------- |
| 8-12            | 181 unit, 143 integration                                                                                         | OUTDATED         | Section 2: 217 and 178                           | Point to verifying doc      |
| 14,18-26        | Existing strict parser                                                                                            | OUTDATED         | D14                                              | Past tense                  |
| 97              | Additive, one migration                                                                                           | WRONG            | 5 migrations; `term_workbooks_only` deletes rows | State the actual migrations |
| 105,232-235     | `layout`, STRICT_V1, nullable term                                                                                | OUTDATED         | `schema.prisma:295`                              | Correct                     |
| 111,318         | `sync_jobs.content_hash`                                                                                          | WRONG            | Absent. `last_content_hash` unused               | Fix or build                |
| 387             | Unchanged hash skips tab                                                                                          | NOT BUILT        | `engine.ts`                                      | Mark                        |
| 190,280         | Roles PROFILE, PROGRAM                                                                                            | OUTDATED         | `schema.prisma:388-400`                          | Actual enum                 |
| 264             | UNIQUE (offering_id)                                                                                              | OUTDATED         | `schema.prisma:358`                              | Update                      |
| 242             | Scale seeded with intake                                                                                          | NOT BUILT        | `generations.service.ts:193-207`                 | Mark                        |
| 283-285,347     | Draft then published                                                                                              | OUTDATED         | D17                                              | Published at next sync      |
| 352-354,641     | Cross-check confirms MsOffice weights                                                                             | WRONG            | `layout.ts:285`; `read.spec.ts:149`              | "Verify manually" or build  |
| 370,507,508,599 | Dry-run preview, two scopes                                                                                       | OUTDATED         | `sync.dto.ts:17`                                 | Rewrite                     |
| 390,409,623     | PROGRAM_MISMATCH                                                                                                  | NOT BUILT        | No code                                          | Mark                        |
| 406             | Error scope TAB                                                                                                   | OUTDATED         | `read.ts:303`                                    | COURSE                      |
| 442,512         | `letter`, `teacherComment`                                                                                        | NOT BUILT        | `results.service.ts:298-334`                     | Mark                        |
| 472-492         | Module tree                                                                                                       | OUTDATED         | `app.module.ts`                                  | Redraw                      |
| 499-500,510-511 | Program, grade-scale endpoints                                                                                    | NOT BUILT        | Route list                                       | Mark                        |
| 504             | PUT mappings/:id                                                                                                  | WRONG            | `sheet-mappings.controller.ts:32`                | Remove                      |
| 561,565         | Audit rows                                                                                                        | NOT BUILT (part) | Service files                                    | Split row, add new actions  |
| 602             | Release per subject or term                                                                                       | OUTDATED         | D16                                              | "Per term"                  |
| 600,606,640     | Programs, filter, scale in checklist                                                                              | NOT BUILT        | No code                                          | Mark                        |
| 642             | R6 preview before sync                                                                                            | OUTDATED         | First sheet has none                             | "For replacement sheets"    |
| 661-664         | Next three actions                                                                                                | OUTDATED         | Sprint 1 done                                    | Replace                     |
| 44,62           | Confirmed dates                                                                                                   | UNVERIFIABLE     | Migrations dated 20261031                        | You confirm                 |
| 521-523,528     | Key on machine, quota                                                                                             | UNVERIFIABLE     | Not read                                         | Leave                       |
| New             | Remove a sheet, Discard, history, reconnect                                                                       | MISSING          | `sheets-sources.service.ts:325-352,380,482-513`  | Add decision D30            |
| New             | Preview and check endpoints, Workbooks by term, Reopen, TERM scope, `sync/targets`, per-term limit, audit actions | MISSING          | Controllers                                      | Add to C.2                  |

### `docs/deployment.md`

| Line    | Claim                                    | Status       | Evidence                                   | Proposed edit                    |
| ------- | ---------------------------------------- | ------------ | ------------------------------------------ | -------------------------------- |
| 44,100  | `cp .env.production.example`             | WRONG        | Not on disk; `.gitignore:14-16` ignores it | Create it, add a `!` rule (F-01) |
| 26      | `init: true` everywhere                  | WRONG        | `docker-compose.prod.yml:92-100`           | See DEV-23                       |
| 92      | Run `backup.sh --once` directly          | WRONG        | Git mode 100644                            | Prefix `sh` or chmod             |
| 100     | All settings come from `.env.production` | WRONG        | 8 variables not passed through (section 8) | Pass them, or say so             |
| 111     | `GOOGLE_SA_FILE` required                | WRONG        | `docker-compose.prod.yml:155`              | Has a default                    |
| 121     | CI on every push                         | WRONG        | `.github/workflows/ci.yml:4-6`             | Main and PRs                     |
| 105-117 | Config table                             | MISSING      | `docker-compose.prod.yml:13`               | Add `LOG_LEVEL`                  |
| 48-50   | Key readable only by root                | UNVERIFIABLE | `Dockerfile:68`: containers run as `node`  | Test on a server                 |
| 57      | `ps` shows migrate exited                | UNVERIFIABLE | Not run                                    | Probably `ps -a`                 |
| 31-32   | Sizing, Docker 27+                       | UNVERIFIABLE | No code evidence                           | Leave                            |

### `docs/google-sheets-template.md`

| Line         | Claim                                 | Status        | Evidence                                                      | Proposed edit                                     |
| ------------ | ------------------------------------- | ------------- | ------------------------------------------------------------- | ------------------------------------------------- |
| 15,61        | Tabs can be marked Not a subject      | WRONG (edge)  | DEV-07                                                        | State the exception                               |
| 29           | `TOTAL` only checked                  | WRONG (minor) | DEV-06                                                        | "Also stored, never used for results"             |
| 60           | Renamed tab: nothing to do            | WRONG (edge)  | `sheet-mappings.service.ts:282-290,586-594,616`               | Detect shows a duplicate draft: do not confirm it |
| 69           | Check link, then term shows new sheet | WRONG         | `term-sheet.tsx:129-137`                                      | Check sheet, then Connect new sheet               |
| 79           | Discard at any time                   | WRONG (minor) | `sheets-sources.service.ts:332`                               | Except during a sync                              |
| 94           | `TERM_SOURCE_EXISTS`: disable first   | OUTDATED      | `sheets-sources.service.ts:387-398`                           | Use Replace or Remove; add `USE_CHANGE_SHEET`     |
| 12           | ALL lists five columns                | MISSING       | `roster.ts:50-60`; `labels.ts:52-61`                          | Required and optional                             |
| 37,57,59     | Bad row skipped                       | MISSING       | `engine.ts:329,363`                                           | Active sheets only                                |
| 78           | What voids a preview                  | MISSING       | `engine.ts:320-322,497-501`                                   | Add                                               |
| §3           | Retry, job outcomes, bulk sync        | MISSING       | `sync/[id]/page.tsx:193,214`; `generations/[id]/page.tsx:422` | Add                                               |
| §4           | Deleted tab, unmapped column          | MISSING       | Issue codes                                                   | Add rows                                          |
| §6           | Error list                            | MISSING       | Section 9                                                     | Extend                                            |
| 8,17,102-105 | File name, Google menus               | UNVERIFIABLE  | External                                                      | Leave. Add `GOOGLE_ERROR`                         |

### `docs/implementation-plan.md`

| Line     | Claim              | Status   | Evidence                     | Proposed edit          |
| -------- | ------------------ | -------- | ---------------------------- | ---------------------- |
| 15       | config contents    | WRONG    | `packages/config`            | Fix                    |
| 20       | postgres 16        | OUTDATED | `docker-compose.yml:9`       | 17                     |
| 30       | Admin command      | WRONG    | `apps/api/package.json:13`   | `pnpm admin:create`    |
| 39-42    | Phase 3 scope      | OUTDATED | D15                          | Annotate               |
| 49-51    | Phase 4 template   | OUTDATED | D14                          | Annotate               |
| 57       | BullMQ flows       | OUTDATED | `sync.service.ts:298-328`    | "Independent jobs"     |
| 62,73-74 | Draft, editor      | OUTDATED | Deleted                      | Annotate               |
| 87-93    | Phase 10, 10 steps | OUTDATED | 12 steps                     | Update                 |
| New      | Stops at Phase 10  | MISSING  | Term workbooks, sheet change | Link the delivery plan |

### `docs/operations.md`

| Line                  | Claim                        | Status       | Evidence                                            | Proposed edit                     |
| --------------------- | ---------------------------- | ------------ | --------------------------------------------------- | --------------------------------- |
| 16                    | Logs carry `requestId`       | WRONG        | `apps/api/src/common/logger.ts:35,42-46`            | `req.id`                          |
| 23                    | Redis holds queue and caches | WRONG        | `session.service.ts:10`; `login-rate-limiter.ts:17` | Add limits, revoked, heartbeat    |
| 26                    | Backup is `ssrs-…dump`       | WRONG        | `docker/backup/backup.sh:19`                        | `<POSTGRES_DB>-…`                 |
| 35                    | `backup.sh --once`           | WRONG        | Mode 100644                                         | Same as deployment:92             |
| 39                    | Drill compares row counts    | WRONG        | `scripts/restore-drill.sh:16,31,44-51`              | Prints only; `BACKUP_DIR` ignored |
| 43                    | Run the drill directly       | WRONG        | Mode 100644                                         | `bash scripts/…`                  |
| 52-54                 | Restore commands             | WRONG        | `docker-compose.prod.yml:103`                       | Load env; use `$POSTGRES_DB`      |
| 71                    | `auth.login.locked`          | WRONG        | `auth.service.ts:166`                               | `auth.account.locked`             |
| 80,92,102,105,106,115 | Course steps                 | OUTDATED     | `generations/[id]/page.tsx:312-338`                 | Rewrite for term release          |
| §4                    | Common tasks                 | MISSING      | `sheets-sources.controller.ts:69-79`                | Add changing a sheet              |
| 58,61-63              | Sign-out, drill log          | UNVERIFIABLE | No drill recorded                                   | Run one                           |

### `docs/progress.md`

| Line        | Claim                    | Status       | Evidence                                           | Proposed edit           |
| ----------- | ------------------------ | ------------ | -------------------------------------------------- | ----------------------- |
| 5           | Last updated 2026-10-30  | OUTDATED     | Later work                                         | Update                  |
| 21          | Phase 10 not started     | OUTDATED     | Artifacts exist                                    | In progress             |
| 22          | Sprint 2 next            | OUTDATED     | Built                                              | Add rows                |
| 43          | Two migrations           | OUTDATED     | 7 in total                                         | List                    |
| 48          | 11 of 11 steps           | OUTDATED     | Section 2: 12                                      | Update                  |
| 145-146     | Compose, CI are Phase 10 | OUTDATED     | All exist                                          | Remove                  |
| 166         | A1 as default            | OUTDATED     | D17                                                | Update                  |
| 32,170      | Live test needs a key    | OUTDATED     | `:47`                                              | Needs the sheet URL     |
| 49          | Build failure cause      | WRONG        | Disagrees with `verifying-term-workbooks.md:85-87` | Corrupted `.next` cache |
| 143-144,155 | SIGTERM, port            | UNVERIFIABLE | Not run; `.env` not read                           | Leave                   |
| New         | Later work               | MISSING      | Section 6                                          | Add                     |

### `docs/requirements.md`

No note says the delivery plan overrides it. Proposed: add one at the top.

| Line    | Claim                      | Status       | Evidence             | Proposed edit |
| ------- | -------------------------- | ------------ | -------------------- | ------------- |
| 41      | ACAD-03 catalog managed    | OUTDATED     | D15                  | Tables only   |
| 53-54   | CRIT-04, 05                | OUTDATED     | D15                  | Tab review    |
| 75      | GS-01 several URLs         | OUTDATED     | `schema.prisma:315`  | Rewrite       |
| 77,165  | `_meta` required           | OUTDATED     | `read.ts:200`        | Optional      |
| 79      | GS-05 standard template    | OUTDATED     | D14                  | Rewrite       |
| 80      | GS-06 reordering tolerated | OUTDATED     | `read.ts:340`        | Rewrite       |
| 91,171  | SYNC-05 advisory lock      | OUTDATED     | `apply-roster.ts:49` | Rewrite       |
| 92      | SYNC-06 PARTIAL            | WRONG        | `parent.ts:60`       | Fix the name  |
| 121-123 | ADM page list              | OUTDATED     | 6 nav entries        | Rewrite       |
| 147-157 | A1, A3, A6, A9, A11        | OUTDATED     | D17, D9, D16, D5     | Replace       |
| 166     | Machine key row 1          | OUTDATED     | Header signature     | Update        |
| 170     | Drafts need admin publish  | OUTDATED     | D17                  | Update        |
| 117,141 | STU-05, tested restore     | UNVERIFIABLE | Not run              | Leave         |

### `docs/security.md`

| Line              | Claim                                 | Status       | Evidence                                | Proposed edit                                            |
| ----------------- | ------------------------------------- | ------------ | --------------------------------------- | -------------------------------------------------------- |
| 11                | CSP via Next.js headers               | OUTDATED     | `apps/web/src/proxy.ts:13-26,64`        | Per-request nonce CSP                                    |
| 13                | Draft schemes control                 | OUTDATED     | `apply-course.ts:184-188,216-230`       | Mapping confirmation, preview                            |
| 14,126            | Allowlist                             | WRONG        | DEV-08                                  | Decision                                                 |
| 21-25             | Login errors reveal nothing           | MISSING      | `auth.service.ts:75-82`                 | `ACCOUNT_LOCKED` exposes existence: document or equalize |
| 29                | Admins unlock by reset                | MISSING      | `students.service.ts:198-211`           | Students only                                            |
| 37                | Denylist TTL = access TTL             | WRONG        | `session.service.ts:237`                | TTL + 60 s                                               |
| 38                | Rejects revoked sessions              | WRONG        | DEV-09                                  | Decision                                                 |
| 44-45             | Password policy                       | MISSING      | `auth/password-policy.ts:63,65`         | Add                                                      |
| 72                | `AuthUser` principal                  | WRONG        | DEV-11                                  | Decision                                                 |
| 78-79             | Exactly one mechanism                 | WRONG        | DEV-12                                  | Decision                                                 |
| 81                | API credentials for registration only | OUTDATED     | `sheet-mappings.service.ts:486,574`     | Add detect, check, preview                               |
| 118               | `requestId` from header               | OUTDATED     | `logger.ts:6,26`; `Caddyfile:19`        | Reword                                                   |
| 119-120           | Redaction list, also worker           | WRONG        | `logger.ts:9-21`; `worker.module.ts:23` | State both lists                                         |
| 126,133           | Retention                             | WRONG        | DEV-13, 14, 15                          | Decision                                                 |
| 133               | App logs 30 days                      | UNVERIFIABLE | No `logging:` config                    | Name the mechanism                                       |
| 134               | Fixtures synthetic only               | UNVERIFIABLE | Not reviewed                            | Leave                                                    |
| 136               | Redis commands disabled               | WRONG        | DEV-16                                  | Decision                                                 |
| 155               | 16-character temporary password       | OUTDATED     | `password.service.ts:66`                | 16 plus hyphens                                          |
| 92-93,164-167,171 | SRI, handover, placeholders           | UNVERIFIABLE | History or process; values not read     | Leave                                                    |
| 172               | Silent refresh on rotation            | WRONG        | DEV-17                                  | Decision                                                 |
| 173               | Revoke-all CLI                        | WRONG        | DEV-18                                  | Decision                                                 |

### `docs/verifying-term-workbooks.md`

| Line     | Claim                                | Status       | Evidence                             | Proposed edit             |
| -------- | ------------------------------------ | ------------ | ------------------------------------ | ------------------------- |
| 30       | API integration 116, total 175       | OUTDATED     | Section 2: 119 and 178               | Update                    |
| 53-54    | Student data stays identical         | WRONG        | DEV-01                               | "Scores", or fix the code |
| 62,69-70 | Real file figures, `RESULT: OK`      | UNVERIFIABLE | Fixture is synthetic                 | Run it                    |
| 74,77,85 | Generation name, weights, panic text | UNVERIFIABLE | Data or external                     | Leave                     |
| §1-2     | Shell and environment                | MISSING      | `e2e/support/stack.ts:21-23`         | Add test URLs; PowerShell |
| §3       | Script prerequisites and flags       | MISSING      | `verify-term-workbook.mjs:8-9,28-30` | Add                       |
| §4       | App prerequisites                    | MISSING      | `pnpm admin:create`                  | Add                       |
| Scenario | Step count                           | OUTDATED     | `scenario.spec.ts`: 12               | Update                    |

Note: this table's total of 175 was correct when written, then the new tests added 3.

## 8. Environment variable names

| Group                                                                 | Names                                                                                                                                                                                                                                                                     |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| In code, not in `.env.example`                                        | `DATABASE_POOL_MAX`, `WORKER_HEARTBEAT_INTERVAL_MS`, `SYNC_JOBS_PER_MINUTE`, `SHEETS_TEST_MODE`                                                                                                                                                                           |
| Tests and CI, not in `.env.example`                                   | `E2E_CHANNEL`, `E2E_WEB_PORT`, `E2E_API_PORT`, `E2E_STOPPING`, `CI`                                                                                                                                                                                                       |
| Belongs in the missing `.env.production.example`                      | `SITE_ADDRESS`, `ACME_EMAIL`, `GOOGLE_SA_FILE`, `BACKUP_TIME`, `BACKUP_RETENTION_DAYS`, `BACKUP_DIR`, `IMAGE_PREFIX`, `IMAGE_TAG`, `ENV_FILE`                                                                                                                             |
| In code, named in no doc reviewed for ops                             | `DATABASE_POOL_MAX`, `WORKER_HEARTBEAT_INTERVAL_MS`, `SYNC_JOBS_PER_MINUTE`, `COOKIE_SECURE`, `CORS_ORIGINS`, `GOOGLE_SERVICE_ACCOUNT_EMAIL`, `GOOGLE_PRIVATE_KEY`, `ACCESS_TOKEN_TTL_SECONDS`, `SESSION_TTL_HOURS`, `API_PORT`, `LOG_LEVEL`, `API_INTERNAL_URL`, `E2E_*` |
| Not passed by `docker-compose.prod.yml`, so setting them does nothing | api: `ACCESS_TOKEN_TTL_SECONDS`, `SESSION_TTL_HOURS`, `CORS_ORIGINS`, `DATABASE_POOL_MAX`. worker: `SYNC_JOBS_PER_MINUTE`, `ORPHAN_SWEEP_INTERVAL_MS`, `WORKER_HEARTBEAT_INTERVAL_MS`, `DATABASE_POOL_MAX`                                                                |

## 9. Issue codes

Documented codes that no longer exist in the sheet docs: none. All 22 in the template exist.

Delete from `docs/api-specification.md:221`: `OFFERING_OWNED_ELSEWHERE`, `OFFERING_TERM_CHANGED`,
`OFFERING_COURSE_CHANGED`, `OFFERING_EXISTS_FOR_COURSE`, `MARK_EXCEEDS_PUBLISHED_MAX`,
`CRITERION_INACTIVE`, `SCHEME_DRAFT_PENDING`, `SCHEME_DRAFT_CONFLICT`,
`SCHEME_HAS_INACTIVE_CRITERIA`.

In code with no entry in the sheet docs:

| Group        | Codes                                                                                                                                                                                                                                                                                                                                                                          |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Parser       | `MISSING_COLUMN`, `TAB_TOO_LARGE`, `MISSING_STUDENT_ID_COLUMN`, `DUPLICATE_COLUMN`, `NO_CRITERIA`, `WORKSHEET_NOT_FOUND`, `INVALID_STUDENT_ID`, `MISSING_STUDENT_ID`, `MISSING_STUDENT_NAME`, `DUPLICATE_STUDENT`, `DUPLICATE_ROW`, `UNKNOWN_GENDER`, `MISSING_WEIGHT`, `WEIGHTS_NOT_100`, `GROUP_WEIGHT_MISMATCH`, `WEIGHTS_DISAGREE_WITH_SHEET_TOTAL`, `UNRECOGNIZED_COLUMN` |
| Apply        | `STUDENT_ID_CONFLICT`, `STUDENT_IN_OTHER_GENERATION`, `OFFERING_NOT_FOUND`, `CRITERION_REMOVED_IN_SOURCE`, `MARK_CLEARED_IN_SOURCE`, `APPLY_FAILED`, `SOURCE_BUSY`                                                                                                                                                                                                             |
| Job failure  | `TEMPLATE_INVALID`, `SHEET_CHANGE_REJECTED`, `PREVIEW_REQUIRED`, `PREVIEW_STALE`, `SOURCE_DISABLED`, `GENERATION_ARCHIVED`, `INVALID_JOB`, `ALL_SOURCES_FAILED`, `ENQUEUE_FAILED`, `WORKER_ERROR`, `WORKER_LOST`                                                                                                                                                               |
| API, mapping | `USE_CHANGE_SHEET`, `SAME_SHEET`, `NOT_PENDING`, `PENDING_SHEET_EXISTS`, `SYNC_IN_PROGRESS`, `JOB_NOT_RETRYABLE`, `NO_SOURCES`, `NO_WORKBOOK_FOR_TERM`, `TERM_NOT_IN_GENERATION`, `QUEUE_UNAVAILABLE`, `PREVIEW_HAS_ERRORS`, `INVALID_COLUMN`, `STUDENT_ID_COLUMN_REQUIRED`, `SUBJECT_ALREADY_MAPPED`                                                                          |
| Google       | `GOOGLE_AUTH_FAILED`, `GOOGLE_ERROR`                                                                                                                                                                                                                                                                                                                                           |

`STUDENT_IN_OTHER_GENERATION` is cast at `packages/sync/src/preview.ts:82` and is not in the
`IssueCode` union.

## 10. Code and repo problems found

These are not doc edits. Nothing here was changed. Phase 2 does not touch source code.

| ID   | Problem                                                                                                                                         | Evidence                                                             |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| F-01 | `.env.production.example` does not exist, and `.gitignore` would ignore it. The deployment steps fail at the first copy                         | `docs/deployment.md:44,100`; `.gitignore:14-16`                      |
| F-02 | `backup.sh` and `restore-drill.sh` are not executable in git. Direct runs should fail on Linux (not run)                                        | Mode 100644                                                          |
| F-03 | 8 production settings have no effect because compose does not pass them                                                                         | Section 8                                                            |
| F-04 | The job page always says "Nothing from this run was applied" on FAILED, but a run can fail after the roster was applied                         | `apps/web/src/app/admin/sync/[id]/page.tsx:247`; `engine.ts:514-520` |
| F-05 | Stray untracked `prisma/migrations/20261031090100_sheet_change/migration.sql`, 0 bytes, from 2026-10-30. No config reads it. Safe to delete     | Real copy is under `packages/database/prisma/migrations/`            |
| F-06 | `pnpm format:check` fails on 241 files. Expected cause is CRLF with `core.autocrlf=true`. Not confirmed file by file                            | Section 2                                                            |
| F-07 | Discard, run preview and confirm preview have no archived-generation guard                                                                      | `sheets-sources.service.ts:325`; `sheet-mappings.service.ts:476,518` |
| F-08 | `scripts/verify-term-workbook.mjs:2` points to `docs/verify-sprint-1.md`, which does not exist                                                  | Should be `docs/verifying-term-workbooks.md`                         |
| F-09 | Tests lost with `academic.integration-spec.ts`                                                                                                  | Section 6                                                            |
| F-10 | Unused schema: `programs`, `offering_programs`, `grade_scales`, `grade_bands`, `last_content_hash`, `visibility_overridden`, `sheet_column_key` | No app code                                                          |

## 11. Proposed edits for Phase 2

Every fix is in the "Proposed edit" columns above. Apart from those:

1. Fix all OUTDATED and WRONG rows. Rows marked "Decision" wait for your answer.
2. Add a note at the top of `requirements.md` and `implementation-plan.md` that the delivery plan
   overrides them.
3. Add D30 (removing a sheet) and the missing endpoints to the delivery plan. Move Change sheet
   wording to Replace and Remove.
4. Add a "Known deviations" section to `docs/delivery-plan-2027.md` with file paths, because
   `docs/decisions.md` does not exist.
5. Backlog: tick VERIFIED tasks, mark others "unverified", add the built tasks from section 6.
6. Put the commands from section 2 in `README.md`.
7. Add this line to each changed doc:
   `Last verified: 2026-10-31, commit b222954 plus uncommitted working tree`.
8. Add a dated entry to `docs/progress.md`.
9. Keep `docs/doc-review.md` as the record of this review.

Deletions proposed: the 9 issue codes in section 9, the removed modules and pages in the
architecture and README walkthroughs, and `README.md:144-145`. No whole doc is deleted.

New files proposed: none are required. `docs/architecture.md` exists, and
`docs/api-specification.md` covers `docs/api.md`. See question 8 for the rest.

## 12. Decisions needed

1. **DEV-01:** should confirming a tab on a pending sheet change names students see? Recommended:
   fix the code so names change with the sync. Otherwise the docs must say names can change early.
2. **DEV-02:** does D28 cover only replacement sheets? Recommended: yes, reword D28.
3. **DEV-03:** keep the 20,000 cap and word D22 around it, or remove the cap? Recommended: keep and
   reword, and show a note when the cap is hit.
4. **DEV-04, DEV-05:** mark D7 and A1 as superseded by D16 and D17? Recommended: yes.
5. **DEV-08 to DEV-18:** for each, fix the code or change the rule. Recommended to fix before
   go-live: DEV-09 (revocation), DEV-10 (audit role), DEV-15 (backups), DEV-18 (revoke-all CLI).
6. **DEV-19 to DEV-23:** accept and reword? Recommended: accept DEV-20 and DEV-22, and reword
   DEV-21 and DEV-23. DEV-19 needs a look at how long the lock is held on 101 students.
7. **F-07, F-09:** restore the lost tests and add the guards as code tasks? Recommended: yes.
8. **New files:** the brief expects `CLAUDE.md`, `docs/decisions.md`, `docs/backlog.md` and
   `docs/existing-code-audit.md`. Earlier you chose to map to what exists, so the Re-review section
   would go in `docs/progress.md`. Confirm, or ask for any of these.
9. **`docs/delivery-plan-2027.md:44,62`:** confirm the decision dates.
