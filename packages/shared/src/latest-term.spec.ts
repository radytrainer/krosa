import { latestTermHighest } from './latest-term.js';
import type { CourseResultView } from './results.js';

let n = 0;
function course(
  status: CourseResultView['status'],
  finalScore: string | null = null,
  finalGrade: string | null = null,
): CourseResultView {
  n++;
  return {
    offeringId: `o${n}`,
    termNumber: 0,
    courseCode: `C${n}`,
    title: `Subject ${n}`,
    credits: '1.0',
    status,
    schemeVersion: 1,
    criteria: [],
    finalScore,
    finalGrade,
    attemptedWeight: '100.000',
    earnedSoFar: finalScore ?? '0.00',
    teacherComment: null,
  };
}
const term = (number: number, courses: CourseResultView[]) => ({
  number,
  name: `Term ${number}`,
  courses,
});

describe('latestTermHighest', () => {
  it('is null when no subject is released', () => {
    expect(latestTermHighest([term(1, []), term(2, [])])).toBeNull();
    expect(latestTermHighest([])).toBeNull();
  });

  it('takes the highest COMPLETE final score of the highest term with a released subject', () => {
    const t1 = term(1, [course('COMPLETE', '99.00', 'A')]);
    const top = course('COMPLETE', '92.50', 'A');
    const t2 = term(2, [
      course('COMPLETE', '81.00', 'B'),
      top,
      // An unfinished subject never counts, whatever it has so far.
      course('INCOMPLETE'),
      course('NEEDS_REVIEW'),
    ]);
    expect(latestTermHighest([t2, t1, term(3, [])])).toEqual({
      termNumber: 2,
      termName: 'Term 2',
      finalScore: '92.50',
      finalGrade: 'A',
      subjects: [{ offeringId: top.offeringId, courseCode: top.courseCode, title: top.title }],
    });
  });

  it('never falls back to an older term when the latest has no final score yet', () => {
    const result = latestTermHighest([
      term(1, [course('COMPLETE', '95.00', 'A')]),
      term(3, [course('INCOMPLETE'), course('NOT_CONFIGURED')]),
    ]);
    expect(result).toEqual({
      termNumber: 3,
      termName: 'Term 3',
      finalScore: null,
      finalGrade: null,
      subjects: [],
    });
  });

  it('returns every subject tied on the displayed score, in order', () => {
    const a = course('COMPLETE', '88.10', 'B');
    const b = course('COMPLETE', '88.10', 'B');
    const result = latestTermHighest([term(2, [a, course('COMPLETE', '88.09', 'B'), b])]);
    expect(result?.finalScore).toBe('88.10');
    expect(result?.subjects.map((s) => s.offeringId)).toEqual([a.offeringId, b.offeringId]);
  });

  it('keeps a missing grade as null instead of inventing one', () => {
    expect(latestTermHighest([term(1, [course('COMPLETE', '70.00', null)])])).toMatchObject({
      finalScore: '70.00',
      finalGrade: null,
    });
  });
});
