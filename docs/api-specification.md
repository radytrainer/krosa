# REST API Specification (v1)

Last verified: 2026-10-31, commit b222954 plus uncommitted working tree.

Base path: `/api/v1`. JSON only. Interactive docs: Swagger UI at `/api/docs`, only when
`SWAGGER_ENABLED=true` (default false; production compose forces false).
This file is the contract. The generated OpenAPI document must stay consistent with it.

## 1. Conventions

**Authentication**: cookies set by `/auth/login`:

- `ssrs_at`: access JWT, HttpOnly, SameSite=Lax, Path=/api, 15 min.
- `ssrs_rt`: refresh token, HttpOnly, SameSite=Strict, Path=/api/v1/auth, 7 days.
- `ssrs_csrf`: CSRF token, readable by JS, SameSite=Lax, Path=/.

Cookies are `Secure` when `COOKIE_SECURE` is on, which production requires.

All non-GET requests (except `/auth/login`) must send header `X-CSRF-Token` equal to the
`ssrs_csrf` cookie, and an `Origin` (or `Referer`) matching `WEB_ORIGIN` or `CORS_ORIGINS`.

**Error envelope** (all 4xx/5xx). `details` entries always have `message`. `field` is optional, and
is absent on 400 validation errors:

```json
{
  "error": {
    "code": "VALIDATION_FAILED",
    "message": "Human readable",
    "details": [{ "field": "name", "message": "must not be empty" }],
    "requestId": "…"
  }
}
```

Status codes: 400 validation, 401 unauthenticated, 403 forbidden / password change required
(`code: PASSWORD_CHANGE_REQUIRED`), 404 not found (also used for other students' resources),
409 conflict, 422 business rule violation (e.g. `WEIGHTS_NOT_100`), 429 rate limited, 502 Google
authentication failed (`GOOGLE_AUTH_FAILED`), 503 dependency down.

Authentication and authorization error codes (all endpoints):

| Status | Code                       | Meaning / client action                                                        |
| ------ | -------------------------- | ------------------------------------------------------------------------------ |
| 401    | `UNAUTHENTICATED`          | No or invalid access token. Try `/auth/refresh` once, then sign in             |
| 401    | `ACCESS_TOKEN_EXPIRED`     | Call `/auth/refresh` and retry                                                 |
| 401    | `SESSION_REVOKED`          | Signed out elsewhere, password changed, or token theft detected. Sign in again |
| 403    | `ORIGIN_NOT_ALLOWED`       | Unsafe method from a foreign (or missing) Origin                               |
| 403    | `CSRF_INVALID`             | Missing or wrong `X-CSRF-Token`                                                |
| 403    | `PASSWORD_CHANGE_REQUIRED` | Redirect to the change-password page                                           |
| 403    | `FORBIDDEN`                | Role not allowed (also returned for routes without an access policy)           |

Access policy: every route is either `@Public()`, `@Roles(...)` or `@Authenticated()`. Routes with
none of these are denied by `RolesGuard` (deny by default).

**Pagination**: `?page=1&pageSize=25` (max 100). Response:

```json
{ "data": [ … ], "meta": { "page": 1, "pageSize": 25, "total": 312 } }
```

**Decimals** are serialized as fixed-precision strings to avoid float loss: 3 decimal places for marks
and weights (`"41.500"`), 2 for scores (`"41.50"`).

**Mass assignment**: every body is a whitelisted DTO; unknown fields → 400. Fields like `role`,
`status`, `passwordHash`, `generationId` of students are never accepted from generic update bodies.

## 2. Auth

| Method | Path                  | Role   | Description                                                                                                                                                                                                                                                                                                                                              |
| ------ | --------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| POST   | /auth/login           | public | `{ identifier, password }` → 200 `{ user }` + cookies. Generic 401 `INVALID_CREDENTIALS` for unknown accounts and wrong passwords. 429 `RATE_LIMITED` / `ACCOUNT_LOCKED` (with `Retry-After`). After a correct password: 403 `ACCOUNT_DISABLED` / `ACCOUNT_PENDING` / `TEMPORARY_PASSWORD_EXPIRED`                                                       |
| POST   | /auth/refresh         | cookie | Rotates the refresh token and issues a new access token → 204. Needs `X-CSRF-Token` for the refresh token's session. Errors: 401 `INVALID_REFRESH_TOKEN` / `SESSION_EXPIRED` / `SESSION_REVOKED` / `REFRESH_TOKEN_REUSED` (whole session revoked) / `ACCOUNT_NOT_ACTIVE`, 403 `CSRF_INVALID`                                                             |
| POST   | /auth/logout          | cookie | Revokes the session identified by the access cookie, or the refresh cookie if the access token has expired, and clears cookies → 204. Needs `X-CSRF-Token` for that session                                                                                                                                                                              |
| POST   | /auth/change-password | any    | `{ currentPassword, newPassword }` → 204. Policy: 10–128 characters, doesn't contain the username/student ID, not a common password, not one repeated character, differs from the current password. Revokes the user's other sessions and re-issues the access cookie. Errors: 400 `INVALID_CURRENT_PASSWORD`, 422 `WEAK_PASSWORD` (with `details`), 429 |
| GET    | /auth/me              | any    | `{ id, role, username, displayName, mustChangePassword, student }`, where `student` is `{ id, studentCode, fullName }` or `null`                                                                                                                                                                                                                         |

## 3. Student (role STUDENT; identity from session) ✅ (Phase 6)

Students see only offerings that are `VISIBLE` and where their enrollment is `ENROLLED`. Hidden,
withdrawn, unknown (well-formed ID) and other students' offerings all return the same 404
`NOT_FOUND`. A malformed ID returns 400. No route
accepts a student identifier; unknown query parameters are rejected with 400. Students who must
change their password get 403 `PASSWORD_CHANGE_REQUIRED`.

| Method | Path                            | Description                                                                        |
| ------ | ------------------------------- | ---------------------------------------------------------------------------------- |
| GET    | /student/me                     | Profile: id, studentCode, fullName, gender, className, generation {id, code, name} |
| GET    | /student/me/results             | All 5 terms. `?term=1..5` filters to one term                                      |
| GET    | /student/me/courses             | Visible offerings the student is enrolled in (lightweight list)                    |
| GET    | /student/me/courses/:offeringId | One course result; 404 if not enrolled/visible                                     |
| GET    | /student/me/summary             | Per-term summary + counts (for dashboard and chart)                                |

`GET /student/me/results` response:

```json
{
  "student": {
    "id": "uuid",
    "studentCode": "GEN26-0001",
    "fullName": "…",
    "gender": "FEMALE",
    "className": "A",
    "generation": { "id": "uuid", "code": "GEN2026", "name": "Generation 2026" }
  },
  "terms": [
    {
      "number": 1,
      "name": "Term 1",
      "summary": {
        "status": "INCOMPLETE",
        "average": null,
        "completedCourses": 1,
        "totalCourses": 2,
        "creditsCompleted": "3.0"
      },
      "courses": [
        {
          "offeringId": "uuid",
          "termNumber": 1,
          "courseCode": "MATH101",
          "title": "Mathematics I",
          "credits": "3.0",
          "status": "COMPLETE",
          "schemeVersion": 1,
          "criteria": [
            {
              "criterionId": "uuid",
              "key": "Q1",
              "name": "Quiz 1",
              "category": "QUIZ",
              "order": 1,
              "maxMark": "10.000",
              "weight": "5.000",
              "score": { "status": "RECORDED", "mark": "8.000" },
              "invalidMark": false,
              "contribution": "4.00"
            }
          ],
          "finalScore": "86.75",
          "attemptedWeight": "100.000",
          "earnedSoFar": "86.75"
        }
      ]
    }
  ]
}
```

Course `status`: `COMPLETE` | `INCOMPLETE` (finalScore null; attemptedWeight/earnedSoFar shown) |
`NEEDS_REVIEW` (a stored mark lies outside 0…maxMark; that criterion has `invalidMark: true` and
no contribution; no final score) | `NOT_CONFIGURED` (no published scheme; `criteria` is `[]`,
`schemeVersion` is null).
`score` is `null` when no mark has been entered. `ABS` appears as `{ "status": "ABSENT", "mark": "0.000" }`.
Courses also carry `termNumber`; terms carry `startDate`/`endDate` (`YYYY-MM-DD` or null). All five
terms are always returned; a term without courses has summary status `EMPTY`. Courses within a
term are ordered by course code.

Term `summary`: `status` (`COMPLETE` | `INCOMPLETE` | `EMPTY`), `average` (credit-weighted, only
when every course is COMPLETE), `provisionalAverage` (credit-weighted over COMPLETE courses so far),
`completedCourses`, `totalCourses`, `creditsCompleted`, `creditsTotal`. Averages use exact final
scores and are rounded once.

`GET /student/me/summary` → `{ student, terms: [{ number, name, summary }], overall }`, where
`overall` has the same shape as a term summary, across all terms.
`GET /student/me/courses` → `[{ offeringId, termNumber, courseCode, title, credits, status, finalScore }]`.

## 4. Admin (role ADMIN)

### Generations & terms ✅ (Phase 3)

| Method | Path                            | Description                                                                                                                                                                                  |
| ------ | ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | /admin/generations              | paginated; filters `status`, `q` (code/name)                                                                                                                                                 |
| POST   | /admin/generations              | `{ code, name, startDate, endDate? }` (dates `YYYY-MM-DD`) → 201 with the 5 terms created in the same transaction. 409 `GENERATION_CODE_EXISTS` (case-insensitive), 422 `INVALID_DATE_RANGE` |
| GET    | /admin/generations/:id          | details: terms (each with `subjects`, `visibleSubjects`), `counts { students, offerings, sources }`                                                                                          |
| PATCH  | /admin/generations/:id          | `{ name?, startDate?, endDate? }`. 409 `GENERATION_ARCHIVED`, 422 `INVALID_DATE_RANGE`                                                                                                       |
| POST   | /admin/generations/:id/archive  | → 200; blocks term, workbook, mapping, release and sync changes. Discard, preview and confirm preview have no guard yet                                                                      |
| POST   | /admin/generations/:id/activate | → 200                                                                                                                                                                                        |
| GET    | /admin/generations/:id/terms    | the five terms                                                                                                                                                                               |
| PATCH  | /admin/terms/:id                | `{ name?, startDate?, endDate? }` (null clears a date). 409 `GENERATION_ARCHIVED`, 422 `INVALID_DATE_RANGE`                                                                                  |

### Term workbooks

| Method | Path                                           | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------ | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | /admin/sources/service-account                 | `{ configured, email }`: the address to share workbooks with (Viewer)                                                                                                                                                                                                                                                                                                                                                                       |
| GET    | /admin/generations/:id/sources                 | workbooks of a generation, each with its `term` and `rosterTab`                                                                                                                                                                                                                                                                                                                                                                             |
| POST   | /admin/terms/:id/sources                       | `{ url, label, rosterTab? = "ALL" }` → 201. Checks URL, readability, roster tab (422 `ROSTER_TAB_MISSING`) and `_meta` when present (422 `GENERATION_MISMATCH` / `TERM_MISMATCH`). One active workbook per term (409 `TERM_SOURCE_EXISTS`); one spreadsheet once (409 `SOURCE_EXISTS`, except a sheet removed from this never-synced term, which comes back). 409 `USE_CHANGE_SHEET` when the term has synced scores, `GENERATION_ARCHIVED` |
| GET    | /admin/sources/:id                             | one workbook                                                                                                                                                                                                                                                                                                                                                                                                                                |
| PATCH  | /admin/sources/:id                             | `{ label?, status? }` (`ACTIVE` / `DISABLED`). `DISABLED` removes the sheet from its term; scores stay. 409 `SYNC_IN_PROGRESS`, `PENDING_SHEET_EXISTS`, `NOT_PENDING` (a pending sheet cannot change status here), `USE_CHANGE_SHEET` (enabling on a synced term), `TERM_SOURCE_EXISTS`                                                                                                                                                     |
| GET    | /admin/sources/:id/sync-history                | paginated sync jobs of this workbook, newest first                                                                                                                                                                                                                                                                                                                                                                                          |
| POST   | /admin/sources/:id/detect                      | Reads the workbook and stores a DRAFT tab + column mapping per subject tab → 200 `{ spreadsheetTitle, fatal, meta, rosterTab, rosterStudents, issues[≤500], issuesTruncated, tabs[] }`. CONFIRMED and IGNORED tabs are not overwritten. Stale drafts are deleted and previews voided. Imports nothing. 409 `SOURCE_DISABLED`, `GENERATION_ARCHIVED`                                                                                         |
| GET    | /admin/term-workbooks                          | every term of the active generations with its `active`, `pending` (+ `previewState`) and `history` sheets, and `runningJobId`                                                                                                                                                                                                                                                                                                               |
| POST   | /admin/terms/:id/sources/check                 | `{ url, rosterTab? }` → 200 `{ spreadsheetId, spreadsheetTitle, tabs }`. Validates a replacement sheet; changes nothing. 409 `SOURCE_EXISTS` if another term uses it                                                                                                                                                                                                                                                                        |
| POST   | /admin/terms/:id/sources/change                | `{ url, label, rosterTab? }` → 201. Connects the sheet as PENDING (reusing its record if the term used it before). Scores don't change. 409 `SYNC_IN_PROGRESS`, `SAME_SHEET`, `SOURCE_EXISTS`. Audited `source.switched`                                                                                                                                                                                                                    |
| POST   | /admin/sources/:id/discard                     | gives up on a pending sheet. 409 `NOT_PENDING`, `SYNC_IN_PROGRESS`                                                                                                                                                                                                                                                                                                                                                                          |
| GET    | /admin/sources/:id/preview                     | newest usable preview, or null                                                                                                                                                                                                                                                                                                                                                                                                              |
| POST   | /admin/sources/:id/preview                     | pending sheets only (409 `NOT_PENDING`) → 201. Compares the sheet with the database and imports nothing                                                                                                                                                                                                                                                                                                                                     |
| POST   | /admin/sources/:id/preview/:previewId/confirm  | → 200. Required before a pending sheet can sync. 422 `PREVIEW_HAS_ERRORS`, 409 `PREVIEW_STALE`                                                                                                                                                                                                                                                                                                                                              |
| GET    | /admin/sources/:id/mappings                    | stored tab mappings with their columns                                                                                                                                                                                                                                                                                                                                                                                                      |
| POST   | /admin/sources/:id/mappings/:mappingId/confirm | `{ subjectName, columns: [{ columnIndex, role, name?, weight? }] }` → 200. Creates or reuses the subject, term offering and mark columns. 422 `STUDENT_ID_COLUMN_REQUIRED`, `NO_CRITERIA`, `MISSING_WEIGHT`, `WEIGHTS_NOT_100`, `INVALID_WEIGHT`, `TOO_MANY_DECIMALS`, `INVALID_COLUMN`; 409 `SUBJECT_ALREADY_MAPPED`                                                                                                                       |
| POST   | /admin/sources/:id/mappings/:mappingId/ignore  | marks the tab as not a subject                                                                                                                                                                                                                                                                                                                                                                                                              |
| POST   | /admin/sources/:id/mappings/:mappingId/reopen  | back to DRAFT for review; run detect next                                                                                                                                                                                                                                                                                                                                                                                                   |
| POST   | /admin/terms/:id/release                       | `{ visible }` → 200 `{ termId, visible, subjects }`. Shows or hides every subject of the term to students. 422 `NOTHING_TO_RELEASE`, 409 `GENERATION_ARCHIVED`                                                                                                                                                                                                                                                                              |

### Students

| Method | Path                               | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------ | ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | /admin/students                    | filters `generationId`, `className`, `status`, `q` (name/ID)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| GET    | /admin/students/:id                | profile + account status                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| GET    | /admin/students/:id/results        | ✅ same shape as student results, all offerings incl. hidden and withdrawn; each course adds `admin: { visibility, enrollmentStatus, presentInSource }`. Withdrawn courses are listed but not counted in summaries. Never cached                                                                                                                                                                                                                                                                                                                                                                                                               |
| PATCH  | /admin/students/:id/status         | ✅ `{ status }` with status `ACTIVE` or `DISABLED`. Disabling revokes all sessions. PENDING → ACTIVE: 409 `CREDENTIALS_NOT_ISSUED` (use reset-password)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| POST   | /admin/students/:id/reset-password | ✅ → 200 `{ studentCode, temporaryPassword, expiresAt }`, shown once (`no-store`). Also activates PENDING accounts. Forces a password change at next login, expires after `TEMP_PASSWORD_TTL_DAYS` (14), revokes sessions. 409 `ACCOUNT_DISABLED`                                                                                                                                                                                                                                                                                                                                                                                              |
| POST   | /admin/students/issue-credentials  | ✅ `{ studentIds? \| generationId?, className?, onlyPending = true }` → 200 `text/csv` attachment (`student_id, student_name, class, temporary_password, expires_at`; UTF-8 BOM, formula-injection safe), header `X-Issued-Count`, `no-store`. At most 500 students per request (over 500 `studentIds`: 400; a larger selection: 422 `TOO_MANY_STUDENTS`; 422 `SELECTION_REQUIRED` without a selection). `onlyPending: false` also resets active accounts. Audited as `student.credentials.issued` for PENDING accounts, `student.password.reset` for others, plus one `student.credentials.bulk_issued`; passwords are never stored or logged |

### Sync ✅ (Phase 5)

| Method | Path                      | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------ | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| POST   | /admin/sync               | `{ scope, sourceId?, generationId?, termId?, termNumber? }` with scope `SOURCE`, `TERM`, `GENERATION` or `ALL` → 202 `{ jobId }`. TERM needs `generationId` and `termId` and starts that term's workbook as a SOURCE job: 422 `TERM_NOT_IN_GENERATION`, `NO_WORKBOOK_FOR_TERM`. ALL accepts `termNumber` to limit the run to that term of every active generation. SOURCE: 409 `SYNC_IN_PROGRESS` (with the active `jobId`), `SOURCE_DISABLED`, `GENERATION_ARCHIVED`; 422 `NO_CONFIRMED_TABS`, `PREVIEW_REQUIRED`, `PREVIEW_STALE` (pending sheets). GENERATION/ALL: a parent job with one child job per active source that has a confirmed tab (pending sheets are skipped); busy sources are skipped and reported as `SOURCE_BUSY` warnings on the parent; 409 if every source is busy, 422 `NO_SOURCES`. 503 `QUEUE_UNAVAILABLE` if Redis is down (the job is recorded as FAILED, `ENQUEUE_FAILED`). Rate limit: 10/min per admin |
| GET    | /admin/sync               | paginated, newest first; filters `status`, `scope`, `generationId`, `sourceId`; `includeChildren=true` also lists per-source child jobs                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| GET    | /admin/sync/:jobId        | `{ id, scope, termNumber, status, phase, progress { current, total }, counts, errorCount, warningCount, failureCode, failureMessage, source, generation, requestedBy, parentId, retryOfId, queuedAt, startedAt, finishedAt, children[] }`. Poll this endpoint while the job is QUEUED or RUNNING                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| GET    | /admin/sync/targets       | active generations with their terms, for the sync form                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| GET    | /admin/sync/:jobId/errors | paginated issues `{ severity, code, message, sheetTab, rowNumber, columnKey, studentCode, courseKey, criterionKey, rawValue, source }` plus `tabs[]`. A parent job returns its own rows and all its children's, read at query time; `source` is null for a job-level row. Filters `severity`, `code`, `sheetTab`, `sourceId`. Codes: docs/google-sheets-template.md                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| POST   | /admin/sync/:jobId/retry  | only `FAILED` / `SUCCEEDED_WITH_ERRORS` → 202 `{ jobId }` of a new job with the same target and `retryOfId`. 409 `JOB_NOT_RETRYABLE`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |

Job statuses: `QUEUED` → `RUNNING` (phases `FETCH`, `APPLY`, `WAITING_RETRY` during backoff, `DONE` at the end) → `SUCCEEDED` (warnings at most) / `SUCCEEDED_WITH_ERRORS` (some rows, cells or courses rejected; everything else applied) / `FAILED` (no course applied) / `CANCELLED` (no API sets this). Failure codes: `SHEET_NOT_SHARED`, `SHEET_NOT_FOUND`, `GOOGLE_NOT_CONFIGURED`, `GOOGLE_UNAVAILABLE`, `RATE_LIMITED` (after 3 attempts), `TEMPLATE_INVALID`, `SOURCE_DISABLED`, `GENERATION_ARCHIVED`, `APPLY_FAILED`, `ENQUEUE_FAILED`, `WORKER_LOST`, `WORKER_ERROR`, `ALL_SOURCES_FAILED` (parent), `SHEET_CHANGE_REJECTED`, `PREVIEW_REQUIRED`, `PREVIEW_STALE`, `INVALID_JOB`, `GOOGLE_AUTH_FAILED`.

`counts`: `students`, `offerings` (`created`/`updated`/`unchanged`/`rejected`/`failed`), `criteria`, `schemes` (`published`/`unchanged`; `drafted` and `skipped` are always 0), `enrollments` (`created`/`unchanged`/`missingInSource`), `scores` (`created`/`updated`/`unchanged`/`rejected`/`clearedInSource`).

Apply-time issue codes: `STUDENT_IN_OTHER_GENERATION`, `STUDENT_ID_CONFLICT`, `OFFERING_NOT_FOUND`, `APPLY_FAILED` (errors); `MARK_CLEARED_IN_SOURCE`, `ENROLLMENT_MISSING_IN_SOURCE`, `CRITERION_REMOVED_IN_SOURCE`, `SOURCE_BUSY` (warnings).

### Audit & dashboard

| Method | Path              | Description                                                                                                                                                                                                                                    |
| ------ | ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | /admin/audit-logs | ✅ paginated; filters `action` (exact, or a prefix ending in `.`), `actorUserId`, `entityType`, `entityId`, `from`, `to`                                                                                                                       |
| GET    | /admin/dashboard  | ✅ `{ generations { active, archived }, students { total, pending, active, disabled }, sources { active, disabled }, offerings { total, visible, withoutPublishedScheme }, jobs { active, failedRecently, failedWindowDays }, recentJobs[5] }` |

## 5. Health

| Method | Path          | Description                                   |
| ------ | ------------- | --------------------------------------------- |
| GET    | /health       | liveness: `{ status: "ok" }`                  |
| GET    | /health/ready | PostgreSQL + Redis checks; 503 when any fails |
