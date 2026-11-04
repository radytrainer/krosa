# QA Evidence

Trimmed output of the final QA runs on 2026-10-31, revision `b62f43f`. Each file keeps test names,
results, measured values and failure messages. Local paths are replaced by `<qa-clone>`. Every file was
checked for the QA passwords, password hashes and tokens.

| File                | Run                                                                                   |
| ------------------- | ------------------------------------------------------------------------------------- |
| `baseline.txt`      | Step, exit code and seconds for the Phase 1 baseline. Exit 1 on `format` is CRLF only |
| `unit-grading.txt`  | `qa-grading.spec.ts`                                                                  |
| `unit-cells.txt`    | `qa-cells.spec.ts`                                                                    |
| `api-tests.txt`     | `apps/api/test/qa/*`                                                                  |
| `worker-tests.txt`  | `apps/worker/test/qa/faults.integration-spec.ts`, including D-16 and D-20 timelines   |
| `ui-tests.txt`      | `e2e/qa/ui.spec.ts`                                                                   |
| `session-tests.txt` | `e2e/qa/session.spec.ts`                                                              |
| `live-check.txt`    | `docs/qa/scripts/live-check.mjs` against separate API, worker and web processes       |
| `live-queries.txt`  | SQL statements for one results call, from PostgreSQL's statement log                  |
| `fix-run.txt`       | Summary of the re-test on 2026-11-01, after the fixes                                 |

`live-check.txt` prints FAIL for G-19c on purpose: that is defect QA-013. In `api-tests.txt`, `×` means
a test failed. Each failure belongs to a defect in `../qa-report.md`.

`worker-tests.txt` is from the run before the final one. After it, the worker test file was only
formatted and given a lint comment, and D-18, D-19 and D-21 were re-run with the same result.

| File                    | Run                                                |
| ----------------------- | -------------------------------------------------- |
| `manual-cases.txt`      | The 196 cases of `test-case.xlsx`, 2026-11-01      |
| `retest-2026-11-01.txt` | Independent re-test of the fixes, with live checks |
| `fixes-2026-11-01.txt`  | Re-test of QA-018 to QA-022 after their fixes      |
