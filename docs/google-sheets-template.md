# Google Sheets Workbooks

Last verified: 2026-11-01, commit 66888b7 plus uncommitted working tree.

The system reads the school's own term workbooks. Teachers keep their sheets as they are, and an
admin confirms once per term how each tab maps to a subject.

## 1. Workbook layout

One Google Sheet per term, for example `TERM1- GEN 2027 Scoring`.

| Tab                 | Required | Purpose                                                                                                                                                                            |
| ------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ALL`               | Yes      | The roster and the authority: `STUDENT ID`, `FIRST NAME` + `LAST NAME` (or `NAME`), `GENDER`, `CLASS`, and in Terms 2–5 `CLASS 2` ("WEP A", "SNAC"). Its score columns are ignored |
| `_meta`             | Yes      | Identifies the workbook's generation and term. It is checked when connecting and syncing, and never imported (layout below)                                                        |
| One tab per subject | Yes      | Student rows and marks                                                                                                                                                             |
| Other tabs          | No       | Tabs starting with `_` are always skipped. Tabs with a `STUDENT ID` header can be marked "Not a subject"; others keep a warning                                                    |

An uploaded `.xlsx` must be saved as a Google Sheet (File → Save as Google Sheets) before it can be
read.

### `_meta`

`_meta` identifies the workbook's generation and term. It is checked when connecting and syncing,
and never imported. One key per row: the key in column A, its value in column B. A header row such
as `key | value` and other keys (`template_version`) are allowed and ignored.

| Key               | Value                                                     | Matches when                                                                       |
| ----------------- | --------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `generation_code` | The generation's code, for example `GEN2027`              | Equal to the selected generation's code, ignoring case and surrounding spaces only |
| `education_term`  | The term: `1`, `Term 1` or `T1` (`term` is an older name) | The same number as the selected term                                               |

Keys and the tab name are read ignoring case and surrounding spaces. `gen2027` with spaces around
it matches `GEN2027`; `GEN 2027` does not. A missing tab, or a blank or unreadable value, is
`META_MISSING`; a value that differs is `WORKBOOK_MISMATCH`. Either blocks connecting or replacing
the sheet (nothing is saved, and the term's current sheet stays), blocks the preview, and fails the
sync before anything is written. Each blocked connection is audited (`source.connect.blocked`).

## 2. Subject tabs

- The header row is the first row in the top 10 containing `STUDENT ID`. Rows above it are group
  headers, such as `MIDTERM (30%)`.
- A column's weight is read from its label: `Quiz 1 10%`, `Speaking (10%)`, `Quiz 3- 10%`,
  `Participation - 5%`.
- A column with no weight of its own shares what is left of its group's weight equally:
  `Projects (15%)` over two columns gives 7.5 + 7.5.
- Every mark is out of 100.
- Profile columns in a subject tab never decide anything; `ALL` does (§3):
  - `CLASS`, and `MAJOR` / `PROGRAM`: a value that differs from `ALL` is a `PROFILE_MISMATCH`
    warning, and the marks still import.
  - Names are compared ignoring case, extra spaces and first/last order, so a swapped first and
    last name is the same name (no warning). A name nobody in `ALL` has is a warning; the row
    imports under its ID.
  - A name that belongs to a **different** student in `ALL` is `IDENTITY_MISMATCH`: the row is
    rejected and both IDs are shown, so no mark is stored under the wrong student. When more than
    20% of a tab's rows do this (IDs and names shifted), the whole tab is blocked with one
    `IDENTITY_MISMATCH_TAB` error.
  - A row-number column (`#`, `#N`, `No`, or a generic header such as `Column 1` over 1, 2, 3…)
    is recognised and never read as a mark.
- `TOTAL` is used to check the weights at detection and is stored for reference. It is never used for
  results. `GRADE` is ignored.
- `COMMENTS` (also `COMMENT`, `REMARK(S)`, `FEEDBACK`, any case) is the teacher's comment for that
  student in that subject. It is text, never a mark: it does not change totals, grades or whether
  a subject is Incomplete. The student sees it on the subject once the term is released, also when
  the subject is Incomplete. It follows the sheet:
  - A new or changed comment replaces the stored one and is counted in the preview.
  - A blank cell, or one with only spaces, clears the stored comment.
  - Khmer and emoji are kept exactly. The limit is 4000 characters (not bytes). A longer comment
    is not imported: the stored one is kept, the row's marks still import, and `COMMENT_TOO_LONG`
    names the tab, row and length.

| Cell  | Meaning                                                                                                                                                                  |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 0–100 | Recorded mark (up to 3 decimals)                                                                                                                                         |
| Blank | Not entered, never zero. An erased mark also counts as not entered: the subject goes back to Incomplete, the admin gets a warning, and the old mark stays in the history |
| `ABS` | Absent, counts as 0                                                                                                                                                      |
| Other | `INVALID_MARK`: that cell is skipped, the rest of the row still applies                                                                                                  |

## 3. Classes, programs and who takes a subject

Glossary: **General** is the Term 1 program. **WEP** = Web Programming. **SNAC** = System Network
Administrators and Cybersecurity (`SNA` in a sheet means SNAC).

- Every term has its programs and a class list per program, editable by admins. Defaults: Term 1
  General with classes A, B, C, D; Terms 2–5 WEP (A, B, C) and SNAC (D). A class name is unique
  within a term.
- Each student has one enrollment per term: program and class. **`ALL`'s `CLASS` decides it**,
  through the term's class list. An admin assignment overrides the program. `CLASS 2` is a
  cross-check: when it names another program or class, the student is reported as
  `PROGRAM_CONFLICT` and nothing is guessed.
- A later term never changes an earlier one: Term 1's class and marks stay as they were.
- Within a term, a new class in the same program is applied and audited. A new program is not:
  it waits for an admin (`PROGRAM_SWITCH_PENDING`), and meanwhile only shared subjects import for
  that student.
- An unknown class (`UNKNOWN_CLASS`), no class (`PROGRAM_UNDETERMINED`), a conflict or a student
  listed twice in `ALL` blocks only that student: no enrollment is created or changed, their
  rows are skipped (`NO_TERM_ENROLLMENT`), and the admin issue list shows the ID and the values.
- **Audience:** a Terms 2–5 tab is Shared (every program, like ENG and PL) or for one program
  (Algorithm: WEP; CCNA1: SNAC). Term 1 tabs are General. A tab without one gets it guessed by
  the first sync from who it lists: only WEP students → WEP only, only SNAC → SNAC only, both →
  Shared. The guess is saved and reported (`AUDIENCE_GUESSED`), so a student added to the wrong
  tab later is still caught; an admin can change it. `AUDIENCE_REQUIRED` only when no listed
  student has a known class.
  - A student of another program in a program's tab is rejected (`PROGRAM_NOT_IN_AUDIENCE`).
  - A student missing from a tab their program takes is warned (`STUDENT_MISSING_FROM_TAB`);
    stored marks stay. Missing from another program's tab is normal: no warning.
- The preview shows new enrollments, class changes, students who need an admin, and the list of
  program changes.
- **Where to manage it:** Generations → the generation → **Classes and students** on a term: the
  class lists, and the student issues (approve or reverse a program switch). A student's page
  shows program and class per term, and an admin can set them there.

## 4. Admin flow

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

## 5. When a sheet changes

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

## 6. Changing a term's sheet

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

Confirming a tab on a new sheet saves only that sheet's review. Subject and column names change when
the sync succeeds, and a subject that only the new sheet has is created then. Discard leaves nothing
behind. A blank cell in the new sheet clears a stored mark, and the preview counts these.

**Remove** disconnects the sheet and stops its syncs. Students keep their current scores, and the
sheet stays in the term's history. A term with synced scores then connects a new sheet through the
same reviewed steps; a term that never synced connects one straight away, including the same sheet.

## 7. Common errors

| Code                                                         | Meaning / fix                                                                                     |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| `INVALID_URL` / `UNSUPPORTED_HOST` / `NOT_A_SPREADSHEET_URL` | Copy the URL from the address bar of the open spreadsheet                                         |
| `SHEET_NOT_SHARED`                                           | Share the file with the service-account address (Viewer)                                          |
| `SHEET_NOT_FOUND`                                            | The URL is wrong or the file was deleted                                                          |
| `ROSTER_TAB_MISSING`                                         | The `ALL` tab is missing                                                                          |
| `META_MISSING`                                               | No `_meta` tab, or its `generation_code` / `education_term` is blank or unreadable. Add them (§1) |
| `WORKBOOK_MISMATCH`                                          | `_meta` names another generation or term. Choose the matching term or check the workbook          |
| `TERM_MISMATCH`                                              | Older name of `WORKBOOK_MISMATCH` (term only), kept on jobs from before 2026-11-13                |
| `TERM_SOURCE_EXISTS`                                         | The term already has an active workbook. Use Replace, or Remove first                             |
| `SOURCE_EXISTS`                                              | This spreadsheet is already connected                                                             |
| `NO_CONFIRMED_TABS`                                          | Confirm at least one tab before syncing                                                           |
| `GOOGLE_NOT_CONFIGURED`                                      | The server has no service-account credentials. See `.env.example`                                 |
| `RATE_LIMITED` / `GOOGLE_UNAVAILABLE`                        | Temporary. Requests are already retried; try again later                                          |

### More codes

| Code                                                                                                        | Meaning / fix                                                                                               |
| ----------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `USE_CHANGE_SHEET`                                                                                          | The term has synced scores. Use Edit → Replace on the term                                                  |
| `SAME_SHEET`                                                                                                | This is already the term's active sheet                                                                     |
| `PENDING_SHEET_EXISTS`                                                                                      | A new sheet is waiting. Discard or sync it before removing the active sheet                                 |
| `SYNC_IN_PROGRESS`                                                                                          | A sync of this term is running. Wait until it finishes                                                      |
| `NOT_PENDING`                                                                                               | This action applies only to a sheet waiting to replace the active one                                       |
| `PREVIEW_REQUIRED` / `PREVIEW_STALE`                                                                        | Run and confirm the preview again                                                                           |
| `PREVIEW_HAS_ERRORS`                                                                                        | Fix the sheet; a preview with errors cannot be confirmed                                                    |
| `REMOVALS_CHANGED`                                                                                          | The subjects to remove changed after the preview. Nothing changed. Choose Sync now again                    |
| `REMOVAL_REJECTED`                                                                                          | A sync that removes subjects needs zero errors. Fix them. Nothing was imported or removed                   |
| `SHEET_CHANGE_REJECTED`                                                                                     | The new sheet's sync had errors. Nothing was imported and the old sheet stays active                        |
| `NEEDS_REMAP`                                                                                               | Reopen the tab, detect again, confirm                                                                       |
| `WORKSHEET_NOT_FOUND`                                                                                       | A confirmed tab is gone from the sheet. Other tabs still sync                                               |
| `CRITERION_REMOVED_IN_SOURCE`                                                                               | A mapped column is gone. Stored scores are kept                                                             |
| `MARK_CLEARED_IN_SOURCE`                                                                                    | A cell with a stored mark is blank. The mark no longer counts; it stays in the history                      |
| `MISSING_COLUMN`, `DUPLICATE_COLUMN`, `TAB_TOO_LARGE`, `MISSING_STUDENT_ID_COLUMN`, `NO_CRITERIA`           | The tab's layout cannot be used. Fix the sheet                                                              |
| `MISSING_WEIGHT`, `WEIGHTS_NOT_100`, `GROUP_WEIGHT_MISMATCH`, `WEIGHTS_DISAGREE_WITH_SHEET_TOTAL`           | Check the weights on the review screen                                                                      |
| `INVALID_STUDENT_ID`, `MISSING_STUDENT_ID`, `MISSING_STUDENT_NAME`, `DUPLICATE_STUDENT`, `DUPLICATE_ROW`    | Fix that row                                                                                                |
| `UNKNOWN_GENDER`, `UNRECOGNIZED_COLUMN`                                                                     | Warnings. Check the sheet                                                                                   |
| `COMMENT_TOO_LONG`                                                                                          | Warning. Shorten the comment to 4000 characters. The old comment is kept until then                         |
| `IDENTITY_MISMATCH`, `IDENTITY_MISMATCH_TAB`                                                                | The row's name belongs to another student. Fix the IDs or names; over 20% of rows blocks the tab            |
| `AUDIENCE_GUESSED`, `AUDIENCE_REQUIRED`, `PROGRAM_NOT_IN_AUDIENCE`                                          | Check or set who takes the tab; a student of another program in it is rejected                              |
| `UNKNOWN_CLASS`, `PROGRAM_UNDETERMINED`, `PROGRAM_CONFLICT`, `PROGRAM_SWITCH_PENDING`, `NO_TERM_ENROLLMENT` | Fix the student's class in `ALL`, or decide in the admin issue list                                         |
| `STUDENT_MISSING_FROM_TAB`, `NO_CLASS_LIST`                                                                 | Warnings. Add the student to the tab; set up the term's class list                                          |
| `STUDENT_ID_CONFLICT`, `STUDENT_IN_OTHER_GENERATION`                                                        | The ID already belongs to someone else or to another generation                                             |
| `SOURCE_BUSY`                                                                                               | A workbook was already syncing and was skipped in a bulk sync                                               |
| `GOOGLE_AUTH_FAILED` / `GOOGLE_ERROR`                                                                       | Check the service-account key. An uploaded `.xlsx` not saved as a Google Sheet may also give `GOOGLE_ERROR` |

Other job failures are listed in [api-specification.md](api-specification.md).

## 8. Service account setup

1. In Google Cloud Console, create a project and enable the **Google Sheets API**.
2. Create a service account (no roles needed) and a JSON key. Store it as described in
   `security.md`.
3. Share each workbook with the service account's email as **Viewer**, with "Notify people"
   unticked. The app only requests the `spreadsheets.readonly` scope.
