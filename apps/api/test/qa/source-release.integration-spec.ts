/* eslint-disable -- QA suite: supertest .expect() chains */
import { termWorkbookFixture } from '@ssrs/sheets/testing';
import {
  ADMIN_V1,
  createHarness,
  SHEET_B,
  sheetUrl,
  V1,
  type Api,
  type Harness,
} from './support.js';

/**
 * Hide and Release from the Sync Center's per-source list, and "Release scores after sync"
 * (docs/decisions.md R1–R5). A source is one term's workbook; every action acts on the term.
 */

const CODE = 'PNC2027-001';

interface ReleaseRow {
  sourceId: string;
  state: string;
  subjects: number;
  visibleSubjects: number;
  students: number;
  term: { id: string; number: number };
}

describe('QA R: per-source Hide and Release', () => {
  let h: Harness;
  let sourceId: string;
  let student: Api;

  const status = async (...ids: string[]) =>
    (await h.admin.get(`${ADMIN_V1}/sources/release?ids=${ids.join(',')}`).expect(200))
      .body as ReleaseRow[];
  const setRelease = (sourceIds: string[], visible: boolean) =>
    h.admin.post(`${ADMIN_V1}/sources/release`, { sourceIds, visible });
  const studentView = async () => {
    const [results, courses, summary] = await Promise.all([
      student.get(`${V1}/student/me/results`).expect(200),
      student.get(`${V1}/student/me/courses`).expect(200),
      student.get(`${V1}/student/me/summary`).expect(200),
    ]);
    return { results: results.body, courses: courses.body, summary: summary.body };
  };
  const audits = (action: string) =>
    h.ctx.prisma.auditLog.findMany({ where: { action }, orderBy: { createdAt: 'asc' } });

  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(async () => h.close());

  beforeEach(async () => {
    await h.reset();
    sourceId = await h.importSheet(undefined, { release: false });
    student = await h.activate(CODE);
  });

  it('reports the state with subject and student counts; changes nothing', async () => {
    const before = await h.counts();
    const [row] = await status(sourceId);
    expect(row).toMatchObject({ sourceId, state: 'HIDDEN', visibleSubjects: 0 });
    expect(row!.subjects).toBeGreaterThan(0);
    expect(row!.students).toBeGreaterThan(0);
    expect(row!.term.number).toBe(1);
    expect(await h.counts()).toEqual(before);
    await h.admin.get(`${ADMIN_V1}/sources/release?ids=`).expect(400);
    await h.admin.get(`${ADMIN_V1}/sources/release?ids=not-a-uuid`).expect(400);
  });

  it('releases a source: students see it at once; audited with admin, source, term and states', async () => {
    // A cached view of "nothing released" must not survive the release.
    expect((await studentView()).courses).toEqual([]);
    const [row] = await status(sourceId);

    const res = await setRelease([sourceId], true).expect(200);
    expect(res.body).toEqual([
      {
        sourceId,
        termId: h.termId,
        oldState: 'HIDDEN',
        newState: 'RELEASED',
        subjects: row!.subjects,
        students: row!.students,
      },
    ]);
    expect((await status(sourceId))[0]).toMatchObject({
      state: 'RELEASED',
      visibleSubjects: row!.subjects,
    });
    const view = await studentView();
    expect(view.courses.length).toBeGreaterThan(0);
    expect(view.summary.overall.totalCourses).toBe(view.courses.length);

    const [entry, ...more] = await audits('source.released');
    expect(more).toEqual([]);
    const admin = await h.ctx.prisma.user.findFirstOrThrow({ where: { role: 'ADMIN' } });
    expect(entry).toMatchObject({
      actorType: 'USER',
      actorUserId: admin.id,
      entityType: 'source',
      entityId: sourceId,
      metadata: {
        sourceId,
        termId: h.termId,
        termNumber: 1,
        generationId: h.generationId,
        oldState: 'HIDDEN',
        newState: 'RELEASED',
        subjects: row!.subjects,
        students: row!.students,
      },
    });
    expect(entry!.createdAt).toBeInstanceOf(Date);
  });

  it('hides a source: absent from every student response and number; all data kept', async () => {
    await setRelease([sourceId], true).expect(200);
    const shown = await studentView();
    const titles: string[] = shown.courses.map((c: { title: string }) => c.title);
    const ids: string[] = shown.courses.map((c: { offeringId: string }) => c.offeringId);
    expect(titles.length).toBeGreaterThan(0);
    const before = await h.counts();

    const res = await setRelease([sourceId], false).expect(200);
    expect(res.body[0]).toMatchObject({ oldState: 'RELEASED', newState: 'HIDDEN' });

    const hidden = await studentView();
    expect(hidden.courses).toEqual([]);
    expect(hidden.results.terms.flatMap((t: { courses: unknown[] }) => t.courses)).toEqual([]);
    expect(hidden.summary.overall).toMatchObject({ totalCourses: 0, completedCourses: 0 });
    expect(hidden.summary.overall.provisionalAverage).toBeNull();
    expect(hidden.summary.latestTermHighest).toBeNull();
    const text = JSON.stringify(hidden);
    for (const t of titles) expect(text).not.toContain(t);
    for (const id of ids) {
      expect(text).not.toContain(id);
      await student.get(`${V1}/student/me/courses/${id}`).expect(404);
    }
    // Nothing deleted: same rows; the admin still sees every subject.
    expect(await h.counts()).toEqual(before);
    const studentRow = await h.ctx.prisma.student.findUniqueOrThrow({
      where: { studentCode: CODE },
    });
    const adminView = await h.admin
      .get(`${ADMIN_V1}/students/${studentRow.id}/results`)
      .expect(200);
    expect(
      adminView.body.terms.flatMap((t: { courses: unknown[] }) => t.courses).length,
    ).toBeGreaterThan(0);
    expect((await audits('source.hidden'))[0]?.metadata).toMatchObject({
      sourceId,
      oldState: 'RELEASED',
      newState: 'HIDDEN',
    });
  });

  it('an open course page gets 404 on its very next request after a hide, like an unknown id', async () => {
    await setRelease([sourceId], true).expect(200);
    const [first] = (await studentView()).courses as { offeringId: string }[];
    expect(first).toBeDefined();
    const path = `${V1}/student/me/courses/${first!.offeringId}`;
    // Warm the student's cached view with this exact course, as an open page would.
    await student.get(path).expect(200);
    await student.get(path).expect(200);

    await setRelease([sourceId], false).expect(200);
    const hidden = await student.get(path).expect(404);
    const unknown = await student
      .get(`${V1}/student/me/courses/00000000-0000-4000-8000-000000000000`)
      .expect(404);
    // Same answer, no detail: a student cannot tell a hidden subject from one that never existed.
    const shape = (b: { error: Record<string, unknown> }) => {
      const { requestId: _id, ...rest } = b.error;
      return rest;
    };
    expect(shape(hidden.body)).toEqual({ code: 'NOT_FOUND', message: 'Course not found' });
    expect(shape(unknown.body)).toEqual(shape(hidden.body));
  });

  it('shows Partly released; student numbers ignore the hidden subject; release covers the term', async () => {
    await setRelease([sourceId], true).expect(200);
    const all = await studentView();
    const hiddenOne = all.courses[0] as { offeringId: string; title: string };
    await h.ctx.prisma.courseOffering.update({
      where: { id: hiddenOne.offeringId },
      data: { visibility: 'HIDDEN' },
    });
    await h.ctx.prisma.generation.update({
      where: { id: h.generationId },
      data: { cacheVersion: { increment: 1 } },
    });
    const [row] = await status(sourceId);
    expect(row).toMatchObject({ state: 'PARTLY_RELEASED', visibleSubjects: row!.subjects - 1 });

    const partly = await studentView();
    expect(partly.courses).toHaveLength(all.courses.length - 1);
    expect(partly.summary.overall.totalCourses).toBe(all.courses.length - 1);
    expect(JSON.stringify(partly)).not.toContain(hiddenOne.offeringId);
    if (partly.summary.latestTermHighest) {
      expect(
        partly.summary.latestTermHighest.subjects.map((s: { offeringId: string }) => s.offeringId),
      ).not.toContain(hiddenOne.offeringId);
    }

    const res = await setRelease([sourceId], true).expect(200);
    expect(res.body[0]).toMatchObject({ oldState: 'PARTLY_RELEASED', newState: 'RELEASED' });
    expect((await studentView()).courses).toHaveLength(all.courses.length);
  });

  it('bulk: one audit entry per source; a term listed twice changes once', async () => {
    // A replacement sheet waiting for review: a second source of the same term.
    h.reader.set(SHEET_B, termWorkbookFixture());
    const pending = (
      await h.admin
        .post(`${ADMIN_V1}/terms/${h.termId}/sources/change`, {
          url: sheetUrl(SHEET_B),
          label: 'Sheet B',
        })
        .expect(201)
    ).body as { id: string };
    const res = await setRelease([sourceId, pending.id, sourceId], true).expect(200);
    expect(res.body.map((r: { sourceId: string }) => r.sourceId)).toEqual([sourceId, pending.id]);
    expect(res.body.map((r: { oldState: string }) => r.oldState)).toEqual(['HIDDEN', 'HIDDEN']);
    const entries = await audits('source.released');
    expect(entries.map((e) => e.entityId).toSorted()).toEqual([sourceId, pending.id].toSorted());
    expect(await status(sourceId, pending.id)).toEqual([
      expect.objectContaining({ sourceId, state: 'RELEASED' }),
      expect.objectContaining({ sourceId: pending.id, state: 'RELEASED' }),
    ]);
  });

  it('rejects bad requests and students; changes nothing on failure', async () => {
    const before = await h.counts();
    await setRelease([], true).expect(400);
    await setRelease([sourceId], 'yes' as unknown as boolean).expect(400);
    await setRelease(['00000000-0000-7000-8000-000000000000'], true).expect(404);
    // A term with nothing synced yet.
    const admin = await h.ctx.prisma.user.findFirstOrThrow({ where: { role: 'ADMIN' } });
    const empty = await h.ctx.prisma.googleSheetSource.create({
      data: {
        generationId: h.generationId,
        termId: h.terms[2]!,
        spreadsheetId: SHEET_B,
        label: 'T2',
        createdById: admin.id,
      },
    });
    const res = await setRelease([sourceId, empty.id], true).expect(422);
    expect(res.body.error.code).toBe('NOTHING_TO_RELEASE');
    // All or nothing: the first source was not released either.
    expect((await status(sourceId))[0]!.state).toBe('HIDDEN');
    expect(await audits('source.released')).toEqual([]);

    await student
      .post(`${ADMIN_V1}/sources/release`, { sourceIds: [sourceId], visible: true })
      .expect(403);
    await student.get(`${ADMIN_V1}/sources/release?ids=${sourceId}`).expect(403);
    await student.get(`${ADMIN_V1}/sync/plan?scope=ALL`).expect(403);
    expect(await h.counts()).toEqual(before);
  });

  it('the term button and the source action share one logic and one state', async () => {
    await h.admin.post(`${ADMIN_V1}/terms/${h.termId}/release`, { visible: true }).expect(200);
    expect((await status(sourceId))[0]!.state).toBe('RELEASED');
    expect((await audits('term.released'))[0]?.metadata).toMatchObject({
      oldState: 'HIDDEN',
      newState: 'RELEASED',
    });
    await setRelease([sourceId], false).expect(200);
    const generation = (await h.admin.get(`${ADMIN_V1}/generations/${h.generationId}`).expect(200))
      .body;
    expect(generation.terms[0]).toMatchObject({ visibleSubjects: 0 });
  });

  describe('Release scores after sync', () => {
    const syncWith = async (body: Record<string, unknown>) => {
      const { jobId } = (await h.admin.post(`${ADMIN_V1}/sync`, body).expect(202)).body;
      return jobId as string;
    };

    it('off by default: a sync leaves hidden scores hidden', async () => {
      const jobId = await syncWith({ scope: 'SOURCE', sourceId });
      await h.runJob(jobId);
      const job = (await h.admin.get(`${ADMIN_V1}/sync/${jobId}`).expect(200)).body;
      expect(job).toMatchObject({
        releaseAfterSync: false,
        status: expect.stringMatching(/SUCCEEDED/),
      });
      expect((await status(sourceId))[0]!.state).toBe('HIDDEN');
      expect(await audits('source.released')).toEqual([]);
    });

    it('on: the term is released once the sync succeeds, audited with the job', async () => {
      const jobId = await syncWith({ scope: 'SOURCE', sourceId, releaseAfterSync: true });
      expect((await status(sourceId))[0]!.state).toBe('HIDDEN'); // not before the run
      await h.runJob(jobId);
      expect((await status(sourceId))[0]!.state).toBe('RELEASED');
      expect((await studentView()).courses.length).toBeGreaterThan(0);
      const [entry] = await audits('source.released');
      expect(entry).toMatchObject({
        entityId: sourceId,
        metadata: expect.objectContaining({
          sourceId,
          termId: h.termId,
          oldState: 'HIDDEN',
          newState: 'RELEASED',
          syncJobId: jobId,
        }),
      });
      const job = (await h.admin.get(`${ADMIN_V1}/sync/${jobId}`).expect(200)).body;
      expect(job.releaseAfterSync).toBe(true);
    });

    it('a failed sync releases nothing; a retry does not carry the choice', async () => {
      h.reader.fail(SHEET_B, 'SHEET_NOT_FOUND');
      await h.ctx.prisma.googleSheetSource.update({
        where: { id: sourceId },
        data: { spreadsheetId: SHEET_B },
      });
      const jobId = await syncWith({ scope: 'SOURCE', sourceId, releaseAfterSync: true });
      await h.runJob(jobId);
      const job = (await h.admin.get(`${ADMIN_V1}/sync/${jobId}`).expect(200)).body;
      expect(job.status).toBe('FAILED');
      expect((await status(sourceId))[0]!.state).toBe('HIDDEN');
      const retry = (await h.admin.post(`${ADMIN_V1}/sync/${jobId}/retry`).expect(202)).body;
      const retried = await h.ctx.prisma.syncJob.findUniqueOrThrow({ where: { id: retry.jobId } });
      expect(retried.releaseAfterSync).toBe(false);
    });

    it('a generation sync passes the choice to each workbook', async () => {
      const parentId = await syncWith({
        scope: 'GENERATION',
        generationId: h.generationId,
        releaseAfterSync: true,
      });
      const children = await h.ctx.prisma.syncJob.findMany({ where: { parentId } });
      expect(children.length).toBe(1);
      expect(children.every((c) => c.releaseAfterSync)).toBe(true);
      for (const c of children) await h.runJob(c.id);
      expect((await status(sourceId))[0]!.state).toBe('RELEASED');
    });

    it('the plan lists what a Sync Center sync reads, with release state; it changes nothing', async () => {
      const before = await h.counts();
      const byGeneration = await h.admin
        .get(`${ADMIN_V1}/sync/plan?scope=GENERATION&generationId=${h.generationId}`)
        .expect(200);
      expect(byGeneration.body).toEqual([
        expect.objectContaining({
          sourceId,
          state: 'HIDDEN',
          term: expect.objectContaining({ number: 1 }),
        }),
      ]);
      const byTerm = await h.admin
        .get(`${ADMIN_V1}/sync/plan?scope=TERM&generationId=${h.generationId}&termId=${h.termId}`)
        .expect(200);
      expect(byTerm.body.map((r: ReleaseRow) => r.sourceId)).toEqual([sourceId]);
      expect(
        (await h.admin.get(`${ADMIN_V1}/sync/plan?scope=ALL&termNumber=2`).expect(200)).body,
      ).toEqual([]);
      expect((await h.admin.get(`${ADMIN_V1}/sync/plan?scope=ALL`).expect(200)).body).toHaveLength(
        1,
      );
      await h.admin.get(`${ADMIN_V1}/sync/plan?scope=GENERATION`).expect(400);
      expect(await h.counts()).toEqual(before);
      expect(await h.ctx.prisma.syncJob.count()).toBe(1); // only the import's own job
    });
  });
});
