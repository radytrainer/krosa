# Read-latency baseline (QA G-15)

`apps/api/test/qa/perf.integration-spec.ts`, run on its own against `ssrs_test` on the development
laptop (Windows, PostgreSQL and Redis in Docker). 300 students × 5 subjects, 20 requests at a time.
The test fails if p99 of cached student results reaches 1000 ms, or p99 of admin results reaches
2000 ms. Add a dated section for every new baseline so later runs can be compared.

## 2026-11-18: after the session rules (decisions.md SR1–SR5)

The 5-second positive session cache was removed (SR1): every authenticated request now reads its
session from PostgreSQL by primary key, so each request makes one more query than before. No
measurement from before the change exists to compare with.

Run with: `cd apps/api && npx vitest run --config ./vitest.config.integration.ts
test/qa/perf.integration-spec.ts --silent=false --reporter=verbose`

| Run | Student results, cached: p50 / p99 (ms) | Admin results, not cached: p50 / p99 (ms) | Student list, 100 rows: p50 / p99 (ms) | Result |
| --- | --- | --- | --- | --- |
| 1 (09:17) | 153 / 554 | 309 / 639 | 222 / 599 | pass |
| 2 (09:18) | 136 / 359 | 254 / 306 | 204 / 273 | pass |
| 3 (09:20) | 114 / 428 | 244 / 347 | 204 / 300 | pass |

The 1000 ms limit stays (user decision, 2026-11-18). Under extra load the cached p99 goes past it:

- 1377 ms during the full API integration suite, and 1320 ms in one standalone run while a
  database backup and migration ran at the same time.
- On its own, an earlier run the same day gave 550 ms.

A failure of G-15 during the full suite, or while other work runs on the machine, is not
conclusive. Rerun it on its own before treating it as a regression.
