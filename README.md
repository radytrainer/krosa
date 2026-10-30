# Student Score Record System

Last verified: 2026-10-31, commit b222954 plus uncommitted working tree.

A web application for schools. Administrators import students, subjects and marks from Google
Sheets; students sign in to see their own results across five terms, with every mark, weight and
contribution explained.

> **Status:** Phases 0–9, term workbooks and sheet change are built and tested. Phase 10 files
> (Docker images, CI, browser test) exist, but no production deployment has been done. Plan:
> [docs/delivery-plan-2027.md](docs/delivery-plan-2027.md). Log: [docs/progress.md](docs/progress.md).

## Contents

- [Features](#features)
- [Tech stack](#tech-stack)
- [Getting started](#getting-started)
- [Test accounts and demo data](#test-accounts-and-demo-data)
- [Testing the application by hand](#testing-the-application-by-hand)
- [Everyday commands](#everyday-commands)
- [Automated checks](#automated-checks)
- [Configuration](#configuration)
- [Troubleshooting](#troubleshooting)
- [Repository layout](#repository-layout)
- [Documentation](#documentation)

## Features

### Administrators

- Generations (cohorts) with five terms each, and one Google Sheet per term
- Connect a sheet, detect its tabs, confirm each subject and its weights (must total 100%), then sync
  with live progress and row-level problems
- Release or hide a term's scores for students
- Replace or remove a term's sheet. A replacement is reviewed and previewed, and marks change only
  when its sync succeeds
- Students: search and filter, enable/disable accounts, issue temporary passwords one by one or in bulk (CSV)
- Dashboard, sync history, and an append-only audit log

### Students

- Overview with an average per term (chart, or as a table)
- Results by term: each course collapses to a summary and expands to marks, weights and contributions
- A missing mark is never treated as zero; final scores appear once every mark is in
- Profile and password change; a temporary password must be replaced at first sign-in

## Tech stack

| Area           | Technology                                                                          |
| -------------- | ----------------------------------------------------------------------------------- |
| Web            | Next.js 16, React 19, Tailwind CSS 4, shadcn/ui (Base UI), TanStack Query, Recharts |
| API and worker | NestJS 12, BullMQ                                                                   |
| Data           | PostgreSQL 17 (Prisma 7), Redis 7                                                   |
| Spreadsheets   | Google Sheets API (read-only service account)                                       |
| Tooling        | pnpm workspaces, Turborepo, TypeScript (strict), Vitest, oxlint, ESLint, Prettier   |

## Getting started

### 1. Prerequisites

- **Node.js 22.12 or newer** (see `.nvmrc`)
- **pnpm 11**: run `corepack enable`, or install pnpm globally
- **Docker Desktop** (or Docker Engine with Compose v2) for PostgreSQL and Redis

### 2. Install and configure

```bash
pnpm install
cp .env.example .env
```

Open `.env` and replace every `change-me` value with a random secret. To generate one:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

Use the same PostgreSQL and Redis passwords in `DATABASE_URL`, `REDIS_URL` and the `TEST_*` URLs.

### 3. Start the database and build

```bash
pnpm infra:up       # PostgreSQL + Redis in Docker, listening on 127.0.0.1 only
pnpm build          # generates the Prisma client and builds every package
pnpm db:deploy      # applies the database migrations
```

### 4. Create an administrator

There are no built-in accounts. This prompts for a password (hidden while you type):

```bash
pnpm admin:create --username admin --display-name "Registrar"
```

The password must be 10–128 characters, not a common password, and must not contain the username.

### 5. Load demo data (optional, local only)

```bash
pnpm demo:seed
```

This adds a small dataset (one generation, five courses, three students with marks) so you can try
the student portal without Google Sheets. See [Test accounts and demo data](#test-accounts-and-demo-data).

### 6. Run the application

```bash
pnpm dev
```

| Service | Address                                                                                |
| ------- | -------------------------------------------------------------------------------------- |
| Web app | <http://localhost:3000>                                                                |
| API     | <http://localhost:4000/api/v1> (Swagger UI at `/api/docs` when `SWAGGER_ENABLED=true`) |
| Worker  | background process, no address                                                         |

The home page shows **Service online** when the web app can reach the API.

## Test accounts and demo data

After steps 4 and 5:

| Role          | Sign in with              | Password                    | Notes                                                                  |
| ------------- | ------------------------- | --------------------------- | ---------------------------------------------------------------------- |
| Administrator | `admin`                   | the one you chose in step 4 |                                                                        |
| Student       | `GEN26-0001` (Sokha Chan) | `Student-Pass-2026x`        | Two completed courses, one in progress, one not graded yet; term chart |
| Student       | `GEN26-0002` (Dara Pich)  | `Student-Pass-2026x`        | One completed course                                                   |
| Student       | `GEN26-0003` (Malis Keo)  | none yet                    | Awaiting credentials: issue a password from the admin portal           |

The demo data also contains a course hidden from students (**Physics I**) and a course without a
grading scheme (**Art & Design**). To use another student password:
`pnpm demo:seed -- --student-password "Your-Own-Pass-2026"`.

`demo:seed` only adds data. It refuses to run if the demo generation already exists, and it never
runs with `NODE_ENV=production`. **These are local test credentials: never load demo data on a
shared or production server.**

## Testing the application by hand

A walkthrough that covers the main flows. Each step says what you should see.

### Administrator

Sign in as `admin`.

1. **Dashboard**: 3 students, "1 awaiting credentials", 5 subjects, and how many are released.
2. **Students → Malis Keo → Issue password**: a temporary password is shown once. Copy it.
3. **Generations → the generation → Release scores** on Term 1. Sokha now sees every subject of
   that term, including Physics I.
4. **Audit log**: the password issue and `term.released` are listed.

### Student, first sign-in

Sign in as `GEN26-0003` with the temporary password from step 2.

1. You are asked to choose a new password. A weak one (for example one containing the student ID)
   is rejected with a reason; a strong one takes you to the student portal.

### Student

Sign in as `GEN26-0001`.

1. **Overview**: overall average, term chart (hatched bars are provisional), course list.
2. **My results**: switch terms; click a course to expand its marks. "Not entered" marks show no
   contribution and the course stays _In progress_. Absent counts as 0.
3. Open `/admin` in the address bar: you are sent back to the student portal.
4. **Sign out**: you return to the sign-in page.

### Also worth checking

- A phone-sized window: menu button, courses shown as cards.
- Collapsing the sidebar on a desktop: the choice is remembered.
- Five wrong passwords in a row: the account locks for a minute, longer after further failures.

## Everyday commands

| Command             | What it does                                                               |
| ------------------- | -------------------------------------------------------------------------- |
| `pnpm dev`          | Runs web, API and worker with live reload                                  |
| `pnpm infra:up`     | Starts PostgreSQL and Redis                                                |
| `pnpm infra:down`   | Stops them (data is kept in Docker volumes)                                |
| `pnpm db:deploy`    | Applies new database migrations (run after pulling changes)                |
| `pnpm db:migrate`   | Creates a migration after editing `packages/database/prisma/schema.prisma` |
| `pnpm admin:create` | Creates another administrator                                              |
| `pnpm demo:seed`    | Loads the demo dataset into an empty database                              |

To start over with an empty local database, run `docker compose down -v` (this **deletes all local
data**), then repeat step 3 onward.

## Automated checks

```bash
pnpm typecheck
pnpm lint
pnpm format:check
pnpm test               # unit tests, no database needed
pnpm test:integration   # needs `pnpm infra:up`; wipes the *_test database and Redis DB 15
pnpm build
pnpm test:e2e           # browser scenario; needs `pnpm infra:up` and the TEST_* URLs
```

`pnpm test:e2e` uses Chromium. To use an installed browser, set `E2E_CHANNEL`, for example to
`msedge`. On a Windows checkout with `core.autocrlf=true`, `pnpm format:check` reports files because
of line endings. Do not run `pnpm format` there: use `prettier --end-of-line auto` on changed files.

Load test of the results endpoints (needs prepared data and a raised `RATE_LIMIT_PER_MINUTE`; see
the header of [`scripts/load-test.mjs`](scripts/load-test.mjs)):

```bash
node scripts/load-test.mjs --base http://localhost:4100 --password <student pw> --admin-password <admin pw>
```

## Configuration

All settings live in `.env` (template: [`.env.example`](.env.example)). The ones you are most likely
to change:

| Variable                         | Purpose                                                                                               |
| -------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`, `REDIS_URL`      | Connections for the API and worker                                                                    |
| `WEB_ORIGIN`                     | Public address of the web app; used for CSRF checks and secure cookies                                |
| `JWT_ACCESS_SECRET`              | Signs sign-in tokens; at least 32 random characters                                                   |
| `GOOGLE_APPLICATION_CREDENTIALS` | Path to the Google service-account key. Without it, the portal says "Google access is not configured" |
| `TEMP_PASSWORD_TTL_DAYS`         | How long issued temporary passwords stay valid (default 14)                                           |
| `RATE_LIMIT_PER_MINUTE`          | Requests per minute per IP address (default 300)                                                      |
| `SENTRY_DSN`                     | Optional error reporting; off when unset                                                              |

How to prepare a spreadsheet: [docs/google-sheets-template.md](docs/google-sheets-template.md).

## Troubleshooting

| Symptom                                                                              | Cause and fix                                                                                                                              |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Sign-in shows **Internal Server Error**, or the home page says _Service unavailable_ | The API isn't running. Check the `pnpm dev` output for an API error; stop it (Ctrl+C) and run `pnpm dev` again                             |
| `port is already allocated` when starting Docker                                     | Another program uses 5432 or 6379. Change `POSTGRES_PORT` / `REDIS_PORT` in `.env` and the port in `DATABASE_URL` / `REDIS_URL`            |
| `EADDRINUSE` on 3000 or 4000                                                         | An old dev server is still running. Stop it (Ctrl+C in its terminal, or end the `node` process in Task Manager), then run `pnpm dev` again |
| Errors about a missing column or table                                               | Run `pnpm db:deploy` after pulling changes                                                                                                 |
| "Too many sign-in attempts"                                                          | Sign-in is limited to 10 tries a minute per address and 5 per account; wait a minute                                                       |
| "Google access is not configured" when adding a sheet                                | Set `GOOGLE_APPLICATION_CREDENTIALS` and share the sheet with the service account (Viewer)                                                 |

Health endpoints: `GET /api/v1/health` (the API is up) and `GET /api/v1/health/ready` (PostgreSQL
and Redis reachable; 503 if not).

## Repository layout

| Path                | What                                                                          |
| ------------------- | ----------------------------------------------------------------------------- |
| `apps/web`          | Next.js frontend: admin portal, student portal, sign-in                       |
| `apps/api`          | NestJS REST API under `/api/v1`, plus the `admin:create` and `demo:seed` CLIs |
| `apps/worker`       | Background worker that runs spreadsheet syncs                                 |
| `packages/database` | Prisma schema, migrations and client                                          |
| `packages/sheets`   | Google Sheets reader and term-workbook parser (with test fakes)               |
| `packages/sync`     | The synchronization engine used by the worker                                 |
| `packages/shared`   | Shared domain logic: grading engine, student IDs, environment validation      |
| `packages/config`   | Shared TypeScript configuration                                               |
| `scripts/`          | Load test, restore drill, workbook verifier, `.xlsx` converter                |
| `e2e/`              | Playwright browser scenario                                                   |
| `docker/`           | Backup job, Caddy and PostgreSQL configuration                                |
| `Dockerfile`        | Production images; `docker-compose.prod.yml` is the production stack          |
| `docs/`             | Design documents (below)                                                      |

## Documentation

- [Requirements and decisions](docs/requirements.md)
- [Delivery plan and current decisions](docs/delivery-plan-2027.md)
- [Architecture](docs/architecture.md)
- [Database design](docs/database-design.md)
- [Google Sheets template](docs/google-sheets-template.md)
- [API specification](docs/api-specification.md)
- [Security](docs/security.md)
- [Implementation plan](docs/implementation-plan.md)
- [Deployment](docs/deployment.md)
- [Operations](docs/operations.md)
- [Verifying term workbooks](docs/verifying-term-workbooks.md)
- [Progress and verification log](docs/progress.md)
- [Documentation review](docs/doc-review.md)
