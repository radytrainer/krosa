# Progress

Legend: ✅ done · 🟡 in progress · ⬜ pending · ⛔ blocked

_Last updated: 2026-10-26_

## Phases

| Phase                         | Status | Notes                                                                                                          |
| ----------------------------- | ------ | -------------------------------------------------------------------------------------------------------------- |
| 0 Requirements & architecture | ✅     | Docs; decisions A1 (hybrid) and A7 (no `EX`) adopted as defaults                                               |
| 1 Repository & infrastructure | ✅     | Monorepo, api/worker/web skeletons, compose, health                                                            |
| 2 Database & authentication   | ✅     | Full schema + constraints, auth, guards, audit, admin bootstrap CLI                                            |
| 3 Academic management         | ✅     | Grading engine; generations/terms, courses/offerings, criteria, versioned schemes, student accounts, audit API |
| 4 Google Sheets integration   | ✅     | `@ssrs/sheets` (URL, Google reader with retries, template parser, fakes); source registration + preview API    |
| 5 Synchronization engine      | ✅     | `@ssrs/sync` engine, BullMQ worker + orphan recovery, sync API, bulk credential CSV                            |
| 6 Student results API         | ✅     | Results assembler + version-keyed cache; `/student/me*`; admin student results; `EXPLAIN` checked              |
| 7 Admin frontend              | ⬜     | Next                                                                                                           |
| 8 Student frontend            | ⬜     |                                                                                                                |
| 9 Security & performance      | ⬜     |                                                                                                                |
| 10 Testing & deployment       | ⬜     |                                                                                                                |

## Requirement groups (see `requirements.md`)

| Group       | Status | Notes                                                                                               |
| ----------- | ------ | --------------------------------------------------------------------------------------------------- |
| AUTH-01…12  | ✅     | AUTH-11 admin reset (temporary password, shown once, expiring, forced change) done in Phase 3       |
| ACAD-01…06  | ✅     | Enrollments are written by sync (ACAD-05)                                                           |
| CRIT-01…05  | ✅     | Add / rename / reorder / disable; key immutable; deactivation policy                                |
| GRADE-01…10 | ✅     | Engine applied on read to raw marks + the PUBLISHED scheme (GRADE-08)                               |
| GS-01…07    | ✅     | Live Google access not yet exercised: needs a service-account key (see Blocked)                     |
| SYNC-01…12  | ✅     | All twelve covered by engine, worker and API integration tests                                      |
| PROV-01…04  | ✅     | PENDING accounts with a locked hash; single and bulk (CSV) issuance; 14-day expiry                  |
| STU-01…05   | 🟡     | STU-01…04 API ✅ (session identity, five terms, dynamic criteria, VISIBLE only). STU-05 UI: Phase 8 |
| ADM pages   | 🟡     | APIs for generations, courses, criteria, schemes, students and audit ✅; UI in Phase 7              |
| OBS-01…04   | 🟡     | OBS-01 auth events audited ✅; OBS-02 logs ✅; OBS-03 health ✅; OBS-04 Sentry in Phase 9           |

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

- Graceful SIGTERM shutdown of api/worker is wired but cannot be exercised on Windows; verified in
  Linux containers in Phase 10.
- Dockerfiles, `docker-compose.prod.yml`, Caddy and GitHub Actions: Phase 10.
- Results summaries count only ENROLLED courses; withdrawn ones appear in the admin view only.
- Global request throttling (`@nestjs/throttler`) and the route-metadata coverage test: Phase 9.
  Login/change-password limiting and deny-by-default `RolesGuard` are already active.
- If Redis is down when a session is revoked, its access token stays valid until expiry
  (≤ 15 min); the error is logged. Revocation checks themselves fall back to PostgreSQL.
- Web: the API client handles CSRF + one-shot refresh; login pages and route protection arrive
  with the frontends (Phases 7–8).
- A RUNNING job whose worker dies after BullMQ has given up on it is marked `WORKER_LOST` at the next
  worker start; there is no periodic sweeper while a worker keeps running (planned for Phase 9).
- Local machine: `POSTGRES_PORT=5433` (5432 is taken by another project); compose project name
  `student-score-system`.

## Environment (inspected 2026-10-26)

- Windows 11, Node 22.17.0, npm 11.7.0, pnpm 11.20.0, Docker 29.9.2, Compose v5.6.1, Git 2.42.
- PostgreSQL 17 and Redis 7.4 run in Docker.
- Git repository initialised (`main`), nothing committed yet.

## Open questions

None. A1 (hybrid structure authority) and A7 (no `EX` marks) are implemented as defaults. Changing either later is a contained change in `packages/sync/src/apply-course.ts` and the sheet parser.

## Blocked

Nothing blocks development. **A live test against Google needs a service-account key from you.** Automated tests use the in-memory reader, which follows the same contract. Error mapping and retries are unit-tested; the real HTTP path to Google has not been exercised.
