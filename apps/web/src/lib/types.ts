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
  terms: Term[];
  counts: { students: number; offerings: number; sources: number };
}

export interface Source {
  id: string;
  generation: { id: string; code: string; name: string };
  spreadsheetId: string;
  spreadsheetUrl: string;
  label: string;
  spreadsheetTitle: string | null;
  status: 'ACTIVE' | 'DISABLED';
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

export interface SourcePreview {
  spreadsheetTitle: string;
  fatal: boolean;
  stats: {
    students: number;
    courses: number;
    coursesWithValidScheme: number;
    markRows: number;
    marks: number;
    blankMarks: number;
    errors: number;
    warnings: number;
  };
  issues: SheetIssue[];
  issuesTruncated: boolean;
  courses: {
    courseKey: string;
    termNumber: number;
    title: string;
    criteria: number;
    rows: number;
    schemeValid: boolean;
  }[];
}

export interface Course {
  id: string;
  code: string;
  name: string;
  description: string | null;
}

export type Visibility = 'HIDDEN' | 'VISIBLE';

export interface Offering {
  id: string;
  generationId: string;
  term: { id: string; number: number; name: string };
  course: { id: string; code: string; name: string };
  externalKey: string;
  title: string;
  credits: string;
  visibility: Visibility;
  visibilityOverridden: boolean;
  status: 'ACTIVE' | 'ARCHIVED';
  sourceId: string | null;
  sheetTab: string | null;
  criteriaCount: number;
  publishedSchemeVersion: number | null;
  hasDraftScheme: boolean;
}

export const CRITERION_CATEGORIES = [
  'QUIZ',
  'EXAM',
  'HOMEWORK',
  'ASSIGNMENT',
  'PROJECT',
  'PRESENTATION',
  'PARTICIPATION',
  'OTHER',
] as const;
export type CriterionCategory = (typeof CRITERION_CATEGORIES)[number];

export interface Criterion {
  id: string;
  offeringId: string;
  key: string;
  name: string;
  category: CriterionCategory;
  displayOrder: number;
  isActive: boolean;
  description: string | null;
  sheetColumnKey: string | null;
  published: { maxMark: string; weight: string } | null;
  scoreCount: number;
}

export interface SchemeIssue {
  code: string;
  message: string;
  criterionId?: string;
  count?: number;
}

export interface SchemeValidation {
  valid: boolean;
  totalWeight: string;
  issues: SchemeIssue[];
}

export interface Scheme {
  id: string;
  offeringId: string;
  version: number;
  status: 'DRAFT' | 'PUBLISHED' | 'ARCHIVED';
  origin: 'SHEET' | 'ADMIN';
  totalWeight: string;
  publishedAt: string | null;
  publishedBy: { id: string; username: string } | null;
  notes: string | null;
  createdAt: string;
  items: {
    criterionId: string;
    key: string;
    name: string;
    isActive: boolean;
    displayOrder: number;
    maxMark: string;
    weight: string;
  }[];
  validation?: SchemeValidation;
}

export type AccountStatus = 'PENDING' | 'ACTIVE' | 'DISABLED';

export interface Student {
  id: string;
  studentCode: string;
  fullName: string;
  gender: 'FEMALE' | 'MALE' | 'OTHER' | 'UNSPECIFIED';
  className: string | null;
  generation: { id: string; code: string; name: string };
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
  source: { id: string; label: string; spreadsheetId: string } | null;
  generation: { id: string; code: string; name: string } | null;
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
