# Requirements — Student Score Record System

Last verified: 2026-10-31, commit b222954 plus uncommitted working tree.

Status legend used in `docs/progress.md`: ✅ done · 🟡 in progress · ⬜ pending · ⛔ blocked.

This document restates the master prompt as numbered, testable requirements, records the
assumptions made where the prompt was ambiguous, and lists data-integrity risks with mitigations.

**[delivery-plan-2027.md](delivery-plan-2027.md) overrides this document.** Where its decisions D1–D29
differ, they win. Rows changed by a decision say so.

---

## 1. Scope

A web application with exactly two roles (Admin, Student). Staff enter marks in Google Sheets;
a background worker synchronizes them into PostgreSQL; students read their own results from a
REST API backed by PostgreSQL (never from Google Sheets at request time).

## 2. Functional requirements

### 2.1 Authentication & accounts (AUTH)

| ID      | Requirement                                                                                                                                     |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| AUTH-01 | Admin logs in with username + password; student logs in with student ID + password.                                                             |
| AUTH-02 | Passwords hashed with Argon2id. No plaintext passwords stored, logged or returned.                                                              |
| AUTH-03 | Short-lived access token (15 min) + rotating refresh token (opaque, hashed at rest).                                                            |
| AUTH-04 | Refresh-token reuse detection revokes the whole session family.                                                                                 |
| AUTH-05 | Logout revokes the session; revoked sessions cannot be reused (access token included).                                                          |
| AUTH-06 | Users can change their own password (current password required).                                                                                |
| AUTH-07 | Forced password change: a user flagged `mustChangePassword` can only call `/auth/me`, `/auth/change-password`, `/auth/logout`, `/auth/refresh`. |
| AUTH-08 | Rate limiting on login (per IP and per identifier) and temporary account lockout after repeated failures.                                       |
| AUTH-09 | HttpOnly, Secure, SameSite cookies; CSRF protection (double-submit token + Origin check) on state-changing requests.                            |
| AUTH-10 | Account status checked on every request (PENDING / ACTIVE / DISABLED). Disabling a user revokes all sessions.                                   |
| AUTH-11 | Admin can reset a student password; result is a one-time temporary password shown once to the admin, flagged must-change, with expiry.          |
| AUTH-12 | No default admin credentials. First admin created by a CLI bootstrap command.                                                                   |

### 2.2 Generations & academic structure (ACAD)

| ID      | Requirement                                                                                                                                  |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| ACAD-01 | Create, read, update and archive generations (code, name, start date, optional end date, ACTIVE/ARCHIVED). No delete.                        |
| ACAD-02 | Creating a generation creates exactly five terms (1–5) in the same transaction.                                                              |
| ACAD-03 | Course catalog and offerings (a course in one term of one generation) are tables only, filled when a tab is confirmed. No admin pages (D15). |
| ACAD-04 | Each offering has its own criteria and grading schemes.                                                                                      |
| ACAD-05 | Students belong to exactly one generation; enrollments link students to offerings.                                                           |
| ACAD-06 | Archived generations are read-only (no sync, no config edits); their students keep read access unless disabled.                              |

### 2.3 Assessment criteria (CRIT)

| ID      | Requirement                                                                                                                                                                 |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CRIT-01 | Criteria are rows, never columns. No `quiz1`/`midterm` columns anywhere.                                                                                                    |
| CRIT-02 | Each criterion: UUID, offering, stable `key` (unique per offering), display name, category, display order, active flag, description, optional sheet column key, timestamps. |
| CRIT-03 | Max mark and weight are versioned on grading-scheme items (see GRADE).                                                                                                      |
| CRIT-04 | Admin sets criteria on the tab review screen (D15, D17); renaming never changes `key` or touches scores.                                                                    |
| CRIT-05 | A criterion removed from a sheet keeps its stored scores and stays in historical schemes (`CRITERION_REMOVED_IN_SOURCE`). There is no admin disable (D15).                  |

### 2.4 Grading (GRADE)

| ID       | Requirement                                                                                                                                                                                             |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GRADE-01 | Grading schemes are versioned per offering: DRAFT → PUBLISHED → ARCHIVED. At most one DRAFT and one PUBLISHED per offering (DB-enforced).                                                               |
| GRADE-02 | Publishing requires weights to total exactly 100.000, every weight > 0, every max mark > 0, every criterion active.                                                                                     |
| GRADE-03 | `contribution = mark / maxMark × weight`; `final = Σ contributions`. Decimal arithmetic only (decimal.js), no floating point.                                                                           |
| GRADE-04 | Rounding: contributions and final score are computed exactly and rounded once, half-up, to 2 dp for display. Final score is the rounded exact sum, not the sum of rounded contributions.                |
| GRADE-05 | Marks must satisfy `0 ≤ mark ≤ maxMark`. Out-of-range marks are rejected at import.                                                                                                                     |
| GRADE-06 | Missing mark ≠ zero. A course is COMPLETE only when every criterion of the published scheme has a recorded value; otherwise INCOMPLETE and no final score is shown (partial progress is shown instead). |
| GRADE-07 | `ABS` (absent) is stored as an explicit zero with status ABSENT and is displayed as such.                                                                                                               |
| GRADE-08 | Results are always calculated on read from raw marks + the currently PUBLISHED scheme; raw marks and computed values are never conflated. Historical schemes remain queryable.                          |
| GRADE-09 | Offerings with no published scheme report status NOT_CONFIGURED and no score.                                                                                                                           |
| GRADE-10 | A stored mark outside 0…maxMark of the published scheme (only possible through inconsistent data) gives course status NEEDS_REVIEW with no final score.                                                 |

### 2.5 Google Sheets (GS)

| ID    | Requirement                                                                                                                                                                     |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GS-01 | Admin connects one Google Sheet per term. One ACTIVE and one PENDING per term.                                                                                                  |
| GS-02 | URL validated: `https://docs.google.com/spreadsheets/d/<id>…` only; spreadsheet ID extracted.                                                                                   |
| GS-03 | Connecting verifies the service account can read the file and that an optional `_meta` tab, when present, names this generation and term. Otherwise rejected.                   |
| GS-04 | Server-side service-account access, read-only scope. Credentials never reach the browser.                                                                                       |
| GS-05 | Term workbooks (see `google-sheets-template.md`): tabs are detected and an admin confirms each one. The strict template was removed (D14).                                      |
| GS-06 | Parser tolerant of whitespace and blank rows. Reordered columns change the header signature, so the tab needs review (`NEEDS_REMAP`). Malformed data gets row or column errors. |
| GS-07 | Batched reads, retry with exponential backoff on 429/5xx, a job rate limit of 50 per minute.                                                                                    |

### 2.6 Synchronization (SYNC)

| ID      | Requirement                                                                                                                                                          |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SYNC-01 | Sync one source, one generation, or all sources.                                                                                                                     |
| SYNC-02 | Jobs run in a separate worker via BullMQ; the API only enqueues.                                                                                                     |
| SYNC-03 | Progress, counts (created / updated / unchanged / skipped / rejected) and row-level errors persisted and visible.                                                    |
| SYNC-04 | Idempotent: re-running with unchanged data changes nothing. Unique constraints back up application checks.                                                           |
| SYNC-05 | No overlapping jobs per source or term (partial unique indexes + run lease + BullMQ job ID dedupe). Roster and offering steps take advisory locks.                   |
| SYNC-06 | Per-source outcome: multi-source syncs are a parent job with independent child jobs. Parent status aggregates honestly (SUCCEEDED / SUCCEEDED_WITH_ERRORS / FAILED). |
| SYNC-07 | Validate-then-apply: parse and validate everything first; structural errors abort the source with zero writes.                                                       |
| SYNC-08 | Never delete on disappearance; missing rows are reported, enrollments are marked not-seen.                                                                           |
| SYNC-09 | Score changes are written to a revision history with sync job, sheet, tab and row reference.                                                                         |
| SYNC-10 | Failed jobs can be retried safely; jobs orphaned by a worker crash are detected and marked failed/retryable.                                                         |
| SYNC-11 | Caches for affected generations are invalidated after commit.                                                                                                        |
| SYNC-12 | Students can keep reading during sync (per-offering transactions, MVCC). A sheet change is one long transaction: known deviation in the delivery plan.               |

### 2.7 Student provisioning (PROV)

| ID      | Requirement                                                                                                                                                                                                                           |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PROV-01 | A new student in a valid roster row gets a student record and a user account in status PENDING, with a random unusable password hash.                                                                                                 |
| PROV-02 | Existing accounts are never touched by sync (password, sessions and status preserved).                                                                                                                                                |
| PROV-03 | Credentials are issued by an admin action ("Issue credentials", single or bulk): fresh temporary passwords are generated, hashed, shown once, and optionally downloaded as CSV. Account becomes ACTIVE + mustChangePassword. Audited. |
| PROV-04 | Temporary passwords expire (default 14 days).                                                                                                                                                                                         |

### 2.8 Student portal (STU)

| ID     | Requirement                                                                                                |
| ------ | ---------------------------------------------------------------------------------------------------------- |
| STU-01 | Student sees only their own profile/results; identity is taken from the session, never from request input. |
| STU-02 | Five-term navigation; courses per term; criteria rendered dynamically from API data.                       |
| STU-03 | Shows raw mark, max mark, weight, contribution, final score, completion status, term summary.              |
| STU-04 | Only offerings with visibility VISIBLE are returned to students.                                           |
| STU-05 | Responsive (mobile/tablet/desktop), accessible.                                                            |

### 2.9 Admin portal (ADM)

Pages: dashboard, generations (list/create/edit/details, with term edit and term release), sheet
sources (tab review and preview), students (list/detail/academic record/status/reset/issue
credentials), sync center, sync job details, audit logs, account settings.

### 2.10 Audit & monitoring (OBS)

| ID     | Requirement                                                                                                                                                             |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OBS-01 | Audit log for logins, password resets/issuance, account creation/status changes, generation/term/source/mapping changes, scheme publication, sync start/finish/failure. |
| OBS-02 | Structured JSON logs with request ID and sync job ID; secrets redacted.                                                                                                 |
| OBS-03 | `/api/v1/health` (liveness) and readiness covering PostgreSQL and Redis.                                                                                                |
| OBS-04 | Sentry (optional via `SENTRY_DSN`) with sensitive-data scrubbing.                                                                                                       |

## 3. Non-functional requirements

- TypeScript strict everywhere; lint and type-check in CI.
- Admin lists paginated (`page`, `pageSize` ≤ 100) with filters.
- No N+1 queries on result endpoints (results for one student = bounded number of queries).
- Docker images run as non-root; graceful shutdown for API and worker.
- PostgreSQL and Redis never exposed publicly.
- Automated daily PostgreSQL backups with documented, tested restore.

## 4. Assumptions and decisions (safe defaults)

| #   | Ambiguity                                             | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| --- | ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1  | Who owns criteria/weights, the sheet or the admin UI? | **Superseded by D17:** the admin confirms weights on the tab review screen and the next sync publishes them. Original decision, kept for history: **Hybrid**: the sheet's `Criteria` tab proposes structure. On first import of an offering with valid weights, version 1 is auto-published. Later scoring changes from the sheet (weight/max mark) create a **DRAFT** scheme that an admin must publish. Admin UI edits also create drafts. Cosmetic fields (name, order, description) from the sheet are applied directly. **Adopted as default (no change requested, 2026-10-26).** |
| A2  | Course model                                          | Global catalog `courses` (by code) + `course_offerings` (term × course). Criteria and schemes attach to offerings.                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| A3  | Where do student profile fields come from?            | The term workbook's `ALL` roster tab (D9). Originally the `Students` tab. Name/gender/class columns in course tabs are optional and only checked for mismatch warnings.                                                                                                                                                                                                                                                                                                                                                                                                                |
| A4  | Number of terms                                       | Exactly 5 per generation, created automatically. Not user-extendable in v1.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| A5  | Student in two generations                            | Not allowed. Roster row for a student ID owned by another generation is rejected.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| A6  | Results visibility                                    | Per term: an admin releases or hides the term (D16). Subjects start HIDDEN. Originally per offering from a `visible` column.                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| A7  | Excused/exempt marks                                  | Not supported in v1 (would require weight renormalization rules). `EX` is rejected as invalid. **Adopted as default (2026-10-26).**                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| A8  | Term summary                                          | Credit-weighted mean of COMPLETE course final scores; shown as final only when every visible course in the term is COMPLETE. `credits` default 1.                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| A9  | Letter grades / GPA                                   | Planned by D5, not built. Originally out of scope.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| A10 | Initial password delivery                             | Admin-assisted issuance (PROV-03). No email/SMS delivery in v1.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| A11 | Two sources defining the same offering                | The offering moves to the source that confirmed its tab. Originally first source owns it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| A12 | Mark history                                          | Current value in `assessment_scores`; every change appended to `assessment_score_revisions`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| A13 | Deployment topology                                   | Single origin behind a reverse proxy: `/` → Next.js, `/api` → NestJS. Simplifies cookies and CSRF.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

## 5. Data-integrity risks and mitigations

| Risk                                                      | Mitigation                                                                                                                                                             |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Wrong spreadsheet attached to a generation                | `_meta`, when present, must name this generation and term at connect and at every sync (D26).                                                                          |
| Renamed column header remaps marks to the wrong criterion | A header signature is stored at confirmation. A changed header skips the tab with `NEEDS_REMAP` until it is reviewed.                                                  |
| Student ID formatting differences (`st001 `, `ST001`)     | Normalization: trim (incl. NBSP and zero-width characters), uppercase; inner whitespace is rejected, never collapsed; validated by regex `^[A-Z0-9][A-Z0-9_-]{0,31}$`. |
| Numbers stored as text / locale decimals (`8,5`)          | UNFORMATTED_VALUE reads; strings parsed strictly; comma decimals rejected with an explicit error.                                                                      |
| Blank treated as zero                                     | Blank = no score row (or NULL value); `ABS` = explicit absent zero.                                                                                                    |
| Weight change silently alters published results           | Weights change only through the tab review screen; the next sync publishes a new version (D17). Replacement sheets also need a confirmed preview (D28).                |
| Duplicate students/scores from concurrent jobs            | Unique constraints, roster and offering advisory locks, one active job per source and term.                                                                            |
| Partial import presented as success                       | Per-source status includes `SUCCEEDED_WITH_ERRORS`; parent aggregates honestly.                                                                                        |
| Rows removed from sheet delete history                    | No deletes on sync; `lastSeenSyncJobId` tracks presence.                                                                                                               |
| Duplicate student row within one tab                      | Whole duplicate set rejected for that tab (no "last row wins").                                                                                                        |
