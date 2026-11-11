# Backlog

What is left, most urgent first. Built work is in [progress.md](progress.md).

## Before go-live (1 Jan 2027)

| Item                                        | Why / notes                                                                                          |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Deploy to the AWS server                    | Follow [deployment.md §8](deployment.md#8-hosting-on-aws). DNS, TLS, first admin, backups            |
| Restore drill                               | A backup is only proven by restoring it ([operations.md §2](operations.md#2-backups-and-restore))    |
| Fix Web Design and UXUI in the Term 2 sheet | 74 of 75 rows carry another student's name; both tabs are blocked until the teacher fixes them       |
| Weights for the SNAC tabs                   | `ASSESSMENT 1–6` and `Column 13` have no weights: enter them when confirming, or add them to headers |
| CI on `development`                         | Runs on pushes to `main`, `development` and on pull requests; check it is green after the first push |

## After go-live

| Item                                  | Notes                                                                                        |
| ------------------------------------- | -------------------------------------------------------------------------------------------- |
| Skip unchanged tabs (`content_hash`)  | `sheet_tab_mappings.last_content_hash` exists but nothing reads or writes it                 |
| Carry a tab's audience to a new sheet | A replacement sheet's tabs get a fresh proposal instead of the previous sheet's audience     |
| Dark mode                             | The white PN logo is ready; the app has no dark theme                                        |
| Grade scale editor                    | The official scale is seeded per generation (G1); `grade_bands` is ready for an admin editor |
| Update dated QA records               | `qa/test-plan.md`, `qa/qa-report.md`, `doc-review.md` still say 53 routes and SNA            |
| Playwright Chromium on Windows        | Its bundled browser version may not match; end-to-end runs use `E2E_CHANNEL=msedge`          |
| Format check on Windows               | `pnpm format:check` fails on CRLF working trees; not a content problem                       |
