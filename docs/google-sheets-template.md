# Google Sheets Template (template_version 1)

One spreadsheet file per generation is the recommended layout. A generation may have several files
(for example one per department), but each course offering must be defined in exactly one file.

The parser identifies everything by **machine keys**, never by tab position or visible labels alone.

## 1. Required tabs

| Tab name (exact)   | Purpose                                                |
| ------------------ | ------------------------------------------------------ |
| `_meta`            | File-level metadata                                    |
| `Students`         | Roster: the only source of student profile data        |
| `Courses`          | Course offerings defined in this file                  |
| `Criteria`         | Criteria, max marks and weights per course             |
| one tab per course | Marks. Tab name is referenced from `Courses.worksheet` |

Tab names are matched case-insensitively after trimming. Other tabs are ignored (and listed as
info in the job report).

## 2. `_meta`

Two columns, key/value, starting at A1. Header row optional.

| key              | value   |
| ---------------- | ------- |
| template_version | 1       |
| generation_code  | GEN2026 |

`generation_code` must equal the generation's code in the application, otherwise the source is
rejected at registration and every sync fails with `GENERATION_MISMATCH`. This guards against
attaching the wrong file.

## 3. `Students`

Row 1 = machine keys (exact, case-insensitive). Columns may appear in any order.

| student_id | student_name      | gender | class |
| ---------- | ----------------- | ------ | ----- |
| GEN26-0001 | Example Student A | F      | A     |
| GEN26-0002 | Example Student B | M      | B     |

- `student_id` required; normalized (trim, uppercase; inner spaces are rejected); must match
  `^[A-Z0-9][A-Z0-9_-]{0,31}$`.
- `student_name` required.
- `gender`: `F`/`Female` → FEMALE, `M`/`Male` → MALE, `O`/`Other` → OTHER, blank → UNSPECIFIED.
  Any other value → warning, stored as UNSPECIFIED.
- `class` optional.
- Duplicate student IDs in the roster → all duplicates rejected (`DUPLICATE_STUDENT`).
- Blank rows are skipped.

## 4. `Courses`

| course_key | term | course_code | course_name   | credits | worksheet  | visible |
| ---------- | ---- | ----------- | ------------- | ------- | ---------- | ------- |
| T1-MATH101 | 1    | MATH101     | Mathematics I | 3       | T1 Math    | TRUE    |
| T1-ENG101  | 1    | ENG101      | English I     | 2       | T1 English | FALSE   |

- `course_key`: unique within the generation, `^[A-Za-z0-9_-]{1,40}$`. This is the stable offering ID.
- `term`: integer 1–5.
- `course_code`: catalog code; creates the catalog course if new. `course_name` is the offering title.
- `credits`: optional positive number (default 1).
- `worksheet`: exact tab name holding the marks.
- `visible`: TRUE/FALSE, as a checkbox or text (`yes`/`no` also accepted; default FALSE). An unrecognized
  value gives an `INVALID_VISIBLE` warning, and the course stays hidden. The column is ignored once an admin has
  overridden visibility in the app.
- Same `(term, course_code)` twice → both rejected.

## 5. `Criteria`

| course_key | criterion_key | criterion_name | category      | max_mark | weight | order | description |
| ---------- | ------------- | -------------- | ------------- | -------- | ------ | ----- | ----------- |
| T1-MATH101 | Q1            | Quiz 1         | QUIZ          | 10       | 5      | 1     |             |
| T1-MATH101 | Q2            | Quiz 2         | QUIZ          | 10       | 5      | 2     |             |
| T1-MATH101 | MID           | Midterm Exam   | EXAM          | 50       | 30     | 3     |             |
| T1-MATH101 | FINAL         | Final Exam     | EXAM          | 100      | 40     | 4     |             |
| T1-MATH101 | HW            | Homework       | HOMEWORK      | 10       | 10     | 5     |             |
| T1-MATH101 | PART          | Participation  | PARTICIPATION | 10       | 10     | 6     |             |

- `criterion_key`: `^[A-Za-z][A-Za-z0-9_]{0,31}$`, unique per course. **Never change a key once marks
  exist.** Rename via `criterion_name` instead.
- `category`: one of QUIZ, EXAM, HOMEWORK, ASSIGNMENT, PROJECT, PRESENTATION, PARTICIPATION, OTHER
  (default OTHER).
- `max_mark` > 0, `weight` > 0, decimals allowed (use `.` as decimal separator).
- Weights for a course must total exactly 100. If not, the course's scheme is rejected
  (`WEIGHTS_NOT_100`); marks are still validated but the offering stays NOT_CONFIGURED.
- A criterion previously synced but now missing from this tab → warning `CRITERION_REMOVED_IN_SOURCE`;
  the criterion is **not** deleted or deactivated automatically. A proposed draft scheme excludes it.

### How structure changes are applied

| Change in sheet                                        | Effect                                                                                                                  |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| New course, valid weights                              | Offering + criteria created, scheme v1 PUBLISHED automatically                                                          |
| Name / order / description / category changed          | Applied directly (key unchanged, scores untouched)                                                                      |
| Weight or max mark changed, or criterion added/removed | DRAFT scheme created/updated (origin SHEET); job warning `SCHEME_DRAFT_PENDING`; admin reviews and publishes in the app |
| Weights don't total 100                                | Draft not created; error reported                                                                                       |

## 6. Course mark tabs

- **Row 1: machine keys** (`student_id` plus criterion keys, or the criterion's `sheet_column_key`).
  Staff may hide/freeze row 1.
- **Row 2: human labels** (free text, ignored by the parser).
- **Row 3+: data.**

| student_id | student_name      | Q1     | Q2     | MID     | FINAL | HW       | PART          |
| ---------- | ----------------- | ------ | ------ | ------- | ----- | -------- | ------------- |
| Student ID | Name              | Quiz 1 | Quiz 2 | Midterm | Final | Homework | Participation |
| GEN26-0001 | Example Student A | 8      | 9      | 41.5    |       | 9        | 10            |
| GEN26-0002 | Example Student B | 7      | ABS    | 38      | 72    | 8        | 9             |

Cell rules:

| Cell                                                           | Meaning                                                                                 |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| number within `0..max_mark`                                    | RECORDED mark                                                                           |
| blank                                                          | not entered (no score). If a value existed before → warning, existing value kept        |
| `ABS` (case-insensitive)                                       | ABSENT, counts as 0                                                                     |
| more than 3 decimal places (e.g. a formula `=A1/3`)            | `INVALID_MARK`: never rounded silently. Enter the intended value                        |
| anything else (text, `EX`, negative, > max, `8,5`, TRUE/FALSE) | `INVALID_MARK` cell error. That cell is skipped; the other cells in the row still apply |

Row rules:

- `student_id` must exist in this file's `Students` roster (`UNKNOWN_STUDENT` otherwise).
- A student listed in the tab is enrolled in the offering.
- Duplicate student rows in one tab → all rejected (`DUPLICATE_ROW`).
- Columns `student_name`, `gender`, `class` are optional and ignored for data (mismatch → warning).
- Unknown column keys (not `student_id`, not optional profile keys, not a criterion key of this
  course) → **course rejected** (`UNKNOWN_COLUMN`), since this usually means a typo that would
  otherwise drop marks.
- Columns with an empty key in row 1 are ignored (staff notes columns are allowed if row 1 is blank).
- Students removed from the tab are not unenrolled; enrollment marked `present_in_source=false`
  with warning `ENROLLMENT_MISSING_IN_SOURCE`.

## 7. Sharing the spreadsheet with the service account

1. In Google Cloud Console create a project, enable **Google Sheets API**.
2. Create a service account (no roles needed) and a JSON key; store it as described in
   `security.md`. The account's email looks like `ssrs-sync@<project>.iam.gserviceaccount.com`.
3. In the spreadsheet: **Share** → add the service-account email → role **Viewer** → uncheck
   "Notify people". The application only requests the `spreadsheets.readonly` scope.
4. In the admin app: Generation → Sources → **Connect spreadsheet** → paste the URL.
   The API verifies access, the four template tabs and `_meta.generation_code` before saving
   (`POST /api/v1/admin/generations/:id/sources`). The address to share with is shown by
   `GET /api/v1/admin/sources/service-account`.
5. Optional but recommended: **Validate** (`POST /api/v1/admin/sources/:id/preview`) reads the whole
   file exactly as a sync would and lists every problem with tab, row and column, without
   importing anything.

Common errors:

| Code                                                         | Meaning / fix                                                                                                                                       |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `INVALID_URL` / `UNSUPPORTED_HOST` / `NOT_A_SPREADSHEET_URL` | Copy the URL from the address bar of the open spreadsheet (`https://docs.google.com/spreadsheets/d/<id>/edit`). "Publish to web" links do not work. |
| `SOURCE_EXISTS` (409)                                        | The file is already connected; a file can belong to one generation only.                                                                            |
| `SHEET_NOT_SHARED` (403)                                     | Share the file with the service-account email.                                                                                                      |
| `SHEET_NOT_FOUND` (404)                                      | URL wrong or file deleted.                                                                                                                          |
| `TEMPLATE_TAB_MISSING`                                       | Add the missing required tab.                                                                                                                       |
| `GENERATION_MISMATCH`                                        | `_meta.generation_code` differs from the generation code.                                                                                           |
| `UNSUPPORTED_TEMPLATE_VERSION`                               | Update `_meta.template_version`.                                                                                                                    |
| `GOOGLE_NOT_CONFIGURED` (503)                                | The server has no service-account credentials. See `.env.example`.                                                                                  |
| `RATE_LIMITED` / `GOOGLE_UNAVAILABLE` (503)                  | Temporary. Requests are already retried with backoff; try again later.                                                                              |

## 8. Migrating an existing spreadsheet

Do not point the sync at a non-conforming file and hope for the best: the parser will reject it
rather than guess. To migrate:

1. Make a copy of the existing file (keep the original untouched as a record).
2. Add `_meta`, `Students`, `Courses`, `Criteria` tabs.
3. Build the roster from the existing student columns (de-duplicate first).
4. For each existing course tab: insert a new row 1 with machine keys above the current header
   (which becomes row 2), and list the tab in `Courses`.
5. Enter each assessment column in `Criteria` with its max mark and weight.
6. Connect the copy in a **test generation** first, run **Validate**, fix the reported problems, run sync,
   review the job report, compare a
   sample of students' results against the original, then connect to the real generation.

An example workbook (synthetic data only) is provided as one CSV per tab in
[docs/templates/](templates/). Create a Google spreadsheet, add tabs with exactly these names
(`_meta`, `Students`, `Courses`, `Criteria`, `T1 Math`, `T2 English`), and import each CSV into its tab
(File → Import → Replace current sheet). The CSVs are generated from the same fixture the automated
tests use (`workbookFixture()` in `@ssrs/sheets/testing`), so they are known to parse without issues.

## 9. Issue reference

Every problem is reported with its tab, 1-based row, column key and the offending value (truncated
to 200 characters). The **scope** decides what is skipped:

| Scope                | Effect                                        | Codes                                                                                                                                                                                                                                                                                                                                           |
| -------------------- | --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| FILE                 | Nothing from this spreadsheet is applied      | `TEMPLATE_TAB_MISSING`, `UNSUPPORTED_TEMPLATE_VERSION`, `GENERATION_CODE_MISSING`, `GENERATION_MISMATCH`, `MISSING_COLUMN`, `TAB_TOO_LARGE`, `TOO_MANY_COURSES`                                                                                                                                                                                 |
| COURSE               | That course is skipped                        | `INVALID_COURSE_KEY`, `INVALID_TERM`, `INVALID_COURSE_CODE`, `MISSING_COURSE_NAME`, `INVALID_CREDITS`, `DUPLICATE_COURSE`, `DUPLICATE_WORKSHEET`, `WORKSHEET_NOT_FOUND`, `NO_CRITERIA`, `INVALID_CRITERION_KEY`, `DUPLICATE_CRITERION`, `INVALID_MAX_MARK`, `INVALID_WEIGHT`, `MISSING_STUDENT_ID_COLUMN`, `UNKNOWN_COLUMN`, `DUPLICATE_COLUMN` |
| COURSE (scheme only) | Marks are imported; the grading scheme is not | `WEIGHTS_NOT_100`                                                                                                                                                                                                                                                                                                                               |
| ROW                  | That row is skipped                           | `UNKNOWN_COURSE`, `INVALID_STUDENT_ID`, `MISSING_STUDENT_NAME`, `DUPLICATE_STUDENT`, `UNKNOWN_STUDENT`, `DUPLICATE_ROW`                                                                                                                                                                                                                         |
| CELL                 | That cell is skipped                          | `INVALID_MARK`                                                                                                                                                                                                                                                                                                                                  |
| Warning              | Nothing is skipped                            | `UNKNOWN_GENDER`, `UNKNOWN_CATEGORY`, `INVALID_VISIBLE`, `INVALID_ORDER`, `MISSING_CRITERION_COLUMN`, `PROFILE_MISMATCH`, `IGNORED_COLUMN`, `IGNORED_TAB`                                                                                                                                                                                       |

Safety limits per tab: 20,000 rows and 300 columns; at most 500 courses per spreadsheet.
