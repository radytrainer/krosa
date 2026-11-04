# Progress

Last verified: 2026-10-31, commit b222954 plus uncommitted working tree.

Legend: ✅ done · 🟡 in progress · ⬜ pending · ⛔ blocked · unverified = finished at the time, but the
code was later removed or changed, so it cannot be checked now

_Last updated: 2026-11-01_

## Phases

| Phase                         | Status     | Notes                                                                                                                                                                                                      |
| ----------------------------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0 Requirements & architecture | ✅         | Docs; decisions A1 (hybrid) and A7 (no `EX`) adopted as defaults                                                                                                                                           |
| 1 Repository & infrastructure | ✅         | Monorepo, api/worker/web skeletons, compose, health                                                                                                                                                        |
| 2 Database & authentication   | ✅         | Full schema + constraints, auth, guards, audit, admin bootstrap CLI                                                                                                                                        |
| 3 Academic management         | unverified | Scope partly removed by D15. Grading engine and generations verified. Originally: grading engine; generations/terms, courses/offerings, criteria, versioned schemes, student accounts, audit API           |
| 4 Google Sheets integration   | unverified | Template parser removed by D14; URL and reader verified. Originally: `@ssrs/sheets` (URL, Google reader with retries, template parser, fakes); source registration + preview API                           |
| 5 Synchronization engine      | ✅         | `@ssrs/sync` engine, BullMQ worker + orphan recovery, sync API, bulk credential CSV                                                                                                                        |
| 6 Student results API         | ✅         | Results assembler + version-keyed cache; `/student/me*`; admin student results; `EXPLAIN` checked                                                                                                          |
| 7 Admin frontend              | unverified | Offering and scheme pages removed by D15; the others verified. Originally: all admin pages incl. scheme editor with live 100% total, credential issuance, sync center with polling; `GET /admin/dashboard` |
| 8 Student frontend            | ✅         | Overview with term chart, results by term (tables → cards on mobile), course detail, profile, forced password change                                                                                       |
| 9 Security & performance      | ✅         | Nonce CSP, throttling, CORS/CSRF tests, route-policy test, log/Sentry scrubbing, sync run lease, orphan sweep, load test                                                                                   |
| 10 Testing & deployment       | 🟡         | Dockerfile, production compose, CI, browser test and backup scripts exist. Not deployed; no restore drill recorded                                                                                         |
| S1 Term workbooks (plan v2)   | ✅         | Sprint 1 of `delivery-plan-2027.md`: migration, term-workbook parser, connect + detect API                                                                                                                 |
| S2 Confirm and sync           | ✅         | Tab mapping API and UI, engine, `NEEDS_REMAP`, `UNMAPPED_TAB`, integration tests. `content_hash` skip not built                                                                                            |
| Sync center targets, issues   | ✅         | D19–D22: Generation + Term target, term number with all generations, issues roll up on the job page                                                                                                        |
| Sheet change                  | ✅         | D23–D29: replace, review, preview, promote; Discard; Remove; sheet controls in Edit term. Not tried on a real second Google Sheet                                                                          |

## Requirement groups (see `requirements.md`)

| Group       | Status     | Notes                                                                                                                      |
| ----------- | ---------- | -------------------------------------------------------------------------------------------------------------------------- |
| AUTH-01…12  | ✅         | AUTH-11 admin reset (temporary password, shown once, expiring, forced change) done in Phase 3                              |
| ACAD-01…06  | unverified | ACAD-03 removed by D15. Enrollments are written by sync (ACAD-05)                                                          |
| CRIT-01…05  | unverified | CRIT-04 and 05 UI and API removed by D15                                                                                   |
| GRADE-01…10 | ✅         | Engine applied on read to raw marks + the PUBLISHED scheme (GRADE-08)                                                      |
| GS-01…07    | unverified | GS-01, 03, 05 superseded by term workbooks. Live connect not yet run: needs the sheet URL                                  |
| SYNC-01…12  | ✅         | All twelve covered by engine, worker and API integration tests                                                             |
| PROV-01…04  | ✅         | PENDING accounts with a locked hash; single and bulk (CSV) issuance; 14-day expiry                                         |
| STU-01…05   | ✅         | API + UI. STU-05: responsive (checked at 390 px and 1280 px, no page overflow), labelled controls, status never color-only |
| ADM pages   | unverified | Offering, criteria and scheme pages removed by D15                                                                         |
| OBS-01…04   | ✅         | OBS-04: Sentry in API and worker, off without `SENTRY_DSN`, all data collection disabled                                   |

## Term workbook flow verification (2026-10-30, actually executed)

| Check                                                                                                                                                                                                                      | Result                                                                                                                                                      |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Migrations `20261030090000_term_workbooks`, `20261030130000_term_workbooks_only`, `20261030150000_sync_job_term_number`, `20261031090000_source_status_pending`, `20261031090100_sheet_change` applied to the dev database | ✅                                                                                                                                                          |
| `pnpm typecheck` (13/13), `pnpm lint` (zero warnings)                                                                                                                                                                      | ✅                                                                                                                                                          |
| `pnpm test` (unit)                                                                                                                                                                                                         | ✅ see `verifying-term-workbooks.md`                                                                                                                        |
| `pnpm test:integration`                                                                                                                                                                                                    | ✅ see `verifying-term-workbooks.md`; API suite covers connect → confirm → sync → release → student sees the score                                          |
| Live connect with a real Google Sheet                                                                                                                                                                                      | ⬜ Not run: needs the sheet URL. Google accepts the key (a made-up ID returned `SHEET_NOT_FOUND`)                                                           |
| Browser scenario (`e2e/tests/scenario.spec.ts`) with installed Edge, production build                                                                                                                                      | ✅ 12 of 12 steps (2026-10-31), including changing a term's sheet: student score unchanged until the new sheet's sync completes                             |
| `pnpm build`                                                                                                                                                                                                               | ✅ 8 of 8 (2026-10-31). An earlier failure was a corrupted build cache: delete `apps/web/.next`. `next build --webpack` compiles but has no Tailwind styles |

## Phase 9 verification (2026-10-26, actually executed)

| Check                                                                                                                                                                                                                                                                                               | Result                                                                                                                               |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `pnpm build` / `pnpm typecheck` / `pnpm lint` (zero warnings) / `pnpm format:check`                                                                                                                                                                                                                 | ✅                                                                                                                                   |
| `pnpm test` (unit)                                                                                                                                                                                                                                                                                  | ✅ 181: shared 51 (incl. Sentry scrubbing 3), sheets 80, sync 3, api 45 (incl. route policy 4, log redaction 2), worker 2            |
| `pnpm test:integration`                                                                                                                                                                                                                                                                             | ✅ 143: database 20, sync engine 26 (incl. run lease 4), worker 3 (incl. periodic sweep 1), API 94 (incl. security 7, concurrency 2) |
| Throttling: global per-IP limit with `Retry-After`, health exempt; refresh 30/min per IP; credentials 20/min per admin shared by bulk and single                                                                                                                                                    | ✅                                                                                                                                   |
| CSRF: missing / foreign Origin rejected, Referer fallback, other session's token rejected; CORS only for `CORS_ORIGINS`                                                                                                                                                                             | ✅                                                                                                                                   |
| Route policy: every route has exactly one policy; `/admin` → ADMIN, `/student` → STUDENT; public surface fixed. Mutation check: removing `@Public()` from health fails the test                                                                                                                     | ✅                                                                                                                                   |
| Concurrency: 6 simultaneous sync requests → one 202, five 409, one job row. Same job delivered twice at once → **found a bug** (ran twice); fixed with a run lease, now one run + one `busy`                                                                                                        | ✅                                                                                                                                   |
| CSP in the browser (production build): nonce differs per request, full admin + student flow with zero CSP violations; dev server (port 3000) also violation-free. SRI-only policy tried first: blocked Next's inline scripts, page dead                                                             | ✅                                                                                                                                   |
| Migration `20261026150000_sync_job_lease` applied; `prisma migrate diff` database → schema empty                                                                                                                                                                                                    | ✅                                                                                                                                   |
| Load test (`scripts/load-test.mjs`, autocannon, 50 connections × 20 s, 4,000 students × 40 offerings, one API process on the dev machine): A cached `/student/me/results` 471 req/s, p50 97 ms, p99 254 ms; B uncached admin results over 1,000 students 78 req/s, p50 622 ms, p99 899 ms; 0 errors | ✅                                                                                                                                   |

## Phases 7–8 verification (2026-10-26, actually executed)

| Check                                                                                                                                                                                                                                   | Result                                                                    |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `pnpm build` (8/8, web: 21 routes) / `pnpm typecheck` / `pnpm lint` (zero warnings) / `pnpm format:check`                                                                                                                               | ✅                                                                        |
| `pnpm test` (unit)                                                                                                                                                                                                                      | ✅ 172 (unchanged)                                                        |
| `pnpm test:integration`                                                                                                                                                                                                                 | ✅ 129: database 20, sync engine 22, worker 2, API 85 (incl. dashboard 1) |
| Browser run (Playwright driving installed Edge, production build, separate API on the test database, seeded demo data)                                                                                                                  | ✅ see below                                                              |
| Admin: wrong password message; dashboard counts; generation detail; offerings; scheme editor shows 95% → publish disabled, 100% → published v1; criteria reorder; issue password (shown once); sync center, audit log, catalog, account | ✅                                                                        |
| Student: temporary password → forced change; weak password rejected by the API policy; overview with chart and table view; results by term; hidden course absent; course detail                                                         | ✅                                                                        |
| Access: student opening `/admin/*` is sent to `/student`; student calling an admin API → 403; after sign-out the API returns 401                                                                                                        | ✅                                                                        |
| Mobile 390 px: navigation menu, results as cards, admin lists; horizontal page overflow 0 px                                                                                                                                            | ✅                                                                        |
| No password text left in kept-alive pages after sign-in or sign-out; no 5xx and no unexpected 4xx during the run                                                                                                                        | ✅                                                                        |
| Chart color validated with the dataviz palette checker against both surfaces                                                                                                                                                            | ✅                                                                        |

## Phase 6 verification (2026-10-26, actually executed)

| Check                                                                                                                                                                                               | Result                                                                                     |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `pnpm typecheck` / `pnpm lint` (zero warnings) / `pnpm format:check`                                                                                                                                | ✅                                                                                         |
| `pnpm test` (unit)                                                                                                                                                                                  | ✅ 172 (unchanged)                                                                         |
| `pnpm test:integration`                                                                                                                                                                             | ✅ 128: database 20, sync engine 22, worker 2, API 84 (incl. results 11)                   |
| Results: five terms; contributions, final, ABSENT, INCOMPLETE progress, NOT_CONFIGURED; term filter; profile, course list, course detail, summary                                                   | ✅                                                                                         |
| Access: hidden / withdrawn / not-enrolled / unknown → 404; `?studentId`/`?studentCode` → 400; spoofed header ignored; admin route → 403; unauthenticated 401; admin 403; forced password change 403 | ✅                                                                                         |
| Cache: per-student keys under the generation version; served from cache; isolation between students; invalidated by visibility, term and generation edits; corrupt entry falls back to PostgreSQL   | ✅                                                                                         |
| Admin view: hidden + withdrawn with `admin` metadata, withdrawn not counted, not cached                                                                                                             | ✅                                                                                         |
| `EXPLAIN ANALYZE` on 4,000 students (2 generations × 2,000) × 40 offerings, 160k enrollments, 800k scores                                                                                           | ✅ Large tables use indexes (≤ 0.9 ms each); small tables seq-scan but have usable indexes |

## Phase 5 verification (2026-10-26, actually executed)

| Check                                                                                                                                                                                                                                                                                                                                    | Result                                                                             |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `pnpm build` / `pnpm typecheck`                                                                                                                                                                                                                                                                                                          | ✅ 8/8, 12/12                                                                      |
| `pnpm lint` (zero warnings) / `pnpm format:check`                                                                                                                                                                                                                                                                                        | ✅                                                                                 |
| `pnpm test` (unit)                                                                                                                                                                                                                                                                                                                       | ✅ 172 (shared 48, sheets 80, sync 3, api 39, worker 2)                            |
| `pnpm test:integration`                                                                                                                                                                                                                                                                                                                  | ✅ 117: database 20, sync engine 22, worker 2 (real BullMQ), API 73 (incl. sync 8) |
| Engine: first import; idempotent re-run (no writes); mark revisions; cleared cell kept; existing account untouched; missing enrollment flagged; hybrid scheme drafts; admin draft respected; max-mark guard; cross-generation refusal; ownership conflict; per-course rollback; fatal, access and transient failures; parent aggregation | ✅                                                                                 |
| Live: real API + worker processes; HTTP login (Secure cookies); sync request → queue → worker → FAILED `GOOGLE_NOT_CONFIGURED` (no credentials configured); structured logs with `syncJobId`; no secrets in logs                                                                                                                         | ✅                                                                                 |

## Phase 4 verification (2026-10-26, actually executed)

| Check                                             | Result                                                                                     |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `pnpm build` / `pnpm typecheck`                   | ✅                                                                                         |
| `pnpm lint` (zero warnings) / `pnpm format:check` | ✅                                                                                         |
| `@ssrs/sheets` unit tests                         | ✅ 77 (URL 16, retry 4, Google error mapping 4, cells 30, workbook parser 23)              |
| API integration: sources                          | ✅ 15 (registration rules, sharing errors, generation guard, preview, no-credentials mode) |
| Example CSVs generated from the test fixture      | ✅ `docs/templates/`                                                                       |

## Phase 3 verification (2026-10-26, actually executed)

| Check                                                                | Result                                                                  |
| -------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `pnpm build` / `pnpm typecheck`                                      | ✅ 6/6, 8/8                                                             |
| `pnpm lint` (zero warnings) / `pnpm format:check`                    | ✅                                                                      |
| `pnpm test` (unit)                                                   | ✅ 85 tests (shared 48 incl. 27 grading-engine cases, api 35, worker 2) |
| `pnpm test:integration`                                              | ✅ 70 tests: database 20, API 50 (health 4, auth 23, academic 23)       |
| Live: Swagger lists all 29 routes; unauthenticated admin route → 401 | ✅                                                                      |

## Phase 2 verification (2026-10-26, actually executed)

| Check                                                      | Result                                                        |
| ---------------------------------------------------------- | ------------------------------------------------------------- |
| `prisma validate`                                          | ✅                                                            |
| `prisma migrate deploy` (dev DB)                           | ✅ 1 migration                                                |
| `prisma migrate diff` live DB → schema                     | ✅ empty (no drift)                                           |
| `pnpm build` / `pnpm typecheck`                            | ✅ 6/6, 8/8                                                   |
| `pnpm lint` (zero warnings) / `pnpm format:check`          | ✅                                                            |
| `pnpm test` (unit)                                         | ✅ 52 tests (shared 23, api 27, worker 2)                     |
| `pnpm test:integration`                                    | ✅ 47 tests: database constraints 20, API health 4 + auth 23  |
| Admin CLI: weak password / bad username / duplicate        | ✅ rejected with exit 1                                       |
| Admin CLI: create (test DB)                                | ✅ Argon2id hash, `admin.created` audit row without secrets   |
| Live: login via Next proxy (unknown user / no Origin / me) | ✅ 401 `INVALID_CREDENTIALS` / 403 `ORIGIN_NOT_ALLOWED` / 401 |
| Live: Swagger lists auth routes                            | ✅                                                            |

## Known issues / deferred

- Graceful SIGTERM shutdown of api/worker is wired but cannot be exercised on Windows. Not yet run in
  Linux containers.
- `pnpm format:check` fails on a Windows checkout with `core.autocrlf=true` (241 files on 2026-10-31).
  Expected cause is line endings; not confirmed file by file.
- Deviations from written rules are listed in `delivery-plan-2027.md` and `security.md`.
- Results summaries count only ENROLLED courses; withdrawn ones appear in the admin view only.
- If Redis is down when a session is revoked, its access token stays valid until expiry
  (≤ 15 min); the error is logged. Revocation checks themselves fall back to PostgreSQL.
- A duplicate delivery that arrives while a crashed worker's lease (≤ 2 min) has not expired yet is
  completed as `BUSY`; the job then stays RUNNING until the orphan sweep (≤ 5 min) marks it
  `WORKER_LOST`, and an admin retries it. Rare: it needs a crash and a fast redelivery together.
- Per-request rendering (for the CSP nonce) costs a server render per page view. Fine for this
  traffic; revisit if pages ever move behind a CDN.
- Local machine: `POSTGRES_PORT=5433` (5432 is taken by another project); compose project name
  `student-score-system`.

## Environment (inspected 2026-10-26)

- Windows 11, Node 22.17.0, npm 11.7.0, pnpm 11.20.0, Docker 29.9.2, Compose v5.6.1, Git 2.42.
- PostgreSQL 17 and Redis 7.4 run in Docker.
- Git repository on `main`; Phases 0–6 committed by the user (`initial krosa`, `api`).

## Open questions

See the open items in `delivery-plan-2027.md`. A7 (no `EX` marks) is implemented as a default. A1 was superseded by D17.

## Blocked

Nothing blocks development. **A live connect through the app needs a real sheet URL.** Automated tests use the in-memory reader, which follows the same contract. Error mapping and retries are unit-tested. Google accepted the key on 2026-10-30, with a made-up ID returning `SHEET_NOT_FOUND`.

## Term enrollments, part 3c: admin screens and history (2026-11-04)

API (`apps/api/src/programs`): programs, a term's class lists (edit; a class in two programs or a
class with students is refused), student issues per term, approve and reverse a program switch
(withdrawn subjects keep their marks, flagged for admins, restored on reverse), and an admin's
program/class per term. Tab confirm takes `audience`; detection proposes it. Students list filters
by term, program and class; admin student page and the student profile show program and class per
term. `termNumber` in a sync request is 1–5 (`TERMS_PER_GENERATION` in `@ssrs/shared`, checked
against the database's CHECK). Web: **Generations → term → Classes and students**, audience on the
tab review, term/program filters, history sections.

## Term enrollments, part 3b: sync and preview (2026-11-04)

`ALL` decides each student's class and program per term (`packages/sync/src/student-terms.ts`);
`CLASS 2` cross-checks; subject-tab CLASS/MAJOR only warn; swapped names are silent; a name of
another student rejects the row and over 20% blocks the tab; row-number columns are recognised.
Tab audience: confirmed, or guessed once by the sync from who the tab lists and saved
(`AUDIENCE_GUESSED`). Student issues (unknown class, conflict, duplicate, program switch) block
only that student. The preview counts new enrollments, class changes and program changes. Fixtures
shaped like the real files: `program-workbooks-fixture.ts` (made-up people). Rehearsed on a copy
of the dev database with the real workbooks: Term 1 101 General (A 26, B 24, C 25, D 26); Term 2
75 WEP + 25 SNAC with Term 1 unchanged; audiences guessed right; Web Design and UXUI blocked
(74 of 75 rows carry another student's name); re-sync changes nothing. Admin screens (class lists,
issue list, audience on confirm, program-switch approval) are part 3c.

## Term enrollments, part 3a: data model (2026-11-03)

Migration `20261103090000_term_enrollments`: `program_aliases`, `term_programs`, `term_classes`,
`student_terms`, `student_term_issues`, tab audience on `sheet_tab_mappings`,
`enrollments.ended_reason`, column roles PROGRAM and ROW_NUMBER. Defaults and the backfill are SQL
functions (`ssrs_apply_term_defaults`, `ssrs_backfill_student_terms`); new generations get the
defaults. Rehearsed on a copy of the dev database: 101 Term 1 General rows (A 26, B 24, C 25, D 26),
none from another term, re-run creates 0, no schema drift. **Not applied to the dev database yet.**
Sync does not use the new tables until part 3b. Check report: `qa/step3-check.md`.

## Issue lists, 5 per page (2026-11-03)

Retest issue 2. Job, preview and tab-detection issues share one component (`paged-issues.tsx`):
5 per page, "1–5 of 23", no page controls at 5 or fewer, back to page 1 on any filter change, tab
and severity filters everywhere (plus workbook on multi-source jobs). Jobs and previews are paged
on the server; a preview now keeps up to 20,000 issues and its summary carries only counts
(`GET /admin/sources/:id/preview/:previewId/issues`). Detection issues are not stored, so they are
paged in the browser. What is reported did not change. The dev database held 5 stored warnings,
none repeated per row; detection warnings are not stored, so a flood there is not yet explained.

## Teacher comments (2026-11-03)

Retest issue 1. The comment was stored but never returned by the results API or shown on the student
screen, and the preview ignored it (D6 was "stored only"). Now: shown to the student per released
subject, also when Incomplete, as plain text; counted in the preview (`comments`) and the job
(`enrollments.commentsUpdated`); blank or whitespace-only cells clear it; over 4000 characters
(code points) it is not imported and `COMMENT_TOO_LONG` is reported. Results cache key is now
`ssrs:v2:results:`. Results: 343 unit, all integration packages green (worker: 2 skipped without
QA containers), 12 of 12 e2e with `E2E_CHANNEL=msedge`. Next: warnings pagination, then term
enrollments (classes and programs).

## QA fixes (2026-11-01)

All 17 defects in `qa/qa-report.md` fixed and re-tested, on top of commit `66888b7`. Decisions D32-D37
are in `delivery-plan-2027.md`. Results: 338 unit, 349 integration (2 skipped without QA containers),
12 of 12 e2e, 22 of 22 QA UI, 3 of 3 QA session in 10 runs, 14 of 14 QA worker on the `ssrs-qa`
containers. Migrations `20261101090000_score_cleared` and `20261101090100_pending_sheet_review` are
applied to the dev database. Not yet tried on a real Google Sheet.

## Re-review (2026-10-31)

Full review of the docs against the code at commit `b222954` plus the uncommitted working tree. All
findings: [doc-review.md](doc-review.md). `docs/existing-code-audit.md` does not exist, so the
section is here.

| Check                                       | Result                                                  |
| ------------------------------------------- | ------------------------------------------------------- |
| `pnpm lint`, `pnpm typecheck`               | ✅                                                      |
| `pnpm test`                                 | ✅ 217: shared 51, sheets 114, sync 3, worker 3, api 46 |
| `pnpm build`                                | ✅ 8 of 8                                               |
| `pnpm test:integration`                     | ✅ 178: database 25, sync 31, api 119, worker 3         |
| `pnpm test:e2e` with `E2E_CHANNEL=msedge`   | ✅ 12 of 12                                             |
| `pnpm format:check`                         | ❌ 241 files, expected cause is line endings on Windows |
| Routes compared with `api-specification.md` | ✅ 53 of 53                                             |

Docs corrected: `README.md`, `api-specification.md`, `architecture.md`, `database-design.md`,
`delivery-plan-2027.md`, `deployment.md`, `google-sheets-template.md`, `implementation-plan.md`,
`operations.md`, `progress.md`, `requirements.md`, `security.md`, `verifying-term-workbooks.md`.

Historical run logs above are kept as written. Rows naming removed pages, specs or `docs/templates/`
record what passed on that date and are unverified now.

Tests lost when `apps/api/test/academic.integration-spec.ts` was deleted are listed as a task in
`delivery-plan-2027.md`.
