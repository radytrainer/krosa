# Architecture

## 1. Overview

```
                ┌──────────────────────────── reverse proxy (Caddy, TLS) ───────────────────────────┐
 Browser ──────▶│  /            → web (Next.js, App Router)                                          │
                │  /api/v1/*    → api (NestJS)                                                       │
                └────────────────────────────────────────────────────────────────────────────────────┘
                                   │                                  ▲
                                   │ enqueue (BullMQ)                 │ reads/writes
                                   ▼                                  │
                     Redis ◀──── worker (NestJS app context) ─────▶ PostgreSQL
                  (queues, cache,         │
                   rate limits,           ▼
                   session denylist)  Google Sheets API (read-only, service account)
```

- **web**: renders UI only. All data comes from the API through the same origin. In development,
  Next.js `rewrites` proxy `/api/*` to the API so cookies behave like production.
- **api**: authentication, authorization, CRUD, results calculation, job enqueueing, Google Sheets
  access check at source registration. Never runs long sync work.
- **worker**: consumes the `sync` queue, reads spreadsheets, validates, applies changes, provisions
  student accounts, invalidates caches. Separately deployable and horizontally scalable (per-source
  locking makes concurrent workers safe).
- **PostgreSQL**: authoritative store for all academic data, users, sessions, jobs and audit logs.
- **Redis**: BullMQ queues, cache, throttler storage, revoked-session denylist. Never authoritative;
  losing Redis loses only cache and in-flight queue state (jobs are re-creatable from `sync_jobs`).

## 2. Repository layout

pnpm workspaces + Turborepo.

```
student-score-system/            (repository root = this folder)
  apps/
    web/                         Next.js App Router, Tailwind, shadcn/ui (Base UI), TanStack Query, Recharts
    api/                         NestJS REST API (/api/v1), Swagger at /api/docs (disabled in prod by default)
    worker/                      NestJS application context hosting BullMQ processors
  packages/
    database/                    Prisma schema, migrations, generated client, seed + admin bootstrap CLI
    shared/                      Framework-free domain code: grading engine (decimal.js), student-ID
                                 normalization, enums, API response types, Zod schemas shared with web
    sheets/                      Google Sheets client wrapper, URL parsing, template parser + validator
    sync/                        Sync engine: roster provisioning, per-course apply, parent jobs
                                 (framework-free; run by the worker, tested against PostgreSQL)
    config/                      tsconfig bases, ESLint/Prettier config, env schema helpers
  docs/
  scripts/                       backup/restore, dev helpers
  e2e/                           Playwright tests
  docker/                        Dockerfiles, Caddyfile
  docker-compose.yml             local development (postgres, redis, api, worker, web)
  docker-compose.prod.yml        production overrides
  .env.example
```

**Deviation from the suggested layout**: the Prisma schema lives in `packages/database` rather than a
root `prisma/` folder so that both `api` and `worker` depend on one versioned package that exports
the generated client. The template parser lives in `packages/sheets` because both the API (source
registration check) and the worker (sync) need it, and it is unit-testable without Nest.

## 3. Backend modules (api)

| Module                       | Responsibility                                                                      |
| ---------------------------- | ----------------------------------------------------------------------------------- |
| ConfigModule                 | Validated env (Zod), fails fast at startup.                                         |
| PrismaModule                 | PrismaClient lifecycle.                                                             |
| RedisModule                  | ioredis connection shared by cache, throttler, denylist.                            |
| AuthModule                   | login/refresh/logout/change-password/me, JWT strategy, CSRF guard, password policy. |
| UsersModule                  | Admin accounts, status, password reset, credential issuance.                        |
| StudentsModule               | Admin student list/detail; student self-profile.                                    |
| GenerationsModule            | Generations + automatic terms.                                                      |
| TermsModule                  | Term listing per generation.                                                        |
| CoursesModule                | Catalog + offerings, visibility.                                                    |
| EnrollmentModule             | Enrollment read/withdraw.                                                           |
| AssessmentCriteriaModule     | Criteria CRUD/reorder/disable.                                                      |
| GradingSchemesModule         | Drafts, validation, publish, history.                                               |
| ResultsModule (ScoresModule) | Result assembly + calculation for students and admins, caching.                     |
| GoogleSheetsModule           | Source registration, access verification.                                           |
| SyncModule                   | Job creation, listing, details, retry (enqueue only).                               |
| AuditModule                  | Append-only audit writer + query API.                                               |
| HealthModule                 | Liveness/readiness (Terminus).                                                      |

Cross-cutting: global `ValidationPipe` (whitelist, forbidNonWhitelisted, transform), global
exception filter producing the standard error envelope, `RolesGuard`, `MustChangePasswordGuard`,
`CsrfGuard`, throttler, `nestjs-pino` with request IDs, Helmet, Sentry.

## 4. Worker

- `SyncProcessor` (queue `sync`): processes `sync.source` jobs (one spreadsheet) and `sync.batch`
  jobs (fan-out to child source jobs, then aggregate via BullMQ flows).
- Concurrency per worker: configurable (default 2). Global Google quota protected by a BullMQ
  rate limiter (default 50 jobs/min) and the Sheets client's backoff.
- Graceful shutdown: `worker.close()` waits for the active job; on SIGTERM no new jobs are taken.
- Crash recovery: BullMQ stalled-job detection re-queues stalled jobs; at startup the worker marks
  `sync_jobs` rows stuck in RUNNING with no live BullMQ job as FAILED (`WORKER_LOST`, retryable).

## 5. Synchronization pipeline (per source) — implemented in `packages/sync`

```
 API  POST /admin/sync → sync_jobs row (QUEUED) → BullMQ job "sync.source" (jobId = row id)
 worker (runSourceSync):
   0. terminal already?  → return (re-delivered job); clear old sync_errors; RUNNING, phase FETCH
   1. guards             source ACTIVE, generation ACTIVE            else FAILED, nothing written
   2. FETCH + PARSE      readWorkbook: 1 metadata + 2 batched value requests, full validation
                         transient Google error → phase WAITING_RETRY, BullMQ retries (3 attempts,
                         exponential backoff from 30 s); other access errors → FAILED
                         FILE-level template error → FAILED (TEMPLATE_INVALID), report stored
   3. APPLY roster       one tx under a global advisory lock: provision new students (PENDING,
                         locked password), update profiles, never touch existing accounts
                         failure → FAILED, nothing else applied
   4. APPLY courses      one tx per offering under a per-offering advisory lock: offering,
                         criteria, scheme (hybrid rule A1), enrollments, scores + revisions
                         failure → that course is rolled back (APPLY_FAILED); others continue
   5. INVALIDATE         generations.cache_version += 1; source last_synced_at / last_sync_job_id
   6. FINALIZE           sync_errors (≤ 20,000 rows), counts, status, audit (sync.completed/failed),
                         refresh the parent job (if any)
```

**Concurrency.** Only one job per source can be active, which the partial unique index
`sync_jobs_one_active_per_source` and the BullMQ job id (= database id) both guarantee. Different sources
of one generation may run at the same time, so the roster step takes a global advisory lock and each
course takes an advisory lock on (generation, course key). Both are transaction-scoped
(`pg_advisory_xact_lock`), so no lock outlives a crashed connection. The originally planned per-source
session lock was dropped: session locks are unreliable behind a connection pool, and the unique index
already provides the guarantee.

**Atomicity.** A source is not one giant transaction, because a large import would hold locks too long. The
roster and each offering commit independently. Every write is keyed by unique constraints and compared
before writing, so re-running a partially applied source converges to the correct state, and unchanged
data produces no score writes or revisions (covered by the idempotency test). A failed offering
transaction is recorded as a course-level error, and the job ends `SUCCEEDED_WITH_ERRORS` or `FAILED`,
never `SUCCEEDED`.

**Multi-source jobs.** GENERATION/ALL requests create a parent row and one SOURCE child per active
source. Each child commits independently. When a child finishes, the parent is recomputed under a row
lock: all succeeded → SUCCEEDED, all failed → FAILED, otherwise SUCCEEDED_WITH_ERRORS.

**One run at a time.** `runSourceSync` first claims a lease on the job row (an atomic update that only
succeeds when `lease_expires_at` is empty or past), renews it every 40 s and clears it at the end. BullMQ
can deliver the same job twice (it redelivers a job whose lock it believes lost); the second delivery
gets `busy`, writes nothing and completes. A crashed worker's lease expires after 2 minutes, matching
BullMQ's lock duration, so a redelivery can take over.

**Recovery.** BullMQ stalled-job detection re-delivers jobs whose worker died mid-run, and the engine
restarts them idempotently. `recoverOrphans` re-enqueues QUEUED jobs that Redis doesn't know about and
marks RUNNING jobs that the queue no longer tracks as FAILED (`WORKER_LOST`, retryable). It runs at
worker startup and then every `ORPHAN_SWEEP_INTERVAL_MS` (5 min), ignoring jobs younger than 2 minutes
so a job recorded by the API but not yet enqueued is never touched. On SIGTERM, `worker.close()` lets
active jobs finish.

**Progress.** `phase` and `progress_current/total` (roster + one step per course) are written to
`sync_jobs` as the job advances. The admin UI polls `GET /admin/sync/:jobId`.

## 6. Results read path

`GET /student/me/results` → resolve `studentId` from the session → cache lookup
`ssrs:v1:results:gen:{genId}:v{genVersion}:student:{studentUuid}` → on miss, batched queries (terms;
enrollments with offerings and published scheme items; scores) → `@ssrs/shared` grading engine →
cache (TTL 10 min) → response. Implemented in `apps/api/src/results/results.service.ts`. Prisma
issues ten `IN`-batched statements per miss, independent of the number of courses (student,
generation, terms, enrollments, offerings, courses, published schemes, scheme items, criteria,
scores). The cached value also holds the overall summary, because averages need exact final scores
that the views don't carry. All `/student/me*` endpoints read the same cache entry. Redis errors (or
an unreadable entry) fall back to PostgreSQL. Admin views (`/admin/students/:id/results`) are never
cached. The generation version counter is incremented after any sync commit, scheme publish,
visibility change, offering/criterion/term/generation edit shown to students, or score correction
affecting that generation, so stale entries are never read and simply expire.

## 7. Web app (`apps/web`)

- **Routes.** `/login`, `/change-password` (forced after a temporary password), `/admin/*` (dashboard,
  generations, sources, offerings with criteria and the scheme editor, course catalog, students,
  sync center and job pages, audit log, account) and `/student/*` (overview with term chart,
  results by term, course detail, profile).
- **Access.** The API enforces every rule. On the web side, `src/proxy.ts` redirects visitors without
  the `ssrs_csrf` cookie to `/login` (session cookies are scoped to `/api`, so the proxy cannot see
  them), and `useRequireRole` in the portal layouts routes users by `/auth/me` (sign-in, forced
  password change, or their own portal). Pages render client-side after that check.
- **Data.** `src/lib/api.ts` sends same-origin requests with the CSRF header and refreshes an expired
  access token once. `useApi` keys queries by path segments, so invalidating `/admin/offerings`
  refreshes every offering query. Response types for results come from `@ssrs/shared`.
- **Forms** are plain HTML forms with native constraints for quick feedback; the API's validation
  errors (`details[].field`) are shown next to the fields. No client-side copy of the rules.
- **Rendering and CSP.** `proxy.ts` sets a Content-Security-Policy with a fresh nonce per request, so
  pages are rendered per request (root layout: `connection()` + `instant = false`) instead of being
  served from a prerendered shell, which could not carry the nonce. See docs/security.md §6.
- **Kept-alive pages.** With Cache Components, Next keeps visited pages mounted but hidden. Forms that
  hold passwords reset themselves after success, and signing out does a full page load to `/login`
  so nothing of the previous user's data stays in the tab (shared computers).
- **Lists** keep their filters in the URL (`useUrlState`), so dashboard links such as
  `/admin/students?status=PENDING` open pre-filtered.

## 8. Technology versions (verified against the npm registry, 2026-10-26)

| Area         | Choice                                                                                                                                       | Notes                                                                                                            |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Runtime      | Node.js 22 LTS (≥ 22.12), pnpm 11.20, Turborepo 2.11                                                                                         |                                                                                                                  |
| Language     | TypeScript 6.0                                                                                                                               | TS 7 (native) excluded: typescript-eslint supports < 6.1 and ts tooling peers < 7                                |
| API / worker | NestJS 12 (ESM-only), `module: nodenext`                                                                                                     | Matches the official `nest new` v12 template                                                                     |
| Tests (node) | Vitest 4 + Supertest                                                                                                                         | Nest 12's default runner. Replaces Jest from the original prompt, since Jest's ESM support is still experimental |
| Lint (node)  | oxlint 1.x                                                                                                                                   | Nest 12 template default. The web app keeps `eslint-config-next`                                                 |
| ORM          | Prisma 7.10.1 (`prisma-client` generator, `@prisma/adapter-pg`, `prisma7.config.ts`)                                                         | Prisma 8 is still an RC (even though npm's `latest` tag points to it), so it isn't used                          |
| Queue        | BullMQ 6 + ioredis 6                                                                                                                         |                                                                                                                  |
| Web          | Next.js 16.4 (Turbopack, Cache Components, Partial Prefetching), React 19.3, Tailwind 4, shadcn/ui 4 (base-nova / Base UI), TanStack Query 5 | Next 16 renames `middleware` to `proxy`                                                                          |
| Datastores   | PostgreSQL 17, Redis 7.4                                                                                                                     | Docker images `postgres:17-alpine`, `redis:7.4-alpine`                                                           |

Prisma's generated client lives in `packages/database/src/generated/` (git-ignored), built with
`moduleFormat = "esm"` and `importFileExtension = "js"` so that it compiles under `nodenext`.

## 9. Environments

| Env        | Notes                                                                                                                                                                                                 |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| local      | `docker compose up` for postgres/redis; apps via `pnpm dev` or all-in-compose.                                                                                                                        |
| test/CI    | GitHub Actions service containers for postgres/redis; fake Google client injected for integration/E2E (the real client is used in production code paths; only the transport is substituted in tests). |
| production | Single Linux VPS with Docker Compose + Caddy (automatic HTTPS). Postgres/Redis on an internal network only.                                                                                           |
