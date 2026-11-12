# Decisions

Decisions D1–D38 (term workbooks, sheet changes, removed subjects) are in
[delivery-plan-2027.md](delivery-plan-2027.md). This file records the decisions made after it,
during the November 2026 retest. Each says where the rule now lives.

## Teacher comments (2026-11-03)

| #   | Decision                                                                                                                       | Rule in                      |
| --- | ------------------------------------------------------------------------------------------------------------------------------ | ---------------------------- |
| C1  | A comment follows the sheet: new or changed replaces, blank or whitespace-only clears                                          | google-sheets-template.md §2 |
| C2  | Over 4000 characters (code points): not imported, the old comment stays, a warning with tab/row/length; the marks still import | google-sheets-template.md §2 |
| C3  | Comments are text: never part of totals, grades or completeness; shown as plain text, also on Incomplete subjects              | api-specification.md §3      |

## Issue lists (2026-11-03)

| #   | Decision                                                                          | Rule in                   |
| --- | --------------------------------------------------------------------------------- | ------------------------- |
| W1  | Every issue list shows 5 per page with "1–5 of N"; no page controls at 5 or fewer | .claude/rules/frontend.md |
| W2  | Job and preview issues are paged on the server; detection issues in the browser   | api-specification.md      |

## Classes and programs per term (2026-11-04)

| #   | Decision                                                                                                                                                                               | Rule in                      |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| P1  | `ALL` is the roster and the authority (ID, name, gender, class; `CLASS 2` from Term 2). Its score columns are ignored                                                                  | google-sheets-template.md §1 |
| P2  | `_meta` is ignored except `education_term`, which must match the term (2026-11-05)                                                                                                     | google-sheets-template.md §1 |
| P3  | Program per term: admin assignment, else `ALL`'s class through the term's class list; `CLASS 2` cross-checks; a disagreement is a conflict, never a guess                              | google-sheets-template.md §3 |
| P4  | Defaults: Term 1 General (A–D); Terms 2–5 WEP (A, B, C) and SNAC (D). Class lists and programs per term are configuration, editable by admins; a class name is unique within a term    | database-design.md           |
| P5  | Tab audience Shared or one program. Confirmed on the tab, or guessed once by the sync from who the tab lists and kept                                                                  | google-sheets-template.md §3 |
| P6  | Subject-tab CLASS / MAJOR only warn. Swapped first/last names are the same name. A name of another student rejects the row; over 20% blocks the tab                                    | google-sheets-template.md §2 |
| P7  | A program change within a term needs an admin. Approval withdraws subjects the new program does not take (marks kept, hidden from the student, flagged for admins); it can be reversed | google-sheets-template.md §3 |
| P8  | A later term never changes an earlier one. `students.class_name` / `program_id` show the highest term                                                                                  | database-design.md           |
| P9  | A generation has exactly 5 terms (database CHECK and `TERMS_PER_GENERATION`)                                                                                                           | requirements.md              |
| P10 | SNA is renamed SNAC everywhere; `SNA` stays as an alias in sheets                                                                                                                      | requirements.md glossary     |

## Letter grades (2026-11-10)

Replaces the D5 placeholder scale (A 85 / B 70 / C 50, a fail band below 50), which was never
stored. G1 is superseded by G5 (2026-11-12).

| #   | Decision                                                                                                                                                                     | Rule in                                  |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| G1  | Superseded by G5 on 2026-11-12. Was: minimum thresholds A 90, B 80, C 70, D 60, E 50, and a fail band below 50. One copy per generation                                      | database-design.md `grade_bands`         |
| G2  | The grade uses the final score as displayed (2 decimals, half up): a raw 84.995 shows 85.00 and A; 84.99 shows B+. A student never sees a score and a letter that disagree   | `packages/shared/src/grading/letters.ts` |
| G3  | A grade appears only beside a COMPLETE subject's final score: never on a component mark, a "so far" figure, an average, a term summary or an INCOMPLETE subject (UI and API) | api-specification.md §3                  |
| G4  | No confirmed, usable scale (for example no band at 0): no grade and an error in the log, never a default letter. Grades are computed on read and never stored                | api-specification.md §3                  |

## Grade scale (2026-11-12)

Supersedes G1 (the scale of 2026-11-10). G2–G4 still apply.

| #   | Decision                                                                                                                                                                                                                                                                                                 | Rule in                                        |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| G5  | Official scale: A 85–100, B+ 80 to below 85, B 70 to below 80, C+ 65 to below 70, C 60 to below 65, D 50 to below 60, E 0 to below 50. Lower bound inclusive, compared on the displayed score (G2): 85.00 is A, 84.99 is B+, 50.00 is D, 49.99 is E. There is no F; E is the only fail (`is_pass` false) | `packages/shared/src/grading/letters.ts`       |
| G6  | It replaces the bands of every generation (each scale marked confirmed) and is what every new generation gets. Grades are computed on read, so released results show the new letters at once                                                                                                             | migration `20261113090000_grade_scale_2026_11` |

## Student dashboard summary (2026-11-10)

| #   | Decision                                                                                                                                                                                                          | Rule in                              |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| S1  | The Overall card shows "Courses complete" (all terms, released, enrolled) and "Highest final score of the latest term". No average and no credits anywhere (T1)                                                   | api-specification.md §3              |
| S2  | Latest term = the highest term number with a released subject. Only released COMPLETE subjects count; ties are all shown in one line. No COMPLETE subject yet: "Term 3: no final scores yet", never an older term | `packages/shared/src/latest-term.ts` |
| S3  | The grade beside that highest score is the only grade in the summary (G3)                                                                                                                                         | api-specification.md §3              |

## Term summary: Top scoring (2026-11-11)

| #   | Decision                                                                                                                                                                                                                | Rule in                              |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| T1  | No term average, provisional average or credit totals, for students and admins, and no "Averages by term" chart. Each term shows Courses complete and Top scoring; the term tab shows "N courses"                       | api-specification.md §3              |
| T2  | Top scoring: the highest final score among the term's COMPLETE subjects, with name, score and grade; ties all shown in one line; none yet: "No final score yet", never a zero. Withdrawn enrollments never count        | `packages/shared/src/top-scoring.ts` |
| T3  | Students: released subjects only. Admins: hidden subjects count, marked "Hidden from student". Its grade, beside that final score, is the summary's only grade (G3). The dashboard's highest score uses the same helper | api-specification.md §3              |

## Tab detection (2026-11-11)

| #   | Decision                                                                                                                                                                                                               | Rule in                                      |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| TD1 | Tabs are read once, automatically, right after a sheet is connected (first sheet or each new pending sheet), from either connect form; never on a page load. "Detect tabs" stays. One run per source: a 2-minute lease | `apps/api/src/sheet-mappings/detect-lock.ts` |
| TD2 | Re-detecting never overwrites what an admin set: a reopened tab keeps its audience and each matched column's role, name and weight; new columns are proposed; another audience is only suggested; changes are listed   | api-specification.md §4 (Tab detection)      |
| TD3 | Detection never syncs and never changes scores or visibility. If it fails, the sheet stays connected, with a clear error and Try again                                                                                 | api-specification.md §4 (Tab detection)      |

## Releasing scores from the Sync Center (2026-11-10)

| #   | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                   | Rule in                   |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------- |
| R1  | Release is per term. A source is one term's workbook, so Hide / Release on the Sync Center's per-source list acts on the whole term, with the same logic as the term button (`setTermVisibility` in `packages/sync/src/release.ts`). No per-subject toggle                                                                                                                                                                                 | api-specification.md §4   |
| R2  | States: Released, Hidden, Partly released (some subjects of the term visible), Nothing synced. Each change needs a confirmation that says how many subjects and students it affects                                                                                                                                                                                                                                                        | .claude/rules/frontend.md |
| R3  | Every change is audited per source: admin, source, term, old and new state, subjects, students, time. Hiding keeps all data and takes effect at once (cache version bumped)                                                                                                                                                                                                                                                                | api-specification.md §4   |
| R4  | Subjects stay Hidden by default; a sync never changes visibility, except that a new subject in a term with a visible subject is visible. "Release scores after sync" is off by default, offered on the source page, the pending sheet and the Sync Center / generation sync confirmations; a term already released shows a note instead. A job that ends `SUCCEEDED` or `SUCCEEDED_WITH_ERRORS` releases; a failed job or a retry does not | api-specification.md §4   |
| R5  | Students get released subjects only, in every response and every figure (results, courses, summary, highest score). A term with no released subject shows a neutral empty state without names or counts                                                                                                                                                                                                                                    | api-specification.md §3   |
