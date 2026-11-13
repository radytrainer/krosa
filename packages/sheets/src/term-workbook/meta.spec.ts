import type { Grid } from '../reader.js';
import { IssueLog } from '../template/issues.js';
import {
  capMetaValue,
  checkTermMeta,
  META_VALUE_MAX,
  isMetaIssueCode,
  parseMetaTerm,
  readTermMeta,
  sameGeneration,
  type MetaExpected,
} from './meta.js';

const GEN2027_T1: MetaExpected = { generationCode: 'GEN2027', termNumber: 1 };

const meta = (generation: unknown, term: unknown): Grid => [
  ['key', 'value'],
  ['template_version', 1],
  ['generation_code', generation as string],
  ['education_term', term as string],
];

function check(grid: Grid | null, expected = GEN2027_T1) {
  const log = new IssueLog();
  const result = checkTermMeta(grid, expected, log);
  return { result, issues: log.items, fatal: log.hasFileError };
}

describe('sameGeneration', () => {
  it('ignores surrounding spaces and case, nothing else', () => {
    expect(sameGeneration(' gen2027 ', 'GEN2027')).toBe(true);
    expect(sameGeneration('Gen2027', 'gen2027')).toBe(true);
    expect(sameGeneration('GEN 2027', 'GEN2027')).toBe(false);
    expect(sameGeneration('GEN-2027', 'GEN2027')).toBe(false);
    expect(sameGeneration('GEN2026', 'GEN2027')).toBe(false);
  });
});

describe('parseMetaTerm', () => {
  it.each([
    [1, 1],
    [2, 2],
    ['1', 1],
    [' 1 ', 1],
    ['Term 1', 1],
    ['term 2', 2],
    ['TERM  3', 3],
    ['Term1', 1],
    ['T1', 1],
    ['t 2', 2],
    [' T5 ', 5],
    ['Term 12', 12],
  ])('reads %j as term %d', (cell, n) => {
    expect(parseMetaTerm(cell)).toBe(n);
  });

  it.each([
    ['abc'],
    [''],
    ['Term'],
    ['Term one'],
    ['1.5'],
    [1.5],
    [0],
    ['0'],
    [-1],
    ['Semester 1'],
    ['Term 1 (2027)'],
    ['TT1'],
    ['100'],
    [true],
    [null],
    [undefined],
  ])('cannot read %j', (cell) => {
    expect(parseMetaTerm(cell as never)).toBeNull();
  });
});

describe('readTermMeta', () => {
  it('reads keys whatever their case and spacing, keeps values as written (trimmed)', () => {
    const grid: Grid = [
      [' GENERATION_CODE ', ' gen2027 '],
      ['Education_Term', ' Term 1 '],
    ];
    expect(readTermMeta(grid)).toEqual({
      present: true,
      found: { generationCode: 'gen2027', term: 'Term 1' },
      termNumber: 1,
    });
  });

  it('accepts the older `term` key', () => {
    expect(
      readTermMeta([
        ['generation_code', 'GEN2027'],
        ['term', 2],
      ]).termNumber,
    ).toBe(2);
  });

  it('reports a missing tab', () => {
    expect(readTermMeta(null)).toEqual({
      present: false,
      found: { generationCode: null, term: null },
      termNumber: null,
    });
  });
});

describe('checkTermMeta', () => {
  it.each([
    ['GEN2027', 1],
    [' gen2027 ', '1'],
    ['Gen2027', 'Term 1'],
    ['GEN2027', 'T1'],
    ['GEN2027', ' term 1 '],
  ])('accepts generation %j and term %j for GEN2027, Term 1', (generation, term) => {
    const { issues, fatal } = check(meta(generation, term));
    expect(issues).toEqual([]);
    expect(fatal).toBe(false);
  });

  it('refuses another generation, showing both values', () => {
    const { issues, fatal } = check(meta('GEN2026', 2));
    expect(fatal).toBe(true);
    expect(issues).toEqual([
      expect.objectContaining({
        severity: 'ERROR',
        scope: 'FILE',
        code: 'WORKBOOK_MISMATCH',
        sheetTab: '_meta',
        message:
          'This workbook is for GEN2026, Term 2. You selected GEN2027, Term 1. ' +
          'Choose the matching term or check the workbook.',
      }),
    ]);
  });

  it('refuses "GEN 2027" for GEN2027', () => {
    const { issues } = check(meta('GEN 2027', 1));
    expect(issues.map((i) => i.code)).toEqual(['WORKBOOK_MISMATCH']);
    expect(issues[0]!.message).toContain('This workbook is for GEN 2027, Term 1.');
  });

  it('refuses another term of the same generation; "T2" reads as Term 2', () => {
    const { issues } = check(meta('GEN2027', 'T2'));
    expect(issues.map((i) => i.code)).toEqual(['WORKBOOK_MISMATCH']);
    expect(issues[0]!.message).toBe(
      'This workbook is for GEN2027, Term 2. You selected GEN2027, Term 1. ' +
        'Choose the matching term or check the workbook.',
    );
  });

  it('shows the generation as written (original case) and the selected one as stored', () => {
    const { issues } = check(meta(' gen2026 ', 1), { generationCode: 'GEN2027', termNumber: 3 });
    expect(issues[0]!.message).toBe(
      'This workbook is for gen2026, Term 1. You selected GEN2027, Term 3. ' +
        'Choose the matching term or check the workbook.',
    );
  });

  it('refuses a workbook without _meta', () => {
    const { issues, fatal } = check(null);
    expect(fatal).toBe(true);
    expect(issues).toEqual([
      expect.objectContaining({
        scope: 'FILE',
        code: 'META_MISSING',
        message: 'The workbook has no _meta tab. Add one with generation_code and education_term.',
      }),
    ]);
  });

  it('refuses a blank or absent generation_code', () => {
    for (const grid of [meta('  ', 1), [['education_term', 1]] as Grid, meta(null, 1)]) {
      const { issues } = check(grid);
      expect(issues).toEqual([
        expect.objectContaining({ code: 'META_MISSING', message: '_meta has no generation_code.' }),
      ]);
    }
  });

  it('refuses a blank or absent education_term', () => {
    for (const grid of [meta('GEN2027', ''), [['generation_code', 'GEN2027']] as Grid]) {
      const { issues } = check(grid);
      expect(issues).toEqual([
        expect.objectContaining({ code: 'META_MISSING', message: '_meta has no education_term.' }),
      ]);
    }
  });

  it('refuses an education_term that is not a term number', () => {
    const { issues } = check(meta('GEN2027', 'abc'));
    expect(issues).toEqual([
      expect.objectContaining({
        code: 'META_MISSING',
        message: '_meta education_term "abc" cannot be read as a term number.',
        rawValue: 'abc',
      }),
    ]);
  });

  it('lists every missing value, and no mismatch until both can be read', () => {
    const { issues } = check([['template_version', 1]]);
    expect(issues.map((i) => i.message)).toEqual([
      '_meta has no generation_code.',
      '_meta has no education_term.',
    ]);
    const unreadable = check(meta('GEN2026', 'soon'));
    expect(unreadable.issues.map((i) => i.code)).toEqual(['META_MISSING']);
  });

  it('only the generation and term matter: other keys are ignored', () => {
    const grid = [...meta('GEN2027', 1), ['template_version', 'anything'], ['notes', 'x']];
    expect(check(grid).issues).toEqual([]);
  });
});

describe('long _meta values', () => {
  const long = `G${'X'.repeat(3999)}`;

  it('caps a value at 100 characters plus "…"', () => {
    expect(META_VALUE_MAX).toBe(100);
    expect(capMetaValue(long)).toBe(`${long.slice(0, 100)}…`);
    expect(capMetaValue('X'.repeat(100))).toBe('X'.repeat(100));
    expect(capMetaValue(null)).toBeNull();
  });

  it('shows at most 100 characters of a long generation_code or term in messages', () => {
    const mismatch = check(meta(long, 1)).issues[0]!;
    expect(mismatch.code).toBe('WORKBOOK_MISMATCH');
    expect(mismatch.message).toBe(
      `This workbook is for ${long.slice(0, 100)}…, Term 1. You selected GEN2027, Term 1. ` +
        'Choose the matching term or check the workbook.',
    );
    const unreadable = check(meta('GEN2027', long)).issues[0]!;
    expect(unreadable.message).toBe(
      `_meta education_term "${long.slice(0, 100)}…" cannot be read as a term number.`,
    );
  });

  it('still compares the full value', () => {
    // Same first 100 characters, different after: a mismatch, not a match.
    const expected = { generationCode: `${long.slice(0, 100)}Y`, termNumber: 1 };
    expect(check(meta(long, 1), expected).issues.map((i) => i.code)).toEqual(['WORKBOOK_MISMATCH']);
  });
});

describe('isMetaIssueCode', () => {
  it('names the two _meta codes only', () => {
    expect(isMetaIssueCode('META_MISSING')).toBe(true);
    expect(isMetaIssueCode('WORKBOOK_MISMATCH')).toBe(true);
    expect(isMetaIssueCode('TERM_MISMATCH')).toBe(false);
    expect(isMetaIssueCode('ROSTER_TAB_MISSING')).toBe(false);
  });
});
