# Removed Subjects: What the System Does Today

Checked 2026-11-02, commit 66888b7 plus the uncommitted working tree. Phase 1 only: no product code
was changed.

## Result

**Nothing is ever removed today.** In every scenario the subject stays in the system and students
keep seeing it. There is no removed-subjects list, no comparison of old and new sheets, and no
confirm dialog before a sync.

| Scenario                              | Wanted                                  | Today                                                                                                        |
| ------------------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| 1. Tab deleted from the same sheet    | Listed, confirmed, subject gone         | No preview possible (409). Job ends `SUCCEEDED_WITH_ERRORS` on every sync. Student still sees BCU            |
| 2. Sheet replaced with fewer subjects | Kept, added, removed; only new subjects | One line: "Subjects not fed by this sheet (keep their scores)". Job `SUCCEEDED`. Student still sees all five |
| 2. Completely different subjects      | Matches the new sheet 100%              | Old five stay. New subject is imported but **hidden**, so the student sees only the old subjects             |

## How It Was Run

- Throwaway copy of the working tree without `.env` or secrets, on new Postgres and Redis containers
  that held only test data. `.env`, the dev containers and the `ssrs-qa` stack were not used.
- Real API, sync engine, web app and worker. The workbook is the synthetic fixture
  `termWorkbookFixture()` (5 subjects, 3 students). Nothing contacted Google.
- Tab ids were kept stable, as in Google. The in-memory reader numbers tabs by position, so a deleted
  tab would shift the others and give a false result.
- Baseline on the same copy: 105 API sync tests and 31 engine tests passed.
- Raw output is in the appendix.

## Scenario 1: Tab Removed from the Same Sheet

| Step                       | What happened                                                                                              |
| -------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Preview                    | `POST /preview` on an active sheet returns 409 `NOT_PENDING`. The active sheet page has no Preview section |
| Detect tabs                | BCU drops out of the result, but its stored mapping stays `CONFIRMED`                                      |
| Sync now                   | Starts on click, with no dialog                                                                            |
| Job                        | `SUCCEEDED_WITH_ERRORS`, 1 error `WORKSHEET_NOT_FOUND BCU`, on this and every later sync                   |
| Data                       | 5 offerings, 74 scores, 12 enrollments, identical hash before and after                                    |
| Student                    | Still sees BCU, in the API and on `/student/results`                                                       |
| Audit                      | Nothing about the subject                                                                                  |
| Workaround: Ignore the tab | Job becomes clean `SUCCEEDED`, and the student **still** sees BCU                                          |

A rename inside Google keeps the tab id, and sync follows it correctly: no error, same subject.

## Scenario 2: Sheet Replaced

**Fewer subjects (BCU and MsOffice dropped).** The preview says "Subjects not fed by this sheet (keep
their scores): BCU, MsOffice", with no counts. Confirm preview and Sync now open no dialog. The job
is `SUCCEEDED`. BCU and MsOffice stay ACTIVE and VISIBLE, still owned by the now-disabled Sheet A.

**Completely different subjects.**

| Question                          | Today                                                                                                                |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Are new tabs auto-created?        | Not by Detect or Confirm on a pending sheet. The promoting sync creates the subject, for confirmed tabs only         |
| New tab left unconfirmed?         | **Skipped with a warning.** `UNMAPPED_TAB` is not a blocker: preview can be confirmed and the job is `SUCCEEDED`     |
| No tab confirmed at all?          | Blocked: `NO_CONFIRMED_TABS`                                                                                         |
| Can students see the new subject? | **No.** It is created HIDDEN and stays hidden even though the term is already released, until someone releases again |

On an active sheet the rule differs: confirming a tab creates the subject immediately
(`sheet-mappings.service.ts:376`).

## Other Checks

| Check                                 | Today                                                                                                                                    |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Rename-like, replacement sheet        | Not flagged. BCU stays and Business is added as a new hidden subject, so both exist                                                      |
| Rename-like, active sheet             | Not flagged. Mapping the new tab to BCU fails with 409 `SUBJECT_ALREADY_MAPPED`, because the deleted tab still holds the mapping         |
| Tab deleted after preview confirmed   | Pending sheet: `PREVIEW_STALE`, source stays PENDING, students unchanged. This protection does not exist for active sheets               |
| Tab added after preview confirmed     | From the code, not run: the fingerprint covers only tabs that are read (`read.ts:314`), so a new unconfirmed tab does not void a preview |
| Google down                           | `FAILED`, no data changed                                                                                                                |
| Empty tab list, or roster tab missing | `FAILED` `TEMPLATE_INVALID`, no data changed                                                                                             |
| Only the roster tab left              | **`SUCCEEDED_WITH_ERRORS`, not failed.** Every subject tab reads as missing. No harm today, but removal must never act on this           |
| Re-sync of an unchanged sheet         | Data identical                                                                                                                           |
| Student calling sync or preview       | 403 `FORBIDDEN`                                                                                                                          |
| One active sync per term              | Unique index `sync_jobs_one_active_per_term` in the schema; existing suites passed                                                       |
| Cancelled sync                        | No Cancel button (D27). Covered only by an existing test that sets `CANCELLED` directly                                                  |

## Component Column Removed (Quiz 2 from Logic)

No behavior was changed.

1. The header check catches it: `NEEDS_REMAP` on Logic. Logic is skipped, other tabs sync, and the job
   is `SUCCEEDED_WITH_ERRORS`. Students keep the old Logic total (78.90).
2. The admin must reopen the tab, detect, and confirm it again. Weights now total 90, so confirming as
   detected fails with `WEIGHTS_NOT_100`. The admin must make them total 100.
3. The next sync publishes a new weight version. Logic went from 78.90 to 79.00 with Quiz 1 at 20%.
4. Quiz 2 marks stay in the database (3 rows) and stop counting. The criterion stays `is_active=true`,
   so every later sync repeats a `CRITERION_REMOVED_IN_SOURCE` warning.

## What the Code Means for the Design

- **`course_offerings.status` already has `ACTIVE` and `ARCHIVED`, but nothing reads it.** Setting it
  hides nothing. These reads need a filter: `results.service.ts:185` (student and admin),
  `preview.ts:226`, `preview.ts:234`, `dashboard.controller.ts:58-60`,
  `generations.service.ts:125-127`, `sheets-sources.service.ts:32`.
- **Archive is the right call.** Hard delete is not realistic: revisions and audit logs are append-only
  by trigger, and mappings restrict deleting an offering.
- **Reactivation is natural.** One offering per term and course (`@@unique([termId, courseId])`) means
  a returning tab finds the same offering, enrollments and marks.
- **Ignored cannot stand in for removed.** An ignored tab name is skipped forever, so a returning tab
  would be silently skipped. It also clears the mapping's offering.
- **Re-syncs are per tab, not all-or-nothing.** A failure midway leaves earlier tabs saved (D36). To
  keep scores identical after a failed removal, a sync carrying removals must use the all-or-nothing
  path that sheet changes use (`engine.ts:353`).
- **The fingerprint is too strict for active sheets.** It covers every mark, and teachers edit daily, so
  the comparison must be on the removed set.
- **Removal must follow the sync's tab matching:** by tab id first, then by title. Otherwise a Google
  rename would look like a removal.

## Differences from the Brief

| Brief says                                                                                          | Code or repo says                                                                                                                                                                                      |
| --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Read `CLAUDE.md`, `docs/decisions.md`, `docs/sheet-import-format.md`, `docs/existing-code-audit.md` | None of them exists, now or in git history. Decisions are in `docs/delivery-plan-2027.md` (D1–D37), the rule is `SYNC-08` in `docs/requirements.md`, the format is in `docs/google-sheets-template.md` |
| A tab feeds one or more offerings per program                                                       | One tab feeds exactly one offering, and a course has one offering per term. `offering_programs` is not used by sync                                                                                    |
| Confirm dialog exists to extend                                                                     | There is none. "Sync now" and "Confirm preview" act on click                                                                                                                                           |
| Preview runs before a sync                                                                          | Only for pending sheets. D28 says active re-syncs need none                                                                                                                                            |

## After the Change

Implemented on 2026-11-02 from the answers above, tested the same way: a throwaway copy without
`.env`, on containers holding only test data. D38 to D44 in `docs/delivery-plan-2027.md` record the
rules. The tests are in `apps/api/test/removed-subjects.integration-spec.ts`.

| Scenario                              | Now                                                                                                               |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Tab deleted, Sync now                 | Dialog lists the subject and counts, tick required. After sync the subject is ARCHIVED and hidden, with data kept |
| Nothing removed                       | Plain confirm dialog with no warning and no tick                                                                  |
| Replaced, fewer or different subjects | Preview shows kept, added and removed. After sync students see only the new sheet's subjects                      |
| New tab with subject data, no mapping | Blocks the preview on a replacement or a removal. A notes tab does not                                            |
| Failed, cancelled or partial read     | Nothing removed. Scores, offerings and student results identical before and after                                 |
| Removed set changes after preview     | Job `FAILED` `REMOVALS_CHANGED`, no writes                                                                        |
| One tab gone, one new                 | Flagged. Mapping the new tab to the old subject keeps the subject and its data                                    |
| Tab added back                        | Same offering reactivated, starts fresh. Old marks `CLEARED` in the history, old enrollments withdrawn            |
| Generation, All or Term sync          | Never archives. The missing tab stays a `WORKSHEET_NOT_FOUND` error                                               |

The component-column behavior is unchanged and now has a test.

Two safety checks were broken on purpose, in the copy only, to prove the tests catch them: without
the removed-set comparison 3 tests fail, and without the all-or-nothing path 11 fail.

## Appendix: Raw Output

```text

=== S1 tab removed from the same sheet ===
baseline student sees: ["BCU=null","ENG=80.00","Logic=78.90","MsOffice=93.00","PL=76.80"]
baseline offerings: ["BCU[ACTIVE,VISIBLE,src=Sheet A,enr=2]","ENG[ACTIVE,VISIBLE,src=Sheet A,enr=2]","Logic[ACTIVE,VISIBLE,src=Sheet A,enr=3]","MsOffice[ACTIVE,VISIBLE,src=Sheet A,enr=2]","PL[ACTIVE,VISIBLE,src=Sheet A,enr=3]"]
baseline db: {"offerings":5,"scores":74,"scoresHash":"7567f7369fc2","revisions":74,"enrollments":12}
POST preview on the ACTIVE sheet: {"http":409,"code":"NOT_PENDING","message":"Only a sheet waiting to replace the active one is previewed."}
detect tabs: ["Logic:CONFIRMED","ENG:CONFIRMED","PL:CONFIRMED","MsOffice:CONFIRMED"]
stored mappings after detect: ["Logic:CONFIRMED","ENG:CONFIRMED","PL:CONFIRMED","BCU:CONFIRMED","MsOffice:CONFIRMED"]
sync 1: {"http":202,"outcome":{"kind":"finished","status":"SUCCEEDED_WITH_ERRORS"},"status":"SUCCEEDED_WITH_ERRORS","failureCode":null,"errorCount":1,"warningCount":0,"offerings":{"failed":0,"created":0,"updated":0,"rejected":1,"unchanged":4},"issues":["ERROR WORKSHEET_NOT_FOUND BCU"]}
student sees after sync: ["BCU=null","ENG=80.00","Logic=78.90","MsOffice=93.00","PL=76.80"]
offerings after sync: ["BCU[ACTIVE,VISIBLE,src=Sheet A,enr=2]","ENG[ACTIVE,VISIBLE,src=Sheet A,enr=2]","Logic[ACTIVE,VISIBLE,src=Sheet A,enr=3]","MsOffice[ACTIVE,VISIBLE,src=Sheet A,enr=2]","PL[ACTIVE,VISIBLE,src=Sheet A,enr=3]"]
db after sync: {"offerings":5,"scores":74,"scoresHash":"7567f7369fc2","revisions":74,"enrollments":12}
scores unchanged: true
sync 2 (same sheet again): {"http":202,"outcome":{"kind":"finished","status":"SUCCEEDED_WITH_ERRORS"},"status":"SUCCEEDED_WITH_ERRORS","failureCode":null,"errorCount":1,"warningCount":0,"offerings":{"failed":0,"created":0,"updated":0,"rejected":1,"unchanged":4},"issues":["ERROR WORKSHEET_NOT_FOUND BCU"]}
audit actions: ["auth.login.success","auth.password.changed","generation.created","scheme.published","source.created","source.tabs.detected","student.credentials.issued","student.provisioned","sync.completed","sync.requested","term.released"]

=== S1b ignore the BCU mapping after the tab is gone ===
sync: {"http":202,"outcome":{"kind":"finished","status":"SUCCEEDED"},"status":"SUCCEEDED","failureCode":null,"errorCount":0,"warningCount":0,"offerings":{"failed":0,"created":0,"updated":0,"rejected":0,"unchanged":4},"issues":[]}
student sees: ["BCU=null","ENG=80.00","Logic=78.90","MsOffice=93.00","PL=76.80"]
offerings: ["BCU[ACTIVE,VISIBLE,src=Sheet A,enr=2]","ENG[ACTIVE,VISIBLE,src=Sheet A,enr=2]","Logic[ACTIVE,VISIBLE,src=Sheet A,enr=3]","MsOffice[ACTIVE,VISIBLE,src=Sheet A,enr=2]","PL[ACTIVE,VISIBLE,src=Sheet A,enr=3]"]

=== S1c rename-like on the active sheet ===
sync before detect: {"http":202,"outcome":{"kind":"finished","status":"SUCCEEDED_WITH_ERRORS"},"status":"SUCCEEDED_WITH_ERRORS","failureCode":null,"errorCount":1,"warningCount":1,"offerings":{"failed":0,"created":0,"updated":0,"rejected":1,"unchanged":4},"issues":["ERROR WORKSHEET_NOT_FOUND BCU","WARNING UNMAPPED_TAB Business"]}
new tab mapping: {"status":"DRAFT","carriedFrom":null}
confirm Business as subject BCU: {"http":409,"code":"SUBJECT_ALREADY_MAPPED","message":"Tab \"BCU\" is already mapped to BCU."}
offerings: ["BCU[ACTIVE,VISIBLE,src=Sheet A,enr=2]","ENG[ACTIVE,VISIBLE,src=Sheet A,enr=2]","Logic[ACTIVE,VISIBLE,src=Sheet A,enr=3]","MsOffice[ACTIVE,VISIBLE,src=Sheet A,enr=2]","PL[ACTIVE,VISIBLE,src=Sheet A,enr=3]"]

=== S1d tab renamed in place, same sheetId ===
sync: {"http":202,"outcome":{"kind":"finished","status":"SUCCEEDED"},"status":"SUCCEEDED","failureCode":null,"errorCount":0,"warningCount":1,"offerings":{"failed":0,"created":0,"updated":1,"rejected":0,"unchanged":4},"issues":["WARNING PROFILE_MISMATCH BCU renamed"]}
offerings: ["BCU[ACTIVE,VISIBLE,src=Sheet A,enr=2]","ENG[ACTIVE,VISIBLE,src=Sheet A,enr=2]","Logic[ACTIVE,VISIBLE,src=Sheet A,enr=3]","MsOffice[ACTIVE,VISIBLE,src=Sheet A,enr=2]","PL[ACTIVE,VISIBLE,src=Sheet A,enr=3]"]

=== S2a replacement drops BCU and MsOffice ===
tabs detected with carry-over: ["Logic<-Logic","ENG<-ENG","PL<-PL"]
preview: {"http":201,"canConfirm":true,"tabs":["ENG:OK","Logic:OK","PL:OK"],"unmappedTabs":[],"subjectsNotInSheet":["BCU","MsOffice"],"missingStudents":0,"summaryKeys":["tabs","issues","scores","students","canConfirm","unmappedTabs","issuesTruncated","missingStudents","spreadsheetTitle","subjectsNotInSheet"]}
sync: {"http":202,"outcome":{"kind":"finished","status":"SUCCEEDED"},"status":"SUCCEEDED","failureCode":null,"errorCount":0,"warningCount":0,"offerings":{"failed":0,"created":0,"updated":3,"rejected":0,"unchanged":0},"issues":[]}
student sees: ["BCU=null","ENG=80.00","Logic=78.90","MsOffice=93.00","PL=76.80"]
offerings: ["BCU[ACTIVE,VISIBLE,src=Sheet A,enr=2]","ENG[ACTIVE,VISIBLE,src=Sheet B,enr=2]","Logic[ACTIVE,VISIBLE,src=Sheet B,enr=3]","MsOffice[ACTIVE,VISIBLE,src=Sheet A,enr=2]","PL[ACTIVE,VISIBLE,src=Sheet B,enr=3]"]
db before/after: {"before":{"offerings":5,"scores":74,"scoresHash":"8cf7b1453d1b","revisions":74,"enrollments":12},"after":{"offerings":5,"scores":74,"scoresHash":"8cf7b1453d1b","revisions":74,"enrollments":12}}
sources: ["Sheet A:DISABLED","Sheet B:ACTIVE"]
mappings by source: ["Sheet A/BCU:CONFIRMED","Sheet A/ENG:CONFIRMED","Sheet A/Logic:CONFIRMED","Sheet A/MsOffice:CONFIRMED","Sheet A/PL:CONFIRMED","Sheet B/ENG:CONFIRMED","Sheet B/Logic:CONFIRMED","Sheet B/PL:CONFIRMED"]
audit actions: ["auth.login.success","auth.password.changed","generation.created","mapping.confirmed","scheme.published","source.created","source.preview.confirmed","source.preview.run","source.promoted","source.switched","source.tabs.detected","student.credentials.issued","student.provisioned","sync.completed","sync.requested","term.released"]

=== S2b completely different subjects, Chemistry left unconfirmed ===
detect before any confirm: ["Physics:DRAFT:offering=null","Chemistry:DRAFT:offering=null"]
offerings after detect (auto-create?): ["BCU[ACTIVE,VISIBLE,src=Sheet A,enr=2]","ENG[ACTIVE,VISIBLE,src=Sheet A,enr=2]","Logic[ACTIVE,VISIBLE,src=Sheet A,enr=3]","MsOffice[ACTIVE,VISIBLE,src=Sheet A,enr=2]","PL[ACTIVE,VISIBLE,src=Sheet A,enr=3]"]
offerings after confirming Physics, before sync: ["BCU[ACTIVE,VISIBLE,src=Sheet A,enr=2]","ENG[ACTIVE,VISIBLE,src=Sheet A,enr=2]","Logic[ACTIVE,VISIBLE,src=Sheet A,enr=3]","MsOffice[ACTIVE,VISIBLE,src=Sheet A,enr=2]","PL[ACTIVE,VISIBLE,src=Sheet A,enr=3]"]
preview: {"http":201,"canConfirm":true,"tabs":["Physics:OK"],"unmappedTabs":["Chemistry"],"subjectsNotInSheet":["Logic","ENG","PL","BCU","MsOffice"],"missingStudents":0,"summaryKeys":["tabs","issues","scores","students","canConfirm","unmappedTabs","issuesTruncated","missingStudents","spreadsheetTitle","subjectsNotInSheet"],"issues":["WARNING UNMAPPED_TAB"]}
sync: {"http":202,"outcome":{"kind":"finished","status":"SUCCEEDED"},"status":"SUCCEEDED","failureCode":null,"errorCount":0,"warningCount":1,"offerings":{"failed":0,"created":0,"updated":0,"rejected":0,"unchanged":1},"issues":["WARNING UNMAPPED_TAB Chemistry"]}
student sees: ["BCU=null","ENG=80.00","Logic=78.90","MsOffice=93.00","PL=76.80"]
offerings: ["BCU[ACTIVE,VISIBLE,src=Sheet A,enr=2]","ENG[ACTIVE,VISIBLE,src=Sheet A,enr=2]","Logic[ACTIVE,VISIBLE,src=Sheet A,enr=3]","MsOffice[ACTIVE,VISIBLE,src=Sheet A,enr=2]","PL[ACTIVE,VISIBLE,src=Sheet A,enr=3]","Physics[ACTIVE,HIDDEN,src=Sheet B,enr=2]"]

=== S2c replacement with nothing confirmed ===
preview: {"http":201,"canConfirm":false,"tabs":[],"unmappedTabs":["Physics"],"subjectsNotInSheet":["Logic","ENG","PL","BCU","MsOffice"],"missingStudents":0,"summaryKeys":["tabs","issues","scores","students","canConfirm","unmappedTabs","issuesTruncated","missingStudents","spreadsheetTitle","subjectsNotInSheet"],"issues":["ERROR NO_CONFIRMED_TABS","WARNING UNMAPPED_TAB"]}
sync request: {"http":422,"code":"NO_CONFIRMED_TABS"}

=== S2d BCU becomes Business in the replacement sheet ===
carry-over: ["Logic<-Logic","ENG<-ENG","PL<-PL","MsOffice<-MsOffice","Business<-none"]
preview: {"canConfirm":true,"tabs":["Business:OK","ENG:OK","Logic:OK","MsOffice:OK","PL:OK"],"unmappedTabs":[],"subjectsNotInSheet":["BCU"],"missingStudents":0,"summaryKeys":["tabs","issues","scores","students","canConfirm","unmappedTabs","issuesTruncated","missingStudents","spreadsheetTitle","subjectsNotInSheet"]}
sync: {"http":202,"outcome":{"kind":"finished","status":"SUCCEEDED"},"status":"SUCCEEDED","failureCode":null,"errorCount":0,"warningCount":1,"offerings":{"failed":0,"created":0,"updated":4,"rejected":0,"unchanged":1},"issues":["WARNING PROFILE_MISMATCH Business"]}
student sees: ["BCU=null","ENG=80.00","Logic=78.90","MsOffice=93.00","PL=76.80"]
offerings: ["BCU[ACTIVE,VISIBLE,src=Sheet A,enr=2]","Business[ACTIVE,HIDDEN,src=Sheet B,enr=2]","ENG[ACTIVE,VISIBLE,src=Sheet B,enr=2]","Logic[ACTIVE,VISIBLE,src=Sheet B,enr=3]","MsOffice[ACTIVE,VISIBLE,src=Sheet B,enr=2]","PL[ACTIVE,VISIBLE,src=Sheet B,enr=3]"]

=== S2e tab removed after the preview was confirmed ===
sync: {"http":202,"outcome":{"kind":"finished","status":"FAILED"},"status":"FAILED","failureCode":"PREVIEW_STALE","errorCount":1,"warningCount":0,"offerings":{"failed":0,"created":0,"updated":0,"rejected":0,"unchanged":0},"issues":["ERROR WORKSHEET_NOT_FOUND BCU"]}
source status: PENDING
student sees: ["BCU=null","ENG=80.00","Logic=78.90","MsOffice=93.00","PL=76.80"]

=== F failures on the active sheet ===
google down: {"http":202,"outcome":{"kind":"finished","status":"FAILED"},"status":"FAILED","failureCode":"GOOGLE_UNAVAILABLE","errorCount":0,"warningCount":0,"offerings":{"failed":0,"created":0,"updated":0,"rejected":0,"unchanged":0},"issues":[]}
empty tab list: {"http":202,"outcome":{"kind":"finished","status":"FAILED"},"status":"FAILED","failureCode":"TEMPLATE_INVALID","errorCount":6,"warningCount":0,"offerings":{"failed":0,"created":0,"updated":0,"rejected":5,"unchanged":0},"issues":["ERROR ROSTER_TAB_MISSING ALL","ERROR WORKSHEET_NOT_FOUND BCU","ERROR WORKSHEET_NOT_FOUND ENG","ERROR WORKSHEET_NOT_FOUND Logic","ERROR WORKSHEET_NOT_FOUND MsOffice","ERROR WORKSHEET_NOT_FOUND PL"]}
roster tab missing: {"http":202,"outcome":{"kind":"finished","status":"FAILED"},"status":"FAILED","failureCode":"TEMPLATE_INVALID","errorCount":1,"warningCount":0,"offerings":{"failed":0,"created":0,"updated":0,"rejected":0,"unchanged":0},"issues":["ERROR ROSTER_TAB_MISSING ALL"]}
only the roster left (every subject tab gone): {"http":202,"outcome":{"kind":"finished","status":"SUCCEEDED_WITH_ERRORS"},"status":"SUCCEEDED_WITH_ERRORS","failureCode":null,"errorCount":5,"warningCount":0,"offerings":{"failed":0,"created":0,"updated":0,"rejected":5,"unchanged":0},"issues":["ERROR WORKSHEET_NOT_FOUND BCU","ERROR WORKSHEET_NOT_FOUND ENG","ERROR WORKSHEET_NOT_FOUND Logic","ERROR WORKSHEET_NOT_FOUND MsOffice","ERROR WORKSHEET_NOT_FOUND PL"]}
db unchanged: true
student sees: ["BCU=null","ENG=80.00","Logic=78.90","MsOffice=93.00","PL=76.80"]

=== C Quiz 2 column removed from Logic ===
student sees before: ["BCU=null","ENG=80.00","Logic=78.90","MsOffice=93.00","PL=76.80"]
sync with the column gone: {"http":202,"outcome":{"kind":"finished","status":"SUCCEEDED_WITH_ERRORS"},"status":"SUCCEEDED_WITH_ERRORS","failureCode":null,"errorCount":1,"warningCount":1,"offerings":{"failed":0,"created":0,"updated":0,"rejected":1,"unchanged":4},"issues":["ERROR NEEDS_REMAP Logic","WARNING PROFILE_MISMATCH BCU"]}
student sees: ["BCU=null","ENG=80.00","Logic=78.90","MsOffice=93.00","PL=76.80"]
mapping status after detect: CONFIRMED
columns after reopen: ["Quiz 1=10","Homework=10","Participation=10","MIDTERM=25","FINAL=35"]
re-confirm as detected (weights now 90): {"http":422,"code":"WEIGHTS_NOT_100","message":"Weights total 90.000%, but must total exactly 100%."}
re-confirm with weights fixed to 100: {"http":200}
sync after re-confirm: {"http":202,"outcome":{"kind":"finished","status":"SUCCEEDED"},"status":"SUCCEEDED","failureCode":null,"errorCount":0,"warningCount":2,"offerings":{"failed":0,"created":0,"updated":0,"rejected":0,"unchanged":5},"issues":["WARNING PROFILE_MISMATCH BCU","WARNING CRITERION_REMOVED_IN_SOURCE Logic"]}
sync again: {"http":202,"outcome":{"kind":"finished","status":"SUCCEEDED"},"status":"SUCCEEDED","failureCode":null,"errorCount":0,"warningCount":2,"offerings":{"failed":0,"created":0,"updated":0,"rejected":0,"unchanged":5},"issues":["WARNING PROFILE_MISMATCH BCU","WARNING CRITERION_REMOVED_IN_SOURCE Logic"]}
student sees: ["BCU=null","ENG=80.00","Logic=79.00","MsOffice=93.00","PL=76.80"]
Logic criteria kept: ["QUIZ_2:active=true:scores=3","QUIZ_1:active=true:scores=3","HOMEWORK:active=true:scores=3","PARTICIPATION:active=true:scores=3","MIDTERM:active=true:scores=3","FINAL:active=true:scores=3"]

=== A access and idempotency ===
student POST sync: {"http":403,"code":"FORBIDDEN"}
student POST preview: {"http":403,"code":"FORBIDDEN"}
re-sync unchanged sheet: {"http":202,"outcome":{"kind":"finished","status":"SUCCEEDED"},"status":"SUCCEEDED","failureCode":null,"errorCount":0,"warningCount":1,"offerings":{"failed":0,"created":0,"updated":0,"rejected":0,"unchanged":5},"issues":["WARNING PROFILE_MISMATCH BCU"]}
db identical: true

=== Browser S1 ===
headings on the active sheet page: ["Test Sheet A\nActive","Subject tabs","Sync history"]
"Run preview" button present: 0
dialogs open when the sync request left: 0
job: {"status":"SUCCEEDED_WITH_ERRORS","errorCount":1}
student page still shows BCU: 2

=== Browser S2 ===
preview lines mentioning subjects: ["Subjects not fed by this sheet (keep their scores): BCU, MsOffice"]
dialogs after Confirm preview click: 0
dialogs open when the sync request left: 0
job: {"status":"SUCCEEDED","errorCount":0}
student page still shows BCU: 2
student page still shows MsOffice: 2
```
