import { createHash } from 'node:crypto';
import {
  InMemorySheetsReader,
  TERM_FIXTURE_SPREADSHEET_ID,
  termWorkbookFixture,
  type FakeSpreadsheet,
} from '@ssrs/sheets/testing';
import { runSourceSync } from '@ssrs/sync';
import { confirmAllTabs } from '@ssrs/sync/testing';
import request from 'supertest';
import {
  api,
  createTestApp,
  login,
  resetState,
  seedUser,
  type LoggedIn,
  type TestAppOptions,
  type TestContext,
} from '../support/test-app.js';

export const ADMIN = { username: 'admin', password: 'Qa-Admin-Pass-2026-river' };
export const STUDENT_PASSWORD = 'River-Lantern-Morning-48';
export const V1 = '/api/v1';
export const ADMIN_V1 = `${V1}/admin`;
export const SHEET_A = TERM_FIXTURE_SPREADSHEET_ID;
export const SHEET_B = '1QaReplacementSheetB00000000000000000000';
export const sheetUrl = (id: string) => `https://docs.google.com/spreadsheets/d/${id}/edit`;

export interface Column {
  columnIndex: number;
  headerLabel: string;
  role: string;
  proposedName: string | null;
  proposedWeight: string | null;
}
export interface Tab {
  id: string;
  tabName: string;
  status: string;
  columns: Column[];
  carriedFrom?: { subject: string; headersMatch: boolean } | null;
}

export type Api = ReturnType<typeof api>;

export const ACADEMIC_TABLES = [
  'students',
  'courses',
  'course_offerings',
  'assessment_criteria',
  'grading_schemes',
  'grading_scheme_items',
  'enrollments',
  'assessment_scores',
  'assessment_score_revisions',
] as const;

export interface Harness {
  ctx: TestContext;
  reader: InMemorySheetsReader;
  admin: Api;
  session: LoggedIn;
  generationId: string;
  termId: string;
  terms: Record<number, string>;
  /** Fresh database, one admin, GEN2027 with its five terms. */
  reset(): Promise<void>;
  close(): Promise<void>;
  /** Connects a sheet to term 1, confirms every tab and syncs it. */
  importSheet(id?: string, options?: { release?: boolean }): Promise<string>;
  sync(sourceId: string): Promise<SyncJobBody>;
  runJob(jobId: string): Promise<unknown>;
  /** Issues a temporary password, signs in and replaces it. */
  activate(studentCode: string): Promise<Api>;
  counts(): Promise<Record<string, number>>;
  /** Digest of every row of the score-bearing tables. Any change at all changes it. */
  digest(): Promise<Record<string, string>>;
  review(sourceId: string): Promise<Tab[]>;
  previewAndConfirm(sourceId: string): Promise<{ id: string }>;
}

export interface SyncJobBody {
  id: string;
  status: string;
  failureCode: string | null;
  counts: {
    students: Record<string, number>;
    enrollments: Record<string, number>;
    scores: Record<string, number>;
  };
  errorCount: number;
  warningCount: number;
}

export async function createHarness(options: TestAppOptions = {}): Promise<Harness> {
  const reader = (options.sheetsReader as InMemorySheetsReader) ?? new InMemorySheetsReader();
  const ctx = await createTestApp({ ...options, sheetsReader: reader });

  const h: Harness = {
    ctx,
    reader,
    admin: undefined as unknown as Api,
    session: undefined as unknown as LoggedIn,
    generationId: '',
    termId: '',
    terms: {},
    close: () => ctx.close(),

    async reset() {
      await resetState(ctx);
      reader.clearCalls();
      reader.set(SHEET_A, termWorkbookFixture());
      await seedUser(ctx, { ...ADMIN, role: 'ADMIN' });
      h.session = await login(ctx, ADMIN.username, ADMIN.password);
      h.admin = api(h.session);
      h.generationId = (
        await h.admin
          .post(`${ADMIN_V1}/generations`, {
            code: 'GEN2027',
            name: 'Generation 2027',
            startDate: '2026-11-02',
          })
          .expect(201)
      ).body.id;
      const terms = await h.admin
        .get(`${ADMIN_V1}/generations/${h.generationId}/terms`)
        .expect(200);
      h.terms = Object.fromEntries(
        (terms.body as { id: string; number: number }[]).map((t) => [t.number, t.id]),
      );
      h.termId = h.terms[1]!;
    },

    runJob: (jobId) =>
      runSourceSync({ prisma: ctx.prisma, reader }, jobId, { attempt: 1, maxAttempts: 1 }),

    async sync(sourceId) {
      const { jobId } = (
        await h.admin.post(`${ADMIN_V1}/sync`, { scope: 'SOURCE', sourceId }).expect(202)
      ).body;
      await h.runJob(jobId);
      return (await h.admin.get(`${ADMIN_V1}/sync/${jobId}`).expect(200)).body as SyncJobBody;
    },

    async importSheet(id = SHEET_A, { release = true } = {}) {
      const source = (
        await h.admin
          .post(`${ADMIN_V1}/terms/${h.termId}/sources`, { url: sheetUrl(id), label: 'Sheet A' })
          .expect(201)
      ).body as { id: string };
      await confirmAllTabs(ctx.prisma, reader, source.id);
      await h.sync(source.id);
      if (release) {
        await h.admin.post(`${ADMIN_V1}/terms/${h.termId}/release`, { visible: true }).expect(200);
      }
      return source.id;
    },

    async activate(studentCode) {
      const row = await ctx.prisma.student.findUniqueOrThrow({ where: { studentCode } });
      const issued = await h.admin
        .post(`${ADMIN_V1}/students/${row.id}/reset-password`)
        .expect(200);
      const student = api(await login(ctx, studentCode, issued.body.temporaryPassword));
      await student
        .post(`${V1}/auth/change-password`, {
          currentPassword: issued.body.temporaryPassword,
          newPassword: STUDENT_PASSWORD,
        })
        .expect(204);
      return student;
    },

    async counts() {
      const out: Record<string, number> = {};
      for (const table of ACADEMIC_TABLES) {
        const [row] = await ctx.prisma.$queryRawUnsafe<{ n: bigint }[]>(
          `SELECT count(*) AS n FROM ${table}`,
        );
        out[table] = Number(row!.n);
      }
      return out;
    },

    async digest() {
      const out: Record<string, string> = {};
      for (const table of ACADEMIC_TABLES) {
        const rows = await ctx.prisma.$queryRawUnsafe<{ t: string }[]>(
          `SELECT t::text AS t FROM ${table} t ORDER BY t::text`,
        );
        out[table] = createHash('sha256')
          .update(rows.map((r) => r.t).join('\n'))
          .digest('hex');
      }
      return out;
    },

    async review(sourceId) {
      await h.admin.post(`${ADMIN_V1}/sources/${sourceId}/detect`).expect(200);
      const tabs = (await h.admin.get(`${ADMIN_V1}/sources/${sourceId}/mappings`).expect(200))
        .body as Tab[];
      for (const tab of tabs) {
        await h.admin
          .post(`${ADMIN_V1}/sources/${sourceId}/mappings/${tab.id}/confirm`, confirmBody(tab))
          .expect(200);
      }
      return tabs;
    },

    async previewAndConfirm(sourceId) {
      const preview = (await h.admin.post(`${ADMIN_V1}/sources/${sourceId}/preview`).expect(201))
        .body as { id: string };
      await h.admin
        .post(`${ADMIN_V1}/sources/${sourceId}/preview/${preview.id}/confirm`)
        .expect(200);
      return preview;
    },
  };
  return h;
}

export function confirmBody(tab: Tab, subjectName?: string, weights: Record<string, string> = {}) {
  return {
    subjectName: subjectName ?? tab.carriedFrom?.subject ?? tab.tabName,
    columns: tab.columns.map((c) => ({
      columnIndex: c.columnIndex,
      role: c.role,
      ...(c.role === 'CRITERION'
        ? {
            name: c.proposedName ?? c.headerLabel,
            weight: weights[c.headerLabel] ?? c.proposedWeight ?? undefined,
          }
        : {}),
    })),
  };
}

/** A copy of the fixture with its rows edited by `edit`. */
export function editedFixture(edit: (sheet: FakeSpreadsheet) => void): FakeSpreadsheet {
  const sheet = termWorkbookFixture();
  edit(sheet);
  return sheet;
}

/** All routes of the running app, from Express itself, so a new route cannot be forgotten. */
export function liveRoutes(ctx: TestContext): { method: string; path: string }[] {
  const express = ctx.app.getHttpAdapter().getInstance() as {
    router: {
      stack: { route?: { path: string; methods: Record<string, boolean> } }[];
    };
  };
  const out: { method: string; path: string }[] = [];
  for (const layer of express.router.stack) {
    if (!layer.route) continue;
    for (const method of Object.keys(layer.route.methods)) {
      if (method === '_all') continue;
      out.push({ method, path: layer.route.path });
    }
  }
  return out.filter(
    (r) =>
      !r.path.includes('/test/') && !r.path.startsWith('/api/docs') && !r.path.includes('splat'),
  );
}

export const fillPath = (path: string, id = '00000000-0000-7000-8000-000000000000') =>
  path.replace(/:[A-Za-z]+/g, id);

export function call(
  agent: request.Agent | ReturnType<typeof request>,
  method: string,
  path: string,
) {
  return (agent as unknown as Record<string, (p: string) => request.Test>)[method]!(path);
}
