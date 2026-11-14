import { latestTermHighest } from './latest-term.js';
import type { CourseResultView } from './results.js';
import { topScoring } from './top-scoring.js';

let n = 0;
function course(
  status: CourseResultView['status'],
  finalScore: string | null = null,
  finalGrade: string | null = null,
  admin?: CourseResultView['admin'],
): CourseResultView {
  n++;
  return {
    offeringId: `o${n}`,
    termNumber: 1,
    courseCode: `C${n}`,
    title: `Subject ${n}`,
    credits: '1.0',
    status,
    schemeVersion: 1,
    criteria: [],
    finalScore,
    finalGrade,
    attemptedWeight: '100.000',
    earnedSoFar: finalScore ?? '40.00',
    teacherComment: null,
    ...(admin ? { admin } : {}),
  };
}
const ref = (c: CourseResultView) => ({
  offeringId: c.offeringId,
  courseCode: c.courseCode,
  title: c.title,
});
const admin = (
  visibility: 'HIDDEN' | 'VISIBLE',
  enrollmentStatus: 'ENROLLED' | 'WITHDRAWN' = 'ENROLLED',
): CourseResultView['admin'] => ({
  visibility,
  enrollmentStatus,
  endedReason: enrollmentStatus === 'WITHDRAWN' ? 'PROGRAM_SWITCH' : null,
  presentInSource: true,
});

describe('topScoring (decisions.md T1–T3)', () => {
  it('is the highest COMPLETE final score, with its grade', () => {
    const top = course('COMPLETE', '92.50', 'A');
    expect(topScoring([course('COMPLETE', '81.00', 'B'), top])).toEqual({
      finalScore: '92.50',
      finalGrade: 'A',
      subjects: [ref(top)],
    });
  });

  it('never counts an unfinished subject, whatever it has so far', () => {
    const done = course('COMPLETE', '55.00', 'E');
    const result = topScoring([
      course('INCOMPLETE'),
      course('NEEDS_REVIEW'),
      course('NOT_CONFIGURED'),
      done,
    ]);
    expect(result?.subjects).toEqual([ref(done)]);
  });

  it('is null (no final score yet, never a zero) when no subject is COMPLETE', () => {
    expect(topScoring([])).toBeNull();
    expect(topScoring([course('INCOMPLETE'), course('NEEDS_REVIEW')])).toBeNull();
  });

  it('shows every tied subject, in the order given; ties compare as displayed', () => {
    const a = course('COMPLETE', '90.00', 'A');
    const b = course('COMPLETE', '88.00', 'B');
    const c = course('COMPLETE', '90.00', 'A');
    expect(topScoring([a, b, c])).toEqual({
      finalScore: '90.00',
      finalGrade: 'A',
      subjects: [ref(a), ref(c)],
    });
  });

  it('keeps a null grade when there is no usable scale (never a default letter)', () => {
    expect(topScoring([course('COMPLETE', '70.00', null)])?.finalGrade).toBeNull();
  });

  it('admin views: counts and marks hidden subjects, also when hidden is the top', () => {
    const hidden = course('COMPLETE', '97.00', 'A', admin('HIDDEN'));
    const shown = course('COMPLETE', '97.00', 'A', admin('VISIBLE'));
    const lower = course('COMPLETE', '80.00', 'B', admin('VISIBLE'));
    expect(topScoring([lower, hidden, shown])?.subjects).toEqual([
      { ...ref(hidden), hiddenFromStudent: true },
      { ...ref(shown), hiddenFromStudent: false },
    ]);
  });

  it('admin views: a withdrawn enrollment never counts, like Courses complete', () => {
    const withdrawn = course('COMPLETE', '99.00', 'A', admin('VISIBLE', 'WITHDRAWN'));
    const kept = course('COMPLETE', '60.00', 'D', admin('VISIBLE'));
    expect(topScoring([withdrawn, kept])).toMatchObject({
      finalScore: '60.00',
      subjects: [{ offeringId: kept.offeringId }],
    });
    expect(topScoring([withdrawn])).toBeNull();
  });

  it('student views carry no visibility field at all', () => {
    const subject = topScoring([course('COMPLETE', '75.00', 'C')])!.subjects[0]!;
    expect(subject).not.toHaveProperty('hiddenFromStudent');
  });

  it('agrees with the dashboard: the latest term highest is that term Top scoring', () => {
    const courses = [
      course('COMPLETE', '84.00', 'B'),
      course('COMPLETE', '91.25', 'A'),
      course('INCOMPLETE'),
      course('COMPLETE', '91.25', 'A'),
    ];
    const top = topScoring(courses)!;
    const latest = latestTermHighest([{ number: 2, name: 'Term 2', courses }])!;
    expect(latest).toEqual({ termNumber: 2, termName: 'Term 2', ...top });
  });
});
