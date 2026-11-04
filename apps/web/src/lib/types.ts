/**
 * Response shapes of the admin API (docs/api-specification.md §4). Student result views come
 * from @ssrs/shared, which the API also uses, so both sides share one contract.
 */
export type {
  CourseResultView,
  CourseStatus,
  CriterionResultView,
  StudentCourseListItem,
  StudentProfileView,
  StudentResultsView,
  StudentSummaryView,
  TermResultView,
  TermSummary,
} from '@ssrs/shared';

export interface Paginated<T> {
  data: T[];
  meta: { page: number; pageSize: number; total: number };
}

export type Role = 'ADMIN' | 'STUDENT';

export interface Me {
  id: string;
  role: Role;
  username: string;
  displayName: string | null;
  mustChangePassword: boolean;
  student: { id: string; studentCode: string; fullName: string } | null;
}

export interface Term {
  id: string;
  number: number;
  name: string;
  startDate: string | null;
  endDate: string | null;
}

export interface TermDetail extends Term {
  subjects: number;
  visibleSubjects: number;
}

export interface Generation {
  id: string;
  code: string;
  name: string;
  startDate: string;
  endDate: string | null;
  status: 'ACTIVE' | 'ARCHIVED';
  createdAt: string;
  updatedAt: string;
}

export interface GenerationDetail extends Generation {
  terms: TermDetail[];
  counts: { students: number; offerings: number; sources: number };
}

export interface Source {
  id: string;
  generation: { id: string; code: string; name: string };
  term: { id: string; number: number; name: string };
  rosterTab: string;
  spreadsheetId: string;
  spreadsheetUrl: string;
  label: string;
  spreadsheetTitle: string | null;
  status: 'ACTIVE' | 'PENDING' | 'DISABLED';
  lastSyncedAt: string | null;
  lastSyncJobId: string | null;
  ownedOfferings: number;
  createdBy: { id: string; username: string };
  createdAt: string;
}

export interface SheetIssue {
  severity: 'ERROR' | 'WARNING';
  scope?: string;
  code: string;
  message: string;
  sheetTab?: string | null;
  rowNumber?: number | null;
  columnKey?: string | null;
  studentCode?: string | null;
  courseKey?: string | null;
  criterionKey?: string | null;
  rawValue?: string | null;
}

export type ColumnRole =
  | 'STUDENT_ID'
  | 'FIRST_NAME'
  | 'LAST_NAME'
  | 'FULL_NAME'
  | 'GENDER'
  | 'CLASS'
  | 'PROGRAM'
  | 'ROW_NUMBER'
  | 'CRITERION'
  | 'REFERENCE_TOTAL'
  | 'COMMENT'
  | 'IGNORE';

export interface ColumnMapping {
  columnIndex: number;
  headerLabel: string | null;
  groupLabel: string | null;
  role: ColumnRole;
  criterionId: string | null;
  proposedName: string | null;
  proposedWeight: string | null;
}

export interface TabMapping {
  id: string;
  tabName: string;
  status: 'DRAFT' | 'CONFIRMED' | 'IGNORED';
  version: number;
  headerRow: number;
  offeringId: string | null;
  confirmedAt: string | null;
  /** SHARED, a program code, or null (the sync guesses it from who the tab lists). */
  audience: string | null;
  columns: ColumnMapping[];
  carriedFrom: { subject: string; headersMatch: boolean } | null;
}

export interface SheetCheck {
  spreadsheetId: string;
  spreadsheetTitle: string;
  tabs: string[];
}

export interface TermWorkbooks {
  generation: { id: string; code: string; name: string };
  term: { id: string; number: number; name: string };
  active: Source | null;
  pending: (Source & { previewState: 'NONE' | 'NOT_CONFIRMED' | 'CONFIRMED' }) | null;
  history: Source[];
  runningJobId: string | null;
}

export interface ImpactCounts {
  new: number;
  changed: number;
  unchanged: number;
  invalid: number;
}

/** Teacher comments a sync would write; missing on previews run before comments were counted. */
export interface CommentCounts {
  new: number;
  changed: number;
  cleared: number;
  unchanged: number;
  tooLong: number;
}

export interface PreviewTab {
  tabName: string;
  subject: string;
  status: 'OK' | 'MISSING' | 'HEADERS_CHANGED' | 'INVALID';
  scores: ImpactCounts;
  comments?: CommentCounts;
  /** Stored marks that a now-blank cell would clear. */
  cleared: number;
  weightsChanged: boolean;
}

export interface RemovedSubject {
  offeringId: string;
  subject: string;
  tabName: string | null;
  students: number;
  scores: number;
}

export interface SheetComparison {
  kept: string[];
  added: { subject: string; tabName: string; returning: boolean }[];
  removed: RemovedSubject[];
  possibleRenames: { from: string; to: string }[];
  blockers: string[];
}

export interface SheetPreview {
  id: string;
  createdAt: string;
  confirmedAt: string | null;
  summary: {
    spreadsheetTitle: string;
    canConfirm: boolean;
    students: ImpactCounts;
    scores: ImpactCounts;
    comments?: CommentCounts;
    /** Missing on previews run before term enrollments existed. */
    termEnrollments?: { created: number; classChanged: number; unchanged: number; blocked: number };
    programChanges?: { studentCode: string; from: string; to: string }[];
    studentIssues?: Record<string, number>;
    tabs: PreviewTab[];
    unmappedTabs: string[];
    comparison: SheetComparison;
    missingStudents: { total: number; sample: { studentCode: string; fullName: string }[] };
    /** The issues themselves are paged: GET /admin/sources/:id/preview/:previewId/issues. */
    issueCounts: { total: number; errors: number; warnings: number };
    firstErrors: string[];
    issuesTruncated: boolean;
  };
}

/** One page of a preview's issues. */
export interface PreviewIssuePage extends Paginated<SheetIssue> {
  tabs: string[];
  /** Issues found but past the storage cap. */
  notListed: number;
}

export interface DetectedTab {
  tabName: string;
  mapping: TabMapping | null;
  detected: {
    headerRow: number;
    totalWeight: string | null;
    studentRows: number;
    unknownStudents: number;
    crossCheck: {
      comparableRows: number;
      mismatchedRows: number;
      blanksAsZeroRows: number;
    } | null;
    headersChanged: boolean;
  } | null;
}

export interface Detection {
  spreadsheetTitle: string;
  fatal: boolean;
  rosterTab: string | null;
  rosterStudents: number;
  issues: SheetIssue[];
  issuesTruncated: boolean;
  tabs: DetectedTab[];
}

export type AccountStatus = 'PENDING' | 'ACTIVE' | 'DISABLED';

export interface Student {
  id: string;
  studentCode: string;
  fullName: string;
  gender: 'FEMALE' | 'MALE' | 'OTHER' | 'UNSPECIFIED';
  /** The latest term's class and program. */
  className: string | null;
  program: { code: string; name: string } | null;
  generation: { id: string; code: string; name: string };
  terms: StudentTerm[];
  account: {
    status: AccountStatus;
    mustChangePassword: boolean;
    temporaryPasswordExpiresAt: string | null;
    lastLoginAt: string | null;
    locked: boolean;
  };
  createdAt: string;
  updatedAt: string;
}

export interface StudentTerm {
  termId: string;
  termNumber: number;
  termName: string;
  program: { code: string; name: string };
  className: string;
  /** ADMIN: set by an admin; the sync keeps the program. */
  programSource: 'SHEET' | 'ADMIN';
}

export interface Program {
  id: string;
  code: string;
  name: string;
  aliases: string[];
}

export interface TermClasses {
  termId: string;
  termNumber: number;
  termName: string;
  generationId: string;
  programs: {
    id: string;
    code: string;
    name: string;
    classes: { id: string; name: string; students: number }[];
  }[];
}

export type StudentIssueKind =
  | 'UNDETERMINED_PROGRAM'
  | 'PROGRAM_CONFLICT'
  | 'PROGRAM_SWITCH'
  | 'UNKNOWN_CLASS'
  | 'DUPLICATE_IN_ROSTER';

export interface StudentIssue {
  id: string;
  termId: string;
  studentId: string | null;
  studentCode: string;
  fullName: string | null;
  kind: StudentIssueKind;
  detail: Record<string, unknown>;
  syncJobId: string | null;
  createdAt: string;
  resolvedAt: string | null;
  resolution: string | null;
}

export interface IssuedCredential {
  studentCode: string;
  temporaryPassword: string;
  expiresAt: string;
}

export type SyncStatus =
  'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'SUCCEEDED_WITH_ERRORS' | 'FAILED' | 'CANCELLED';
export type SyncScope = 'SOURCE' | 'GENERATION' | 'ALL';

export interface SyncJob {
  id: string;
  scope: SyncScope;
  status: SyncStatus;
  phase: string | null;
  progress: { current: number; total: number };
  counts: Record<string, Record<string, number> | number> | null;
  errorCount: number;
  warningCount: number;
  failureCode: string | null;
  failureMessage: string | null;
  source: {
    id: string;
    label: string;
    spreadsheetId: string;
    generation: { id: string; code: string; name: string };
    term: { id: string; number: number; name: string };
  } | null;
  generation: { id: string; code: string; name: string } | null;
  termNumber: number | null;
  requestedBy: { id: string; username: string };
  parentId: string | null;
  retryOfId: string | null;
  queuedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface SyncJobDetail extends SyncJob {
  children: SyncJob[];
}

export interface SyncError extends SheetIssue {
  id: string;
  /** The workbook that found it; null for a job-level issue. */
  source: { id: string; label: string } | null;
}

export interface SyncErrorPage extends Paginated<SyncError> {
  tabs: string[];
  /** Issues counted on the job but past the storage cap. */
  notListed: number;
}

export interface SyncTargetOption {
  id: string;
  code: string;
  name: string;
  terms: { id: string; number: number; name: string }[];
}

export interface AuditEntry {
  id: string;
  action: string;
  actorType: 'USER' | 'SYSTEM';
  actor: { id: string; username: string; role: Role } | null;
  entityType: string | null;
  entityId: string | null;
  metadata: Record<string, unknown>;
  ip: string | null;
  userAgent: string | null;
  requestId: string | null;
  createdAt: string;
}

export interface Dashboard {
  generations: { active: number; archived: number };
  students: { total: number; pending: number; active: number; disabled: number };
  sources: { active: number; disabled: number };
  offerings: { total: number; visible: number; withoutPublishedScheme: number };
  jobs: { active: number; failedRecently: number; failedWindowDays: number };
  recentJobs: SyncJob[];
}
