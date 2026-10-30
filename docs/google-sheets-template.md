# Google Sheets Workbooks

Last verified: 2026-10-31, commit b222954 plus uncommitted working tree.

The system reads the school's own term workbooks. Teachers keep their sheets as they are, and an
admin confirms once per term how each tab maps to a subject.

## 1. Workbook layout

One Google Sheet per term, for example `TERM1- GEN 2027 Scoring`.

| Tab                 | Required | Purpose                                                                                                                         |
| ------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `ALL`               | Yes      | Master student list: `STUDENT ID` and `FIRST NAME` + `LAST NAME` (or `NAME`). `GENDER`, `CLASS` optional. Never read for scores |
| `_meta`             | No       | `generation_code` and `education_term`. When present they must match the term the workbook is connected to                      |
| One tab per subject | Yes      | Student rows and marks                                                                                                          |
| Other tabs          | No       | Tabs starting with `_` are always skipped. Tabs with a `STUDENT ID` header can be marked "Not a subject"; others keep a warning |

An uploaded `.xlsx` must be saved as a Google Sheet (File → Save as Google Sheets) before it can be
read.

## 2. Subject tabs

- The header row is the first row in the top 10 containing `STUDENT ID`. Rows above it are group
  headers, such as `MIDTERM (30%)`.
- A column's weight is read from its label: `Quiz 1 10%`, `Speaking (10%)`, `Quiz 3- 10%`,
  `Participation - 5%`.
- A column with no weight of its own shares what is left of its group's weight equally:
  `Projects (15%)` over two columns gives 7.5 + 7.5.
- Every mark is out of 100.
- `TOTAL` is used to check the weights at detection and is stored for reference. It is never used for
  results. `GRADE` is ignored. `COMMENTS` is stored as the teacher's comment.

| Cell  | Meaning                                                                          |
| ----- | -------------------------------------------------------------------------------- |
| 0–100 | Recorded mark (up to 3 decimals)                                                 |
| Blank | Not entered yet, never zero. If a mark existed before, it is kept with a warning |
| `ABS` | Absent, counts as 0                                                              |
| Other | `INVALID_MARK`: that cell is skipped, the rest of the row still applies          |

## 3. Admin flow

1. **Generations → GEN2027 → Terms → Connect workbook.** Share the file with the service account
   as Viewer first; the dialog shows the address.
2. **Detect tabs.** Lists each subject tab. Nothing is imported.
3. **Review and confirm each tab.** Check the subject name, what each column is used as, and the
   weights, which must total 100. Confirmed tabs are what sync imports.
4. **Sync now.** Creates student accounts and imports marks. Syncing again only applies changes,
   and every changed mark is kept in the history. **Sync all workbooks** and **Start sync** do the
   same for many terms, and skip sheets waiting for review.
   A job ends as Succeeded, Succeeded with errors or Failed. After fixing the sheet, **Retry** starts
   a new job with the same target.
5. **Release scores** on the generation page. Students see nothing from a term until then, and it
   can be hidden again.

## 4. When a sheet changes

This table is for an active sheet. On a new sheet waiting to replace it, any error refuses the whole
sync (section 5).

| Change                                 | What happens                                                                                                                                           |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Mark edited                            | Next sync updates it and records the change                                                                                                            |
| Student removed from a subject tab     | Enrollment flagged, marks kept (`ENROLLMENT_MISSING_IN_SOURCE`)                                                                                        |
| Student in a subject tab, not in `ALL` | That row is rejected (`UNKNOWN_STUDENT`)                                                                                                               |
| Name differs from `ALL`                | Warning only (`PROFILE_MISMATCH`). `ALL` wins                                                                                                          |
| Headers of a confirmed tab changed     | That tab is skipped (`NEEDS_REMAP`). Reopen it, detect again, confirm                                                                                  |
| Tab renamed                            | Sync finds it through Google's tab ID. Detect tabs then shows a duplicate draft: do not confirm it                                                     |
| New tab added                          | Warning (`UNMAPPED_TAB`) until Detect tabs lists it and it is confirmed or marked "Not a subject". A tab with no `STUDENT ID` header keeps the warning |
| Confirmed tab deleted                  | `WORKSHEET_NOT_FOUND`. Other tabs still sync                                                                                                           |
| Mapped column deleted                  | Scores kept (`CRITERION_REMOVED_IN_SOURCE`)                                                                                                            |
| Weights changed on the review screen   | The next sync publishes a new weight version; older versions stay on record                                                                            |

## 5. Changing a term's sheet

On the generation page, choose **Edit** on the term. The dialog shows the sheet's URL with
**Replace** and **Remove**. Student scores do not change until the new sheet's sync completes.

1. Paste the new link and choose **Check sheet**. The name and tabs are shown. Choose **Connect new
   sheet**, and the term shows "New sheet connected, not synced yet". The old sheet keeps feeding
   scores.
2. On the new sheet's page, choose **Detect tabs**. Tabs with the same name start from the old
   sheet. Confirm each one.
3. Choose **Run preview**. It shows new, changed, unchanged and invalid counts, tab problems, and
   students missing from the new sheet. They keep their scores.
4. Choose **Confirm preview**, then **Sync now**. The whole sync saves or none of it does, and any
   error leaves the old sheet active.

Editing the sheet or its tabs after the preview means running it again. So does a sync of the old
sheet, or Detect tabs, Reopen, Confirm tab or Not a subject on the new one. If the sheet changed,
**Sync now** starts a job that fails with `PREVIEW_STALE`. Going back to an earlier sheet is the same
flow. A pending sheet can be discarded at any time except during a sync of the term.

**Known deviation:** Confirm tab on a new sheet changes subject and column names at once, so students
can see them before the sync. Marks do not change. A fix is planned
([delivery-plan-2027.md](delivery-plan-2027.md)).

**Remove** disconnects the sheet and stops its syncs. Students keep their current scores, and the
sheet stays in the term's history. A term with synced scores then connects a new sheet through the
same reviewed steps; a term that never synced connects one straight away, including the same sheet.

## 6. Common errors

| Code                                                         | Meaning / fix                                                          |
| ------------------------------------------------------------ | ---------------------------------------------------------------------- |
| `INVALID_URL` / `UNSUPPORTED_HOST` / `NOT_A_SPREADSHEET_URL` | Copy the URL from the address bar of the open spreadsheet              |
| `SHEET_NOT_SHARED`                                           | Share the file with the service-account address (Viewer)               |
| `SHEET_NOT_FOUND`                                            | The URL is wrong or the file was deleted                               |
| `ROSTER_TAB_MISSING`                                         | The `ALL` tab is missing                                               |
| `GENERATION_MISMATCH` / `TERM_MISMATCH`                      | `_meta` names another generation or term. Connect it to the right term |
| `TERM_SOURCE_EXISTS`                                         | The term already has an active workbook. Use Replace, or Remove first  |
| `SOURCE_EXISTS`                                              | This spreadsheet is already connected                                  |
| `NO_CONFIRMED_TABS`                                          | Confirm at least one tab before syncing                                |
| `GOOGLE_NOT_CONFIGURED`                                      | The server has no service-account credentials. See `.env.example`      |
| `RATE_LIMITED` / `GOOGLE_UNAVAILABLE`                        | Temporary. Requests are already retried; try again later               |

### More codes

| Code                                                                                                     | Meaning / fix                                                                                               |
| -------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `USE_CHANGE_SHEET`                                                                                       | The term has synced scores. Use Edit → Replace on the term                                                  |
| `SAME_SHEET`                                                                                             | This is already the term's active sheet                                                                     |
| `PENDING_SHEET_EXISTS`                                                                                   | A new sheet is waiting. Discard or sync it before removing the active sheet                                 |
| `SYNC_IN_PROGRESS`                                                                                       | A sync of this term is running. Wait until it finishes                                                      |
| `NOT_PENDING`                                                                                            | This action applies only to a sheet waiting to replace the active one                                       |
| `PREVIEW_REQUIRED` / `PREVIEW_STALE`                                                                     | Run and confirm the preview again                                                                           |
| `PREVIEW_HAS_ERRORS`                                                                                     | Fix the sheet; a preview with errors cannot be confirmed                                                    |
| `SHEET_CHANGE_REJECTED`                                                                                  | The new sheet's sync had errors. Nothing was imported and the old sheet stays active                        |
| `NEEDS_REMAP`                                                                                            | Reopen the tab, detect again, confirm                                                                       |
| `WORKSHEET_NOT_FOUND`                                                                                    | A confirmed tab is gone from the sheet. Other tabs still sync                                               |
| `CRITERION_REMOVED_IN_SOURCE`                                                                            | A mapped column is gone. Stored scores are kept                                                             |
| `MARK_CLEARED_IN_SOURCE`                                                                                 | A cell with a stored mark is blank. The mark is kept                                                        |
| `MISSING_COLUMN`, `DUPLICATE_COLUMN`, `TAB_TOO_LARGE`, `MISSING_STUDENT_ID_COLUMN`, `NO_CRITERIA`        | The tab's layout cannot be used. Fix the sheet                                                              |
| `MISSING_WEIGHT`, `WEIGHTS_NOT_100`, `GROUP_WEIGHT_MISMATCH`, `WEIGHTS_DISAGREE_WITH_SHEET_TOTAL`        | Check the weights on the review screen                                                                      |
| `INVALID_STUDENT_ID`, `MISSING_STUDENT_ID`, `MISSING_STUDENT_NAME`, `DUPLICATE_STUDENT`, `DUPLICATE_ROW` | Fix that row                                                                                                |
| `UNKNOWN_GENDER`, `UNRECOGNIZED_COLUMN`                                                                  | Warnings. Check the sheet                                                                                   |
| `STUDENT_ID_CONFLICT`, `STUDENT_IN_OTHER_GENERATION`                                                     | The ID already belongs to someone else or to another generation                                             |
| `SOURCE_BUSY`                                                                                            | A workbook was already syncing and was skipped in a bulk sync                                               |
| `GOOGLE_AUTH_FAILED` / `GOOGLE_ERROR`                                                                    | Check the service-account key. An uploaded `.xlsx` not saved as a Google Sheet may also give `GOOGLE_ERROR` |

Other job failures are listed in [api-specification.md](api-specification.md).

## 7. Service account setup

1. In Google Cloud Console, create a project and enable the **Google Sheets API**.
2. Create a service account (no roles needed) and a JSON key. Store it as described in
   `security.md`.
3. Share each workbook with the service account's email as **Viewer**, with "Notify people"
   unticked. The app only requests the `spreadsheets.readonly` scope.
