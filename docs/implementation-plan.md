# Implementation Plan

Last verified: 2026-10-31, commit b222954 plus uncommitted working tree.

Each phase ends with: the app still runs, tests for that phase pass (actually executed), and
`docs/progress.md` is updated. Larger phases are split into verifiable steps.

This plan stops at Phase 10. Later work, and the decisions that override it, are in
[delivery-plan-2027.md](delivery-plan-2027.md). "Unverified" below means the task was finished at the
time, but the code was later removed or changed, so it cannot be checked now.

## Phase 0 — Requirements & architecture ✅

Docs in `docs/`. Decisions A1–A13 recorded in `requirements.md`.

## Phase 1 — Repository & infrastructure ✅

1. `git init`, `.gitignore`, `.editorconfig`, `.nvmrc` (22), pnpm workspace, Turborepo.
2. Verify and pin current stable versions (npm registry + official docs) for Next.js, NestJS,
   Prisma, BullMQ, Tailwind, shadcn/ui, TanStack Query, Playwright, Zod, decimal.js.
3. `packages/config` (tsconfig strict bases). Unverified as first planned: Prettier, markdownlint and
   oxlint configs live at the repository root, and ESLint config in `apps/web`.
4. `packages/shared`, `packages/database`, `packages/sheets` skeletons with build + test scripts.
5. `apps/api` (Nest, `/api/v1` prefix, env validation, pino, Helmet, health endpoints).
6. `apps/worker` (Nest app context, BullMQ connection, graceful shutdown, health log).
7. `apps/web` (Next.js App Router, Tailwind, shadcn/ui init, rewrites to API, base layout).
8. `docker-compose.yml` (postgres 17, redis 7 with password, internal network; apps optional
   profile), `.env.example`.
9. Verify: `pnpm install`, `pnpm typecheck`, `pnpm lint`, `pnpm test`, `docker compose up -d`,
   `GET /api/v1/health/ready` → 200, web home renders.

## Phase 2 — Database & authentication ✅

1. Full Prisma schema per `database-design.md` + raw-SQL migration for CHECKs, partial uniques,
   composite FK, scheme-immutability trigger, `citext`/`pg_trgm` extensions.
2. Migration test: `prisma migrate deploy` on empty DB in CI + constraint tests.
3. Admin bootstrap CLI (`pnpm admin:create`, in `apps/api`).
4. AuthModule: login, refresh rotation, reuse detection, logout, change password, me, lockout,
   CSRF guard, roles guard, must-change guard, revocation denylist.
5. Tests: unit (password policy, token service), integration with Supertest against real
   Postgres/Redis (login/refresh/reuse/logout/lockout/CSRF/forced change/route-role coverage).

## Phase 3 — Academic management (partly removed by D15)

1. `@ssrs/shared` grading engine + exhaustive unit tests (rounding, missing, ABS, invalid weights).
2. Generations (+5 terms in one tx), terms ✅. Catalog, offerings, visibility: unverified, API removed
   by D15.
3. Criteria CRUD/reorder/disable; grading scheme drafts, validation, publish, versioning: unverified,
   API removed by D15. Versioning remains in the sync engine.
4. Audit module wired into all mutations.
5. Integration tests per endpoint: unverified, `academic.integration-spec.ts` was deleted. Immutability
   of published schemes is still tested in `packages/database/test/constraints.integration-spec.ts`.

## Phase 4 — Google Sheets integration (template replaced by D14)

1. URL parser/validator + tests.
2. `SheetsClient` interface; Google implementation (`@googleapis/sheets` + `google-auth-library`,
   read-only scope, batchGet, retry/backoff) and an in-memory fake for tests.
3. Template parser: unverified, removed by D14 and replaced by `packages/sheets/src/term-workbook/`
   with its own tests.
4. Source registration endpoint with access + `_meta` check.

## Phase 5 — Synchronization engine ✅

1. Sync job API (create/list/detail/errors/retry), BullMQ producer, active-job uniqueness.
2. Worker processor: lease → fetch → parse → validate → apply (per-offering tx) → invalidate →
   finalize. Batch jobs are a parent row with independent child jobs, with honest aggregation.
3. Student provisioning (PENDING accounts) + credential issuance endpoint (CSV, shown once).
4. Orphaned-job recovery at worker start.
5. Tests: diff unit tests; integration with fake Sheets client: first import, idempotent re-run
   (all unchanged), changed marks (revisions), duplicate prevention, partial failure, rollback of a
   failed offering tx, concurrent job rejection. Scheme draft on weight change: unverified, replaced by
   publish on weight change (D17).

## Phase 6 — Student results API ✅

1. Results assembler (3 batched queries) + caching with generation version keys.
2. `/student/me*` endpoints; admin student results.
3. Indexes verified with `EXPLAIN` on seeded data (≈2k students × 40 offerings). Unverified now: no
   artifact is kept, only the dated result in `progress.md`.
4. Security tests: cross-student access attempts by every vector, hidden offerings, cache isolation.

## Phase 7 — Admin frontend (partly removed by D15)

Login, layout + responsive nav, dashboard, generations, sources, students (list/detail/status/reset/issue credentials), sync center
(polling progress), job details/errors, audit logs, account settings. Offerings, criteria and scheme
editor pages: unverified, removed by D15.

## Phase 8 — Student frontend ✅

Login, forced password change, dashboard (summary + Recharts term chart), results with term tabs,
dynamic criteria tables (cards on mobile), course detail, profile, change password.

## Phase 9 — Security & performance hardening ✅

Headers/CSP, CORS/CSRF verification tests, throttling limits, route-role coverage test, load test
of results endpoint (autocannon), concurrent sync test, Sentry wiring, log redaction tests.

## Phase 10 — Testing & production deployment 🟡

Files exist and CI is defined. Nothing has been deployed to a server, and no restore drill is
recorded.

Playwright E2E (12-step scenario, using the fake Sheets transport behind an
env-gated test mode that is impossible to enable in production builds), production Dockerfiles
(multi-stage, non-root), `docker-compose.prod.yml` + Caddy, GitHub Actions (lint, typecheck,
unit, integration, e2e, image build), backup container + restore drill script, `docs/deployment.md`,
`docs/operations.md` checklist, pilot plan (one generation first).
