import { createHash } from 'node:crypto';
import {
  InMemorySheetsReader,
  TERM_FIXTURE_SPREADSHEET_ID,
  termWorkbookFixture,
} from '@ssrs/sheets/testing';
import { runSourceSync } from '@ssrs/sync';
import { confirmAllTabs } from '@ssrs/sync/testing';
import {
  api,
  createTestApp,
  login,
  resetState,
  seedUser,
  type TestContext,
} from './support/test-app.js';

const ADMIN = { username: 'admin', password: 'Admin-Initial-Pass-2026' };
const V1 = '/api/v1/admin';
const SHEET_A = TERM_FIXTURE_SPREADSHEET_ID;
const SHEET_B = '1NewTermWorkbookSheetB000000000000000000';
const urlFor = (id: string) => `https://docs.google.com/spreadsheets/d/${id}/edit`;

interface Tab {
  id: string;
  tabName: string;
  status: string;
  columns: {
    columnIndex: number;
    role: string;
    proposedName: string | null;
    proposedWeight: string | null;
  }[];
  carriedFrom: { subject: string } | null;
}

/** Google tab ids stay with a tab. The in-memory reader numbers by position, which shifts. */
class StableIdReader extends InMemorySheetsReader {
  override async getMetadata(id: string) {
    const meta = await super.getMetadata(id);
    return {
      ...meta,
      tabs: meta.tabs.map((t) => ({
        ...t,
        sheetId: createHash('sha256').update(`${id}:${t.title}`).digest().readUInt32BE(0) % 2e9,
      })),
    };
  }
}

const without = (...tabs: string[]) => {
  const sheet = termWorkbookFixture();
  for (const tab of tabs) delete sheet.tabs[tab];
  return sheet;
};

const subjectTab = (a: number, b: number) => [
  ['STUDENT ID', 'FIRST NAME', 'LAST NAME', 'Final 100%'],
  ['PNC2027-001', 'DARA', 'SOK', a],
  ['PNC2027-002', 'BOPHA', 'CHAN', b],
];

const confirmBody = (tab: Tab, subjectName?: string) => ({
  subjectName: subjectName ?? tab.carriedFrom?.subject ?? tab.tabName,
  columns: tab.columns.map((c) => ({
    columnIndex: c.columnIndex,
    role: c.role,
    ...(c.role === 'CRITERION' ? { name: c.proposedName, weight: c.proposedWeight ?? '25' } : {}),
  })),
});

const renamed = () => {
  const sheet = without('BCU');
  sheet.tabs['Business'] = termWorkbookFixture().tabs['BCU']!;
  return sheet;
};

const failSave = () => {
  throw new Error('database failure');
};

const differentSubjects = () => {
  const base = termWorkbookFixture();
  return {
    title: 'Sheet B',
    tabs: {
      _meta: base.tabs['_meta']!,
      ALL: base.tabs['ALL']!,
      Physics: subjectTab(70, 71),
      Chemistry: subjectTab(60, 61),
    },
  };
};

describe('Subjects removed from a term sheet (integration)', () => {
  let ctx: TestContext;
  let reader: StableIdReader;
  let admin: ReturnType<typeof api>;
  let student: ReturnType<typeof api>;
  let generationId: string;
  let termId: string;
  let sourceA: string;

  const results = async () =>
    (await student.get('/api/v1/student/me/results').expect(200)).body as {
      terms: { courses: { title: string }[] }[];
    };

  const titles = async () =>
    (await results()).terms.flatMap((t) => t.courses.map((c) => c.title)).toSorted();

  const run = async (jobId: string, deps = {}) => {
    await runSourceSync({ prisma: ctx.prisma, reader, ...deps }, jobId, {
      attempt: 1,
      maxAttempts: 1,
    });
    return (await admin.get(`${V1}/sync/${jobId}`).expect(200)).body;
  };

  const sync = async (sourceId: string, previewId?: string, deps = {}) => {
    const { jobId } = (
      await admin.post(`${V1}/sync`, { scope: 'SOURCE', sourceId, previewId }).expect(202)
    ).body;
    return run(jobId, deps);
  };

  /** A job's issue codes, leaving out the fixture's PNC2027-003 missing from subjects it takes. */
  const issueCodes = async (jobId: string) =>
    (await admin.get(`${V1}/sync/${jobId}/errors`).expect(200)).body.data
      .map((i: { code: string }) => i.code)
      .filter((code: string) => code !== 'STUDENT_MISSING_FROM_TAB');

  const preview = async (sourceId: string) =>
    (await admin.post(`${V1}/sources/${sourceId}/preview`).expect(201)).body;

  const confirmPreview = (sourceId: string, id: string, acknowledgeRemovals = true) =>
    admin
      .post(`${V1}/sources/${sourceId}/preview/${id}/confirm`, { acknowledgeRemovals })
      .expect(200);

  const previewed = async (sourceId: string) => {
    const p = await preview(sourceId);
    await confirmPreview(sourceId, p.id);
    return p;
  };

  const tabsOf = async (sourceId: string) =>
    (await admin.get(`${V1}/sources/${sourceId}/mappings`).expect(200)).body as Tab[];

  const replaceWith = async (leaveDraft: string[] = []) => {
    const id = (
      await admin
        .post(`${V1}/terms/${termId}/sources/change`, { url: urlFor(SHEET_B), label: 'Sheet B' })
        .expect(201)
    ).body.id as string;
    await admin.post(`${V1}/sources/${id}/detect`).expect(200);
    for (const tab of await tabsOf(id)) {
      if (leaveDraft.includes(tab.tabName)) continue;
      await admin
        .post(`${V1}/sources/${id}/mappings/${tab.id}/confirm`, confirmBody(tab))
        .expect(200);
    }
    return id;
  };

  /** Everything a student could see, plus the kept data, as one comparable value. */
  const snapshot = async () => ({
    results: await results(),
    offerings: await ctx.prisma.courseOffering.findMany({
      select: { id: true, status: true, title: true, visibility: true },
      orderBy: { id: 'asc' },
    }),
    scores: (
      await ctx.prisma.assessmentScore.findMany({
        select: { id: true, status: true, mark: true },
        orderBy: { id: 'asc' },
      })
    ).map((s) => `${s.id}:${s.status}:${s.mark.toString()}`),
    revisions: await ctx.prisma.assessmentScoreRevision.count(),
  });

  const bcu = () => ctx.prisma.courseOffering.findFirstOrThrow({ where: { title: 'BCU' } });

  const archiveThenRestore = async (tab = termWorkbookFixture().tabs['BCU']!) => {
    reader.set(SHEET_A, without('BCU'));
    await sync(sourceA, (await previewed(sourceA)).id);
    const sheet = without('BCU');
    sheet.tabs['BCU'] = tab;
    reader.set(SHEET_A, sheet);
    await admin.post(`${V1}/sources/${sourceA}/detect`).expect(200);
    const restored = (await tabsOf(sourceA)).find((t) => t.tabName === 'BCU')!;
    expect(restored.status).toBe('DRAFT');
    await admin
      .post(`${V1}/sources/${sourceA}/mappings/${restored.id}/confirm`, confirmBody(restored))
      .expect(200);
  };

  beforeAll(async () => {
    reader = new StableIdReader();
    ctx = await createTestApp({ sheetsReader: reader });
  });

  afterAll(async () => {
    await ctx.close();
  });

  beforeEach(async () => {
    await resetState(ctx);
    reader.set(SHEET_A, termWorkbookFixture());
    await seedUser(ctx, { ...ADMIN, role: 'ADMIN' });
    admin = api(await login(ctx, ADMIN.username, ADMIN.password));
    generationId = (
      await admin
        .post(`${V1}/generations`, {
          code: 'GEN2027',
          name: 'Generation 2027',
          startDate: '2026-11-02',
        })
        .expect(201)
    ).body.id;
    termId = (await admin.get(`${V1}/generations/${generationId}/terms`).expect(200)).body[0].id;
    sourceA = (
      await admin
        .post(`${V1}/terms/${termId}/sources`, { url: urlFor(SHEET_A), label: 'Sheet A' })
        .expect(201)
    ).body.id;
    await confirmAllTabs(ctx.prisma, reader, sourceA);
    await sync(sourceA);
    await admin.post(`${V1}/terms/${termId}/release`, { visible: true }).expect(200);
    const row = await ctx.prisma.student.findUniqueOrThrow({
      where: { studentCode: 'PNC2027-001' },
    });
    const issued = await admin.post(`${V1}/students/${row.id}/reset-password`).expect(200);
    student = api(await login(ctx, 'PNC2027-001', issued.body.temporaryPassword));
    await student
      .post('/api/v1/auth/change-password', {
        currentPassword: issued.body.temporaryPassword,
        newPassword: 'River-Lantern-Morning-48',
      })
      .expect(204);
  });

  describe('a subject tab removed from the same sheet', () => {
    it('lists it with counts and needs an acknowledgment', async () => {
      reader.set(SHEET_A, without('BCU'));
      const p = await preview(sourceA);
      const scores = await ctx.prisma.assessmentScore.count({
        where: { offeringId: (await bcu()).id },
      });
      expect(p.summary.comparison.removed).toEqual([
        { offeringId: (await bcu()).id, subject: 'BCU', tabName: 'BCU', students: 2, scores },
      ]);
      expect(p.summary.comparison.kept.toSorted()).toEqual(['ENG', 'Logic', 'MsOffice', 'PL']);
      expect(p.summary.canConfirm).toBe(true);
      expect(p.summary.tabs.map((t: { subject: string }) => t.subject)).not.toContain('BCU');

      const refused = await admin
        .post(`${V1}/sources/${sourceA}/preview/${p.id}/confirm`, {})
        .expect(422);
      expect(refused.body.error.code).toBe('REMOVAL_ACK_REQUIRED');
    });

    it('archives it after the sync and keeps its data', async () => {
      reader.set(SHEET_A, without('BCU'));
      const before = await ctx.prisma.assessmentScore.count();
      const revisions = await ctx.prisma.assessmentScoreRevision.count();
      const p = await previewed(sourceA);
      const job = await sync(sourceA, p.id);

      expect(job.status).toBe('SUCCEEDED');
      expect(job.counts.offerings.rejected).toBe(0);
      expect(await issueCodes(job.id)).toEqual(['SUBJECT_ARCHIVED']);
      expect(await titles()).toEqual(['ENG', 'Logic', 'MsOffice', 'PL']);
      expect(await bcu()).toMatchObject({ status: 'ARCHIVED', archivedAt: expect.any(Date) });
      expect(await ctx.prisma.assessmentScore.count()).toBe(before);
      expect(await ctx.prisma.assessmentScoreRevision.count()).toBe(revisions);
    });

    it('leaves it out of totals, counts and the admin view', async () => {
      reader.set(SHEET_A, without('BCU'));
      await sync(sourceA, (await previewed(sourceA)).id);
      const generation = await admin.get(`${V1}/generations/${generationId}`).expect(200);
      expect(generation.body.counts.offerings).toBe(4);
      expect(generation.body.terms[0].subjects).toBe(4);
      const source = await admin.get(`${V1}/sources/${sourceA}`).expect(200);
      expect(source.body.ownedOfferings).toBe(4);
      const dashboard = await admin.get(`${V1}/dashboard`).expect(200);
      expect(dashboard.body.offerings.total).toBe(4);
      const row = await ctx.prisma.student.findUniqueOrThrow({
        where: { studentCode: 'PNC2027-001' },
      });
      const view = await admin.get(`${V1}/students/${row.id}/results`).expect(200);
      const courses = view.body.terms.flatMap((t: { courses: { title: string }[] }) => t.courses);
      expect(courses.map((c: { title: string }) => c.title)).not.toContain('BCU');
    });

    it('writes one audit entry per removal', async () => {
      reader.set(SHEET_A, without('BCU', 'MsOffice'));
      const job = await sync(sourceA, (await previewed(sourceA)).id);
      const entries = await ctx.prisma.auditLog.findMany({ where: { action: 'subject.archived' } });
      expect(entries).toHaveLength(2);
      const admins = await ctx.prisma.user.findFirstOrThrow({ where: { username: 'admin' } });
      expect(entries[0]).toMatchObject({ actorType: 'USER', actorUserId: admins.id });
      expect(entries[0]!.metadata).toMatchObject({
        termId,
        sourceId: sourceA,
        syncJobId: job.id,
        tab: expect.any(String),
        subject: expect.any(String),
        students: expect.any(Number),
        scores: expect.any(Number),
      });
    });

    it('changes nothing when synced again right after', async () => {
      reader.set(SHEET_A, without('BCU'));
      await sync(sourceA, (await previewed(sourceA)).id);
      const before = await snapshot();
      const again = await preview(sourceA);
      expect(again.summary.comparison.removed).toEqual([]);
      await confirmPreview(sourceA, again.id, false);
      expect((await sync(sourceA, again.id)).status).toBe('SUCCEEDED');
      expect(await snapshot()).toEqual(before);
    });

    it('shows no removal when nothing is removed', async () => {
      const p = await preview(sourceA);
      expect(p.summary.comparison).toMatchObject({
        removed: [],
        possibleRenames: [],
        blockers: [],
      });
      await admin.post(`${V1}/sources/${sourceA}/preview/${p.id}/confirm`, {}).expect(200);
      expect((await sync(sourceA, p.id)).status).toBe('SUCCEEDED');
    });

    it('never archives without a confirmed preview', async () => {
      reader.set(SHEET_A, without('BCU'));
      const job = await sync(sourceA);
      expect(job.status).toBe('SUCCEEDED_WITH_ERRORS');
      expect(await issueCodes(job.id)).toContain('WORKSHEET_NOT_FOUND');

      const all = await admin.post(`${V1}/sync`, { scope: 'GENERATION', generationId }).expect(202);
      const child = await ctx.prisma.syncJob.findFirstOrThrow({
        where: { parentId: all.body.jobId },
      });
      await run(child.id);
      expect(await titles()).toContain('BCU');
      expect((await bcu()).status).toBe('ACTIVE');
    });

    it('refuses a retry from archiving and an out-of-date preview', async () => {
      reader.set(SHEET_A, without('BCU'));
      const p = await previewed(sourceA);
      await sync(sourceA);
      const res = await admin
        .post(`${V1}/sync`, { scope: 'SOURCE', sourceId: sourceA, previewId: p.id })
        .expect(422);
      expect(res.body.error.code).toBe('PREVIEW_STALE');
      expect((await bcu()).status).toBe('ACTIVE');
    });
  });

  describe('a replaced sheet', () => {
    it('shows kept, added and removed, then matches the new sheet', async () => {
      const sheet = without('BCU', 'MsOffice');
      sheet.title = 'Sheet B';
      sheet.tabs['Science'] = subjectTab(88, 77);
      reader.set(SHEET_B, sheet);
      const id = await replaceWith();
      const p = await previewed(id);
      const { comparison } = p.summary;
      expect(comparison.kept.toSorted()).toEqual(['ENG', 'Logic', 'PL']);
      expect(comparison.added).toEqual([
        { subject: 'Science', tabName: 'Science', returning: false },
      ]);
      expect(comparison.removed.map((r: { subject: string }) => r.subject)).toEqual([
        'BCU',
        'MsOffice',
      ]);
      expect((await sync(id)).status).toBe('SUCCEEDED');
      expect(await titles()).toEqual(['ENG', 'Logic', 'PL', 'Science']);
    });

    it('works with a completely different set of subjects', async () => {
      reader.set(SHEET_B, differentSubjects());
      const id = await replaceWith();
      const p = await previewed(id);
      expect(p.summary.comparison.kept).toEqual([]);
      expect(p.summary.comparison.removed).toHaveLength(5);
      expect((await sync(id)).status).toBe('SUCCEEDED');
      expect(await titles()).toEqual(['Chemistry', 'Physics']);
      expect(await ctx.prisma.courseOffering.count({ where: { status: 'ARCHIVED' } })).toBe(5);
    });

    it('needs the acknowledgment too', async () => {
      reader.set(SHEET_B, { ...without('BCU'), title: 'Sheet B' });
      const id = await replaceWith();
      const p = await preview(id);
      const res = await admin.post(`${V1}/sources/${id}/preview/${p.id}/confirm`, {}).expect(422);
      expect(res.body.error.code).toBe('REMOVAL_ACK_REQUIRED');
    });

    it('blocks on a new tab with no mapping, not on a tab that is not a subject', async () => {
      const sheet = differentSubjects() as ReturnType<typeof differentSubjects> & {
        tabs: Record<string, unknown>;
      };
      (sheet.tabs as Record<string, unknown>)['Notes'] = [['Reminder for the teachers']];
      reader.set(SHEET_B, sheet as never);
      const id = await replaceWith(['Chemistry']);
      const p = await preview(id);
      expect(p.summary.canConfirm).toBe(false);
      expect(p.summary.comparison.blockers).toEqual([
        'Tab "Chemistry" has no confirmed subject. Confirm or ignore it first.',
      ]);
    });

    it('keeps old scores of a student missing from the new sheet', async () => {
      const sheet = termWorkbookFixture();
      sheet.title = 'Sheet B';
      sheet.tabs['ALL'] = sheet.tabs['ALL']!.filter((r) => r[0] !== 'PNC2027-001');
      for (const tab of ['Logic', 'ENG', 'PL', 'BCU', 'MsOffice']) {
        sheet.tabs[tab] = sheet.tabs[tab]!.filter((r) => r[0] !== 'PNC2027-001');
      }
      reader.set(SHEET_B, sheet);
      const id = await replaceWith();
      const p = await previewed(id);
      expect(p.summary.missingStudents.total).toBe(1);
      await sync(id);
      expect((await titles()).length).toBe(5);
    });
  });

  describe('a sync that must remove nothing', () => {
    it('rolls everything back when a save fails', async () => {
      reader.set(SHEET_A, without('BCU'));
      const p = await previewed(sourceA);
      const before = await snapshot();
      const job = await sync(sourceA, p.id, { hooks: { beforeCourseCommit: failSave } });
      expect(job.status).toBe('FAILED');
      expect(await snapshot()).toEqual(before);
    });

    it('rolls back marks saved before the failure', async () => {
      const sheet = without('BCU');
      sheet.tabs['Logic']![1]![5] = 11;
      reader.set(SHEET_A, sheet);
      const p = await previewed(sourceA);
      const before = await snapshot();
      let calls = 0;
      const failLate = () => {
        calls += 1;
        if (calls === 3) throw new Error('database failure');
      };
      const job = await sync(sourceA, p.id, { hooks: { beforeCourseCommit: failLate } });
      expect(job.status).toBe('FAILED');
      expect(await snapshot()).toEqual(before);
    });

    it('fails when Google fails', async () => {
      reader.set(SHEET_A, without('BCU'));
      const p = await previewed(sourceA);
      const before = await snapshot();
      reader.fail(SHEET_A, 'GOOGLE_UNAVAILABLE');
      expect((await sync(sourceA, p.id)).status).toBe('FAILED');
      expect(await snapshot()).toEqual(before);
    });

    it.each([
      ['an empty tab list', () => ({ title: 'x', tabs: {} }), 'TEMPLATE_INVALID'],
      [
        'only the roster tab',
        () => ({ title: 'x', tabs: { ALL: termWorkbookFixture().tabs['ALL']! } }),
        'REMOVALS_CHANGED',
      ],
    ])('fails on %s', async (_name, sheet, code) => {
      reader.set(SHEET_A, without('BCU'));
      const p = await previewed(sourceA);
      const before = await snapshot();
      reader.set(SHEET_A, sheet());
      const job = await sync(sourceA, p.id);
      expect(job).toMatchObject({ status: 'FAILED', failureCode: code });
      expect(await snapshot()).toEqual(before);
    });

    it('cannot be previewed into a removal when only the roster is left', async () => {
      reader.set(SHEET_A, { title: 'x', tabs: { ALL: termWorkbookFixture().tabs['ALL']! } });
      const p = await preview(sourceA);
      expect(p.summary.comparison.removed).toEqual([]);
      expect(p.summary.canConfirm).toBe(false);
    });

    it('does nothing for a cancelled job', async () => {
      reader.set(SHEET_A, without('BCU'));
      const p = await previewed(sourceA);
      const before = await snapshot();
      const { jobId } = (
        await admin
          .post(`${V1}/sync`, { scope: 'SOURCE', sourceId: sourceA, previewId: p.id })
          .expect(202)
      ).body;
      await ctx.prisma.syncJob.update({
        where: { id: jobId },
        data: { status: 'CANCELLED', finishedAt: new Date() },
      });
      await run(jobId);
      expect(await snapshot()).toEqual(before);
    });

    it('needs zero errors: a bad mark stops the removal and every mark', async () => {
      reader.set(SHEET_A, without('BCU'));
      const p = await previewed(sourceA);
      const before = await snapshot();
      const sheet = without('BCU');
      sheet.tabs['Logic']![1]![5] = 'oops';
      sheet.tabs['PL']![1]![5] = 12;
      reader.set(SHEET_A, sheet);
      const job = await sync(sourceA, p.id);
      expect(job).toMatchObject({ status: 'FAILED', failureCode: 'REMOVAL_REJECTED' });
      expect(await snapshot()).toEqual(before);
    });

    it.each([
      ['another tab goes too', () => without('BCU', 'MsOffice')],
      ['the tab comes back', () => termWorkbookFixture()],
    ])('rejects the sync when %s after the preview', async (_name, sheet) => {
      reader.set(SHEET_A, without('BCU'));
      const p = await previewed(sourceA);
      const before = await snapshot();
      reader.set(SHEET_A, sheet());
      const job = await sync(sourceA, p.id);
      expect(job).toMatchObject({ status: 'FAILED', failureCode: 'REMOVALS_CHANGED' });
      expect(await snapshot()).toEqual(before);
    });

    it('rejects a replacement when the sheet lost a tab after the preview', async () => {
      reader.set(SHEET_B, { ...without('BCU'), title: 'Sheet B' });
      const id = await replaceWith();
      await previewed(id);
      reader.set(SHEET_B, { ...without('BCU', 'PL'), title: 'Sheet B' });
      expect((await sync(id)).status).toBe('FAILED');
      expect(await titles()).toContain('BCU');
    });
  });

  describe('a possible rename', () => {
    it('is flagged on the active sheet and on a replacement', async () => {
      reader.set(SHEET_A, renamed());
      const p = await preview(sourceA);
      expect(p.summary.comparison.possibleRenames).toEqual([{ from: 'BCU', to: 'Business' }]);

      reader.set(SHEET_A, termWorkbookFixture());
      reader.set(SHEET_B, { ...renamed(), title: 'Sheet B' });
      const id = await replaceWith();
      const pending = await preview(id);
      expect(pending.summary.comparison.possibleRenames).toEqual([{ from: 'BCU', to: 'Business' }]);
    });

    it('is not flagged when several tabs change', async () => {
      const sheet = without('BCU', 'MsOffice');
      sheet.tabs['Business'] = termWorkbookFixture().tabs['BCU']!;
      reader.set(SHEET_A, sheet);
      expect((await preview(sourceA)).summary.comparison.possibleRenames).toEqual([]);
    });

    it('lets the admin map the new tab, so nothing is removed', async () => {
      reader.set(SHEET_A, renamed());
      const { id: offeringId } = await bcu();
      await admin.post(`${V1}/sources/${sourceA}/detect`).expect(200);
      const tab = (await tabsOf(sourceA)).find((t) => t.tabName === 'Business')!;
      await admin
        .post(`${V1}/sources/${sourceA}/mappings/${tab.id}/confirm`, confirmBody(tab, 'BCU'))
        .expect(200);
      expect((await tabsOf(sourceA)).map((t) => t.tabName)).not.toContain('BCU');
      const p = await preview(sourceA);
      expect(p.summary.comparison.removed).toEqual([]);
      await confirmPreview(sourceA, p.id, false);
      expect((await sync(sourceA, p.id)).status).toBe('SUCCEEDED');
      expect(await titles()).toContain('BCU');
      expect((await bcu()).id).toBe(offeringId);
      expect((await bcu()).sheetTab).toBe('Business');
    });

    it('keeps refusing while the other tab is still in the sheet', async () => {
      const sheet = termWorkbookFixture();
      sheet.tabs['Business'] = termWorkbookFixture().tabs['BCU']!;
      reader.set(SHEET_A, sheet);
      await admin.post(`${V1}/sources/${sourceA}/detect`).expect(200);
      const tab = (await tabsOf(sourceA)).find((t) => t.tabName === 'Business')!;
      const res = await admin
        .post(`${V1}/sources/${sourceA}/mappings/${tab.id}/confirm`, confirmBody(tab, 'BCU'))
        .expect(409);
      expect(res.body.error.code).toBe('SUBJECT_ALREADY_MAPPED');
    });
  });

  describe('a removed tab added back', () => {
    it('is skipped until it is confirmed again', async () => {
      reader.set(SHEET_A, without('BCU'));
      await sync(sourceA, (await previewed(sourceA)).id);
      reader.set(SHEET_A, termWorkbookFixture());
      const job = await sync(sourceA);
      expect(await issueCodes(job.id)).toEqual(['UNMAPPED_TAB']);
      expect(await titles()).not.toContain('BCU');
    });

    it('reactivates the same subject, shown as returning', async () => {
      const { id } = await bcu();
      await archiveThenRestore();
      const p = await previewed(sourceA);
      expect(p.summary.comparison.added).toEqual([
        { subject: 'BCU', tabName: 'BCU', returning: true },
      ]);
      expect((await sync(sourceA, p.id)).status).toBe('SUCCEEDED');
      expect(await titles()).toContain('BCU');
      expect(await bcu()).toMatchObject({ id, status: 'ACTIVE', archivedAt: null });
      const audit = await ctx.prisma.auditLog.findFirstOrThrow({
        where: { action: 'subject.reactivated' },
      });
      expect(audit.entityId).toBe(id);
    });

    it('starts fresh: old scores do not reappear, and stay in the history', async () => {
      const code = 'PNC2027-002';
      const tab = termWorkbookFixture().tabs['BCU']!.filter((r) => r[0] !== code);
      const row = tab.find((r) => r[0] === 'PNC2027-001')!;
      row[5] = 66;
      row[10] = null;
      await archiveThenRestore(tab);
      await sync(sourceA, (await previewed(sourceA)).id);

      const { id: offeringId } = await bcu();
      const absent = await ctx.prisma.enrollment.findFirstOrThrow({
        where: { offeringId, student: { studentCode: code } },
        include: { scores: { include: { revisions: true } } },
      });
      expect(absent.status).toBe('WITHDRAWN');
      expect(absent.scores.length).toBeGreaterThan(0);
      expect(absent.scores.every((s) => s.status === 'CLEARED')).toBe(true);
      expect(absent.scores.every((s) => s.revisions.length === 2)).toBe(true);

      const live = await ctx.prisma.assessmentScore.findMany({
        where: { offeringId, status: { not: 'CLEARED' } },
        include: { criterion: { select: { key: true } } },
      });
      expect(live.map((s) => `${s.criterion.key}=${s.mark.toNumber()}`)).toEqual([
        'PARTICIPATION=66',
      ]);
    });

    it('stays stable when synced again', async () => {
      await archiveThenRestore();
      await sync(sourceA, (await previewed(sourceA)).id);
      const before = await snapshot();
      expect((await sync(sourceA)).status).toBe('SUCCEEDED');
      expect(await snapshot()).toEqual(before);
    });

    it('also returns through a replacement sheet, and starts fresh', async () => {
      reader.set(SHEET_A, without('BCU'));
      await sync(sourceA, (await previewed(sourceA)).id);
      reader.set(SHEET_B, { ...termWorkbookFixture(), title: 'Sheet B' });
      const id = await replaceWith();
      const p = await previewed(id);
      expect(p.summary.comparison.added).toEqual([
        { subject: 'BCU', tabName: 'BCU', returning: true },
      ]);
      expect((await sync(id)).status).toBe('SUCCEEDED');
      expect(await titles()).toContain('BCU');
    });
  });

  describe('access', () => {
    it('rejects non-admins', async () => {
      reader.set(SHEET_A, without('BCU'));
      const p = await preview(sourceA);
      await student.post(`${V1}/sources/${sourceA}/preview`).expect(403);
      await student
        .post(`${V1}/sources/${sourceA}/preview/${p.id}/confirm`, { acknowledgeRemovals: true })
        .expect(403);
      await student
        .post(`${V1}/sync`, { scope: 'SOURCE', sourceId: sourceA, previewId: p.id })
        .expect(403);
    });

    it('keeps one active sync per term', async () => {
      const first = await admin.post(`${V1}/sync`, { scope: 'SOURCE', sourceId: sourceA });
      expect(first.status).toBe(202);
      const second = await admin.post(`${V1}/sync`, { scope: 'SOURCE', sourceId: sourceA });
      expect(second.status).toBe(409);
      expect(second.body.error.code).toBe('SYNC_IN_PROGRESS');
      await run(first.body.jobId);
    });
  });

  describe('rules that do not change', () => {
    it('keeps the scores of a student missing from a tab', async () => {
      const sheet = termWorkbookFixture();
      sheet.tabs['Logic'] = sheet.tabs['Logic']!.filter((r) => r[0] !== 'PNC2027-001');
      reader.set(SHEET_A, sheet);
      await sync(sourceA);
      expect(await titles()).toContain('Logic');
      const enrollment = await ctx.prisma.enrollment.findFirstOrThrow({
        where: { student: { studentCode: 'PNC2027-001' }, offering: { title: 'Logic' } },
        include: { scores: true },
      });
      expect(enrollment.presentInSource).toBe(false);
      expect(enrollment.scores.length).toBeGreaterThan(0);
    });

    it('stops a tab whose component column was removed until it is confirmed again', async () => {
      const sheet = termWorkbookFixture();
      sheet.tabs['Logic'] = sheet.tabs['Logic']!.map((row) => row.filter((_, i) => i !== 6));
      reader.set(SHEET_A, sheet);
      const job = await sync(sourceA);
      expect(job.status).toBe('SUCCEEDED_WITH_ERRORS');
      expect(await issueCodes(job.id)).toContain('NEEDS_REMAP');
      expect(await titles()).toContain('Logic');
      const scores = await ctx.prisma.assessmentScore.count({
        where: { criterion: { key: 'QUIZ_2', offering: { title: 'Logic' } } },
      });
      expect(scores).toBe(3);
    });

    it('leaves an unmapped tab as a warning on an active sheet with no removals', async () => {
      const sheet = termWorkbookFixture();
      sheet.tabs['Science'] = subjectTab(88, 77);
      reader.set(SHEET_A, sheet);
      const p = await preview(sourceA);
      expect(p.summary.canConfirm).toBe(true);
      await confirmPreview(sourceA, p.id, false);
      expect((await sync(sourceA, p.id)).status).toBe('SUCCEEDED');
    });
  });
});
