# Krosa — Student Score Record System

Passerelles Numériques Cambodia (PNC). Teachers keep marks in one Google Sheet per term; the system
syncs them and shows each student their own results. Admins connect sheets, confirm tabs, sync,
release terms and manage students.

## Layout

| Path                | What                                                                  |
| ------------------- | --------------------------------------------------------------------- |
| `apps/api`          | NestJS REST API (`/api/v1`)                                           |
| `apps/worker`       | BullMQ worker that runs syncs                                         |
| `apps/web`          | Next.js admin and student app                                         |
| `packages/sheets`   | Reads term workbooks: layout detection, roster, subject rows          |
| `packages/sync`     | Sync engine, preview, term enrollments (`student-terms.ts`)           |
| `packages/database` | Prisma schema, migrations, defaults (`ssrs_apply_term_defaults`)      |
| `packages/shared`   | Types and rules shared by API, worker and web (grading, results)      |
| `e2e`               | Playwright end-to-end scenario                                        |
| `docs`              | Requirements, design, decisions, operations; start at the table below |

## Docs

| Doc                                                         | For                                        |
| ----------------------------------------------------------- | ------------------------------------------ |
| [requirements.md](docs/requirements.md)                     | What the system must do; glossary          |
| [decisions.md](docs/decisions.md)                           | Decisions since the delivery plan          |
| [delivery-plan-2027.md](docs/delivery-plan-2027.md)         | Decisions D1–D38, the term-workbook design |
| [google-sheets-template.md](docs/google-sheets-template.md) | The sheet format and import rules          |
| [database-design.md](docs/database-design.md)               | Tables and constraints                     |
| [api-specification.md](docs/api-specification.md)           | Every route                                |
| [deployment.md](docs/deployment.md)                         | Running on a server, including AWS         |
| [backlog.md](docs/backlog.md)                               | What is left to do                         |
| [progress.md](docs/progress.md)                             | What was built and verified, by date       |

## Commands

```bash
pnpm install
pnpm infra:up              # PostgreSQL and Redis in Docker
pnpm db:deploy             # apply migrations to DATABASE_URL
pnpm dev                   # api, worker, web (web on http://localhost:3000)
pnpm lint && pnpm typecheck && pnpm build
pnpm test                  # unit
pnpm test:integration      # needs TEST_DATABASE_URL (name must end in _test)
E2E_CHANNEL=msedge pnpm test:e2e
```

## Hard rules

- Never write to the ssrs database (migrate deploy, migrate dev, db push, psql writes, seeds,
  resets) without my explicit approval in this session. ssrs contains real student data. Tests run
  only against ssrs_test or a disposable copy.
- Every command that writes to a database goes through `scripts/db-guard.sh`: it stops on the first
  error, refuses an empty database name or URL, refuses unless the URL names exactly the intended
  database, and prints the target host and database first.
- Never wrap a database or git command inside `bash -c`, `sh -c` or another script to avoid a
  permission prompt. Permission rules match the command as written, so a wrapped command would
  slip past them.

## Rules

- **The `ALL` tab is the roster and the authority**: student ID, name, gender, class, and from
  Term 2 the program (class → program through the term's class list; `CLASS 2` cross-checks).
  Score columns in `ALL` are ignored. `_meta` identifies the workbook's generation and term. It
  is checked when connecting and syncing, and never imported.
- A later term's sync never changes an earlier term's enrollments or marks.
- Never delete marks or enrollments: flag, withdraw (with a reason) or keep history.
- Students see only their own data, and only released terms.
- Teacher comments are plain text; never render them as HTML.
- Never put real student names in fixtures, logs, test output or reports. Use IDs and counts.
- Tests use `ssrs_test` only; never point tests at the dev or production database.
- More sync rules: [.claude/rules/sync.md](.claude/rules/sync.md). UI rules:
  [.claude/rules/frontend.md](.claude/rules/frontend.md).

## Working on Windows

- Files may be LF or CRLF in the working tree; Git stores LF. Keep a file's existing endings.
- If `apps/api/dist` or `apps/worker/dist` is empty after a build, delete
  `dist/tsconfig.tsbuildinfo` and build again.
- Playwright's own Chromium may not match its version: run end-to-end with `E2E_CHANNEL=msedge`.
