/* eslint-disable -- QA suite: uses expect messages, console evidence and supertest .expect() */
import { createHash } from 'node:crypto';
import type { PrismaClient } from '@ssrs/database';
import {
  InMemorySheetsReader,
  LOGIC_COMMENT,
  PROGRAM_T1_ONLY,
  PROGRAM_WEP_STUDENTS,
  programStudentCode as code,
  programTerm1Workbook,
  programTerm2Workbook,
  termMetaTab,
  termWorkbookFixture,
  type FakeSpreadsheet,
} from '@ssrs/sheets/testing';
import { runSourceSync } from '@ssrs/sync';
import { confirmAllTabs } from '@ssrs/sync/testing';
// The worker's processor is loaded at run time (it lives outside this package's rootDir).
const WORKER_PROCESSOR = new URL('../../../worker/src/sync/sync.processor.ts', import.meta.url).href;
import request from 'supertest';
import { api, insertSession, login, seedUser, WEB_ORIGIN } from '../support/test-app.js';
import {
  ADMIN,
  ADMIN_V1,
  confirmBody,
  createHarness,
  SHEET_A,
  sheetUrl,
  STUDENT_PASSWORD,
  V1,
  type Harness,
  type Tab,
} from './support.js';

/**
 * QA, 2026-11-14: sheet replacement deletes the term's data, roster check against earlier terms,
 * same ID with another name, IDs of another generation, edit name, passwords for new students.
 * Acceptance criteria 1–18 of the lead's task (brief R1–R7). Synthetic people only.
 */

const SHEET_B = '1QaReplaceSheetB0000000000000000000000000';
const SHEET_T1B = '1QaReplaceTermOneB000000000000000000000000';
const SHEET_T2 = '1QaReplaceTermTwo0000000000000000000000000';
const SHEET_T2B = '1QaReplaceTermTwoB000000000000000000000000';
const SHEET_T3 = '1QaReplaceTermThree00000000000000000000000';
const PROGRAM_T1 = '1QaReplaceProgramTermOne000000000000000000';
const PROFILE = ['STUDENT ID', 'FIRST NAME', 'LAST NAME', 'GENDER', 'CLASS'];

type Grid = FakeSpreadsheet['tabs'][string];

// ---------------------------------------------------------------------------------------------
// Row-level digest of one term: every row of every table that holds the term's data.

const TERM_TABLES: Record<string, string> = {
  student_terms: `SELECT t::text AS t FROM student_terms t WHERE t.term_id = $1::uuid`,
  student_term_issues: `SELECT t::text AS t FROM student_term_issues t WHERE t.term_id = $1::uuid`,
  course_offerings: `SELECT t::text AS t FROM course_offerings t WHERE t.term_id = $1::uuid`,
  offering_programs: `SELECT t::text AS t FROM offering_programs t JOIN course_offerings o ON o.id = t.offering_id WHERE o.term_id = $1::uuid`,
  assessment_criteria: `SELECT t::text AS t FROM assessment_criteria t JOIN course_offerings o ON o.id = t.offering_id WHERE o.term_id = $1::uuid`,
  grading_schemes: `SELECT t::text AS t FROM grading_schemes t JOIN course_offerings o ON o.id = t.offering_id WHERE o.term_id = $1::uuid`,
  grading_scheme_items: `SELECT t::text AS t FROM grading_scheme_items t JOIN course_offerings o ON o.id = t.offering_id WHERE o.term_id = $1::uuid`,
  enrollments: `SELECT t::text AS t FROM enrollments t JOIN course_offerings o ON o.id = t.offering_id WHERE o.term_id = $1::uuid`,
  assessment_scores: `SELECT t::text AS t FROM assessment_scores t JOIN course_offerings o ON o.id = t.offering_id WHERE o.term_id = $1::uuid`,
  assessment_score_revisions: `SELECT t::text AS t FROM assessment_score_revisions t JOIN assessment_scores s ON s.id = t.score_id JOIN course_offerings o ON o.id = s.offering_id WHERE o.term_id = $1::uuid`,
};

async function termDigest(prisma: PrismaClient, termId: string) {
  const out: Record<string, string> = {};
  for (const [table, sql] of Object.entries(TERM_TABLES)) {
    const rows = await prisma.$queryRawUnsafe<{ t: string }[]>(`${sql} ORDER BY 1`, termId);
    out[table] = `${rows.length}:${createHash('sha256')
      .update(rows.map((r) => r.t).join('\n'))
      .digest('hex')
      .slice(0, 16)}`;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Sheet editing helpers (header-driven, so they work on every fixture layout).

const pad3 = (i: number) => String(i).padStart(3, '0');
const headerRow = (grid: Grid) => grid.findIndex((r) => r.includes('STUDENT ID'));

function dropStudent(sheet: FakeSpreadsheet, i: number) {
  for (const [name, grid] of Object.entries(sheet.tabs)) {
    if (name === '_meta') continue;
    sheet.tabs[name] = grid.filter((r) => !r.includes(code(i)));
  }
}

/** Adds student `i` (new, synthetic name FNiii/LNiii) everywhere student `like` is listed. */
function addStudent(sheet: FakeSpreadsheet, i: number, like: number) {
  for (const [name, grid] of Object.entries(sheet.tabs)) {
    if (name === '_meta') continue;
    const h = headerRow(grid);
    if (h < 0) continue;
    const header = grid[h]!.map((c) => (typeof c === 'string' ? c.trim() : c));
    const src = grid.find((r) => r.includes(code(like)));
    if (!src) continue;
    const row = [...src];
    const set = (label: string, value: string) => {
      const at = header.indexOf(label);
      if (at >= 0) row[at] = value;
    };
    set('STUDENT ID', code(i));
    set('FIRST NAME', `FN${pad3(i)}`);
    set('LAST NAME', `LN${pad3(i)}`);
    set('FULL NAME', `FN${pad3(i)} LN${pad3(i)}`);
    set('FULL NAME 2', `LN${pad3(i)} FN${pad3(i)}`);
    set('KH LAST NAME', `KL${pad3(i)}`);
    set('KH FIRST NAME', `KF${pad3(i)}`);
    grid.push(row);
  }
}

/** The Term 2 program workbook without Web Design (its rows carry other students' names). */
function term2Sheet(term = 2) {
  const sheet = programTerm2Workbook();
  delete (sheet.tabs as Record<string, unknown>)['Web Design'];
  sheet.tabs['_meta'] = termMetaTab('GEN2027', term);
  return sheet;
}

/** The Term 1 program workbook with its one bad ENG row fixed (zero errors, for a replacement). */
function term1Clean() {
  const sheet = programTerm1Workbook();
  const eng = sheet.tabs['ENG']!;
  const row = eng.find((r) => r[0] === code(10))!;
  row[1] = 'FN010';
  row[2] = 'LN010';
  return sheet;
}

/** Changes the first mark of `student` in `tab` (first numeric cell after the profile). */
function bumpMark(sheet: FakeSpreadsheet, tab: string, student: number, value: number) {
  const row = sheet.tabs[tab]!.find((r) => r.includes(code(student)))!;
  const at = row.findIndex((c, k) => k >= 5 && typeof c === 'number');
  row[at] = value;
}

// ---------------------------------------------------------------------------------------------

describe('QA replacement and roster checks (2026-11-14)', () => {
  let h: Harness;
  let prisma: PrismaClient;
  let reader: InMemorySheetsReader;
  let adminId: string;

  beforeAll(async () => {
    h = await createHarness();
    prisma = h.ctx.prisma;
    reader = h.reader;
  }, 120_000);
  afterAll(async () => h.close());

  const admin = () => h.admin;

  async function connect(termNumber: number, spreadsheetId: string, sheet: FakeSpreadsheet) {
    reader.set(spreadsheetId, sheet);
    const id = (
      await admin()
        .post(`${ADMIN_V1}/terms/${h.terms[termNumber]}/sources`, {
          url: sheetUrl(spreadsheetId),
          label: `T${termNumber}`,
        })
        .expect(201)
    ).body.id as string;
    await confirmAllTabs(prisma, reader, id);
    return id;
  }

  /** Change sheet → detect → confirm every tab, carrying subject and audience over. */
  async function pending(
    termNumber: number,
    spreadsheetId: string,
    sheet: FakeSpreadsheet,
    from: string,
  ) {
    reader.set(spreadsheetId, sheet);
    const id = (
      await admin()
        .post(`${ADMIN_V1}/terms/${h.terms[termNumber]}/sources/change`, {
          url: sheetUrl(spreadsheetId),
          label: `T${termNumber} replacement`,
        })
        .expect(201)
    ).body.id as string;
    await admin().post(`${ADMIN_V1}/sources/${id}/detect`).expect(200);
    const tabs = (await admin().get(`${ADMIN_V1}/sources/${id}/mappings`).expect(200))
      .body as Tab[];
    const old = await prisma.sheetTabMapping.findMany({
      where: { sourceId: from },
      include: { audienceProgram: true },
    });
    for (const tab of tabs) {
      const prev = old.find((o) => o.tabName === tab.tabName);
      const audience =
        prev?.audience === 'PROGRAM'
          ? prev.audienceProgram?.code
          : prev?.audience === 'SHARED'
            ? 'SHARED'
            : undefined;
      await admin()
        .post(`${ADMIN_V1}/sources/${id}/mappings/${tab.id}/confirm`, {
          ...confirmBody(tab),
          ...(audience ? { audience } : {}),
        })
        .expect(200);
    }
    return id;
  }

  const preview = async (sourceId: string) =>
    (await admin().post(`${ADMIN_V1}/sources/${sourceId}/preview`).expect(201)).body as {
      id: string;
      summary: any;
    };

  const confirmUrl = (sourceId: string, previewId: string) =>
    `${ADMIN_V1}/sources/${sourceId}/preview/${previewId}/confirm`;

  async function startJob(sourceId: string, previewId?: string) {
    return (
      await admin()
        .post(`${ADMIN_V1}/sync`, {
          scope: 'SOURCE',
          sourceId,
          ...(previewId ? { previewId } : {}),
        })
        .expect(202)
    ).body.jobId as string;
  }

  const jobBody = async (jobId: string) =>
    (await admin().get(`${ADMIN_V1}/sync/${jobId}`).expect(200)).body;
  const jobErrors = async (jobId: string) =>
    (await admin().get(`${ADMIN_V1}/sync/${jobId}/errors?pageSize=100`).expect(200)).body.data as {
      code: string;
      severity: string;
      studentCode: string | null;
      message: string;
    }[];

  async function syncSource(sourceId: string, previewId?: string) {
    const jobId = await startJob(sourceId, previewId);
    await h.runJob(jobId);
    return jobBody(jobId);
  }

  /** Runs the job the way the worker does (SyncProcessor, including the Redis denylist). */
  async function runInWorker(jobId: string) {
    const { SyncProcessor } = (await import(/* @vite-ignore */ WORKER_PROCESSOR)) as {
      SyncProcessor: new (...args: unknown[]) => { process(job: unknown): Promise<string> };
    };
    const processor = new SyncProcessor(
      { ACCESS_TOKEN_TTL_SECONDS: 900 } as never,
      reader,
      { client: prisma } as never,
    );
    (processor as unknown as { connection: unknown }).connection = h.ctx.redis;
    return processor.process({
      data: { syncJobId: jobId },
      attemptsMade: 0,
      opts: { attempts: 1 },
    } as never);
  }

  const everything = async () => ({
    digest: await h.digest(),
    users: await prisma.user.count(),
    sessions: await prisma.authSession.count(),
    studentTerms: await prisma.studentTerm.count(),
    issues: await prisma.studentTermIssue.count(),
    offerings: await prisma.courseOffering.count(),
  });

  const clearRateLimits = async () => {
    const keys = await h.ctx.redis.keys('ssrs:v1:rl:*');
    if (keys.length) await h.ctx.redis.del(...keys);
  };

  // ===========================================================================================
  describe('Scenario 1: a wrong Term 1 sheet replaced by another', () => {
    let sourceA: string;

    /** Sheet B: Logic kept (same headers), Physics added, ENG/PL/BCU/MsOffice gone, 003 gone, 004 new. */
    function sheetB(): FakeSpreadsheet {
      const a = termWorkbookFixture();
      const roster = [
        ['PNC2027-001', 'DARA', 'SOK', 'M', 'A'],
        ['PNC2027-002', 'BOPHA', 'CHAN', 'F', 'A'],
        ['PNC2027-004', 'FNQA', 'LNQA', 'F', 'B'],
      ];
      const logicHeader = a.tabs['Logic']![0]!;
      return {
        title: 'Sheet B',
        tabs: {
          _meta: a.tabs['_meta']!,
          ALL: [PROFILE, ...roster],
          Logic: [
            logicHeader,
            [...roster[0]!, 11, 12, 13, 14, 15, 16, null, 'Comment from sheet B'],
            [...roster[1]!, 21, 22, 23, 24, 25, 26],
            [...roster[2]!, 31, 32, 33, 34, 35, 36],
          ],
          Physics: [
            [...PROFILE, 'Quiz 50%', 'Exam 50%'],
            ...roster.map((r, k) => [...r, 40 + k, 50 + k]),
          ],
        },
      };
    }

    beforeEach(async () => {
      await h.reset();
      adminId = (await prisma.user.findUniqueOrThrow({ where: { username: ADMIN.username } })).id;
      sourceA = await h.importSheet(SHEET_A);
      // History in A: a second sync with one changed mark.
      const a2 = termWorkbookFixture();
      a2.tabs['Logic']![1]![5] = 91;
      reader.set(SHEET_A, a2);
      expect((await syncSource(sourceA)).status).toBe('SUCCEEDED');
    }, 60_000);

    it('#1 #5 #8 term holds only B; A data gone; preview counts are exact; one audit entry', async () => {
      const t1 = h.terms[1]!;
      const before = {
        scores: await prisma.assessmentScore.count({ where: { enrollment: { offering: { termId: t1 } } } }),
        revisions: await prisma.assessmentScoreRevision.count({
          where: { score: { enrollment: { offering: { termId: t1 } } } },
        }),
        comments: await prisma.enrollment.count({
          where: { offering: { termId: t1 }, teacherComment: { not: null } },
        }),
        enrollments: await prisma.enrollment.count({ where: { offering: { termId: t1 } } }),
        termEnrollments: await prisma.studentTerm.count({ where: { termId: t1 } }),
      };
      expect(before.revisions).toBeGreaterThan(before.scores); // history exists
      expect(before.comments).toBeGreaterThan(0);
      const s3 = await prisma.student.findUniqueOrThrow({ where: { studentCode: 'PNC2027-003' } });
      const s3Audit = await prisma.auditLog.count({
        where: { OR: [{ entityId: s3.id }, { actorUserId: s3.userId }] },
      });
      expect(s3Audit).toBeGreaterThan(0);

      const id = await pending(1, SHEET_B, sheetB(), sourceA);
      const p = await preview(id);
      const r = p.summary.replacement;
      expect(r.termLabel).toBe('GEN2027 Term 1');
      expect(r.oldSourceId).toBe(sourceA);
      expect(r.subjects.kept).toEqual(['Logic']);
      expect(r.subjects.added).toEqual(['Physics']);
      expect(r.subjects.deleted.map((d: { subject: string }) => d.subject).toSorted()).toEqual([
        'BCU',
        'ENG',
        'MsOffice',
        'PL',
      ]);
      expect(r.students.kept).toBe(2);
      expect(r.students.added).toBe(1);
      expect(r.students.accountsDeleted.map((s: { studentCode: string }) => s.studentCode)).toEqual(
        ['PNC2027-003'],
      );
      expect(r.students.dataRemoved).toEqual([]);
      // RP10: no account here was ever used or renamed, so none is protected.
      expect(r.students.accountsProtected).toEqual([]);
      expect(r.counts).toEqual({
        subjects: 4,
        scoreRows: before.scores,
        scoreHistoryRows: before.revisions,
        comments: before.comments,
        enrollments: before.enrollments,
        termEnrollments: before.termEnrollments,
        accounts: 1,
        accountsProtected: 0,
      });
      expect(typeof r.manifestHash).toBe('string');
      expect(p.summary.rosterCheck).toBeNull();

      // Typed label: missing, wrong case, wrong term, the tick → 422; nothing confirmed.
      for (const body of [
        {},
        { acknowledgeRemovals: true },
        { confirmTermLabel: 'gen2027 term 1' },
        { confirmTermLabel: 'GEN2027 Term 2' },
        { confirmTermLabel: '' },
      ]) {
        const res = await admin().post(confirmUrl(id, p.id), body).expect(422);
        expect(res.body.error.code).toBe('TERM_LABEL_MISMATCH');
      }
      expect(
        (await prisma.sheetPreview.findUniqueOrThrow({ where: { id: p.id } })).confirmedAt,
      ).toBeNull();
      await admin()
        .post(confirmUrl(id, p.id), { confirmTermLabel: 'GEN2027 Term 1' })
        .expect(200);

      const jobId = await startJob(id);
      await h.runJob(jobId);
      const job = await jobBody(jobId);
      expect(job.status).toBe('SUCCEEDED');
      expect(job.counts.replacement).toEqual(r.counts);

      // Term 1 = sheet B exactly.
      const offerings = await prisma.courseOffering.findMany({ where: { termId: t1 } });
      expect(offerings.map((o) => o.title).toSorted()).toEqual(['Logic', 'Physics']);
      const enrolled = await prisma.enrollment.findMany({
        where: { offering: { termId: t1 } },
        include: { student: true },
      });
      expect([...new Set(enrolled.map((e) => e.student.studentCode))].toSorted()).toEqual([
        'PNC2027-001',
        'PNC2027-002',
        'PNC2027-004',
      ]);
      expect(enrolled.length).toBe(6);
      const scores = await prisma.assessmentScore.findMany({
        where: { enrollment: { offering: { termId: t1 } } },
      });
      expect(scores.length).toBe(18 + 6);
      const revisions = await prisma.assessmentScoreRevision.findMany({
        where: { score: { enrollment: { offering: { termId: t1 } } } },
      });
      // History starts from B: one [null → mark] row per score, none from A.
      expect(revisions.length).toBe(scores.length);
      expect(revisions.every((rv) => rv.oldMark === null)).toBe(true);
      const comments = enrolled.map((e) => e.teacherComment).filter((c) => c !== null);
      expect(comments).toEqual(['Comment from sheet B']);
      expect(
        await prisma.enrollment.count({
          where: { teacherComment: { in: [LOGIC_COMMENT, 'Works well in a team.'] } },
        }),
      ).toBe(0);
      // No orphaned A rows anywhere (whole DB, not only via Term 1).
      expect(await prisma.assessmentScore.count()).toBe(scores.length);
      expect(await prisma.assessmentScoreRevision.count()).toBe(revisions.length);

      // Audit: one source.promoted, counts only.
      const promoted = await prisma.auditLog.findMany({ where: { action: 'source.promoted' } });
      expect(promoted).toHaveLength(1);
      expect(promoted[0]).toMatchObject({ actorType: 'USER', actorUserId: adminId });
      expect(promoted[0]!.metadata).toMatchObject({
        syncJobId: jobId,
        termId: t1,
        oldSourceId: sourceA,
        newSourceId: id,
        oldSpreadsheetId: SHEET_A,
        newSpreadsheetId: SHEET_B,
        deleted: r.counts,
      });
      const text = JSON.stringify(promoted[0]!.metadata);
      expect(text).not.toMatch(/PNC2027-|DARA|SOK|BOPHA|CHAN|RITHY|KEO|FNQA/);
      expect(await prisma.auditLog.count({ where: { action: 'subject.archived' } })).toBe(0);
      // Older audit rows of the deleted student remain.
      expect(
        await prisma.auditLog.count({
          where: { OR: [{ entityId: s3.id }, { actorUserId: s3.userId }] },
        }),
      ).toBe(s3Audit);
    });

    it('#2 RP10: an account that signed in is kept when B drops it; only its Term 1 data goes', async () => {
      const s = await h.activate('PNC2027-003');
      await s.get(`${V1}/student/me/results`).expect(200);
      const row = await prisma.student.findUniqueOrThrow({ where: { studentCode: 'PNC2027-003' } });

      const id = await pending(1, SHEET_B, sheetB(), sourceA);
      const p = await preview(id);
      const r = p.summary.replacement;
      expect(r.students.accountsDeleted).toEqual([]);
      expect(
        r.students.accountsProtected.map((x: { studentCode: string; reason: string }) => [
          x.studentCode,
          x.reason,
        ]),
      ).toEqual([['PNC2027-003', 'LOGGED_IN']]);
      expect(r.counts.accounts).toBe(0);
      expect(r.counts.accountsProtected).toBe(1);
      await admin().post(confirmUrl(id, p.id), { confirmTermLabel: r.termLabel }).expect(200);
      const jobId = await startJob(id);
      expect(await runInWorker(jobId)).toBe('SUCCEEDED');

      // The account, its user row and its session stay; the session still works.
      expect(await prisma.student.count({ where: { id: row.id } })).toBe(1);
      expect(await prisma.user.count({ where: { id: row.userId } })).toBe(1);
      await s.get(`${V1}/auth/me`).expect(200);
      // Only this term's data is gone.
      const t1 = h.terms[1]!;
      expect(
        await prisma.enrollment.count({ where: { studentId: row.id, offering: { termId: t1 } } }),
      ).toBe(0);
      expect(await prisma.studentTerm.count({ where: { studentId: row.id, termId: t1 } })).toBe(0);
    });

    it('#2b an account never used is deleted; a session it holds is revoked and denylisted', async () => {
      // A PENDING account cannot sign in, so a deletable account has no session in practice. A
      // session is inserted directly to prove the replacement still ends one (defence in depth).
      const row = await prisma.student.findUniqueOrThrow({
        where: { studentCode: 'PNC2027-003' },
        include: { user: true },
      });
      expect(row.user.status).toBe('PENDING');
      const s = api(await insertSession(h.ctx, row.userId));
      const sessionIds = (
        await prisma.authSession.findMany({ where: { userId: row.userId, revokedAt: null } })
      ).map((x) => x.id);
      expect(sessionIds.length).toBe(1);

      const id = await pending(1, SHEET_B, sheetB(), sourceA);
      const p = await preview(id);
      expect(
        p.summary.replacement.students.accountsDeleted.map(
          (x: { studentCode: string }) => x.studentCode,
        ),
      ).toEqual(['PNC2027-003']);
      await admin()
        .post(confirmUrl(id, p.id), { confirmTermLabel: p.summary.replacement.termLabel })
        .expect(200);
      const jobId = await startJob(id);
      expect(await runInWorker(jobId)).toBe('SUCCEEDED');

      expect(await prisma.student.count({ where: { id: row.id } })).toBe(0);
      expect(await prisma.user.count({ where: { id: row.userId } })).toBe(0);
      expect(await prisma.authSession.count({ where: { userId: row.userId } })).toBe(0);
      expect(await prisma.refreshToken.count({ where: { sessionId: { in: sessionIds } } })).toBe(0);
      for (const sid of sessionIds) {
        expect(await h.ctx.redis.get(`ssrs:v1:auth:revoked:${sid}`)).toBe('ACCOUNT_DELETED');
        expect(await h.ctx.redis.ttl(`ssrs:v1:auth:revoked:${sid}`)).toBeGreaterThan(900);
      }
      // The saved tokens are refused.
      await s.get(`${V1}/auth/me`).expect(401);
      await s.post(`${V1}/auth/refresh`).expect(401);
      // No account to sign in to.
      await clearRateLimits();
      const relogin = await request(h.ctx.app.getHttpServer())
        .post(`${V1}/auth/login`)
        .set('Origin', WEB_ORIGIN)
        .send({ identifier: 'PNC2027-003', password: STUDENT_PASSWORD });
      expect(relogin.status).toBe(401);
    });

    it('#6 a failed, cancelled or unreadable replacement deletes nothing', async () => {
      const id = await pending(1, SHEET_B, sheetB(), sourceA);
      const confirm = async () => {
        const p = await preview(id);
        await admin()
          .post(confirmUrl(id, p.id), { confirmTermLabel: p.summary.replacement.termLabel })
          .expect(200);
      };
      const before = await everything();
      expect(await prisma.student.count({ where: { studentCode: 'PNC2027-003' } })).toBe(1);

      // 1) A save fails mid-transaction (after the deletes ran).
      await confirm();
      let jobId = await startJob(id);
      await runSourceSync(
        {
          prisma,
          reader,
          hooks: {
            beforeCourseCommit: (key: string) => {
              if (key.includes('PHYSICS')) throw new Error('simulated failure');
            },
          },
        },
        jobId,
        { attempt: 1, maxAttempts: 1 },
      );
      expect(await jobBody(jobId)).toMatchObject({ status: 'FAILED' });
      expect(await everything()).toEqual(before);

      // 2) Cancelled before the worker picked it up.
      await confirm();
      jobId = await startJob(id);
      await prisma.syncJob.update({
        where: { id: jobId },
        data: { status: 'CANCELLED', finishedAt: new Date() },
      });
      await h.runJob(jobId);
      expect(await everything()).toEqual(before);

      // 3) The sheet cannot be read.
      await confirm();
      jobId = await startJob(id);
      reader.fail(SHEET_B, 'SHEET_NOT_SHARED');
      await h.runJob(jobId);
      expect((await jobBody(jobId)).status).toBe('FAILED');
      expect(await everything()).toEqual(before);
      expect(await prisma.student.count({ where: { studentCode: 'PNC2027-003' } })).toBe(1);
      expect(
        (await prisma.googleSheetSource.findUniqueOrThrow({ where: { id: sourceA } })).status,
      ).toBe('ACTIVE');
    });

    it('#5 data changed after the preview: REPLACEMENT_CHANGED and nothing written', async () => {
      const id = await pending(1, SHEET_B, sheetB(), sourceA);
      const p = await preview(id);
      await admin()
        .post(confirmUrl(id, p.id), { confirmTermLabel: p.summary.replacement.termLabel })
        .expect(200);
      // A new score revision for A after the preview: the deletion set grows.
      const a3 = termWorkbookFixture();
      a3.tabs['Logic']![1]![5] = 92;
      reader.set(SHEET_A, a3);
      // The active sheet cannot sync while... (it can: only one job at a time). Sync it now.
      const activeJob = await startJob(sourceA);
      await h.runJob(activeJob);
      const before = await everything();
      // The active sync invalidates previews; a confirmed preview from before is refused, or the
      // job fails REPLACEMENT_CHANGED. Either way nothing is deleted.
      const res = await admin().post(`${ADMIN_V1}/sync`, { scope: 'SOURCE', sourceId: id });
      if (res.status === 202) {
        await h.runJob(res.body.jobId);
        expect((await jobBody(res.body.jobId)).failureCode).toBe('REPLACEMENT_CHANGED');
      } else {
        expect(res.status).toBe(422);
        expect(res.body.error.code).toBe('PREVIEW_REQUIRED');
      }
      expect(await everything()).toEqual(before);

      // Direct change under a confirmed preview: an extra comment on an A enrollment.
      const p2 = await preview(id);
      await admin()
        .post(confirmUrl(id, p2.id), { confirmTermLabel: p2.summary.replacement.termLabel })
        .expect(200);
      const e = await prisma.enrollment.findFirstOrThrow({ where: { teacherComment: null } });
      await prisma.enrollment.update({
        where: { id: e.id },
        data: { teacherComment: 'added after the preview' },
      });
      const before2 = await everything();
      const jobId = await startJob(id);
      await h.runJob(jobId);
      const job = await jobBody(jobId);
      expect(job).toMatchObject({ status: 'FAILED', failureCode: 'REPLACEMENT_CHANGED' });
      expect(await everything()).toEqual(before2);
    });

    it('#5b the confirm route refuses students, bad ids, long labels and another source preview', async () => {
      const id = await pending(1, SHEET_B, sheetB(), sourceA);
      const p = await preview(id);
      const label = p.summary.replacement.termLabel as string;
      const student = await h.activate('PNC2027-001');
      await student.post(confirmUrl(id, p.id), { confirmTermLabel: label }).expect(403);
      await student.post(`${ADMIN_V1}/sources/${id}/preview`).expect(403);
      await admin()
        .post(confirmUrl(id, p.id), { confirmTermLabel: 'x'.repeat(101) })
        .expect(400);
      await admin().post(confirmUrl(id, 'not-a-uuid'), { confirmTermLabel: label }).expect(400);
      const other = await preview(sourceA);
      const cross = await admin().post(confirmUrl(id, other.id), { confirmTermLabel: label });
      expect([404, 409, 422]).toContain(cross.status);
      expect(
        (await prisma.sheetPreview.findUniqueOrThrow({ where: { id: p.id } })).confirmedAt,
      ).toBeNull();
      // A student never sees replacement data: their results only hold their own rows.
      const mine = JSON.stringify((await student.get(`${V1}/student/me/results`).expect(200)).body);
      expect(mine).not.toMatch(/PNC2027-00[234]/);
    });

    it('#7 re-syncing the SAME sheet keeps a missing student marks and account', async () => {
      const marks = await prisma.assessmentScore.count({
        where: { enrollment: { student: { studentCode: 'PNC2027-003' } } },
      });
      expect(marks).toBeGreaterThan(0);
      const a = termWorkbookFixture();
      for (const [name, grid] of Object.entries(a.tabs)) {
        if (name !== '_meta') a.tabs[name] = grid.filter((row) => row[0] !== 'PNC2027-003');
      }
      reader.set(SHEET_A, a);
      const p = await preview(sourceA);
      expect(p.summary.replacement).toBeNull();
      const job = await syncSource(sourceA);
      expect(job.status).toBe('SUCCEEDED');
      expect(
        await prisma.assessmentScore.count({
          where: { enrollment: { student: { studentCode: 'PNC2027-003' } } },
        }),
      ).toBe(marks);
      expect(await prisma.student.count({ where: { studentCode: 'PNC2027-003' } })).toBe(1);
    });

    it('#13 same ID with another name: skipped with both names; others import; swapped = warning', async () => {
      const a = termWorkbookFixture();
      a.tabs['ALL']![4]![2] = 'OTHERLAST'; // PNC2027-002 renamed in ALL
      a.tabs['Logic']![2]![5] = 33; // 002's mark: must not import
      a.tabs['Logic']![1]![5] = 44; // 001's mark: imports
      const row3 = a.tabs['ALL']![5]!; // 003: first/last swapped
      [row3[1], row3[2]] = [row3[2]!, row3[1]!];
      reader.set(SHEET_A, a);
      const p = await preview(sourceA);
      expect(p.summary.canConfirm).toBe(true);
      expect(p.summary.nameMismatches).toEqual([
        expect.objectContaining({
          studentCode: 'PNC2027-002',
          sheetTab: 'ALL',
          sheetName: expect.stringContaining('OTHERLAST'),
          systemName: expect.stringContaining('CHAN'),
        }),
      ]);
      expect(p.summary.nameOrderWarnings).toEqual([
        expect.objectContaining({ studentCode: 'PNC2027-003' }),
      ]);
      const before002 = await prisma.assessmentScore.findMany({
        where: { enrollment: { student: { studentCode: 'PNC2027-002' } } },
        orderBy: { id: 'asc' },
      });
      const jobId = await startJob(sourceA);
      await h.runJob(jobId);
      const job = await jobBody(jobId);
      expect(job.status).toBe('SUCCEEDED_WITH_ERRORS');
      const errors = await jobErrors(jobId);
      const mine = errors.filter((e) => e.studentCode === 'PNC2027-002');
      expect(mine.map((e) => `${e.severity} ${e.code}`)).toEqual(['ERROR STUDENT_NAME_MISMATCH']);
      expect(mine[0]!.message).toContain('OTHERLAST');
      expect(mine[0]!.message).toContain('CHAN');
      expect(errors).toContainEqual(
        expect.objectContaining({
          code: 'STUDENT_NAME_ORDER',
          severity: 'WARNING',
          studentCode: 'PNC2027-003',
        }),
      );
      expect(
        await prisma.assessmentScore.findMany({
          where: { enrollment: { student: { studentCode: 'PNC2027-002' } } },
          orderBy: { id: 'asc' },
        }),
      ).toEqual(before002);
      const s1 = await prisma.assessmentScore.findFirstOrThrow({
        where: {
          enrollment: { student: { studentCode: 'PNC2027-001' } },
          criterion: { key: 'QUIZ_1', offering: { title: 'Logic' } },
        },
      });
      expect(s1.mark.toString()).toBe('44');
      expect(
        await prisma.student.findUniqueOrThrow({ where: { studentCode: 'PNC2027-003' } }),
      ).toMatchObject({ firstName: 'RITHY', lastName: 'KEO' });
    });

    it('#14 IDs of another generation and admin usernames: conflict, nothing created, others import', async () => {
      const other = await prisma.generation.create({
        data: { code: 'GEN2030', name: 'Other', startDate: new Date('2030-01-07') },
      });
      const u = await prisma.user.create({
        data: { username: 'PNC2030-001', role: 'STUDENT', passwordHash: 'x' },
      });
      await prisma.student.create({
        data: {
          studentCode: 'PNC2030-001',
          userId: u.id,
          generationId: other.id,
          fullName: 'Other Generation',
        },
      });
      await seedUser(h.ctx, { username: 'PNC2027-050', password: ADMIN.password, role: 'ADMIN' });
      const a = termWorkbookFixture();
      for (const extra of [
        ['PNC2030-001', 'X', 'Y', 'M', 'A'],
        ['PNC2027-050', 'Z', 'W', 'F', 'A'],
      ]) {
        a.tabs['ALL']!.push(extra);
        a.tabs['PL']!.push([...extra, 50, 50, 50, 50]);
      }
      a.tabs['PL']![1]![5] = 72; // 001: imports
      reader.set(SHEET_A, a);
      const p = await preview(sourceA);
      expect(p.summary.canConfirm).toBe(true);
      expect(
        p.summary.studentConflicts
          .map((c: { studentCode: string; code: string }) => `${c.studentCode} ${c.code}`)
          .toSorted(),
      ).toEqual(
        expect.arrayContaining([
          'PNC2030-001 STUDENT_IN_OTHER_GENERATION',
          'PNC2027-050 STUDENT_ID_CONFLICT',
        ]),
      );
      const jobId = await startJob(sourceA);
      await h.runJob(jobId);
      const job = await jobBody(jobId);
      expect(job.status).toBe('SUCCEEDED_WITH_ERRORS');
      const errors = await jobErrors(jobId);
      expect(errors).toContainEqual(
        expect.objectContaining({ code: 'STUDENT_IN_OTHER_GENERATION', studentCode: 'PNC2030-001' }),
      );
      expect(errors).toContainEqual(
        expect.objectContaining({ code: 'STUDENT_ID_CONFLICT', studentCode: 'PNC2027-050' }),
      );
      expect(await prisma.student.count({ where: { studentCode: 'PNC2027-050' } })).toBe(0);
      expect(
        await prisma.student.findUniqueOrThrow({ where: { studentCode: 'PNC2030-001' } }),
      ).toMatchObject({ generationId: other.id });
      expect(
        await prisma.enrollment.count({
          where: { student: { studentCode: 'PNC2030-001' } },
        }),
      ).toBe(0);
      expect(
        await prisma.studentTerm.count({ where: { student: { studentCode: 'PNC2030-001' } } }),
      ).toBe(0);

      // In a replacement too: not blocked.
      const b = sheetB();
      b.tabs['ALL']!.push(['PNC2030-001', 'X', 'Y', 'M', 'A']);
      b.tabs['Physics']!.push(['PNC2030-001', 'X', 'Y', 'M', 'A', 1, 1]);
      const id = await pending(1, SHEET_B, b, sourceA);
      const pb = await preview(id);
      expect(pb.summary.canConfirm).toBe(true);
      await admin()
        .post(confirmUrl(id, pb.id), { confirmTermLabel: pb.summary.replacement.termLabel })
        .expect(200);
      const jb = await syncSource(id);
      expect(jb.status).toBe('SUCCEEDED_WITH_ERRORS');
      expect(
        await prisma.enrollment.count({ where: { student: { studentCode: 'PNC2030-001' } } }),
      ).toBe(0);
    });

    it('#16 edit name: admin only, audited, and the sheet must then match', async () => {
      const s2 = await prisma.student.findUniqueOrThrow({ where: { studentCode: 'PNC2027-002' } });
      const student = await h.activate('PNC2027-001');
      const url = `${ADMIN_V1}/students/${s2.id}/name`;
      await student.patch(url, { firstName: 'X' }).expect(403);
      await admin().patch(`${ADMIN_V1}/students/not-a-uuid/name`, { firstName: 'X' }).expect(400);
      await admin()
        .patch(`${ADMIN_V1}/students/00000000-0000-7000-8000-000000000000/name`, {
          firstName: 'X',
        })
        .expect(404);
      await admin().patch(url, { lastName: 'NUL\u0000' }).expect((r) => {
        expect([400, 422]).toContain(r.status);
      });
      await admin().patch(url, { firstName: 123 }).expect(400);
      expect(
        await prisma.student.findUniqueOrThrow({ where: { id: s2.id } }),
      ).toMatchObject({ firstName: s2.firstName, lastName: s2.lastName });

      const view = (
        await admin().patch(url, { firstName: 'NEWFIRST', lastName: 'NEWLAST' }).expect(200)
      ).body;
      expect(view).toMatchObject({ firstName: 'NEWFIRST', lastName: 'NEWLAST', fullName: 'NEWFIRST NEWLAST' });
      const audit = await prisma.auditLog.findFirstOrThrow({
        where: { action: 'student.name.changed', entityId: s2.id },
      });
      expect(audit).toMatchObject({ actorUserId: adminId });
      expect(audit.metadata).toEqual({
        old: { firstName: s2.firstName, lastName: s2.lastName, fullName: s2.fullName },
        new: { firstName: 'NEWFIRST', lastName: 'NEWLAST', fullName: 'NEWFIRST NEWLAST' },
      });

      // The sheet still has the old name: 002 is skipped.
      const a = termWorkbookFixture();
      a.tabs['Logic']![2]![5] = 33;
      reader.set(SHEET_A, a);
      let jobId = await startJob(sourceA);
      await h.runJob(jobId);
      expect((await jobErrors(jobId)).filter((e) => e.studentCode === 'PNC2027-002').map((e) => e.code)).toEqual([
        'STUDENT_NAME_MISMATCH',
      ]);
      // The sheet is corrected: 002 imports again.
      a.tabs['ALL']![4]![1] = 'NEWFIRST';
      a.tabs['ALL']![4]![2] = 'NEWLAST';
      reader.set(SHEET_A, a);
      jobId = await startJob(sourceA);
      await h.runJob(jobId);
      expect((await jobErrors(jobId)).filter((e) => e.code === 'STUDENT_NAME_MISMATCH')).toEqual([]);
      const mark = await prisma.assessmentScore.findFirstOrThrow({
        where: {
          enrollment: { studentId: s2.id },
          criterion: { key: 'QUIZ_1', offering: { title: 'Logic' } },
        },
      });
      expect(mark.mark.toString()).toBe('33');
    });

    it('#17 issue passwords for the new students of a job: one-time CSV, PENDING before', async () => {
      const id = await pending(1, SHEET_B, sheetB(), sourceA);
      const p = await preview(id);
      await admin()
        .post(confirmUrl(id, p.id), { confirmTermLabel: p.summary.replacement.termLabel })
        .expect(200);
      const job = await syncSource(id);
      const ids = job.counts.newStudents.ids as string[];
      expect(ids).toHaveLength(1);
      const created = await prisma.student.findUniqueOrThrow({
        where: { id: ids[0] },
        include: { user: true },
      });
      expect(created.studentCode).toBe('PNC2027-004');
      expect(created.provisionedSourceId).toBe(id);
      expect(created.user).toMatchObject({ status: 'PENDING', mustChangePassword: true });
      const hashBefore = created.user.passwordHash;

      const student = await h.activate('PNC2027-001');
      await student
        .post(`${ADMIN_V1}/students/issue-credentials`, { studentIds: ids, onlyPending: true })
        .expect(403);
      const res = await admin()
        .post(`${ADMIN_V1}/students/issue-credentials`, { studentIds: ids, onlyPending: true })
        .expect(200);
      expect(res.headers['content-type']).toContain('text/csv');
      expect(res.headers['cache-control']).toContain('no-store');
      expect(res.headers['x-issued-count']).toBe('1');
      const lines = res.text.trim().split(/\r?\n/);
      expect(lines).toHaveLength(2);
      expect(lines[1]).toContain('PNC2027-004');
      const header = lines[0]!.split(',');
      const password = lines[1]!.split(',')[header.indexOf('temporary_password')]!.replace(/"/g, '');
      expect(password.length).toBeGreaterThan(8);
      const after = await prisma.user.findUniqueOrThrow({ where: { id: created.userId } });
      expect(after.passwordHash).not.toBe(hashBefore);
      expect(after.passwordHash).not.toContain(password);
      // Never stored in plain text: not in the audit log.
      const audits = await prisma.auditLog.findMany({
        where: { action: { startsWith: 'student.credentials' } },
      });
      expect(audits.length).toBeGreaterThan(0);
      expect(JSON.stringify(audits)).not.toContain(password);
      // The password works once, and must be changed.
      await clearRateLimits();
      const s = await login(h.ctx, 'PNC2027-004', password);
      expect(s.body.user.mustChangePassword).toBe(true);
    });
  });

  // ===========================================================================================
  describe('Program workbooks: Terms 1–3', () => {
    let t1: string;

    beforeEach(async () => {
      await h.reset();
      adminId = (await prisma.user.findUniqueOrThrow({ where: { username: ADMIN.username } })).id;
      t1 = await connect(1, PROGRAM_T1, programTerm1Workbook());
      const job = await syncSource(t1);
      expect(['SUCCEEDED', 'SUCCEEDED_WITH_ERRORS']).toContain(job.status);
    }, 120_000);

    describe('Scenario 2: first Term 2 sync, 2 missing and 3 new (with preview)', () => {
      const MISSING = [5, PROGRAM_T1_ONLY];
      const NEW = [201, 202, 203];
      const LIKE = PROGRAM_WEP_STUDENTS[3]!;
      let t2: string;

      beforeEach(async () => {
        const sheet = term2Sheet();
        dropStudent(sheet, 5);
        for (const i of NEW) addStudent(sheet, i, LIKE);
        t2 = await connect(2, SHEET_T2, sheet);
      });

      it('#9 lists both groups; after approval missing keep Term 1 only, new are PENDING in Term 2 only', async () => {
        const term1Before = await termDigest(prisma, h.terms[1]!);
        const p = await preview(t2);
        expect(p.summary.canConfirm).toBe(true);
        const rc = p.summary.rosterCheck;
        expect(rc.earlierTerms).toEqual([1]);
        expect(rc.missing.map((m: { studentCode: string; lastTerm: number }) => `${m.studentCode} ${m.lastTerm}`).toSorted()).toEqual(
          MISSING.map((i) => `${code(i)} 1`).toSorted(),
        );
        expect(rc.new).toEqual(
          NEW.map((i) => ({ studentCode: code(i), fullName: expect.any(String), existingAccount: false })),
        );
        await admin().post(confirmUrl(t2, p.id), { rosterChecked: true }).expect(200);
        const jobId = await startJob(t2, p.id);
        await h.runJob(jobId);
        const job = await jobBody(jobId);
        expect(job.status).toBe('SUCCEEDED');

        expect(await termDigest(prisma, h.terms[1]!)).toEqual(term1Before);
        for (const i of MISSING) {
          const terms = await prisma.studentTerm.findMany({
            where: { student: { studentCode: code(i) } },
            include: { term: true },
          });
          expect(terms.map((t) => t.term.number)).toEqual([1]);
          expect(
            await prisma.enrollment.count({
              where: { student: { studentCode: code(i) }, offering: { termId: h.terms[1] } },
            }),
          ).toBeGreaterThan(0);
        }
        const created = await prisma.student.findMany({
          where: { studentCode: { in: NEW.map(code) } },
          include: { user: true, terms: { include: { term: true } } },
        });
        expect(created).toHaveLength(3);
        for (const s of created) {
          expect(s.user).toMatchObject({ status: 'PENDING', mustChangePassword: true });
          expect(s.provisionedSourceId).toBe(t2);
          expect(s.terms.map((t) => t.term.number)).toEqual([2]);
        }
        expect((job.counts.newStudents.ids as string[]).toSorted()).toEqual(
          created.map((s) => s.id).toSorted(),
        );
        const confirmed = await prisma.auditLog.findFirstOrThrow({
          where: { action: 'source.preview.confirmed' },
          orderBy: { createdAt: 'desc' },
        });
        expect(confirmed.metadata).toMatchObject({ rosterCheck: { missing: 2, new: 3 } });
        expect(JSON.stringify(confirmed.metadata)).not.toMatch(/PNC2027-|FN\d|LN\d/);
      });

      it('#10 no rosterChecked: 422 ROSTER_CHECK_REQUIRED, no job, nothing changed', async () => {
        const p = await preview(t2);
        const before = await everything();
        const jobsBefore = await prisma.syncJob.count();
        for (const body of [{}, { rosterChecked: false }, { rosterChecked: 'yes' }]) {
          const res = await admin().post(confirmUrl(t2, p.id), body);
          expect([400, 422]).toContain(res.status);
          if (res.status === 422) expect(res.body.error.code).toBe('ROSTER_CHECK_REQUIRED');
        }
        expect(
          (await prisma.sheetPreview.findUniqueOrThrow({ where: { id: p.id } })).confirmedAt,
        ).toBeNull();
        const res = await admin().post(`${ADMIN_V1}/sync`, {
          scope: 'SOURCE',
          sourceId: t2,
          previewId: p.id,
        });
        expect(res.status).toBe(422);
        expect(await prisma.syncJob.count()).toBe(jobsBefore);
        expect(await everything()).toEqual(before);
        expect(await prisma.student.count({ where: { studentCode: { in: NEW.map(code) } } })).toBe(0);
      });
    });

    it('#11 no roster confirmation needed when both lists are empty', async () => {
      const sheet = term2Sheet();
      addStudent(sheet, PROGRAM_T1_ONLY, PROGRAM_WEP_STUDENTS[3]!); // everyone of Term 1, nobody new
      const t2 = await connect(2, SHEET_T2, sheet);
      const p = await preview(t2);
      expect(p.summary.rosterCheck).toEqual({ earlierTerms: [1], missing: [], new: [] });
      await admin().post(confirmUrl(t2, p.id), {}).expect(200);
      const job = await syncSource(t2, p.id);
      expect(job.status).toBe('SUCCEEDED');
      expect(await prisma.studentTerm.count({ where: { termId: h.terms[2] } })).toBe(101);
    });

    it('#12 Scenario 3: missing in Term 2, back in Term 3 → same account, Term 2 empty', async () => {
      const S = 5;
      const two = term2Sheet();
      dropStudent(two, S);
      const t2 = await connect(2, SHEET_T2, two);
      expect(['SUCCEEDED', 'SUCCEEDED_WITH_ERRORS']).toContain((await syncSource(t2)).status);
      const before = await prisma.student.findUniqueOrThrow({ where: { studentCode: code(S) } });

      const t3 = await connect(3, SHEET_T3, term2Sheet(3));
      const p = await preview(t3);
      expect(p.summary.rosterCheck.earlierTerms).toEqual([1, 2]);
      expect(p.summary.rosterCheck.new).toEqual([]);
      expect(p.summary.rosterCheck.missing.map((m: { studentCode: string }) => m.studentCode)).toEqual([
        code(PROGRAM_T1_ONLY),
      ]);
      await admin().post(confirmUrl(t3, p.id), { rosterChecked: true }).expect(200);
      const job = await syncSource(t3, p.id);
      expect(job.status).toBe('SUCCEEDED');
      expect(job.counts.newStudents.ids).toEqual([]);
      const rows = await prisma.student.findMany({ where: { studentCode: code(S) } });
      expect(rows.map((r) => r.id)).toEqual([before.id]);
      const terms = await prisma.studentTerm.findMany({
        where: { studentId: before.id },
        include: { term: true },
      });
      expect(terms.map((t) => t.term.number).toSorted()).toEqual([1, 3]);
      expect(
        await prisma.enrollment.count({
          where: { studentId: before.id, offering: { termId: h.terms[2] } },
        }),
      ).toBe(0);
      expect(
        await prisma.enrollment.count({
          where: { studentId: before.id, offering: { termId: h.terms[3] } },
        }),
      ).toBeGreaterThan(0);
    });

    describe('with Term 2 synced', () => {
      let t2: string;
      beforeEach(async () => {
        t2 = await connect(2, SHEET_T2, term2Sheet());
        expect(['SUCCEEDED', 'SUCCEEDED_WITH_ERRORS']).toContain((await syncSource(t2)).status);
      }, 120_000);

      it('#3 replacing Term 1: a student with Term 2 data keeps the account, only Term 1 data goes', async () => {
        const KEEP = 5;
        const term2Before = await termDigest(prisma, h.terms[2]!);
        const kept = await prisma.student.findUniqueOrThrow({ where: { studentCode: code(KEEP) } });
        const gone = await prisma.student.findUniqueOrThrow({
          where: { studentCode: code(PROGRAM_T1_ONLY) },
        });
        const sheet = term1Clean();
        dropStudent(sheet, KEEP);
        dropStudent(sheet, PROGRAM_T1_ONLY);
        const id = await pending(1, SHEET_T1B, sheet, t1);
        const p = await preview(id);
        expect(p.summary.canConfirm).toBe(true);
        const r = p.summary.replacement;
        expect(r.students.accountsDeleted.map((s: { studentCode: string }) => s.studentCode)).toEqual([
          code(PROGRAM_T1_ONLY),
        ]);
        expect(r.students.dataRemoved.map((s: { studentCode: string }) => s.studentCode)).toEqual([
          code(KEEP),
        ]);
        await admin().post(confirmUrl(id, p.id), { confirmTermLabel: r.termLabel }).expect(200);
        const job = await syncSource(id);
        expect(job.status).toBe('SUCCEEDED');
        expect(job.counts.replacement).toMatchObject({ accounts: 1 });

        expect(await termDigest(prisma, h.terms[2]!)).toEqual(term2Before);
        const after = await prisma.student.findUniqueOrThrow({
          where: { studentCode: code(KEEP) },
          include: { terms: { include: { term: true } } },
        });
        expect(after.id).toBe(kept.id);
        expect(after.userId).toBe(kept.userId);
        expect(after.terms.map((t) => t.term.number)).toEqual([2]);
        expect(after.className).toBe(kept.className); // still Term 2's class
        expect(
          await prisma.enrollment.count({
            where: { studentId: kept.id, offering: { termId: h.terms[1] } },
          }),
        ).toBe(0);
        expect(await prisma.student.count({ where: { id: gone.id } })).toBe(0);
        expect(await prisma.user.count({ where: { id: gone.userId } })).toBe(0);
      });

      it('#4 replacing Term 2 removes only Term 2 data; Term 1 row-level identical', async () => {
        const term1Before = await termDigest(prisma, h.terms[1]!);
        const sheet = term2Sheet();
        dropStudent(sheet, 5);
        bumpMark(sheet, 'PL', PROGRAM_WEP_STUDENTS[0]!, 99);
        const id = await pending(2, SHEET_T2B, sheet, t2);
        const p = await preview(id);
        expect(p.summary.replacement.termLabel).toBe('GEN2027 Term 2');
        expect(p.summary.replacement.counts.accounts).toBe(0);
        await admin()
          .post(confirmUrl(id, p.id), {
            confirmTermLabel: 'GEN2027 Term 2',
            rosterChecked: true,
          })
          .expect(200);
        const job = await syncSource(id);
        expect(job.status).toBe('SUCCEEDED');
        expect(await termDigest(prisma, h.terms[1]!)).toEqual(term1Before);
        expect(
          await prisma.studentTerm.count({
            where: { termId: h.terms[2], student: { studentCode: code(5) } },
          }),
        ).toBe(0);
        expect(
          await prisma.enrollment.count({
            where: { offering: { termId: h.terms[2] }, student: { studentCode: code(5) } },
          }),
        ).toBe(0);
        expect(await prisma.student.count({ where: { studentCode: code(5) } })).toBe(1);
      });

      it('#15 Generation and All syncs create no new students; everyone else syncs', async () => {
        const NEWID = 300;
        const MOVED = PROGRAM_WEP_STUDENTS[1]!;
        for (const [scope, extra] of [
          ['GENERATION', { generationId: h.generationId }],
          ['ALL', {}],
        ] as const) {
          const sheet = term2Sheet();
          addStudent(sheet, NEWID, PROGRAM_WEP_STUDENTS[3]!);
          const value = scope === 'ALL' ? 98 : 97;
          bumpMark(sheet, 'PL', MOVED, value);
          reader.set(SHEET_T2, sheet);
          const parentId = (
            await admin()
              .post(`${ADMIN_V1}/sync`, { scope, ...extra })
              .expect(202)
          ).body.jobId as string;
          const children = await prisma.syncJob.findMany({ where: { parentId } });
          expect(children.length).toBe(2);
          for (const c of children) await h.runJob(c.id);
          const child = children.find((c) => c.sourceId === t2)!;
          const done = await prisma.syncJob.findUniqueOrThrow({
            where: { id: child.id },
            include: { errors: true },
          });
          expect(['SUCCEEDED', 'SUCCEEDED_WITH_ERRORS']).toContain(done.status);
          const mine = done.errors.filter((e) => e.studentCode === code(NEWID));
          expect(mine.map((e) => `${e.severity} ${e.code}`)).toEqual([
            'WARNING ROSTER_APPROVAL_REQUIRED',
          ]);
          expect(JSON.stringify(mine)).not.toMatch(/FN300|LN300/);
          expect(await prisma.student.count({ where: { studentCode: code(NEWID) } })).toBe(0);
          const pl = await prisma.assessmentScore.findMany({
            where: {
              enrollment: { student: { studentCode: code(MOVED) }, offering: { termId: h.terms[2], title: 'PL' } },
            },
          });
          expect(pl.map((s) => s.mark.toString())).toContain(String(value));
        }
      });
    });
  });

  // ===========================================================================================
  describe('#18 timing: replacement of 300 students x 6 subjects', () => {
    const STUDENTS = 300;
    const TABS = ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot'];
    const MARKS = ['Quiz 1 10%', 'Quiz 2 10%', 'Homework 10%', 'Participation 10%', 'MIDTERM 25%', 'FINAL 35%'];
    const sc = (i: number) => `QR2027-${String(i + 1).padStart(4, '0')}`;

    function workbook(version: number, ids: number[]): FakeSpreadsheet {
      const rows = ids.map((i) => [sc(i), `F${i}`, `L${i}`, i % 2 ? 'M' : 'F', ['A', 'B', 'C', 'D'][i % 4]!]);
      const tabs: FakeSpreadsheet['tabs'] = { _meta: termMetaTab('GEN2027', 1), ALL: [PROFILE, ...rows] };
      TABS.forEach((name, t) => {
        tabs[name] = [
          [...PROFILE, ...MARKS, 'COMMENTS'],
          ...rows.map((row, k) => [
            ...row,
            ...MARKS.map((_, c) => (ids[k]! * 7 + t * 13 + c * 3 + version * 17) % 101),
            `Comment v${version}`,
          ]),
        ];
      });
      return { title: `Perf v${version}`, tabs };
    }

    it('reports the transaction time against 300 s and the total job time', async () => {
      await h.reset();
      const all = Array.from({ length: STUDENTS }, (_, i) => i);
      reader.set(SHEET_A, workbook(1, all));
      const src = (
        await admin()
          .post(`${ADMIN_V1}/terms/${h.termId}/sources`, { url: sheetUrl(SHEET_A), label: 'P' })
          .expect(201)
      ).body.id as string;
      await confirmAllTabs(prisma, reader, src);
      expect((await syncSource(src)).status).toBe('SUCCEEDED');
      reader.set(SHEET_A, workbook(2, all));
      expect((await syncSource(src)).status).toBe('SUCCEEDED');
      const scores = await prisma.assessmentScore.count();
      const revisions = await prisma.assessmentScoreRevision.count();
      expect(scores).toBe(STUDENTS * TABS.length * MARKS.length);

      // B: 10 students gone (accounts deleted), 10 new, every mark changed.
      const bIds = [...all.slice(10), ...Array.from({ length: 10 }, (_, k) => 1000 + k)];
      const id = await pending(1, SHEET_B, workbook(3, bIds), src);
      let t = Date.now();
      const p = await preview(id);
      const previewMs = Date.now() - t;
      expect(p.summary.replacement.counts).toMatchObject({
        scoreRows: scores,
        scoreHistoryRows: revisions,
        accounts: 10,
        subjects: 0,
      });
      await admin()
        .post(confirmUrl(id, p.id), { confirmTermLabel: p.summary.replacement.termLabel })
        .expect(200);
      const jobId = await startJob(id);

      const txMs: number[] = [];
      const timed = new Proxy(prisma, {
        get(target, prop, receiver) {
          if (prop === '$transaction') {
            return async (...args: unknown[]) => {
              const s = performance.now();
              try {
                return await (target.$transaction as (...a: unknown[]) => Promise<unknown>)(...args);
              } finally {
                const opts = args[1] as { timeout?: number } | undefined;
                if (opts?.timeout === 300_000) txMs.push(performance.now() - s);
              }
            };
          }
          const v = Reflect.get(target, prop, receiver);
          return typeof v === 'function' ? v.bind(target) : v;
        },
      });
      t = Date.now();
      await runSourceSync({ prisma: timed as PrismaClient, reader }, jobId, {
        attempt: 1,
        maxAttempts: 1,
      });
      const jobMs = Date.now() - t;
      const job = await jobBody(jobId);
      expect(job.status).toBe('SUCCEEDED');
      expect(job.counts.replacement).toMatchObject({ accounts: 10 });
      expect(txMs).toHaveLength(1);
      const line =
        `[QA #18] 300x6 replacement: preview ${previewMs} ms; transaction ${Math.round(txMs[0]!)} ms of 300000 ms limit; ` +
        `job total ${jobMs} ms; deleted ${scores} scores, ${revisions} history rows, 10 accounts; created ${await prisma.assessmentScore.count()} scores`;
      console.log(line);
      process.stderr.write(`${line}\n`);
      const out = process.env['QA_TIMING_FILE'];
      if (out) (await import('node:fs')).appendFileSync(out, `${line}\n`);
      expect(txMs[0]!).toBeLessThan(300_000);
    }, 600_000);
  });
});
