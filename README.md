# Student Score Record System

Admins sync academic marks from Google Sheets into PostgreSQL; students view their own results across
five terms. Stack: Next.js · NestJS · Prisma/PostgreSQL · Redis/BullMQ · Google Sheets API.

> Status: Phase 6 (student results API) complete. See [docs/progress.md](docs/progress.md).

## Repository layout

| Path                | What                                                                |
| ------------------- | ------------------------------------------------------------------- |
| `apps/web`          | Next.js 16 frontend (App Router, Tailwind 4, shadcn/ui)             |
| `apps/api`          | NestJS 12 REST API, served under `/api/v1`                          |
| `apps/worker`       | NestJS background worker (sync jobs)                                |
| `packages/database` | Prisma 7 schema, migrations, client factory                         |
| `packages/sheets`   | Google Sheets reader, URL validation, template parser + test fakes  |
| `packages/sync`     | Sync engine run by the worker (roster, courses, marks, parent jobs) |
| `packages/shared`   | Framework-free domain helpers (student IDs, env validation…)        |
| `packages/config`   | Shared TypeScript configs                                           |
| `docker/`           | Container support files                                             |

## Prerequisites

- Node.js ≥ 22.12 (see `.nvmrc`) and pnpm 11 (`corepack enable` or install pnpm globally)
- Docker Desktop / Docker Engine with Compose v2+

## Local setup

```bash
pnpm install
cp .env.example .env          # then replace every change-me value with random secrets
pnpm infra:up                 # PostgreSQL + Redis on 127.0.0.1 only
pnpm build                    # generates the Prisma client and builds all packages
pnpm db:deploy                # applies database migrations
pnpm admin:create --username admin --display-name "Registrar"   # first administrator
pnpm dev                      # web :3000, api :4000, worker (watch mode)
```

Open <http://localhost:3000>. The home page shows "Service online" when the web app can reach
the API through the `/api` proxy. Swagger UI (when `SWAGGER_ENABLED=true`) is at
<http://localhost:4000/api/docs>.

If port 5432 or 6379 is already in use on your machine, change `POSTGRES_PORT` / `REDIS_PORT` in
`.env` and update the port in `DATABASE_URL` / `REDIS_URL` to match.

## Checks

```bash
pnpm typecheck
pnpm lint
pnpm test                         # unit tests (no infrastructure needed)
pnpm test:integration             # DB constraints + API integration tests (needs `pnpm infra:up`;
                                  # wipes the *_test database and Redis DB 15)
pnpm format:check
```

## Creating an administrator

There are no default accounts. `pnpm admin:create --username <name>` prompts for a password
(10–128 characters, not common, not containing the username) without echoing it. For automation,
pipe it on stdin: `printf %s "$ADMIN_PASSWORD" | pnpm admin:create --username admin`.

## Health endpoints

- `GET /api/v1/health`: liveness
- `GET /api/v1/health/ready`: PostgreSQL + Redis readiness (503 if either is down)

## Documentation

- [Requirements & decisions](docs/requirements.md)
- [Architecture](docs/architecture.md)
- [Database design](docs/database-design.md)
- [Google Sheets template](docs/google-sheets-template.md)
- [API specification](docs/api-specification.md)
- [Security](docs/security.md)
- [Implementation plan](docs/implementation-plan.md)
- [Progress](docs/progress.md)
