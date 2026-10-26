# REST API Specification (v1)

Base path: `/api/v1`. JSON only. Interactive docs: Swagger UI at `/api/docs` (enabled in
non-production; in production only when `SWAGGER_ENABLED=true`, behind admin network rules).
This file is the contract. The generated OpenAPI document must stay consistent with it.

## 1. Conventions

**Authentication**: cookies set by `/auth/login`:

- `ssrs_at`: access JWT, HttpOnly, Secure, SameSite=Lax, Path=/api, 15 min.
- `ssrs_rt`: refresh token, HttpOnly, Secure, SameSite=Strict, Path=/api/v1/auth, 7 days.
- `ssrs_csrf`: CSRF token, readable by JS, SameSite=Lax, Path=/.

All non-GET requests (except `/auth/login`) must send header `X-CSRF-Token` equal to the
`ssrs_csrf` cookie, and an `Origin` matching `WEB_ORIGIN`.

**Error envelope** (all 4xx/5xx):

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
409 conflict, 422 business rule violation (e.g. `WEIGHTS_NOT_100`), 429 rate limited, 503 dependency down.

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

**Decimals** are serialized as strings (`"41.500"`) to avoid float loss; display values pre-rounded
are provided alongside where relevant (`"41.50"`).

**Mass assignment**: every body is a whitelisted DTO; unknown fields → 400. Fields like `role`,
`status`, `passwordHash`, `generationId` of students are never accepted from generic update bodies.

## 2. Auth

| Method | Path                  | Role   | Description                                                                                                                                                                                                                                                                                                                                              |
| ------ | --------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| POST   | /auth/login           | public | `{ identifier, password }` → 200 `{ user }` + cookies. Generic 401 `INVALID_CREDENTIALS` for unknown accounts and wrong passwords. 429 `RATE_LIMITED` / `ACCOUNT_LOCKED` (with `Retry-After`). After a correct password: 403 `ACCOUNT_DISABLED` / `ACCOUNT_PENDING` / `TEMPORARY_PASSWORD_EXPIRED`                                                       |
| POST   | /auth/refresh         | cookie | Rotates the refresh token and issues a new access token → 204. Needs `X-CSRF-Token` for the refresh token's session. Errors: 401 `INVALID_REFRESH_TOKEN` / `SESSION_EXPIRED` / `SESSION_REVOKED` / `REFRESH_TOKEN_REUSED` (whole session revoked), 403 `CSRF_INVALID`                                                                                    |
| POST   | /auth/logout          | cookie | Revokes the session identified by the access cookie, or the refresh cookie if the access token has expired, and clears cookies → 204. Needs `X-CSRF-Token` for that session                                                                                                                                                                              |
| POST   | /auth/change-password | any    | `{ currentPassword, newPassword }` → 204. Policy: 10–128 characters, doesn't contain the username/student ID, not a common password, not one repeated character, differs from the current password. Revokes the user's other sessions and re-issues the access cookie. Errors: 400 `INVALID_CURRENT_PASSWORD`, 422 `WEAK_PASSWORD` (with `details`), 429 |
| GET    | /auth/me              | any    | `{ id, role, username, displayName, mustChangePassword, student?: { id, studentCode, fullName } }`                                                                                                                                                                                                                                                       |

## 3. Student (role STUDENT; identity from session) ✅ (Phase 6)

Students see only offerings that are `VISIBLE` and where their enrollment is `ENROLLED`. Hidden,
withdrawn, unknown and other students' offerings all return the same 404 `NOT_FOUND`. No route
accepts a student identifier; unknown query parameters are rejected with 400. Students who must
change their password get 403 `PASSWORD_CHANGE_REQUIRED`.

| Method | Path                            | Description                                                                |
| ------ | ------------------------------- | -------------------------------------------------------------------------- |
| GET    | /student/me                     | Profile: studentCode, fullName, gender, className, generation {code, name} |
| GET    | /student/me/results             | All 5 terms. `?term=1..5` filters to one term                              |
| GET    | /student/me/courses             | Visible offerings the student is enrolled in (lightweight list)            |
| GET    | /student/me/courses/:offeringId | One course result; 404 if not enrolled/visible                             |
| GET    | /student/me/summary             | Per-term summary + counts (for dashboard and chart)                        |

`GET /student/me/results` response:

```json
{
  "student": {
    "studentCode": "GEN26-0001",
    "fullName": "…",
    "generation": { "code": "GEN2026", "name": "Generation 2026" }
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
| GET    | /admin/generations/:id          | details: terms, `counts { students, offerings, sources }`                                                                                                                                    |
| PATCH  | /admin/generations/:id          | `{ name?, startDate?, endDate? }`. 409 `GENERATION_ARCHIVED`                                                                                                                                 |
| POST   | /admin/generations/:id/archive  | → 200; makes terms, offerings, criteria and schemes read-only                                                                                                                                |
| POST   | /admin/generations/:id/activate | → 200                                                                                                                                                                                        |
| GET    | /admin/generations/:id/terms    | the five terms                                                                                                                                                                               |
| PATCH  | /admin/terms/:id                | `{ name?, startDate?, endDate? }` (null clears a date). 409 `GENERATION_ARCHIVED`                                                                                                            |

### Sheet sources ✅ (Phase 4)

| Method | Path                            | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------ | ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | /admin/sources/service-account  | `{ configured, email }`: the address to share spreadsheets with (Viewer)                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| GET    | /admin/generations/:id/sources  | sources of a generation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| POST   | /admin/generations/:id/sources  | `{ url, label }`. Checks: URL format (422 `INVALID_URL` / `UNSUPPORTED_HOST` / `NOT_A_SPREADSHEET_URL`); not already connected (409 `SOURCE_EXISTS`); generation editable (409 `GENERATION_ARCHIVED`); readable (422 `SHEET_NOT_SHARED` / `SHEET_NOT_FOUND`); template tabs and `_meta` (422 `TEMPLATE_TAB_MISSING` / `UNSUPPORTED_TEMPLATE_VERSION` / `GENERATION_MISMATCH`). Google outages, quota or missing credentials → 503 (`GOOGLE_UNAVAILABLE`, `RATE_LIMITED`, `GOOGLE_NOT_CONFIGURED`). No academic data is read |
| GET    | /admin/sources/:id              | `{ spreadsheetId, spreadsheetUrl, label, spreadsheetTitle, status, lastSyncedAt, lastSyncJobId, ownedOfferings, generation, createdBy }`                                                                                                                                                                                                                                                                                                                                                                                    |
| PATCH  | /admin/sources/:id              | `{ label?, status? }` (`ACTIVE` / `DISABLED`; disabled sources are skipped by sync)                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| POST   | /admin/sources/:id/preview      | dry run → 200 `{ spreadsheetTitle, fatal, stats, issues[≤500], issuesTruncated, courses[] }`. Validates the whole file exactly as a sync would and writes nothing. Issue shape and codes: docs/google-sheets-template.md §9                                                                                                                                                                                                                                                                                                 |
| GET    | /admin/sources/:id/sync-history | ✅ paginated sync jobs of this source (newest first)                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |

### Courses, criteria, grading ✅ (Phase 3)

| Method | Path                                          | Description                                                                                                                                                                                                                                                                                |
| ------ | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| GET    | /admin/courses                                | catalog, paginated; `q`                                                                                                                                                                                                                                                                    |
| POST   | /admin/courses                                | `{ code, name, description? }`. 409 `COURSE_CODE_EXISTS`                                                                                                                                                                                                                                   |
| PATCH  | /admin/courses/:id                            | `{ name?, description? }` (code immutable)                                                                                                                                                                                                                                                 |
| GET    | /admin/offerings?generationId=&termNumber=&q= | paginated; each offering includes term, course, `credits`, `visibility`, `criteriaCount`, `publishedSchemeVersion`, `hasDraftScheme`                                                                                                                                                       |
| POST   | /admin/offerings                              | `{ termId, courseId, externalKey, title, credits? }` (manual offering). 409 `OFFERING_EXISTS`                                                                                                                                                                                              |
| GET    | /admin/offerings/:id                          | one offering                                                                                                                                                                                                                                                                               |
| PATCH  | /admin/offerings/:id                          | `{ title?, credits?, visibility? }`. Setting visibility sets `visibilityOverridden`, so the sheet no longer controls it                                                                                                                                                                    |
| GET    | /admin/offerings/:id/criteria                 | all criteria incl. inactive, ordered. Each has `published { maxMark, weight }` or null, and `scoreCount`                                                                                                                                                                                   |
| POST   | /admin/offerings/:id/criteria                 | `{ key, name, category?, description?, sheetColumnKey? }`, appended at the end. 409 `CRITERION_KEY_EXISTS`                                                                                                                                                                                 |
| PATCH  | /admin/criteria/:id                           | `{ name?, category?, description?, isActive?, sheetColumnKey? }`. `key` is immutable (sending it → 400). Deactivating: 409 `CRITERION_IN_PUBLISHED_SCHEME`; otherwise the criterion is removed from the draft                                                                              |
| PUT    | /admin/offerings/:id/criteria/order           | `{ criterionIds }` must list every criterion exactly once. 422 `INVALID_CRITERIA_ORDER`                                                                                                                                                                                                    |
| GET    | /admin/offerings/:id/grading-schemes          | all versions, newest first; drafts include `validation`                                                                                                                                                                                                                                    |
| POST   | /admin/offerings/:id/grading-schemes          | creates the DRAFT, or replaces its items: `{ items: [{ criterionId, maxMark, weight }], notes? }`. Values are numbers or decimal strings with ≤ 3 dp. A draft may total ≠ 100. 422 `DUPLICATE_CRITERION` / `CRITERION_NOT_IN_OFFERING` / `INACTIVE_CRITERION`                              |
| GET    | /admin/offerings/:id/grading-schemes/validate | `{ valid, totalWeight, issues[] }` for the draft. 404 `NO_DRAFT`                                                                                                                                                                                                                           |
| GET    | /admin/grading-schemes/:id                    | one version with items                                                                                                                                                                                                                                                                     |
| POST   | /admin/grading-schemes/:id/publish            | → 200; archives the previous published version atomically. 409 `SCHEME_NOT_DRAFT`. 422 with the first issue as `code` (`WEIGHTS_NOT_100`, `INVALID_WEIGHT`, `INVALID_MAX_MARK`, `TOO_MANY_DECIMALS`, `EMPTY_SCHEME`, `INACTIVE_CRITERION`, `MARKS_EXCEED_MAX`) and every issue in `issues` |
| DELETE | /admin/grading-schemes/:id                    | drafts only → 204. 409 `SCHEME_NOT_DRAFT`                                                                                                                                                                                                                                                  |

Criteria belong to offerings, not catalog courses, so the prompt's `/admin/courses/:id/criteria`
paths are implemented as `/admin/offerings/:id/...`. Every mutation in this section is audited. Changes
visible to students (titles, credits, visibility, criterion names and order, published schemes)
increment the generation's `cache_version`.

### Students

| Method | Path                               | Description                                                                                                                                                                                                                                       |
| ------ | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | /admin/students                    | filters `generationId`, `className`, `status`, `q` (name/ID)                                                                                                                                                                                      |
| GET    | /admin/students/:id                | profile + account status                                                                                                                                                                                                                          |
| GET    | /admin/students/:id/results        | ✅ same shape as student results, all offerings incl. hidden and withdrawn; each course adds `admin: { visibility, enrollmentStatus, presentInSource }`. Withdrawn courses are listed but not counted in summaries. Never cached                  |
| PATCH  | /admin/students/:id/status         | ✅ `{ status }` with status `ACTIVE` or `DISABLED`. Disabling revokes all sessions. PENDING → ACTIVE: 409 `CREDENTIALS_NOT_ISSUED` (use reset-password)                                                                                           |
| POST   | /admin/students/:id/reset-password | ✅ → 200 `{ studentCode, temporaryPassword, expiresAt }`, shown once (`no-store`). Also activates PENDING accounts. Forces a password change at next login, expires after `TEMP_PASSWORD_TTL_DAYS` (14), revokes sessions. 409 `ACCOUNT_DISABLED` |
| POST   | /admin/students/issue-credentials  | ✅ `{ studentIds?                                                                                                                                                                                                                                 | generationId?, className?, onlyPending = true }`→ 200`text/csv` attachment (`student_id, student_name, class, temporary_password, expires_at`; UTF-8 BOM, formula-injection safe), header `X-Issued-Count`, `no-store`. At most 500 students per request (422 `TOO_MANY_STUDENTS`; 422 `SELECTION_REQUIRED`without a selection).`onlyPending: false`also resets active accounts. Each student is audited as`student.credentials.issued`; passwords are never stored or logged |

### Sync ✅ (Phase 5)

| Method | Path                      | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------ | ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| POST   | /admin/sync               | `{ scope, sourceId?, generationId? }` with scope `SOURCE`, `GENERATION` or `ALL` → 202 `{ jobId }`. SOURCE: 409 `SYNC_IN_PROGRESS` (with the active `jobId`), `SOURCE_DISABLED`, `GENERATION_ARCHIVED`. GENERATION/ALL: a parent job with one child job per active source; busy sources are skipped and reported as `SOURCE_BUSY` warnings on the parent; 409 if every source is busy, 422 `NO_SOURCES`. 503 `QUEUE_UNAVAILABLE` if Redis is down (the job is recorded as FAILED, `ENQUEUE_FAILED`). Rate limit: 10/min per admin |
| GET    | /admin/sync               | paginated, newest first; filters `status`, `scope`, `generationId`, `sourceId`; `includeChildren=true` also lists per-source child jobs                                                                                                                                                                                                                                                                                                                                                                                           |
| GET    | /admin/sync/:jobId        | `{ id, scope, status, phase, progress { current, total }, counts, errorCount, warningCount, failureCode, failureMessage, source, generation, requestedBy, parentId, retryOfId, queuedAt, startedAt, finishedAt, children[] }`. Poll this endpoint while the job is QUEUED or RUNNING                                                                                                                                                                                                                                              |
| GET    | /admin/sync/:jobId/errors | paginated issues `{ severity, code, message, sheetTab, rowNumber, columnKey, studentCode, courseKey, criterionKey, rawValue }`; filters `severity`, `code`, `sheetTab`. Codes: docs/google-sheets-template.md §9 plus the apply codes below                                                                                                                                                                                                                                                                                       |
| POST   | /admin/sync/:jobId/retry  | only `FAILED` / `SUCCEEDED_WITH_ERRORS` → 202 `{ jobId }` of a new job with the same target and `retryOfId`. 409 `JOB_NOT_RETRYABLE`                                                                                                                                                                                                                                                                                                                                                                                              |

Job statuses: `QUEUED` → `RUNNING` (phases `FETCH`, `APPLY`, `WAITING_RETRY` during backoff) → `SUCCEEDED` (warnings at most) / `SUCCEEDED_WITH_ERRORS` (some rows, cells or courses rejected; everything else applied) / `FAILED` (nothing applied, or every course failed). Failure codes: `SHEET_NOT_SHARED`, `SHEET_NOT_FOUND`, `GOOGLE_NOT_CONFIGURED`, `GOOGLE_UNAVAILABLE`, `RATE_LIMITED` (after 3 attempts), `TEMPLATE_INVALID`, `SOURCE_DISABLED`, `GENERATION_ARCHIVED`, `APPLY_FAILED`, `ENQUEUE_FAILED`, `WORKER_LOST`, `WORKER_ERROR`, `ALL_SOURCES_FAILED` (parent).

`counts`: `students`, `offerings` (`created`/`updated`/`unchanged`/`rejected`/`failed`), `criteria`, `schemes` (`published`/`drafted`/`unchanged`/`skipped`), `enrollments` (`created`/`unchanged`/`missingInSource`), `scores` (`created`/`updated`/`unchanged`/`rejected`/`clearedInSource`).

Apply-time issue codes: `STUDENT_IN_OTHER_GENERATION`, `STUDENT_ID_CONFLICT`, `OFFERING_OWNED_ELSEWHERE`, `OFFERING_TERM_CHANGED`, `OFFERING_COURSE_CHANGED`, `OFFERING_EXISTS_FOR_COURSE`, `APPLY_FAILED`, `MARK_EXCEEDS_PUBLISHED_MAX` (errors); `MARK_CLEARED_IN_SOURCE`, `ENROLLMENT_MISSING_IN_SOURCE`, `CRITERION_REMOVED_IN_SOURCE`, `CRITERION_INACTIVE`, `SCHEME_DRAFT_PENDING`, `SCHEME_DRAFT_CONFLICT`, `SCHEME_HAS_INACTIVE_CRITERIA`, `SOURCE_BUSY` (warnings).

### Admin accounts & audit

| Method | Path              | Description                                                                                                              |
| ------ | ----------------- | ------------------------------------------------------------------------------------------------------------------------ |
| GET    | /admin/audit-logs | ✅ paginated; filters `action` (exact, or a prefix ending in `.`), `actorUserId`, `entityType`, `entityId`, `from`, `to` |
| GET    | /admin/dashboard  | counts: generations, students, pending accounts, recent jobs, failed jobs                                                |

## 5. Health

| Method | Path          | Description                                   |
| ------ | ------------- | --------------------------------------------- |
| GET    | /health       | liveness: `{ status: "ok" }`                  |
| GET    | /health/ready | PostgreSQL + Redis checks; 503 when any fails |
