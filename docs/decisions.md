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
