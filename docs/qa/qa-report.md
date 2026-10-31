# QA Report: PNC Student Score System

Tested: 2026-10-31. Revision: commit `b62f43f`, branch `feature/implement_sync_google_sheet`. Plan:
[test-plan.md](test-plan.md), run with its section 8 defaults. QA changed no source code. Every result
came from a clean clone on a separate local Docker stack (`ssrs-qa`). The real `.env`, your dev
containers, Google and Sentry were not used.

Contents: [issues to fix](#2-defects), [coverage](#3-coverage-by-area), [not tested](#4-what-i-could-not-test-and-what-i-need),
[decisions](#5-decisions-for-you), [re-running](#6-re-running-the-tests),
[every case](#appendix-a-every-case). Saved results: [evidence/](evidence/README.md).

## 1. Summary

**Release recommendation: NOT READY.**

The core is sound. Scores are calculated correctly, students cannot reach each other's data, and no
failure lost a mark. It is not ready because of one security defect, two defects in syncing and
replacing sheets, and three MVP features that do not exist yet.

| Result          | Cases | Meaning                                                                   |
| --------------- | ----- | ------------------------------------------------------------------------- |
| PASS            | 138   | Verified by a named test, a command, or a request and response            |
| FAIL            | 23    | Grouped into 17 defects below                                             |
| NOT IMPLEMENTED | 7     | Grades (3), programs (1), comments (1), create/edit students (1), DLQ (1) |
| NOT TESTED      | 1     | B-14: 404 timing was not measured. The 404 bodies were compared           |
| BLOCKED         | 3     | Listed in section 4, outside the 169 planned cases                        |
| **Total**       | 169   | 165 planned, plus 4 added while testing: A-33, A-34, D-25, E-22           |

Defects: **1 Critical, 2 High, 5 Medium, 9 Low.**

### What held up

- **Isolation (B).** A student token was refused on all 41 admin routes, and no token got 401 on every
  non-public route. Both lists came from the running app, so a new route is covered automatically.
  Changing ids, query strings, headers or bodies never returned another student's data. The cache
  never crossed students.
- **Scores (C).** 10,000 random schemes matched an independent integer calculator to the cent. Exact
  half-up ties, blank vs 0, ABS, and the workbook's own totals on complete rows all matched.
- **Sync (D).** Re-import changed nothing. One changed mark wrote one history row. A worker killed
  mid-job recovered with all marks correct and no duplicate history. No failure lost a score.
- **Secrets (A-25, A-26, F-03).** Passwords, hashes and tokens were absent from every response, from
  all logs at debug level, and from a full `pg_dump`.
- **UI (H).** All 15 cases passed, including 390 px on every page, no CSP violations, and a stored
  script string that did not run.

### Automated tests added

| Suite                                            | Tests | Passed | Failed |
| ------------------------------------------------ | ----- | ------ | ------ |
| `packages/shared/src/grading/qa-grading.spec.ts` | 45    | 45     | 0      |
| `packages/sheets/src/template/qa-cells.spec.ts`  | 69    | 69     | 0      |
| `apps/api/test/qa/*` (8 files)                   | 154   | 129    | 25     |
| `apps/worker/test/qa/faults.integration-spec.ts` | 14    | 12     | 2      |
| `e2e/qa/ui.spec.ts`                              | 22    | 22     | 0      |
| `e2e/qa/session.spec.ts`                         | 3     | 2      | 1      |
| **Total**                                        | 307   | 279    | 28     |

A test failure here means a defect is open, and each failing test is listed against its defect below.
One case can have several tests, so the test counts and case counts differ. Two tests are intermittent
(QA-005 and QA-012), so a run can differ by one or two.
`docs/qa/scripts/live-check.mjs` adds black-box checks on separate API, worker and web processes.

The baseline from section 4 of the plan also passes: 217 unit, 178 integration, 12 of 12 e2e.

## 2. Defects

Severity follows your scale. Items already recorded in the project docs are marked **known**, with
their task number from `delivery-plan-2027.md` section E.4. Being known does not lower the severity
(plan Q8).

Each **cause** comes from reading the code and watching the failure. Each **expected fix** is the
recommended direction; the developer may choose another way if the **done when** line still passes.

### Fix order

| Order | ID     | Severity | Issue                                                | Failing cases    | Size   |
| ----- | ------ | -------- | ---------------------------------------------------- | ---------------- | ------ |
| 1     | QA-001 | Critical | Revoked sessions keep working                        | A-21, A-22, A-28 | Small  |
| 2     | QA-004 | Medium   | Page load after 15 idle minutes signs the user out   | A-34             | Small  |
| 3     | QA-002 | High     | Database failure loses the sync retry                | D-17, D-20       | Medium |
| 4     | QA-003 | High     | Confirm tab changes live data; Discard does not undo | E-11, E-22       | Medium |
| 5     | QA-006 | Medium   | NUL byte returns 500, also at sign-in                | G-04             | Small  |
| 6     | QA-009 | Medium   | Archived generations still allow three actions       | E-20             | Small  |
| 7     | QA-007 | Medium   | Lockout response reveals real student IDs            | A-10             | Medium |
| 8     | QA-008 | Medium   | Anyone can keep a student locked out                 | A-11             | Medium |
| 9     | QA-010 | Low      | Rejected request bodies return 500                   | G-02, G-06, G-07 | Small  |
| 10    | QA-011 | Low      | Huge page number returns 500                         | G-11             | Small  |
| 11    | QA-012 | Low      | Backslash in `className` returns 500                 | G-03             | Small  |
| 12    | QA-013 | Low      | PostgreSQL down returns 500, not 503                 | G-19             | Small  |
| 13    | QA-014 | Low      | Expired temporary password can still be exchanged    | A-19             | Small  |
| 14    | QA-005 | Low      | Two tabs refreshing together can end the session     | A-33             | Medium |
| 15    | QA-015 | Low      | Job totals exceed the issues listed above 20,000     | E-09             | Small  |
| 16    | QA-016 | Low      | Duplicate row also reported as a student who left    | D-09             | Small  |
| 17    | QA-017 | Low      | Three student routes ignore unknown query parameters | B-05             | Small  |

QA-004 is second because it affects nearly every returning student and is a small fix, even though
its severity is Medium. QA-001 and QA-006 together with QA-010 to QA-013 can share one review.

### Critical

#### QA-001 A revoked session keeps working when its Redis denylist entry is missing

- **Severity:** Critical. **Area:** A. **Failing cases:** A-21, A-22, A-28.
- **Known:** in part. T4 covers the failed write, not an entry that is lost later.
- **Issue:** the API trusts Redis alone to know that a session was revoked. If the entry was never
  written, or Redis loses it, a reset or disabled student keeps access.
- **Steps:** Sign in as a student. Make the denylist entry absent in either way: (a) Redis fails while
  an admin resets the password or disables the account, or (b) reset, then Redis loses its data. Call
  any route with the old access cookie.
- **Expected result:** 401. The reset ended the session (your brief: "immediately"), and security.md §2
  says revocation fails closed.
- **Actual result:** 200 until the token expires, up to 15 minutes. The database correctly says the
  session is revoked, but it is only consulted while Redis is throwing. A session row deleted outright
  also keeps working.
- **Why Critical:** it is a security bypass on your scale. It is limited to 15 minutes and needs a
  Redis failure or data loss. Refresh is correctly refused, so it cannot be extended.
- **Evidence:** `apps/api/test/qa/auth.integration-spec.ts`: A-21, A-22, A-22b, A-28, each
  `expected 401 "Unauthorized", got 200 "OK"`.
- **Cause:** `apps/api/src/auth/session.service.ts:213` treats a Redis miss as "not revoked". `:228` only
  logs a failed write. `apps/api/src/auth/guards/auth.guard.ts` does not check the database or account
  status, although AUTH-10 says status is checked on every request.
- **Expected fix:** make PostgreSQL the source of truth. In `isSessionRevoked`, a Redis miss must read
  `auth_sessions.revoked_at` and `expires_at`, and treat a missing row as revoked. Keep Redis hits as
  the fast path. To protect the database, cache a "still valid" answer briefly (a few seconds) in
  Redis. Check `users.status` in the same read, which also meets AUTH-10.
- **Done when:** A-21, A-22, A-22b and A-28 pass, and G-15 latency stays near the table in section 3.

### High

#### QA-002 A transient database failure loses the retry and blocks the term for about 5 minutes

- **Severity:** High. **Area:** D. **Failing cases:** D-17, D-20.
- **Known:** the cause is new. A rarer form is noted in `progress.md`.
- **Issue:** a few seconds of database downtime stops the sync. The retry finds its own old lease,
  gives up, and tells the queue it succeeded. Nothing retries, and the term stays blocked.
- **Steps:** Start a sync of 300 students x 5 tabs with a real worker. Restart PostgreSQL during the
  apply phase, which takes seconds. Wait.
- **Expected result:** a transient error is retried, the job finishes, the term is free.
- **Actual result:** the retry never does any work. BullMQ reports the job **completed** after 2
  attempts, while the database stays `RUNNING/APPLY`. New syncs for that term get 409 until the orphan
  sweep marks it `FAILED WORKER_LOST`. Only 1 of 5 tabs had been applied, although the API spec says
  FAILED means no course was applied (see also T14). Marks were not lost, and an admin retry is safe.
- **Evidence:** D-20, two runs: blocked 288.8 s and 294.4 s, tabs `[2,1,1,1,1]`.
  `[D-20] +30s queue=completed attempts=2 job=RUNNING/APPLY`, unchanged to +270 s, then
  `finished FAILED WORKER_LOST`. D-17b: `queue state completed job RUNNING`.
- **Cause:** the lease release in `packages/sync/src/engine.ts:144` runs while the database is down, so
  it fails and the lease stays. The retry then gets `busy`, and
  `apps/worker/src/sync/sync.processor.ts:113` returns normally, which BullMQ records as success.
- **Expected fix:**
  1. In `sync.processor.ts`, do not finish the queue job on `busy` while the database job is
     unfinished. Throw so BullMQ retries it later (after the lease can have expired).
  2. Make the lease release in `engine.ts` safe: catch its error so it cannot replace the real error,
     and retry it briefly.
  3. Let the orphan sweep act at once on a job that is RUNNING in the database, finished in the queue,
     and past its lease, rather than waiting up to 5 minutes.
  4. Use a clear status or message when some tabs were applied (T14), and update the API spec.
- **Done when:** D-17b and D-20 pass: the job finishes without an admin, the term is free within about
  2 minutes, and every tab holds the new marks.

#### QA-003 Confirm tab on a new sheet changes live data, and Discard does not undo it

- **Severity:** High. **Area:** E. **Failing cases:** E-11, E-22.
- **Known:** in part. T1 covers the change before sync. The Discard behavior is new.
- **Issue:** reviewing a replacement sheet is supposed to change nothing for students. It writes names
  straight into the live subject and its columns, and they stay there if the sheet is thrown away.
- **Steps:** Replace a term's sheet. Run Detect tabs. On Confirm tab, rename a column. Discard the new
  sheet. Sync the old sheet.
- **Expected result:** students see no change until a new sheet's sync succeeds (D23). A discarded
  sheet leaves nothing behind.
- **Actual result:** the new name appears to students before any sync, and remains after Discard **and
  after re-syncing the old sheet**. The offering also keeps pointing at the discarded sheet until that
  sync. Marks and totals did not change.
- **Workaround today:** Reopen the tab on the active sheet and confirm it with the right name. Nothing
  warns an admin that this is needed.
- **Evidence:** `sync-center.integration-spec.ts`: E-11b, E-22, E-22b. E-22b diff:
  `- "1:Quiz 1:9.00"`, `+ "1:Renamed quiz:9.00"`.
- **Cause:** `apps/api/src/sheet-mappings/sheet-mappings.service.ts:269,315` write to the live offering
  and criterion. `discardPending` at `apps/api/src/sheets-sources/sheets-sources.service.ts:325`
  restores nothing.
- **Expected fix:** when the source is PENDING, Confirm tab must write only the mapping rows, keeping
  the subject and column names as proposed values. It must not update `course_offerings` or
  `assessment_criteria`. The sync that promotes the sheet applies them inside its existing transaction.
  Discard then has nothing to undo. This is T1, extended to cover Discard.
- **Done when:** E-11b, E-22 and E-22b pass, and the existing `sheet-change` suite still passes.

### Medium

#### QA-004 Any page load after 15 idle minutes signs the user out, with a valid 7-day session

- **Severity:** Medium. **Area:** A, H. **Failing case:** A-34. **Affects every returning user.**
- **Issue:** the access cookie lasts 15 minutes and the session lasts 7 days. The app should renew the
  access cookie by itself, but the first call on page load skips that step.
- **Steps:** Sign in. Let the access cookie expire (15 min, it has a matching Max-Age). Reload or reopen
  the app.
- **Expected result:** a silent refresh, as the client's own comment promises ("refreshed once,
  transparently").
- **Actual result:** sent to `/login`. The only auth call is `401 /api/v1/auth/me`; refresh is never
  tried. The refresh token stays valid and unused. Inside an already open page, refresh works (A-34b).
- **Evidence:** `e2e/qa/session.spec.ts` A-34:
  `calls ["401 /api/v1/auth/me"] url .../login?next=%2Fadmin%2Fstudents`.
- **Cause:** `apps/web/src/lib/api.ts:104` skips refresh for every `/auth/` path, and that includes the
  `/auth/me` call at `apps/web/src/lib/auth.tsx:31`.
- **Expected fix:** in `request()`, skip refresh only for `/auth/login`, `/auth/refresh` and
  `/auth/logout`, so `/auth/me` follows the normal refresh-once path. If the refresh fails, keep today's
  behavior and go to sign-in.
- **Done when:** A-34 and A-34b pass, and a signed-out visitor still reaches `/login` with no loop.

#### QA-006 A NUL byte returns 500, including on sign-in with no account

- **Severity:** Medium. **Area:** G. **Failing case:** G-04. **Known:** no.
- **Issue:** PostgreSQL text cannot hold the character `\u0000`. The API passes it to the database, and
  the error becomes a 500.
- **Steps:** `POST /api/v1/auth/login` with `{"identifier":"a\u0000b","password":"x"}`.
- **Expected result:** 400 or 401.
- **Actual result:** 500 `INTERNAL_ERROR`. Also on `q` and `className` in student and generation lists,
  audit `entityType`, and generation name, term name and sheet label. Nothing leaks, but anyone can
  create server error log entries, and Sentry reports once it is enabled.
- **Evidence:** `robustness.integration-spec.ts`: 6 G-04 tests.
- **Cause:** DTOs accept the character, and nothing removes it before the query.
- **Expected fix:** add one global check that rejects `\u0000` in any string of the body or query with
  400 `VALIDATION_FAILED`, for example in a global pipe or a small middleware, so a new route cannot
  miss it. At sign-in, return the normal 401 `INVALID_CREDENTIALS` if you want no difference at all.
- **Done when:** all G-04 tests pass.

#### QA-007 The lockout response reveals which student IDs exist

- **Severity:** Medium. **Area:** A. **Failing case:** A-10.
- **Known:** documented as an exception in security.md §2, but your brief requires the same response.
- **Issue:** only real accounts can reach `ACCOUNT_LOCKED`, so an attacker can tell a real ID from a
  made-up one.
- **Steps:** Send 5 wrong passwords for a real ID and for a made-up ID, then a sixth for each.
- **Expected result:** the same response.
- **Actual result:** real ID: 429 `ACCOUNT_LOCKED`. Made-up ID: 401 `INVALID_CREDENTIALS`.
- **Evidence:** A-10:
  `expected { status: 401, … } to deeply equal { status: 429, code: 'ACCOUNT_LOCKED' }`.
- **Cause:** `apps/api/src/auth/auth.service.ts:75-82` returns before the password check, for real
  accounts only.
- **Expected fix:** make both cases look the same. Count failures per identifier in Redis, whether or
  not the account exists, and return the same 429 `RATE_LIMITED` for both, with no `ACCOUNT_LOCKED`
  code. Update security.md §2 and the API spec. Fix together with QA-008, as they touch the same code.
- **Done when:** A-10 passes.

#### QA-008 Anyone who knows a student ID can keep that student locked out

- **Severity:** Medium. **Area:** A. **Failing case:** A-11.
- **Known:** by design, but not recorded as a risk. Student IDs are not secret.
- **Issue:** the lock is on the account, so it stops the real student as well as the attacker.
- **Steps:** Send 5 wrong passwords for a student's ID, then repeat as locks expire.
- **Expected result:** not specified. Reported as measured.
- **Actual result:** the correct password gets 429 `ACCOUNT_LOCKED`, for 1, 2, 4, 8, then 15 minutes per
  lock. An admin password reset unlocks the account. An exam or results day is the exposed moment.
- **Evidence:** A-11, a recorded test. **It passes by asserting today's behavior**, so change the test
  when this is fixed.
- **Cause:** `apps/api/src/auth/auth.service.ts:75` applies the lock before the password is checked.
- **Expected fix:** this needs your decision, because it trades safety against availability.
  Recommended: key the lock on identifier plus client IP, and keep the existing per-identifier rate
  limit as the limit across IPs. Then a guesser from one address does not lock out the student from
  another. The lockout policy in security.md §2 needs updating to match.
- **Done when:** the student can sign in from a different IP during the attack, and guessing stays
  limited to 5 per minute per identifier. A-11 is rewritten to assert this.

#### QA-009 Archived generations still allow discard, preview and confirm preview

- **Severity:** Medium. **Area:** E. **Failing case:** E-20. **Known:** T9.
- **Issue:** archived generations are read-only, but three actions forgot the check.
- **Steps:** Connect a replacement sheet with a preview. Archive the generation. Call each route.
- **Expected result:** 409 `GENERATION_ARCHIVED`.
- **Actual result:** confirm preview 200, preview 201, discard 200. ACAD-06 says archived means
  read-only.
- **Evidence:** E-20.
- **Cause:** the other write paths call `guard.assertGenerationEditable`. `preview` and `confirmPreview`
  at `sheet-mappings.service.ts:476,518` and `discardPending` at `sheets-sources.service.ts:325` do not.
- **Expected fix:** add `await this.guard.assertGenerationEditable(source.generationId)` to those three
  methods. Then remove the "no guard yet" note from the API spec.
- **Done when:** E-20 passes.

### Low

#### QA-005 Two open tabs that refresh at the same moment can end the session

- **Severity:** Low. **Area:** A. **Failing case:** A-33. **Intermittent.**
- **Issue:** a used refresh token means theft to the server, but two tabs of one person can send the
  same token together.
- **Steps:** Open the app in two tabs. As the access token expires, act in both at the same moment.
- **Expected result:** the user stays signed in.
- **Actual result:** the second refresh counts as reuse and revokes the session. The user signs in
  again. It needs both calls to overlap, so it is rare: it failed in 1 of 8 runs, with `204` then `401`.
- **Evidence:** `e2e/qa/session.spec.ts` A-33:
  `calls ["204 /api/v1/auth/refresh","401 /api/v1/auth/refresh"]`. A-14 proves the safe side: two
  refreshes at once never leave two valid chains.
- **Cause:** `apps/api/src/auth/session.service.ts:116,147` have no grace period for the token just
  rotated. The single-flight guard at `apps/web/src/lib/api.ts:89` works per tab only.
- **Expected fix:** allow the previous token for a few seconds after rotation (about 10 s) when the
  caller has the session's CSRF token. Return the current session rather than revoking it. Replay after
  that window still revokes. Or use the browser's Web Locks API so only one tab refreshes.
- **Done when:** A-33 passes 10 runs in a row, and A-13 and A-14 still pass.

#### QA-010 Rejected request bodies return 500

- **Severity:** Low. **Area:** G. **Failing cases:** G-02, G-06, G-07.
- **Issue:** the body parser's own errors reach the error filter, which treats them as server errors.
- **Steps:** Send a 100 KB login body, a 5 MB body, or `Content-Type: application/json; charset=nonsense`.
- **Expected result:** 413 `PAYLOAD_TOO_LARGE` for size, 400 or 415 for a bad charset.
- **Actual result:** 500 with no `requestId`. Reachable with no account.
- **Evidence:** G-02, G-06, G-07.
- **Cause:** `apps/api/src/common/http-exception.filter.ts:107` handles only `HttpException`. Body-parser
  errors carry a `status` or `statusCode` instead.
- **Expected fix:** in `toErrorEnvelope`, respect a 4xx `status` from an error that is not an
  `HttpException`, and use the existing code table. Do not log these as server errors or send them to
  Sentry.
- **Done when:** G-02, G-06 and G-07 pass.

#### QA-011 A huge page number returns 500

- **Severity:** Low. **Area:** G. **Failing case:** G-11. **Admin only.**
- **Issue:** `page` has a minimum but no maximum, so the calculated offset is too large for the
  database.
- **Steps:** `?page=1e308` or `?page=99999999999999999999` on any of the 6 lists.
- **Expected result:** 400 `VALIDATION_FAILED`.
- **Actual result:** 500.
- **Evidence:** G-11.
- **Cause:** `apps/api/src/common/pagination.ts:9-14` has no `@Max`. `:30` multiplies it into `skip`.
- **Expected fix:** add `@Max(1_000_000)` to `page` in `PaginationQueryDto`. Every list inherits it.
  G-11 also expects `page=9007199254740991` and `page=2147483648` to give 200, so change those two
  rows of the test to 400.
- **Done when:** G-11 passes with those rows updated.

#### QA-012 A backslash in `className` returns 500, intermittently

- **Severity:** Low. **Area:** G. **Failing case:** G-03. **Admin only. Failed 7 of 8 runs.**
- **Issue:** a case-insensitive match becomes `ILIKE`, and a backslash is special in that pattern.
- **Steps:** `GET /api/v1/admin/students?className=\`
- **Expected result:** 200 with no rows, or 400.
- **Actual result:** 500.
- **Evidence:** G-03. Confirmed directly in PostgreSQL:
  `ERROR: LIKE pattern must not end with escape character`. The error only occurs when the pattern is
  evaluated against a row, which fits the intermittent result.
- **Cause:** `apps/api/src/students/students.service.ts:102` and `:234` use `equals` with
  `mode: 'insensitive'`. The issue-credentials selection at `:234` has the same problem.
- **Expected fix:** add a pattern to `className` in both DTOs that allows letters, digits, spaces and
  hyphens. Other characters then return 400 before any query runs.
- **Done when:** G-03 passes 10 runs in a row.

#### QA-013 PostgreSQL down gives 500, not 503

- **Severity:** Low. **Area:** G. **Failing case:** G-19.
- **Issue:** the API spec promises 503 when a dependency is down. Monitoring and the web app cannot
  tell this from a bug.
- **Steps:** Stop PostgreSQL. Read `/student/me/results`.
- **Expected result:** 503 `SERVICE_UNAVAILABLE`.
- **Actual result:** 500 `INTERNAL_ERROR`. The body is clean, and the API recovers with no restart.
- **Evidence:** `docs/qa/evidence/live-check.txt`, G-19c.
- **Cause:** database connection errors are not mapped in `http-exception.filter.ts`.
- **Expected fix:** map Prisma connection errors to 503 `SERVICE_UNAVAILABLE` in the filter, without
  sending them to Sentry as bugs.
- **Done when:** `live-check.mjs outage` passes G-19c.

#### QA-014 An expired temporary password can still be exchanged

- **Severity:** Low. **Area:** A. **Failing case:** A-19. It needs a session opened before expiry.
- **Issue:** the expiry is checked at sign-in, but not at change-password.
- **Steps:** Sign in with a temporary password. Wait past its expiry. Change the password from that
  session.
- **Expected result:** refused, as "temporary passwords past expiry cannot log in" implies.
- **Actual result:** 204, and the new password works.
- **Evidence:** A-19b: `expected 204 to be greater than or equal to 400`.
- **Cause:** `apps/api/src/auth/auth.service.ts:248` does not read `passwordExpiresAt`.
- **Expected fix:** in `changePassword`, if `mustChangePassword` is set and `passwordExpiresAt` has
  passed, return 403 `TEMPORARY_PASSWORD_EXPIRED`.
- **Done when:** A-19b passes.

#### QA-015 Job totals exceed the issues listed above 20,000

- **Severity:** Low. **Area:** E. **Failing case:** E-09. **Known:** T2.
- **Issue:** at most 20,000 issues are stored, but all are counted, and nothing tells the admin.
- **Steps:** Run a sync with 20,500 row errors.
- **Expected result:** totals match the rows, or the page says how many are not listed.
- **Actual result:** `errorCount 20500, listed 20000`, with no note.
- **Evidence:** E-09.
- **Cause:** `packages/sync/src/engine.ts:34,64,195-196`.
- **Expected fix:** return a `truncated` count from `GET /admin/sync/:jobId/errors`, and show it on the
  job page. This is T2. E-09 then asserts the note, not equal totals.
- **Done when:** the job page says how many issues are not listed.

#### QA-016 A duplicate row is also reported as a student who left

- **Severity:** Low. **Area:** D. **Failing case:** D-09.
- **Issue:** duplicate rows are removed before the enrollment step, so the student looks missing.
- **Steps:** Add a second row for a student in a tab, and sync.
- **Expected result:** `DUPLICATE_ROW` only.
- **Actual result:** also `ENROLLMENT_MISSING_IN_SOURCE`, and `present_in_source` becomes false. Marks
  are kept.
- **Evidence:** D-09.
- **Cause:** `packages/sheets/src/term-workbook/subject-rows.ts:132` drops the rows, then
  `packages/sync/src/apply-course.ts:309-317` treats the student as gone.
- **Expected fix:** pass the rejected student codes with the parsed course, and exclude them from the
  missing check.
- **Done when:** D-09 passes.

#### QA-017 Three student routes ignore unknown query parameters

- **Severity:** Low. **Area:** B. **Failing case:** B-05. **Not a leak:** B's data is never returned.
- **Issue:** the API spec says unknown query parameters give 400, but three routes declare no query
  type, so the check never runs.
- **Steps:** `GET /student/me?studentId=<another id>`, also `/summary` and `/courses`.
- **Expected result:** 400 (API spec §3).
- **Actual result:** 200 with the caller's own data.
- **Evidence:** B-05: `?studentId -> 200`, 15 combinations.
- **Cause:** `apps/api/src/results/student-results.controller.ts:16,28,33` have no `@Query()` parameter.
- **Expected fix:** add an empty query DTO to those three handlers. The global validation pipe then
  refuses unknown parameters.
- **Done when:** B-05 passes.

## 3. Coverage by area

| Area                      | Cases | PASS | FAIL | NI  | NT  | Failing cases                                  |
| ------------------------- | ----- | ---- | ---- | --- | --- | ---------------------------------------------- |
| A Authentication          | 34    | 26   | 8    | 0   | 0   | A-10, A-11, A-19, A-21, A-22, A-28, A-33, A-34 |
| B Authorization           | 20    | 18   | 1    | 0   | 1   | B-05 (no leak). NT: B-14                       |
| C Score calculation       | 19    | 17   | 0    | 2   | 0   | NI: C-18, C-19                                 |
| D Google Sheets sync      | 25    | 20   | 3    | 2   | 0   | D-09, D-17, D-20. NI: D-14, D-25 (DLQ)         |
| E Sync Center             | 22    | 18   | 4    | 0   | 0   | E-09, E-11, E-20, E-22                         |
| F Student and admin flows | 14    | 11   | 0    | 3   | 0   | NI: F-07, F-08, F-09                           |
| G Robustness              | 20    | 13   | 7    | 0   | 0   | G-02, G-03, G-04, G-06, G-07, G-11, G-19       |
| H User interface          | 15    | 15   | 0    | 0   | 0   |                                                |
| **Total**                 | 169   | 138  | 23   | 7   | 1   |                                                |

Appendix A lists every case with its result and evidence.

Notes on passes:

- **A-02:** median 85.5 ms for a known user, 81.0 ms for an unknown one.
- **D-05:** passes against the documented behavior, but see the first decision in section 5.
- **D-16:** recovery took 131 s, because BullMQ's stall detection follows the 120 s lock. The term is
  blocked for that long after a worker crash.
- **D-20b:** a Redis restart mid-job recovered with no data problem, in 136 s.
- **E-04:** checked through the API, not in the browser.
- **F-11:** the `present_in_source` flag is correct, but there is no history table for enrollment
  changes, so only the current state is kept.
- **G-16:** see the performance table. It has no pass limit in the plan, so it passes as a measurement.
  The sheet change holds the global roster lock for that whole time (T3).
- **H-04:** the three error states are in H-04. The "session expired" part is covered by A-34, which ends
  on the sign-in page with no crash.
- **G-20:** no route accepts uploads, so the `multer` advisory is not reachable in this app. Upgrading
  is still sensible. `shadcn` is listed as a production dependency of the web app, which is why the
  `deepmerge` advisory appears.

### Performance at 300 students x 5 subjects

One Windows development machine, in-process HTTP, 9,000 score rows. Not a production forecast. Two
full runs are shown. The last run started right after Docker Desktop was restarted, which probably
explains its slower writes; that was not measured. Treat the write timings as a range.

| Measure                          | Earlier run               | Last run                  |
| -------------------------------- | ------------------------- | ------------------------- |
| Student results, cached          | p50 95 ms, p99 344 ms     | p50 117 ms, p99 349 ms    |
| Admin results, never cached      | p50 236 ms, p99 295 ms    | p50 229 ms, p99 300 ms    |
| Student list, 100 rows           | p50 110 ms, p99 239 ms    | p50 121 ms, p99 144 ms    |
| First import                     | 8.9 s                     | 19.3 s                    |
| Re-sync, nothing changed         | 0.9 s                     | 3.0 s                     |
| Re-sync, every mark changed      | 23.1 s                    | 95.1 s                    |
| Sheet change, every mark changed | 24.9 s in one transaction | 28.3 s in one transaction |
| SQL statements, one results call | 10 uncached, 2 cached     | Not repeated              |

## 4. What I could not test, and what I need

| Item                                         | Status      | What I need                                                                                                                                |
| -------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Live Google connect and sync                 | BLOCKED     | A Google Sheet of fake data shared with a test service account. All sync tests used the in-memory reader                                   |
| Production images, Caddy, HTTPS, HSTS, Linux | BLOCKED     | A staging host. A kill here is a hard kill, because graceful SIGTERM cannot run on Windows                                                 |
| Backup and restore drill                     | BLOCKED     | The same staging host                                                                                                                      |
| Comparison with the real workbook's formulas | Limited     | `test-case.xlsx` was not opened (plan Q1). C-09 used 3 synthetic students. Confirm it is anonymized, and I will compare every complete row |
| `.env`                                       | Not checked | You asked me not to read it. Please check yourself that it has no production values                                                        |
| B-14 404 timing                              | NOT TESTED  | Nothing needed. Not run because the bodies were identical and the code path is the same                                                    |
| Manual look at each page                     | Partial     | Pages were automated at 1280 and 390 px, and I viewed failure screenshots only                                                             |
| Cached results after a crash mid-sync        | Not tested  | A worker that dies before the cache version is bumped may leave old marks cached for up to 10 minutes. Read from the code, not observed    |

## 5. Decisions for you

These are not defects, because the intended behavior is not defined or the answer is yours:

1. **An erased mark (plan Q7).** A cell cleared in the sheet keeps its old mark, and the student still
   sees COMPLETE with a total, as documented. Your brief says any blank gives INCOMPLETE. D-05 shows it
   with a warning for the admin only.
2. **A new subject after a term is released** stays hidden, with no warning, until someone releases
   the term again (D-18b).
3. **Retry has no rate limit.** The 10 per minute limit is only on `POST /admin/sync`. A retry loop is
   not limited (recorded test in `sync.integration-spec.ts`).

### MVP gaps (not defects)

The delivery plan puts these in the 1 January MVP. None exists beyond empty tables:

- Letter grades and grade scales (D5)
- SNA/WEP programs (D8)
- Teacher comments shown to students (D6)

Also not built: creating or editing students, and a dead-letter queue.

## 6. Re-running the tests

The test files are **not in the commit that adds this report**. They sit in `apps/api/test/qa/`,
`apps/worker/test/qa/`, `e2e/qa/`, `packages/shared/src/grading/qa-grading.spec.ts` and
`packages/sheets/src/template/qa-cells.spec.ts`. `pnpm test:integration` picks them up automatically and
fails while the defects are open, so committing them turns CI red until the fixes land. Saved results
are in [evidence/](evidence/README.md).

Run from a checkout whose `TEST_*` settings point at a test database, after `pnpm build`:

```bash
pnpm --filter @ssrs/api exec vitest run --config ./vitest.config.integration.ts test/qa
```

```bash
pnpm --filter @ssrs/worker exec vitest run --config ./vitest.config.integration.ts test/qa --testTimeout=60000
```

```bash
E2E_CHANNEL=msedge pnpm --filter @ssrs/e2e exec playwright test --config qa/playwright.qa.config.ts qa/ui
```

```bash
E2E_CHANNEL=msedge pnpm --filter @ssrs/e2e exec playwright test --config qa/playwright.qa.config.ts qa/session
```

- The worker suite takes about 12 minutes. Its D-20 tests restart the Docker containers named
  `ssrs-qa-postgres-1` and `ssrs-qa-redis-1`, so run them only against that stack, or change the names.
- `docs/qa/scripts/live-check.mjs` needs a running stack. Its header explains how.
- Run `qa/ui` and `qa/session` separately, a minute apart: they share the limit of 10 sign-ins per minute.
- Counts are from the last run of each suite, all on the final test files. The worker suite is the one
  exception; see [evidence/](evidence/README.md).

## Appendix A. Every case

Evidence names a test in the saved results in [evidence/](evidence/README.md), or a line in
`live-check.txt`. "(baseline)" means an existing project test, re-read and passing in the baseline.

### A Authentication and sessions

| Case | What was checked                                                                         | Result | Evidence                                                           |
| ---- | ---------------------------------------------------------------------------------------- | ------ | ------------------------------------------------------------------ |
| A-01 | Unknown user and wrong password: same status, body and headers                           | PASS   | A-01 in `auth.integration-spec.ts`                                 |
| A-02 | Timing of unknown user and wrong password over 30 samples                                | PASS   | A-02 in `api-tests.txt`                                            |
| A-03 | Disabled account: correct and wrong password; existing session refused                   | PASS   | A-03 in `auth.integration-spec.ts`                                 |
| A-04 | PENDING account and locked password hash cannot sign in                                  | PASS   | A-04 in `auth.integration-spec.ts`                                 |
| A-05 | Per-IP limit: 429 with `Retry-After` on the 11th attempt                                 | PASS   | A-05 in `auth.integration-spec.ts`                                 |
| A-06 | Per-username limit: 429 on the 6th attempt, from different IPs                           | PASS   | A-06 in `auth.integration-spec.ts`                                 |
| A-07 | Case and whitespace variants of a username cannot dodge the limit                        | PASS   | A-07 in `auth.integration-spec.ts`                                 |
| A-08 | Spoofed `X-Forwarded-For` cannot dodge the IP limit with `TRUST_PROXY_HOPS=0`            | PASS   | A-08 in `auth.integration-spec.ts`                                 |
| A-09 | Lockout timing: 1, 2, 4, 8, capped at 15 min; reset on success                           | PASS   | `lockout.spec.ts`; A-09 in `auth.integration-spec.ts`              |
| A-10 | `ACCOUNT_LOCKED` reveals a real account: measure against the "same response" requirement | FAIL   | A-10 in `auth.integration-spec.ts` (QA-007)                        |
| A-11 | An attacker can lock a student out: measure the effect                                   | FAIL   | A-11 in `auth.integration-spec.ts` (QA-008)                        |
| A-12 | Refresh rotates both tokens; old access token behavior recorded                          | PASS   | A-12 in `auth.integration-spec.ts`                                 |
| A-13 | Reusing an old refresh token revokes the whole chain                                     | PASS   | A-13 in `auth.integration-spec.ts`                                 |
| A-14 | Two refreshes at once with the same token: no fork, no valid leftover token              | PASS   | A-14 in `auth.integration-spec.ts`                                 |
| A-15 | Logout revokes access and refresh tokens at once                                         | PASS   | A-15 in `auth.integration-spec.ts`                                 |
| A-16 | Logout with only the refresh cookie (expired access token)                               | PASS   | A-16 in `auth.integration-spec.ts`                                 |
| A-17 | Temporary password: every score and admin route returns 403 until changed                | PASS   | A-17 in `auth.integration-spec.ts`                                 |
| A-18 | Forced-change flag cannot be cleared by refresh or a new login                           | PASS   | A-18 in `auth.integration-spec.ts`                                 |
| A-19 | Temporary password past expiry: no login; existing session behavior recorded             | FAIL   | A-19 in `auth.integration-spec.ts` (QA-014)                        |
| A-20 | Admin reset ends the student's session at once (access and refresh)                      | PASS   | A-20 in `auth.integration-spec.ts`                                 |
| A-21 | Admin reset while Redis is failing: token refused afterwards (known deviation T4)        | FAIL   | A-21 in `auth.integration-spec.ts` (QA-001)                        |
| A-22 | Disable while Redis is failing: same check                                               | FAIL   | A-22 in `auth.integration-spec.ts` (QA-001)                        |
| A-23 | Cookies: HttpOnly, SameSite and Path on all three, local and with `COOKIE_SECURE=true`   | PASS   | A-23, A-23b in `auth.integration-spec.ts`                          |
| A-24 | `NODE_ENV=production` with insecure cookies is refused at startup                        | PASS   | A-24 in `auth.integration-spec.ts`                                 |
| A-25 | No hash or token in any JSON response: scan all 53 routes                                | PASS   | `secrets.integration-spec.ts`                                      |
| A-26 | No password, hash, token or temporary password in API or worker logs, or audit rows      | PASS   | `live-check.txt` A-26, A-26b                                       |
| A-27 | JWT tampering: `alg:none`, wrong secret, changed role, wrong `iss` or `aud`, expired     | PASS   | A-27 in `auth.integration-spec.ts`                                 |
| A-28 | Token for a deleted or other session's `sid`                                             | FAIL   | A-28 in `auth.integration-spec.ts` (QA-001)                        |
| A-29 | CSRF: missing, wrong, other session's token; missing and foreign Origin                  | PASS   | `security.integration-spec.ts`; A-29 in `auth.integration-spec.ts` |
| A-30 | Change password: policy, wrong current password, 5/min limit, other sessions revoked     | PASS   | A-30 in `auth.integration-spec.ts`                                 |
| A-31 | Refresh past the 7-day absolute lifetime                                                 | PASS   | A-31 in `auth.integration-spec.ts`                                 |
| A-32 | Disabled, then enabled: old sessions stay dead                                           | PASS   | A-32 in `auth.integration-spec.ts`                                 |
| A-33 | two open tabs refresh at the same moment; the user stays signed in                       | FAIL   | A-33 in `session-tests.txt` (QA-005)                               |
| A-34 | a page load after the access cookie expires keeps the valid session                      | FAIL   | A-34 in `session-tests.txt` (QA-004)                               |

### B Authorization and data isolation

| Case | What was checked                                                                      | Result     | Evidence                                         |
| ---- | ------------------------------------------------------------------------------------- | ---------- | ------------------------------------------------ |
| B-01 | Generated from live route metadata: student token on all 41 admin routes returns 403  | PASS       | B-01 in `isolation.integration-spec.ts`          |
| B-02 | Same list, no token: 401. Also a garbage token and an expired token                   | PASS       | B-02 in `isolation.integration-spec.ts`          |
| B-03 | Admin token on the 5 student routes returns 403                                       | PASS       | B-03 in `isolation.integration-spec.ts`          |
| B-04 | Student A requests B's offering, hidden, withdrawn, unknown: identical 404            | PASS       | B-04 in `isolation.integration-spec.ts`          |
| B-05 | `studentId`, `studentCode`, `userId` in query, body, headers and cookies: no effect   | FAIL       | B-05 in `isolation.integration-spec.ts` (QA-017) |
| B-06 | Parameter pollution: repeated `term`, array form, nested form                         | PASS       | B-06 in `isolation.integration-spec.ts`          |
| B-07 | Malformed, SQL-shaped and very long `offeringId`, `term`                              | PASS       | B-07 in `isolation.integration-spec.ts`          |
| B-08 | Terms 0, 6, -1, 1.5, `1e0`, empty                                                     | PASS       | B-08 in `isolation.integration-spec.ts`          |
| B-09 | Cache: A then B, responses never cross; keys contain the student id                   | PASS       | B-09 in `isolation.integration-spec.ts`          |
| B-10 | Cache after hide: previously cached results stop showing at once                      | PASS       | B-10 / B-12 in `isolation.integration-spec.ts`   |
| B-11 | Cache after disable, sync, sheet change, withdrawal                                   | PASS       | B-11 in `isolation.integration-spec.ts`          |
| B-12 | Hidden term data absent from all 4 result routes and summaries, including counts      | PASS       | B-10 / B-12 in `isolation.integration-spec.ts`   |
| B-13 | Student in another generation sees nothing of a shared course code                    | PASS       | B-13 in `isolation.integration-spec.ts`          |
| B-14 | 404 body and timing do not reveal whether another student's offering exists           | NOT TESTED | 404 bodies compared in B-04; timing not measured |
| B-15 | Path tricks: `/API/V1/Admin`, trailing slash, double slash, `%2e%2e`, method override | PASS       | B-15 in `isolation.integration-spec.ts`          |
| B-16 | `HEAD`, `OPTIONS`, `PUT`, `DELETE` on protected routes                                | PASS       | B-16 in `isolation.integration-spec.ts`          |
| B-17 | Same access checks through the Next.js `/api` proxy                                   | PASS       | `live-check.txt` B-17a to B-17e                  |
| B-18 | Student opens `/admin/*` pages: redirected and no admin data in the HTML              | PASS       | `ui.spec.ts` B-18; `live-check.txt` B-18a        |
| B-19 | Mass assignment: `role`, `status`, `passwordHash`, `generationId` in every body       | PASS       | B-19 in `isolation.integration-spec.ts`          |
| B-20 | New public route guard: `route-policy.spec.ts` fails if a policy is removed           | PASS       | `route-policy.spec.ts` (baseline)                |

### C Score calculation

| Case | What was checked                                                                                                                        | Result          | Evidence                                         |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------- | --------------- | ------------------------------------------------ |
| C-01 | Total = sum(mark x weight / 100), hand-worked table of 30 rows                                                                          | PASS            | C-01 in `unit-grading.txt`                       |
| C-02 | Half-up on exact ties: x.xx5, x.xx4999, 0.005, 99.995, 100.000                                                                          | PASS            | C-02 in `unit-grading.txt`                       |
| C-03 | Rounded exact sum, not the sum of rounded parts                                                                                         | PASS            | `qa-grading.spec.ts`                             |
| C-04 | Property test against an independent BigInt calculator, 10,000 random schemes                                                           | PASS            | C-04 in `unit-grading.txt`                       |
| C-05 | Any blank: INCOMPLETE, null total, for each position of the blank                                                                       | PASS            | C-05 in `sync.integration-spec.ts`               |
| C-06 | Blank is stored as no row or NULL, never 0: checked in the database                                                                     | PASS            | C-12 / C-05 / C-06 in `sync.integration-spec.ts` |
| C-07 | `ABS` counts as 0 and stays visible as absent                                                                                           | PASS            | C-07 in `unit-grading.txt`                       |
| C-08 | Mark of 0 is complete, not blank                                                                                                        | PASS            | C-05 / C-08 in `qa-grading.spec.ts`              |
| C-09 | Sample comparison, Logic and MsOffice rows against the fixture's own `Total`                                                            | PASS            | C-09 in `sync.integration-spec.ts`               |
| C-10 | ENG group-split weights: 16 columns total exactly 100                                                                                   | PASS            | C-10 in `sync.integration-spec.ts`               |
| C-11 | A group split across 3 columns (edited fixture, 5% over 3): 1.667 x 3 is not 5. Does confirm still work, and does the total stay right? | PASS            | C-11 in `sync.integration-spec.ts`               |
| C-12 | BCU partial rows: INCOMPLETE where the sheet's `Total` shows a number (D3)                                                              | PASS            | C-12 in `sync.integration-spec.ts`               |
| C-13 | Confirm rejected: weights 99.999, 100.001, 0, negative, 4 decimals, missing                                                             | PASS            | C-13 in `sync.integration-spec.ts`               |
| C-14 | Weight change creates a new version and recalculates; history keeps the old one                                                         | PASS            | C-14 in `sync.integration-spec.ts`               |
| C-15 | Term average: credit-weighted, exact, rounded once, only when all complete                                                              | PASS            | C-15 in `unit-grading.txt`                       |
| C-16 | Stored mark above the maximum gives NEEDS_REVIEW, no total                                                                              | PASS            | `grading.spec.ts` (baseline)                     |
| C-17 | API and web agree: the value shown in the browser equals the API value                                                                  | PASS            | H-06 / C-17 / F-06 in `ui.spec.ts`               |
| C-18 | Grade boundaries exact (84.99, 85.00, and so on)                                                                                        | NOT IMPLEMENTED | Feature is not built                             |
| C-19 | Changing the grade scale recalculates and writes history                                                                                | NOT IMPLEMENTED | Feature is not built                             |

### D Google Sheets sync

| Case | What was checked                                                                                      | Result          | Evidence                                                                           |
| ---- | ----------------------------------------------------------------------------------------------------- | --------------- | ---------------------------------------------------------------------------------- |
| D-01 | Preview writes no student, offering, score, revision or enrollment row: table-by-table row-count diff | PASS            | E-10 / D-01 in `sync-center.integration-spec.ts`                                   |
| D-02 | Re-import of the same data: every table identical, zero revisions                                     | PASS            | D-02 in `sync.integration-spec.ts`                                                 |
| D-03 | One changed mark: one score updated, one revision row with job, tab and row                           | PASS            | D-03 in `sync.integration-spec.ts`                                                 |
| D-04 | Row missing later: scores kept, enrollment flagged, warning raised                                    | PASS            | D-04 in `sync.integration-spec.ts`                                                 |
| D-05 | Cleared cell: mark kept with a warning. Effect on the student's total recorded                        | PASS            | D-05 in `sync.integration-spec.ts`                                                 |
| D-06 | Rejected rows name tab and row: unknown student, duplicate, text, above 100, below 0                  | PASS            | D-06 in `sync.integration-spec.ts`                                                 |
| D-07 | Odd cells: `abs`, `85`, `85%`, `8,5`, `1e2`, `TRUE`, dates, `#REF!`, `-0`, 100.0001, 4 decimals, NBSP | PASS            | `qa-cells.spec.ts`                                                                 |
| D-08 | Student IDs: lower case, trailing space, NBSP, zero-width, inner space, 33 characters                 | PASS            | `qa-cells.spec.ts`                                                                 |
| D-09 | Same student twice in one tab, and with different case                                                | FAIL            | D-09 in `sync.integration-spec.ts` (QA-016)                                        |
| D-10 | ENG header on row 3, header named `f`, trailing spaces                                                | PASS            | D-10 in `sync.integration-spec.ts`                                                 |
| D-11 | `_meta` and `ALL` never read for scores. Unmapped tabs reported                                       | PASS            | D-11 in `sync.integration-spec.ts`                                                 |
| D-12 | Tab reorder, column reorder, header rename: `NEEDS_REMAP`, nothing applied to that tab                | PASS            | D-12 in `sync.integration-spec.ts`                                                 |
| D-13 | Formula-injection and script strings in names, comments, tab titles                                   | PASS            | D-13 in `sync.integration-spec.ts`                                                 |
| D-14 | Shared subjects resolve to the right program for SNA and WEP                                          | NOT IMPLEMENTED | Feature is not built                                                               |
| D-15 | Second sync while one runs: 409 for SOURCE, TERM and through retry                                    | PASS            | D-15 in `sync.integration-spec.ts`                                                 |
| D-16 | Worker killed mid-job and restarted: job finishes or fails cleanly, scores intact                     | PASS            | D-16 in `worker-tests.txt`                                                         |
| D-17 | Duplicate delivery, including after a crash (known issue in `progress.md`)                            | FAIL            | D-17 in `faults.integration-spec.ts` (QA-002)                                      |
| D-18 | Google 500, 503, 429, timeout: retried. 403, 404: not retried                                         | PASS            | D-18 in `sync.integration-spec.ts`                                                 |
| D-19 | Database error partway through a tab: that tab rolls back, others kept                                | PASS            | D-19 in `faults.integration-spec.ts`                                               |
| D-20 | Database down for the whole job, Redis down at enqueue, Redis lost mid-job                            | FAIL            | D-20 in `worker-tests.txt` (QA-002)                                                |
| D-21 | Exhausted retries: final state correct and scores intact. BullMQ failed set stands in for a DLQ (Q4)  | PASS            | D-21 in `faults.integration-spec.ts`                                               |
| D-22 | Every failure above: checksum of all score rows before and after                                      | PASS            | Score digest compared in D-18b, D-21, D-21b; D-20 row count                        |
| D-23 | Retry of a job on a disabled source or an archived generation                                         | PASS            | D-23 in `sync.integration-spec.ts`                                                 |
| D-24 | Second generation's student ID in this workbook is refused                                            | PASS            | `engine.integration-spec.ts`: never moves a student between generations (baseline) |
| D-25 | dead-letter queue after the retry limit (from the brief; see Q4)                                      | NOT IMPLEMENTED | Feature is not built                                                               |

### E Sync Center

| Case | What was checked                                                                          | Result | Evidence                                                                                |
| ---- | ----------------------------------------------------------------------------------------- | ------ | --------------------------------------------------------------------------------------- |
| E-01 | Term options follow the selected Generation                                               | PASS   | H-09 / E-01 in `ui.spec.ts`; E-01 / E-02 in `sync-center.integration-spec.ts`           |
| E-02 | Mismatched Generation and Term rejected with 422                                          | PASS   | E-01 / E-02, E-02b in `sync-center.integration-spec.ts`                                 |
| E-03 | All generations + one term covers the right sources                                       | PASS   | E-03 in `sync-center.integration-spec.ts`                                               |
| E-04 | Old jobs without `term_number` still display                                              | PASS   | E-04 in `sync-center.integration-spec.ts`                                               |
| E-05 | Parent job shows all issues from all sources                                              | PASS   | E-05 in `sync-center.integration-spec.ts`                                               |
| E-06 | Source job shows only its own issues                                                      | PASS   | E-06 in `sync-center.integration-spec.ts`                                               |
| E-07 | Job total equals the sum, with no duplicates across pages                                 | PASS   | E-07 in `sync-center.integration-spec.ts`                                               |
| E-08 | Pagination: order stable, last page, past the end, each filter                            | PASS   | E-08 in `sync-center.integration-spec.ts`                                               |
| E-09 | 20,000-issue cap: totals and the missing note (known T2)                                  | FAIL   | E-09 in `api-tests.txt` (QA-015)                                                        |
| E-10 | Score checksum identical before and after: connect, detect, confirm tab, preview, confirm | PASS   | E-10 in `sync-center.integration-spec.ts`                                               |
| E-11 | What a student sees during the same steps, including names (known deviation T1)           | FAIL   | E-11 in `sync-center.integration-spec.ts` (QA-003)                                      |
| E-12 | Sync without a preview rejected, directly and through `POST /sync/:id/retry`              | PASS   | E-12 in `sync-center.integration-spec.ts`                                               |
| E-13 | Old preview cannot sync the new sheet, or another sheet                                   | PASS   | E-13 in `sync-center.integration-spec.ts`                                               |
| E-14 | Sheet edited after the preview: `PREVIEW_STALE`, nothing applied                          | PASS   | `sheet-change.integration-spec.ts`: refuses a sheet edited after its preview (baseline) |
| E-15 | Failed sync leaves the old sheet active and every table unchanged                         | PASS   | E-15 in `sync-center.integration-spec.ts`                                               |
| E-16 | Cancelled sync (set in the database): same check                                          | PASS   | `sheet-change.integration-spec.ts`: job was cancelled (baseline)                        |
| E-17 | Switching during a running sync rejected                                                  | PASS   | `sheet-change.integration-spec.ts`: rejected while a sync is running (baseline); E-17b  |
| E-18 | Each step audited, no secrets: `source.switched`, `promoted`, `pending.discarded`         | PASS   | E-18 in `sync-center.integration-spec.ts`                                               |
| E-19 | Retry of a failed pending-sheet job after its preview is voided                           | PASS   | E-19 in `sync-center.integration-spec.ts`                                               |
| E-20 | Discard, preview and confirm on an archived generation (known T9)                         | FAIL   | E-20 in `sync-center.integration-spec.ts` (QA-009)                                      |
| E-21 | Promoting a sheet when a student is missing from it: scores kept                          | PASS   | `sheet-change.integration-spec.ts`: keeps a missing student scores (baseline)           |
| E-22 | discarding a new sheet undoes what its Confirm tab changed                                | FAIL   | E-22 in `sync-center.integration-spec.ts` (QA-003)                                      |

### F Student and admin flows

| Case | What was checked                                                              | Result          | Evidence                                                                |
| ---- | ----------------------------------------------------------------------------- | --------------- | ----------------------------------------------------------------------- |
| F-01 | First sync creates each account once; a second run creates none               | PASS            | F-01 in `flows.integration-spec.ts`                                     |
| F-02 | Temporary password returned once, not retrievable afterwards                  | PASS            | F-02 in `flows.integration-spec.ts`                                     |
| F-03 | Temporary passwords absent from the database, logs and audit, by value search | PASS            | `live-check.txt` F-03                                                   |
| F-04 | Bulk issue: `onlyPending` default leaves active students alone                | PASS            | F-04 in `flows.integration-spec.ts`                                     |
| F-05 | CSV: BOM, formula-safe cells, `no-store`, 500 limit                           | PASS            | F-05 in `flows.integration-spec.ts`                                     |
| F-06 | Student view: components, status, total only when complete                    | PASS            | F-06 in `flows.integration-spec.ts`; H-06 / C-17 / F-06 in `ui.spec.ts` |
| F-07 | Grade shown only when complete                                                | NOT IMPLEMENTED | Feature is not built                                                    |
| F-08 | Teacher comments shown (D6)                                                   | NOT IMPLEMENTED | Feature is not built                                                    |
| F-09 | Create and edit a student                                                     | NOT IMPLEMENTED | Feature is not built                                                    |
| F-10 | Disable and enable: sessions, login, audit                                    | PASS            | F-10 in `flows.integration-spec.ts`                                     |
| F-11 | Enrollment change keeps history                                               | PASS            | F-11 in `flows.integration-spec.ts`                                     |
| F-12 | Audit written for each admin action, append-only trigger holds                | PASS            | F-12 in `flows.integration-spec.ts`                                     |
| F-13 | Generation create, edit, archive; archived is read-only; five terms always    | PASS            | F-13 in `flows.integration-spec.ts`                                     |
| F-14 | Lost tests from T10: 404 and 400 handling, pagination, reset rules            | PASS            | F-14 in `flows.integration-spec.ts`                                     |

### G Robustness and security basics

| Case | What was checked                                                                     | Result | Evidence                                                            |
| ---- | ------------------------------------------------------------------------------------ | ------ | ------------------------------------------------------------------- |
| G-01 | Generated fuzz over every body route: empty, wrong types, null, arrays, deep nesting | PASS   | G-01 in `robustness.integration-spec.ts`                            |
| G-02 | Very long strings on every string field, and a very long password at login           | FAIL   | G-02 in `robustness.integration-spec.ts` (QA-010)                   |
| G-03 | SQL injection strings in every string field and `q` filter                           | FAIL   | G-03 in `robustness.integration-spec.ts` (QA-012)                   |
| G-04 | NUL byte (`%00`, `\u0000`) in `q`, identifier, label: must not be a 500              | FAIL   | G-04 in `robustness.integration-spec.ts` (QA-006)                   |
| G-05 | Script strings stored and rendered: not executed in the browser                      | PASS   | G-05 in `ui.spec.ts`; G-05b in `robustness.integration-spec.ts`     |
| G-06 | Oversized payload: 413 in the standard error format                                  | FAIL   | G-06 in `robustness.integration-spec.ts` (QA-010)                   |
| G-07 | Malformed JSON, wrong content type, bad charset                                      | FAIL   | G-07 in `robustness.integration-spec.ts` (QA-010)                   |
| G-08 | No stack trace, file path, SQL or Prisma text in any error above                     | PASS   | `assertClean` in every `robustness.integration-spec.ts` test        |
| G-09 | Security headers on API and web, including CSP nonce                                 | PASS   | `live-check.txt` G-09a to G-09j                                     |
| G-10 | CORS: unlisted origin, `CORS_ORIGINS=*` refused at startup                           | PASS   | G-10 in `secrets.integration-spec.ts`; `live-check.txt` G-10, G-10b |
| G-11 | Pagination: `pageSize` 0, -1, 101, huge `page`, non-numeric, on every list           | FAIL   | G-11 in `robustness.integration-spec.ts` (QA-011)                   |
| G-12 | Audit `from` and `to` with invalid dates                                             | PASS   | G-12 in `robustness.integration-spec.ts`                            |
| G-13 | Swagger not served when disabled; production compose forces it off                   | PASS   | G-13 in `secrets.integration-spec.ts`                               |
| G-14 | Global limit, including through the proxy                                            | PASS   | `live-check.txt` G-14a, G-14b                                       |
| G-15 | Response time: 300 students x 5 subjects, cached and uncached, p50 and p99           | PASS   | G-15 lines in `api-tests.txt`                                       |
| G-16 | Sync time and lock time for 300 x 5 (known T3)                                       | PASS   | G-16 lines in `api-tests.txt`                                       |
| G-17 | N+1 check: query count for one student's results                                     | PASS   | `live-queries.txt`                                                  |
| G-18 | Redis down: readiness 503, reads still work, limiters fail open as documented        | PASS   | `live-check.txt` G-18a to G-18f                                     |
| G-19 | PostgreSQL down: clean 503, recovers without restart                                 | FAIL   | `live-check.txt` G-19a to G-19d (QA-013)                            |
| G-20 | `multer` advisory: any upload route reachable?                                       | PASS   | No `FileInterceptor` or upload route in `apps/api/src`              |

### H User interface

| Case | What was checked                                                             | Result | Evidence                                                                                          |
| ---- | ---------------------------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------- |
| H-01 | Sign-in: empty, wrong password, 429 and lockout messages                     | PASS   | H-01, H-01b, H-01c in `ui.spec.ts`                                                                |
| H-02 | Forced password change: weak password message, cannot skip by URL            | PASS   | H-02 in `ui.spec.ts`                                                                              |
| H-03 | Student empty states: no released term, no courses                           | PASS   | H-03 in `ui.spec.ts`                                                                              |
| H-04 | Student error states: API returns 500, 503, session expired mid-use          | PASS   | H-04 in `ui.spec.ts`. Session expiry mid-use: A-34 in `session.spec.ts` ends on sign-in, no crash |
| H-05 | Loading states on slow responses                                             | PASS   | H-05 in `ui.spec.ts`                                                                              |
| H-06 | Results: INCOMPLETE shows no total; "Not entered" is not shown as 0          | PASS   | H-06 in `ui.spec.ts`                                                                              |
| H-07 | Admin empty states: no generations, no students, no jobs, no issues          | PASS   | H-07 in `ui.spec.ts`                                                                              |
| H-08 | Connect and confirm dialogs: bad URL, weights not 100, server errors shown   | PASS   | H-08, H-08b in `ui.spec.ts`                                                                       |
| H-09 | Sync Center: form, polling, job page, issues table, filters, pagination      | PASS   | H-09 in `ui.spec.ts`                                                                              |
| H-10 | Edit term: Replace, Remove, Discard, messages on conflict                    | PASS   | H-10 in `ui.spec.ts`                                                                              |
| H-11 | Temporary password dialog: shown once, gone after close and on Back          | PASS   | H-11 in `ui.spec.ts`                                                                              |
| H-12 | After sign-out, Back shows no data                                           | PASS   | H-12 in `ui.spec.ts`                                                                              |
| H-13 | Phone width: no sideways scroll on all 17 pages; menu works; tables readable | PASS   | H-13, H-13b in `ui.spec.ts`                                                                       |
| H-14 | Keyboard: dialogs trap focus, labels present, status not color-only          | PASS   | H-14 in `ui.spec.ts`                                                                              |
| H-15 | Console: no errors or CSP violations through the main flows                  | PASS   | H-15 in `ui.spec.ts`                                                                              |
