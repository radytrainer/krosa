# Sync rules

Full rules for teachers and admins: `docs/google-sheets-template.md` §2–§3. Code:
`packages/sheets/src/term-workbook/*` (reading) and `packages/sync/src/*` (applying).

## Roster and profiles

- `ALL` is the authority for student ID, name, gender and class (and `CLASS 2` from Term 2).
  Its score columns are ignored. `_meta`: only `education_term` is checked.
- A student in a subject tab but not in `ALL` is rejected (`UNKNOWN_STUDENT`).
- A student ID twice in `ALL`: every copy rejected, and a `DUPLICATE_IN_ROSTER` student issue.

## Class and program per term (`student_terms`)

- One enrollment per student per term. Decision order: admin assignment (kept by sync) → `ALL`'s
  class through the term's class list (`term_classes`) → cross-check with `CLASS 2`.
- Disagreement, unknown class or no class blocks **only that student**: a student issue, no
  enrollment created or changed, their rows skipped (`NO_TERM_ENROLLMENT`).
- Class change within the program: applied and audited (`student_term.class_changed`).
- Program change within a term: never automatic. A `PROGRAM_SWITCH` issue; until an admin approves,
  only shared subjects import for that student. Approval withdraws subjects the new program does
  not take (`ended_reason = PROGRAM_SWITCH`, marks kept); reversal restores them.
- A later term never touches an earlier one. `students.class_name` / `program_id` mirror the
  highest term, updated in the same transaction (`refreshLatestTerm`).
- Programs and classes per term are configuration (`term_programs`, `term_classes`); validation
  reads them, never term numbers. Defaults: `ssrs_apply_term_defaults`.

## Subject tabs

- Tab audience: Shared or one program. Confirmed by an admin, or guessed **once** by the sync from
  who the tab lists and saved (`AUDIENCE_GUESSED`). A student of another program in a program's tab
  is rejected (`PROGRAM_NOT_IN_AUDIENCE`). Missing from a tab their program takes: warning.
- Names compare ignoring case, spaces and first/last order. A name belonging to another student
  rejects the row (`IDENTITY_MISMATCH`); over 20% of a tab's rows blocks the tab.
- CLASS / MAJOR that differ from `ALL`: `PROFILE_MISMATCH` warning, marks still import.
- Row-number columns (`#`, `#N`, `No`, or 1, 2, 3… under a generic header) are never marks.
- Blank mark = not entered (never zero); an erased mark is `CLEARED`, kept in history.
- Comments: blank clears; over 4000 characters keeps the old one and warns.

## Safety

- Re-syncing unchanged data writes nothing but "last seen" markers and `sync.completed`.
- A pending sheet, or a sync that removes subjects, is all-or-nothing and needs zero errors.
- The preview runs the same code as the sync and writes nothing.
