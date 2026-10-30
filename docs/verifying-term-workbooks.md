# Verifying Term Workbooks

Last verified: 2026-10-31, commit b222954 plus uncommitted working tree.

How to check the full flow: connect, confirm, sync, release.

## 1. Automated tests

```bash
pnpm infra:up
```

```bash
pnpm db:deploy
```

```bash
pnpm build --filter=!@ssrs/web
```

```bash
pnpm test
```

```bash
pnpm test:integration
```

| Command                 | Expected on 2026-10-31                                      |
| ----------------------- | ----------------------------------------------------------- |
| `pnpm test`             | 217 passed: shared 51, sheets 114, sync 3, api 46, worker 3 |
| `pnpm test:integration` | 178 passed: database 25, sync 31, worker 3, api 119         |

Both need `TEST_DATABASE_URL` and `TEST_REDIS_URL` in `.env`.

The key suites:

| File                                               | What it proves                                                                     |
| -------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `packages/sheets/src/term-workbook/*.spec.ts`      | Header, weight and roster parsing on the real header shapes                        |
| `packages/sync/test/engine.integration-spec.ts`    | Idempotent re-sync, score history, rollback per tab, run lease, `NEEDS_REMAP`      |
| `apps/api/test/term-workbooks.integration-spec.ts` | Connect, confirm, sync, release, and a student seeing the score only after release |

## 2. Browser scenario

Needs `pnpm build` first (see section 5) and uses the same database as the integration tests, so
don't run both at once.

```bash
pnpm build
```

```bash
E2E_CHANNEL=msedge pnpm test:e2e
```

Expected: 12 passed. Without `E2E_CHANNEL` it uses Chromium. In PowerShell, set it first:
`$env:E2E_CHANNEL='msedge'`, then run `pnpm test:e2e`.

`apps/api/test/sheet-change.integration-spec.ts` covers changing a term's sheet: student scores stay
identical until a sync completes (subject and column names do not, see
[delivery-plan-2027.md](delivery-plan-2027.md)), previews are required and can't be reused, and failed or cancelled
syncs change nothing.

## 3. Real workbook, without the app

Read-only: prints column names, weights and counts, never names or marks. Needs `pnpm build` first.
`--xlsx` also needs Python with `openpyxl`, and `--sheet` needs Google credentials. Options:
`--generation` (default GEN2027), `--term` (default 1), `--python`.

```bash
node scripts/verify-term-workbook.mjs --xlsx "C:\Users\theng\Downloads\TERM1- GEN 2027 Scoring.xlsx"
```

```bash
node scripts/verify-term-workbook.mjs --sheet "https://docs.google.com/spreadsheets/d/<ID>/edit"
```

Expected for the real file: 101 students, Logic 101/101 rows match the sheet total, ENG 16 mark
columns totalling 100, BCU 50/50 complete rows match, MsOffice missing weights, `RESULT: OK`.

## 4. In the app

First create an admin with `pnpm admin:create`. Create a generation with code `GEN2027` in the app;
its five terms are created for you.

1. Run `pnpm dev`, sign in as admin and open **Generations → Generation 2027**.
2. On Term 1, choose **Connect workbook** and paste the sheet URL.
3. Choose **Detect tabs**. Expect 101 students found in `ALL`.
4. Open each tab, check it and choose **Confirm tab**. MsOffice needs weights typed in; 10, 30, 30,
   30 reproduce its `TOTAL` column. This is a test assumption, so confirm the real values with the
   school.
5. Choose **Sync now** and read the job report.
6. Go back to the generation and choose **Release scores** on Term 1.

## 5. Known problems

- If `pnpm build` fails with a Turbopack panic on `globals.css` ("node process exited before we
  could connect"), the build cache in `apps/web/.next` is corrupted. Delete `apps/web/.next` and
  build again. It holds only generated files.
- `pnpm format:check` reports many files on a Windows checkout because of CRLF line endings.
