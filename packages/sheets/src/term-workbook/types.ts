import type { CriterionCategory } from '../template/constants.js';

export interface ParsedMark {
  status: 'RECORDED' | 'ABSENT';
  mark: string;
}

export interface SubjectRow {
  studentCode: string;
  rowNumber: number;
  /** Keyed by upper-cased criterion key; 'BLANK' = not entered. Invalid cells are absent. */
  marks: Map<string, ParsedMark | 'BLANK'>;
  /** Teacher comment; null when blank (clears the stored one). */
  comment: string | null;
  /** Over the length limit: not imported, the stored comment is kept (COMMENT_TOO_LONG). */
  commentRejected: boolean;
  /** The tab's MAJOR / PROGRAM cell, cross-checked against the roster by the sync. */
  programText: string | null;
  /** The sheet's own total, for the cross-check only. */
  sheetTotal: number | null;
}

export interface ParsedCriterion {
  key: string;
  name: string;
  category: CriterionCategory;
  maxMark: string;
  weight: string;
  order: number;
}

/** One confirmed subject tab, ready to apply. */
export interface ParsedCourse {
  offeringId: string;
  courseKey: string;
  title: string;
  worksheet: string;
  criteria: ParsedCriterion[];
  rows: SubjectRow[];
  /** Students rejected for appearing twice: still in the tab, so not missing from it. */
  duplicateStudents: string[];
}
