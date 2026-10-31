# QA Test Plan: PNC Student Score System

Written: 2026-10-31. Tested revision: commit `b62f43f`, branch `feature/implement_sync_google_sheet`.
Status: **Approved with the section 8 defaults on 2026-10-31 and executed. Results: [qa-report.md](qa-report.md).**

## 1. Scope changes from the brief

The brief named files and features that do not exist here. Nothing below is guessed; anything that
needs your decision is in [section 8](#8-decisions-needed-before-phase-2).

| Brief                         | What exists                                                                                                     |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `CLAUDE.md`                   | Does not exist                                                                                                  |
| `docs/decisions.md`           | Does not exist. Decisions D1-D31 are in `docs/delivery-plan-2027.md`                                            |
| `docs/sheet-import-format.md` | Does not exist. Used `docs/google-sheets-template.md`                                                           |
| `docs/backlog.md`             | Does not exist. Used `docs/delivery-plan-2027.md` section E.4 (T1-T16)                                          |
| `codebase-auditor` subagent   | Not available. Read directly                                                                                    |
| Anonymized sample workbook    | Not in the repo. Used the synthetic fixture `packages/sheets/src/testing/term-workbook-fixture.ts`. See Q1      |
| Roster import                 | No separate feature. The `ALL` tab is read during sync, and passwords are issued by a separate admin action     |
| Create and edit students      | Not built. Students come from sync; admins can only change status and reset passwords                           |
| Grade scale, letter grades    | Tables only. No API or UI. Plan D5 says this is in the MVP                                                      |
| SNA/WEP programs              | Tables only. No API, UI or engine logic. Plan D8 says this is in the MVP                                        |
| Dead-letter queue             | None. After 3 attempts the job stays in BullMQ's failed set for 30 days and `sync_jobs` is FAILED               |
| Preview                       | Only for a replacement (PENDING) sheet. First sheets and re-syncs have Detect tabs, which writes draft mappings |
| Cancel a sync                 | No API or button (D27). `CANCELLED` can only be reached by writing to the database                              |

## 2. Implemented features

Verified in the code. 53 routes across 10 controllers, matching `docs/api-specification.md`: 5 auth,
5 student, 41 admin, 2 health.

| Area               | Implemented                                                                                                                  |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| Auth               | Login, refresh rotation, reuse detection, logout, change password, forced change, lockout, throttling, CSRF, Origin checks   |
| Generations, terms | List, create (5 terms), edit, archive, activate, edit term, release or hide a term                                           |
| Term workbooks     | Connect, check, change, discard, remove, detect tabs, confirm/ignore/reopen tab, preview, confirm preview, workbooks by term |
| Sync               | Scopes SOURCE, TERM, GENERATION, ALL; job list and detail; issues roll-up; retry; worker, leases, orphan sweep               |
| Students           | List, detail, results view, enable/disable, reset password, bulk credentials CSV                                             |
| Results            | Five `/student/me*` routes, grading on read, version-keyed Redis cache                                                       |
| Audit, dashboard   | Audit list with filters, dashboard counts                                                                                    |
| Web                | 17 pages: sign-in, change password, home, 4 student, 10 admin                                                                |
| Ops                | Health and readiness, CLI `admin:create` and `demo:seed`, production Dockerfile and compose, backup and restore scripts      |

## 3. Environment

Everything runs from a clean clone of `b62f43f` in the session scratchpad, against a separate Docker
project, `ssrs-qa`. Your checkout, `.env` and dev containers are not used.

**Why a clone:** `loadRootEnv` uses `override: false`, so setting `DATABASE_URL` is not enough. Any
key left unset, such as `SENTRY_DSN` or `GOOGLE_*`, would still be filled in from the real `.env`. The
clone has no `.env`, so that cannot happen, and your `.env` never had to be opened.

| Check                                                                  | Result                                                     |
| ---------------------------------------------------------------------- | ---------------------------------------------------------- |
| `DATABASE_URL`, `TEST_DATABASE_URL`                                    | `localhost:55432`, databases `ssrs` and `ssrs_test`        |
| `REDIS_URL`, `TEST_REDIS_URL`                                          | `localhost:56379`, databases 0 and 15                      |
| `WEB_ORIGIN`, `API_INTERNAL_URL`                                       | `localhost:3100`, `localhost:4100`                         |
| `SENTRY_DSN`, `GOOGLE_APPLICATION_CREDENTIALS`, `GOOGLE_*` in QA shell | Unset                                                      |
| Docker ports                                                           | Bound to `127.0.0.1` only                                  |
| Secrets                                                                | Generated for this run, kept in the scratchpad, not in git |
| Guard                                                                  | Every command aborts if any URL host is not `localhost`    |

Google is never contacted. Tests use the in-memory reader, or `SHEETS_TEST_MODE=fixtures` on the
running stack.

Limits this creates: the real `.env` was not verified (Q5), and no real Google Sheet is tested.

## 4. Baseline

Run 2026-10-31 on Windows 11, Node 22.16.0, pnpm 11.20.0, Docker 28.3.2, from a clean install.

| Step                                   | Result                                                                                          |
| -------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `pnpm install --frozen-lockfile`       | Pass                                                                                            |
| `pnpm build`                           | Pass, 8 of 8 tasks                                                                              |
| `pnpm db:deploy`                       | Pass, 7 migrations. `prisma migrate diff` reports no drift                                      |
| Seed                                   | Pass: 1 admin, 3 students, 5 offerings, 15 scores                                               |
| `pnpm lint`                            | Pass, zero warnings                                                                             |
| `pnpm typecheck`                       | Pass, 13 of 13 tasks                                                                            |
| `pnpm test`                            | Pass, 217: sheets 114, shared 51, api 46, sync 3, worker 3                                      |
| `pnpm test:integration`                | Pass, 178: api 119, sync 31, database 25, worker 3                                              |
| `pnpm test:e2e` (`E2E_CHANNEL=msedge`) | Pass, 12 of 12                                                                                  |
| `pnpm format:check`                    | Fail, 310 files. Cause confirmed: `core.autocrlf=true`. `--end-of-line auto` reports all clean  |
| `pnpm audit --prod`                    | 2 advisories: high `multer` <2.5.0 (DoS), low `deepmerge` <=4.3.1. Reachability checked in G-20 |

Existing tests passing is not treated as evidence that a requirement works. Each case below is
checked independently unless its method is `EX`.

## 5. Method and priority

Method: `EX` existing test, re-read to confirm it asserts the behavior; `NT` new automated test;
`API` direct HTTP call against the running stack; `BR` browser.

Priority: `P0` data leak, wrong score, data loss or security bypass; `P1` core flow; `P2` everything
else. `NI` means NOT IMPLEMENTED and is reported as such, not as a failure, unless you say otherwise
(Q3).

New tests are in `apps/api/test/qa/`, `apps/worker/test/qa/`, `e2e/qa/`,
`packages/shared/src/grading/qa-grading.spec.ts` and `packages/sheets/src/template/qa-cells.spec.ts`.
Reports, the live-check script and saved evidence are in `docs/qa/`.

As executed, direct API cases ran through supertest or `docs/qa/scripts/live-check.mjs`. Both make real
HTTP requests. `qa-report.md` Appendix A gives the actual evidence for every case, and that is the
record if it differs from the Method column here.

Four cases were added during execution because testing found something the plan did not cover: A-33,
A-34, D-25 and E-22. They are marked below.

## 6. Test cases

### A. Authentication and sessions

| ID   | Case                                                                                     | Method   | Pri |
| ---- | ---------------------------------------------------------------------------------------- | -------- | --- |
| A-01 | Unknown user and wrong password: same status, body and headers                           | API      | P0  |
| A-02 | Timing of unknown user and wrong password over 30 samples                                | API      | P1  |
| A-03 | Disabled account: correct and wrong password; existing session refused                   | NT       | P0  |
| A-04 | PENDING account and locked password hash cannot sign in                                  | NT       | P0  |
| A-05 | Per-IP limit: 429 with `Retry-After` on the 11th attempt                                 | API      | P0  |
| A-06 | Per-username limit: 429 on the 6th attempt, from different IPs                           | NT       | P0  |
| A-07 | Case and whitespace variants of a username cannot dodge the limit                        | NT       | P0  |
| A-08 | Spoofed `X-Forwarded-For` cannot dodge the IP limit with `TRUST_PROXY_HOPS=0`            | API      | P0  |
| A-09 | Lockout timing: 1, 2, 4, 8, capped at 15 min; reset on success                           | EX + NT  | P1  |
| A-10 | `ACCOUNT_LOCKED` reveals a real account: measure against the "same response" requirement | API      | P1  |
| A-11 | An attacker can lock a student out: measure the effect                                   | NT       | P1  |
| A-12 | Refresh rotates both tokens; old access token behavior recorded                          | API      | P0  |
| A-13 | Reusing an old refresh token revokes the whole chain                                     | API      | P0  |
| A-14 | Two refreshes at once with the same token: no fork, no valid leftover token              | NT       | P0  |
| A-15 | Logout revokes access and refresh tokens at once                                         | API      | P0  |
| A-16 | Logout with only the refresh cookie (expired access token)                               | NT       | P1  |
| A-17 | Temporary password: every score and admin route returns 403 until changed                | NT       | P0  |
| A-18 | Forced-change flag cannot be cleared by refresh or a new login                           | NT       | P0  |
| A-19 | Temporary password past expiry: no login; existing session behavior recorded             | NT       | P0  |
| A-20 | Admin reset ends the student's session at once (access and refresh)                      | API      | P0  |
| A-21 | Admin reset while Redis is failing: token refused afterwards (known deviation T4)        | NT       | P0  |
| A-22 | Disable while Redis is failing: same check                                               | NT       | P0  |
| A-23 | Cookies: HttpOnly, SameSite and Path on all three, local and with `COOKIE_SECURE=true`   | API      | P0  |
| A-24 | `NODE_ENV=production` with insecure cookies is refused at startup                        | NT       | P0  |
| A-25 | No hash or token in any JSON response: scan all 53 routes                                | NT       | P0  |
| A-26 | No password, hash, token or temporary password in API or worker logs, or audit rows      | NT       | P0  |
| A-27 | JWT tampering: `alg:none`, wrong secret, changed role, wrong `iss` or `aud`, expired     | NT       | P0  |
| A-28 | Token for a deleted or other session's `sid`                                             | NT       | P0  |
| A-29 | CSRF: missing, wrong, other session's token; missing and foreign Origin                  | EX + API | P0  |
| A-30 | Change password: policy, wrong current password, 5/min limit, other sessions revoked     | EX + NT  | P1  |
| A-31 | Refresh past the 7-day absolute lifetime                                                 | NT       | P1  |
| A-32 | Disabled, then enabled: old sessions stay dead                                           | NT       | P0  |
| A-33 | Added: two open tabs refresh at the same moment; the user stays signed in                | BR       | P1  |
| A-34 | Added: a page load after the access cookie expires keeps the valid session               | BR       | P1  |

### B. Authorization and data isolation (highest priority)

| ID   | Case                                                                                  | Method | Pri |
| ---- | ------------------------------------------------------------------------------------- | ------ | --- |
| B-01 | Generated from live route metadata: student token on all 41 admin routes returns 403  | NT     | P0  |
| B-02 | Same list, no token: 401. Also a garbage token and an expired token                   | NT     | P0  |
| B-03 | Admin token on the 5 student routes returns 403                                       | NT     | P0  |
| B-04 | Student A requests B's offering, hidden, withdrawn, unknown: identical 404            | NT     | P0  |
| B-05 | `studentId`, `studentCode`, `userId` in query, body, headers and cookies: no effect   | NT     | P0  |
| B-06 | Parameter pollution: repeated `term`, array form, nested form                         | NT     | P0  |
| B-07 | Malformed, SQL-shaped and very long `offeringId`, `term`                              | NT     | P0  |
| B-08 | Terms 0, 6, -1, 1.5, `1e0`, empty                                                     | NT     | P1  |
| B-09 | Cache: A then B, responses never cross; keys contain the student id                   | NT     | P0  |
| B-10 | Cache after hide: previously cached results stop showing at once                      | NT     | P0  |
| B-11 | Cache after disable, sync, sheet change, withdrawal                                   | NT     | P0  |
| B-12 | Hidden term data absent from all 4 result routes and summaries, including counts      | NT     | P0  |
| B-13 | Student in another generation sees nothing of a shared course code                    | NT     | P0  |
| B-14 | 404 body and timing do not reveal whether another student's offering exists           | NT     | P1  |
| B-15 | Path tricks: `/API/V1/Admin`, trailing slash, double slash, `%2e%2e`, method override | API    | P0  |
| B-16 | `HEAD`, `OPTIONS`, `PUT`, `DELETE` on protected routes                                | API    | P1  |
| B-17 | Same access checks through the Next.js `/api` proxy                                   | API    | P0  |
| B-18 | Student opens `/admin/*` pages: redirected and no admin data in the HTML              | BR     | P0  |
| B-19 | Mass assignment: `role`, `status`, `passwordHash`, `generationId` in every body       | NT     | P0  |
| B-20 | New public route guard: `route-policy.spec.ts` fails if a policy is removed           | EX     | P1  |

### C. Score calculation

| ID   | Case                                                                                                                                        | Method  | Pri |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------- | ------- | --- |
| C-01 | Total = sum(mark x weight / 100), hand-worked table of 30 rows                                                                              | NT      | P0  |
| C-02 | Half-up on exact ties: x.xx5, x.xx4999, 0.005, 99.995, 100.000                                                                              | NT      | P0  |
| C-03 | Rounded exact sum, not the sum of rounded parts                                                                                             | NT      | P0  |
| C-04 | Property test against an independent BigInt calculator, 10,000 random schemes                                                               | NT      | P0  |
| C-05 | Any blank: INCOMPLETE, null total, for each position of the blank                                                                           | NT      | P0  |
| C-06 | Blank is stored as no row or NULL, never 0: checked in the database                                                                         | NT      | P0  |
| C-07 | `ABS` counts as 0 and stays visible as absent                                                                                               | NT      | P0  |
| C-08 | Mark of 0 is complete, not blank                                                                                                            | NT      | P0  |
| C-09 | Sample comparison, Logic and MsOffice rows against the fixture's own `Total`                                                                | NT      | P0  |
| C-10 | ENG group-split weights: 16 columns total exactly 100                                                                                       | NT      | P0  |
| C-11 | **A group split across 3 columns** (edited fixture, 5% over 3): 1.667 x 3 is not 5. Does confirm still work, and does the total stay right? | NT      | P0  |
| C-12 | BCU partial rows: INCOMPLETE where the sheet's `Total` shows a number (D3)                                                                  | NT      | P0  |
| C-13 | Confirm rejected: weights 99.999, 100.001, 0, negative, 4 decimals, missing                                                                 | EX + NT | P0  |
| C-14 | Weight change creates a new version and recalculates; history keeps the old one                                                             | NT      | P0  |
| C-15 | Term average: credit-weighted, exact, rounded once, only when all complete                                                                  | NT      | P1  |
| C-16 | Stored mark above the maximum gives NEEDS_REVIEW, no total                                                                                  | EX      | P1  |
| C-17 | API and web agree: the value shown in the browser equals the API value                                                                      | BR      | P1  |
| C-18 | Grade boundaries exact (84.99, 85.00, and so on)                                                                                            | **NI**  | -   |
| C-19 | Changing the grade scale recalculates and writes history                                                                                    | **NI**  | -   |

### D. Google Sheets sync

Fault cases run real BullMQ, PostgreSQL and Redis with a fault-injecting in-memory reader. A worker is
started as a separate process so it can really be killed. Live Google was not used.

| ID   | Case                                                                                                  | Method | Pri |
| ---- | ----------------------------------------------------------------------------------------------------- | ------ | --- |
| D-01 | Preview writes no student, offering, score, revision or enrollment row: table-by-table row-count diff | NT     | P0  |
| D-02 | Re-import of the same data: every table identical, zero revisions                                     | NT     | P0  |
| D-03 | One changed mark: one score updated, one revision row with job, tab and row                           | NT     | P0  |
| D-04 | Row missing later: scores kept, enrollment flagged, warning raised                                    | NT     | P0  |
| D-05 | Cleared cell: mark kept with a warning. Effect on the student's total recorded                        | NT     | P0  |
| D-06 | Rejected rows name tab and row: unknown student, duplicate, text, above 100, below 0                  | NT     | P0  |
| D-07 | Odd cells: `abs`, `85`, `85%`, `8,5`, `1e2`, `TRUE`, dates, `#REF!`, `-0`, 100.0001, 4 decimals, NBSP | NT     | P0  |
| D-08 | Student IDs: lower case, trailing space, NBSP, zero-width, inner space, 33 characters                 | NT     | P0  |
| D-09 | Same student twice in one tab, and with different case                                                | NT     | P0  |
| D-10 | ENG header on row 3, header named `f`, trailing spaces                                                | NT     | P0  |
| D-11 | `_meta` and `ALL` never read for scores. Unmapped tabs reported                                       | NT     | P1  |
| D-12 | Tab reorder, column reorder, header rename: `NEEDS_REMAP`, nothing applied to that tab                | NT     | P0  |
| D-13 | Formula-injection and script strings in names, comments, tab titles                                   | NT     | P1  |
| D-14 | Shared subjects resolve to the right program for SNA and WEP                                          | **NI** | -   |
| D-15 | Second sync while one runs: 409 for SOURCE, TERM and through retry                                    | NT     | P0  |
| D-16 | Worker killed mid-job and restarted: job finishes or fails cleanly, scores intact                     | NT     | P0  |
| D-17 | Duplicate delivery, including after a crash (known issue in `progress.md`)                            | NT     | P0  |
| D-18 | Google 500, 503, 429, timeout: retried. 403, 404: not retried                                         | NT     | P0  |
| D-19 | Database error partway through a tab: that tab rolls back, others kept                                | NT     | P0  |
| D-20 | Database down for the whole job, Redis down at enqueue, Redis lost mid-job                            | NT     | P0  |
| D-21 | Exhausted retries: final state correct and scores intact. BullMQ failed set stands in for a DLQ (Q4)  | NT     | P0  |
| D-22 | Every failure above: checksum of all score rows before and after                                      | NT     | P0  |
| D-23 | Retry of a job on a disabled source or an archived generation                                         | NT     | P1  |
| D-24 | Second generation's student ID in this workbook is refused                                            | EX     | P0  |
| D-25 | Added: dead-letter queue after the retry limit (from the brief; see Q4)                               | **NI** | -   |

### E. Recent Sync Center features

| ID   | Case                                                                                      | Method  | Pri |
| ---- | ----------------------------------------------------------------------------------------- | ------- | --- |
| E-01 | Term options follow the selected Generation                                               | BR      | P1  |
| E-02 | Mismatched Generation and Term rejected with 422                                          | NT      | P0  |
| E-03 | All generations + one term covers the right sources                                       | NT      | P1  |
| E-04 | Old jobs without `term_number` still display                                              | NT + BR | P1  |
| E-05 | Parent job shows all issues from all sources                                              | NT      | P1  |
| E-06 | Source job shows only its own issues                                                      | NT      | P1  |
| E-07 | Job total equals the sum, with no duplicates across pages                                 | NT      | P1  |
| E-08 | Pagination: order stable, last page, past the end, each filter                            | NT      | P1  |
| E-09 | 20,000-issue cap: totals and the missing note (known T2)                                  | NT      | P2  |
| E-10 | Score checksum identical before and after: connect, detect, confirm tab, preview, confirm | NT      | P0  |
| E-11 | **What a student sees** during the same steps, including names (known deviation T1)       | NT      | P0  |
| E-12 | Sync without a preview rejected, directly and through `POST /sync/:id/retry`              | NT      | P0  |
| E-13 | Old preview cannot sync the new sheet, or another sheet                                   | EX + NT | P0  |
| E-14 | Sheet edited after the preview: `PREVIEW_STALE`, nothing applied                          | EX      | P0  |
| E-15 | Failed sync leaves the old sheet active and every table unchanged                         | NT      | P0  |
| E-16 | Cancelled sync (set in the database): same check                                          | EX      | P1  |
| E-17 | Switching during a running sync rejected                                                  | EX      | P0  |
| E-18 | Each step audited, no secrets: `source.switched`, `promoted`, `pending.discarded`         | NT      | P1  |
| E-19 | Retry of a failed pending-sheet job after its preview is voided                           | NT      | P0  |
| E-20 | Discard, preview and confirm on an archived generation (known T9)                         | NT      | P1  |
| E-21 | Promoting a sheet when a student is missing from it: scores kept                          | EX      | P0  |
| E-22 | Added: discarding a new sheet undoes what its Confirm tab changed                         | NT      | P0  |

### F. Student and admin flows

| ID   | Case                                                                          | Method  | Pri |
| ---- | ----------------------------------------------------------------------------- | ------- | --- |
| F-01 | First sync creates each account once; a second run creates none               | NT      | P0  |
| F-02 | Temporary password returned once, not retrievable afterwards                  | NT      | P0  |
| F-03 | Temporary passwords absent from the database, logs and audit, by value search | NT      | P0  |
| F-04 | Bulk issue: `onlyPending` default leaves active students alone                | NT      | P0  |
| F-05 | CSV: BOM, formula-safe cells, `no-store`, 500 limit                           | NT      | P1  |
| F-06 | Student view: components, status, total only when complete                    | NT + BR | P0  |
| F-07 | Grade shown only when complete                                                | **NI**  | -   |
| F-08 | Teacher comments shown (D6)                                                   | **NI**  | -   |
| F-09 | Create and edit a student                                                     | **NI**  | -   |
| F-10 | Disable and enable: sessions, login, audit                                    | NT      | P0  |
| F-11 | Enrollment change keeps history                                               | NT      | P1  |
| F-12 | Audit written for each admin action, append-only trigger holds                | NT      | P1  |
| F-13 | Generation create, edit, archive; archived is read-only; five terms always    | NT      | P1  |
| F-14 | Lost tests from T10: 404 and 400 handling, pagination, reset rules            | NT      | P1  |

### G. Robustness and security basics

| ID   | Case                                                                                 | Method   | Pri |
| ---- | ------------------------------------------------------------------------------------ | -------- | --- |
| G-01 | Generated fuzz over every body route: empty, wrong types, null, arrays, deep nesting | NT       | P1  |
| G-02 | Very long strings on every string field, and a very long password at login           | NT       | P1  |
| G-03 | SQL injection strings in every string field and `q` filter                           | NT       | P0  |
| G-04 | **NUL byte** (`%00`, `\u0000`) in `q`, identifier, label: must not be a 500          | NT       | P0  |
| G-05 | Script strings stored and rendered: not executed in the browser                      | BR       | P0  |
| G-06 | Oversized payload: 413 in the standard error format                                  | API      | P1  |
| G-07 | Malformed JSON, wrong content type, bad charset                                      | API      | P1  |
| G-08 | No stack trace, file path, SQL or Prisma text in any error above                     | NT       | P0  |
| G-09 | Security headers on API and web, including CSP nonce                                 | API      | P1  |
| G-10 | CORS: unlisted origin, `CORS_ORIGINS=*` refused at startup                           | EX + API | P1  |
| G-11 | Pagination: `pageSize` 0, -1, 101, huge `page`, non-numeric, on every list           | NT       | P1  |
| G-12 | Audit `from` and `to` with invalid dates                                             | NT       | P2  |
| G-13 | Swagger not served when disabled; production compose forces it off                   | API      | P1  |
| G-14 | Global limit, including through the proxy                                            | API      | P1  |
| G-15 | Response time: 300 students x 5 subjects, cached and uncached, p50 and p99           | NT       | P1  |
| G-16 | Sync time and lock time for 300 x 5 (known T3)                                       | NT       | P1  |
| G-17 | N+1 check: query count for one student's results                                     | NT       | P1  |
| G-18 | Redis down: readiness 503, reads still work, limiters fail open as documented        | API      | P1  |
| G-19 | PostgreSQL down: clean 503, recovers without restart                                 | API      | P1  |
| G-20 | `multer` advisory: any upload route reachable?                                       | API      | P2  |

### H. User interface

Run with Playwright on installed Edge, at desktop width and 390 px. The planned page-by-page look in
the built-in browser was not done; failure screenshots were reviewed instead (`qa-report.md` section 4).

| ID   | Case                                                                         | Method | Pri |
| ---- | ---------------------------------------------------------------------------- | ------ | --- |
| H-01 | Sign-in: empty, wrong password, 429 and lockout messages                     | BR     | P1  |
| H-02 | Forced password change: weak password message, cannot skip by URL            | BR     | P0  |
| H-03 | Student empty states: no released term, no courses                           | BR     | P1  |
| H-04 | Student error states: API returns 500, 503, session expired mid-use          | BR     | P1  |
| H-05 | Loading states on slow responses                                             | BR     | P2  |
| H-06 | Results: INCOMPLETE shows no total; "Not entered" is not shown as 0          | BR     | P0  |
| H-07 | Admin empty states: no generations, no students, no jobs, no issues          | BR     | P1  |
| H-08 | Connect and confirm dialogs: bad URL, weights not 100, server errors shown   | BR     | P1  |
| H-09 | Sync Center: form, polling, job page, issues table, filters, pagination      | BR     | P1  |
| H-10 | Edit term: Replace, Remove, Discard, messages on conflict                    | BR     | P1  |
| H-11 | Temporary password dialog: shown once, gone after close and on Back          | BR     | P0  |
| H-12 | After sign-out, Back shows no data                                           | BR     | P0  |
| H-13 | Phone width: no sideways scroll on all 17 pages; menu works; tables readable | BR     | P1  |
| H-14 | Keyboard: dialogs trap focus, labels present, status not color-only          | BR     | P2  |
| H-15 | Console: no errors or CSP violations through the main flows                  | BR     | P1  |

## 7. Out of scope for this run

- A real Google Sheet, Google's real quota behavior and live service-account auth (Q2).
- Production images, Caddy, HTTPS, HSTS and running on Linux. Graceful SIGTERM cannot be exercised on
  Windows, so a kill here is a hard kill.
- Backup and the restore drill.
- A penetration test. G covers basics only.

## 8. Decisions needed before Phase 2

Approved on 2026-10-31 with every default below. No answer was changed.

| #   | Question                                                                                                                                                                                                                                                                    | Default if you just approve                                                                                         |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Q1  | Is `C:\Users\theng\Documents\PNC-PROJECT\test-case.xlsx` the anonymized sample workbook? It is outside the repo and I have not opened it                                                                                                                                    | Not opened. C-09 runs on the synthetic fixture only, a much weaker check: 3 students, not the sheet's real formulas |
| Q2  | Do you have a Google Sheet with fake data, shared with a test service account, for one live connect?                                                                                                                                                                        | Live Google stays BLOCKED                                                                                           |
| Q3  | Grades, programs and teacher comments are in the plan's MVP (D5, D6, D8) but not built. Report as NOT IMPLEMENTED only, or also as a release blocker?                                                                                                                       | NOT IMPLEMENTED, and named in the release recommendation as go-live gaps                                            |
| Q4  | There is no dead-letter queue. Should the failed set plus a FAILED job count as meeting that requirement?                                                                                                                                                                   | Reported NOT IMPLEMENTED. D-21 still tests what happens at the retry limit                                          |
| Q5  | The real `.env` was not checked, because I may not read it. Is it acceptable that this run never uses it?                                                                                                                                                                   | Yes. Please check for yourself that it has no production values                                                     |
| Q6  | "Preview writes nothing": should that allow the preview's own record and audit row?                                                                                                                                                                                         | Yes. D-01 requires zero academic-data writes and lists what else is written. Detect tabs is tested the same way     |
| Q7  | A cleared cell keeps the old mark (documented), but your brief says any blank gives INCOMPLETE. Which wins for a mark that was entered and later erased?                                                                                                                    | The documented behavior. D-05 records what students see, and I raise it as a question if the total stays visible    |
| Q8  | Known deviations already recorded in the docs (T1, T2, T4, T9): report them as defects with your severity scale, or list them separately?                                                                                                                                   | Reported as defects. Being documented does not lower severity, and each is noted as known                           |
| Q9  | New tests must be added to your repo, unstaged, and copied to the clone to run. Each suite needs `TEST_DATABASE_URL`, so re-running from your checkout reads your `.env`, which must point at a test database. The clone and `ssrs-qa` stay up until you say to remove them | As stated. Docker volumes and the clone are removed only when you ask                                               |
