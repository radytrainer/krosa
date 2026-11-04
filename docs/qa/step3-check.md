# Step 3 check: term enrollments, class and program (2026-11-03)

Read only. Nothing was migrated or synced. Both workbooks were read once with the service
account, in memory; this file holds tab names, header labels, codes, student IDs and counts only.

Files named in the brief that do not exist: `CLAUDE.md`, `.claude/rules/sync.md`,
`docs/decisions.md`, `docs/sheet-import-format.md`, `docs/backlog.md`,
`docs/existing-code-audit.md`. Their content lives in `delivery-plan-2027.md` (decisions),
`google-sheets-template.md` (sheet format), `requirements.md` and `progress.md` (backlog).

## 1. The workbooks, compared with the brief

| Item                   | Brief                                                                                                                    | Found                                                                                                                                                                                                                |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Term 1 ALL             | header row 3; ID, names, gender, CLASS, ENG score columns, no MAJOR                                                      | Same. 101 students, CLASS A 26, B 24, C 25, D 26                                                                                                                                                                     |
| Term 2 ALL             | header row 1                                                                                                             | **Header row 3.** First column `#N` (row number), then STUDENT ID, FIRST NAME, LAST NAME, FULL NAME, KH LAST NAME, KH FIRST NAME, FULL NAME 2, GENDER, CLASS, CLASS 2. No MAJOR. 100 students, CLASS A/B/C/D 25 each |
| CLASS 2                | "WEP A/B/C" or "SNAC"                                                                                                    | Same, and it agrees with CLASS for all 100 (A↔WEP A, B↔WEP B, C↔WEP C, D↔SNAC)                                                                                                                                       |
| `_meta`                | empty `generation_code`                                                                                                  | **`generation_code=GEN2027`** in both; `education_term` 1 and 2                                                                                                                                                      |
| Tabs, Term 2           | WEP-only Algorithm, Web Design, UXUI, Git (75); SNAC-only CCNA1, IT Support, SOS, IT Research (25); shared ENG, PL (100) | Same. Every tab's students are all of one program, or all 100                                                                                                                                                        |
| Student only in Term 1 | one                                                                                                                      | `PNC2027-076`                                                                                                                                                                                                        |
| Class reshuffled       | yes                                                                                                                      | Yes: all 16 Term 1 → Term 2 class pairs occur (e.g. D→A 8, B→D 8)                                                                                                                                                    |
| MAJOR in subject tabs  | Term 2                                                                                                                   | In all 10 Term 2 tabs; never blank, never disagrees with ALL                                                                                                                                                         |

## 2. What the code does today with these workbooks

- **Profiles:** read from ALL only (ID, first/last or full name, gender, CLASS). Score columns
  in ALL are ignored. CLASS 2, the Khmer name columns and FULL NAME 2 are ignored.
- **Class:** one `students.class_name`. Each term's sync overwrites it, so syncing Term 2 then
  re-syncing Term 1 swaps every student's class back. No history, no audit.
- **Program:** never set. `programs` is empty, no student has a program, `offering_programs` is
  unused. Nothing checks who may be in a tab.
- **Enrollments:** a student is enrolled in every subject tab their ID appears in.
- **Subject-tab CLASS:** ignored. `PNC2027-051` (ALL C, tabs B) and `PNC2027-076` (ALL D,
  tabs C) differ in all 5 Term 1 tabs; no warning today.
- **Names:** first and last compared separately, so a swapped order is a `PROFILE_MISMATCH`.
- **Warnings a Term 2 sync would write today (the "too many warnings"):** 254 `PROFILE_MISMATCH`,
  one per row, plus 2 `INVALID_MARK` errors in Web Design.

| Tab                                 | PROFILE_MISMATCH today | Cause                                           |
| ----------------------------------- | ---------------------- | ----------------------------------------------- |
| ENG                                 | 6                      | first/last swapped                              |
| CCNA1, IT Support, SOS, IT Research | 25 each                | first/last swapped on every row                 |
| Web Design, UXUI                    | 74 each                | each ID carries another student's name (see §3) |

- **Detection warnings today (mapping screen), Term 2:** `UNRECOGNIZED_COLUMN` for MAJOR in all
  10 tabs; 43 `MISSING_WEIGHT` (see §6). Term 1: 4 `MISSING_WEIGHT` in MsOffice.
- **Risk if Term 2 were synced today:** Web Design and UXUI marks would be stored under the wrong
  students (74 rows each). Term 2 has not been synced on dev, so nothing wrong is stored.

## 3. Decision 4 counts, Term 2 (and Term 1)

Rows compared with ALL by ID. Names compared ignoring case, extra spaces and first/last order.

| Tab         | Rows | Name matches | Swapped (silent) | IDENTITY_MISMATCH | Share | Blocked (>20%) | CLASS ≠ ALL | MAJOR ≠ ALL | Unknown ID | Proposed audience |
| ----------- | ---- | ------------ | ---------------- | ----------------- | ----- | -------------- | ----------- | ----------- | ---------- | ----------------- |
| ENG         | 100  | 94           | 6                | 0                 | 0%    | no             | 0           | 0           | 0          | Shared            |
| PL          | 100  | 100          | 0                | 0                 | 0%    | no             | 0           | 0           | 0          | Shared            |
| CCNA1       | 25   | 0            | 25               | 0                 | 0%    | no             | 0           | 0           | 0          | SNAC              |
| IT Support  | 25   | 0            | 25               | 0                 | 0%    | no             | 0           | 0           | 0          | SNAC              |
| SOS         | 25   | 0            | 25               | 0                 | 0%    | no             | 0           | 0           | 0          | SNAC              |
| IT Research | 25   | 0            | 25               | 0                 | 0%    | no             | 0           | 0           | 0          | SNAC              |
| Web Design  | 75   | 1            | 0                | **74**            | 99%   | **yes**        | 0           | 0           | 0          | WEP               |
| Algorithm   | 75   | 75           | 0                | 0                 | 0%    | no             | 0           | 0           | 0          | WEP               |
| UXUI        | 75   | 1            | 0                | **74**            | 99%   | **yes**        | 0           | 0           | 0          | WEP               |
| Git         | 75   | 75           | 0                | 0                 | 0%    | no             | 0           | 0           | 0          | WEP               |

- Web Design and UXUI are blocked, as expected. Their name column looks shifted against the ID
  column (e.g. the row for `PNC2027-050` holds the name of `PNC2027-002`; `PNC2027-007` →
  `PNC2027-006`).
- No SNAC student appears in a WEP-only tab and no WEP student in a SNAC-only tab.
- Term 1: 505 rows, no identity mismatch, no unknown ID. CLASS ≠ ALL: the 2 students above, in
  each of the 5 tabs (10 rows). One ENG row's name matches neither its own student nor anyone
  else (no warning today); see open question 1.

## 4. Backfill dry run (copy of the dev database: `ssrs_step3_copy`)

- Dev holds GEN2027: Term 1 sheet active and synced (5 succeeded jobs), Term 2 sheet connected
  but never synced (10 DRAFT tab mappings). 101 students, 505 enrollments, all in Term 1.
- Every student's `class_name` came from the Term 1 roster (`students.source_id` is the Term 1
  sheet). **No Term 1 row would take a class from a later term: 0 students.**
- The backfill would create 101 Term 1 rows, program General, classes A 26, B 24, C 25, D 26,
  the same as Term 1 ALL.
- The copy is kept to rehearse the migration; drop it with `DROP DATABASE ssrs_step3_copy`.

## 5. Production data

None found: `progress.md` says "Not deployed", `.env.production` does not exist, CI has no
deploy job, and the only databases on this machine are `ssrs`, `ssrs_test` and the copy. I cannot
see any server outside this machine.

## 6. Detection warnings left once CLASS, MAJOR, PROGRAM and CLASS 2 are recognised

`UNRECOGNIZED_COLUMN` (10, all MAJOR) disappears. What remains, reported only, not fixed:

| Tab                                                                              | Remaining warning        | Column                                                  |
| -------------------------------------------------------------------------------- | ------------------------ | ------------------------------------------------------- |
| ENG, PL, IT Support, SOS, IT Research, Web Design, Algorithm, UXUI, Git (Term 2) | `MISSING_WEIGHT`         | `#N`, a row-number column read as a mark                |
| CCNA1                                                                            | `MISSING_WEIGHT`         | `Column 1` (col A, the same row-number column)          |
| CCNA1, IT Support, SOS, IT Research                                              | `MISSING_WEIGHT`         | `Column 13` (col N), a generic header                   |
| CCNA1, IT Support, SOS, IT Research                                              | `MISSING_WEIGHT` ×6 each | `ASSESSMENT 1` … `ASSESSMENT 6`: no weight in the label |
| Web Design                                                                       | `MISSING_WEIGHT` ×5      | PARTICIPATION, QUIZ I, QIUZ II (typo), MIDTERM, PROJECT |
| MsOffice (Term 1)                                                                | `MISSING_WEIGHT` ×4      | PARTICIPATIONS, MS WORD, MS POWERPOINT, MS EXCEL        |

Blank or generic score headers are in the **SNAC** tabs (CCNA1, IT Support, SOS, IT Research:
`Column 13`; CCNA1 also `Column 1`), not in Algorithm, Git, UXUI or Web Design as the brief
expected. Those four have none; Git's `Final (40%)` label contains invisible zero-width
characters, which are harmless.

## 7. Marks after an approved program switch (proposal)

Within a term only; between terms a new program is a new enrollment. On approval:

- Enrollments in subjects the new program does not take are set `WITHDRAWN` with
  `ended_reason = PROGRAM_SWITCH`. Their marks and history stay stored.
- Students no longer see them (withdrawn enrollments are already hidden and left out of
  summaries). Admins see them with a "Ended by program switch" flag.
- Shared subjects (ENG, PL) continue unchanged. Nothing is deleted.
