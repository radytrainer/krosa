/* eslint-disable -- QA suite: uses expect messages, console evidence and supertest .expect() */
import { normalizeStudentId } from '@ssrs/shared';
import { describe, expect, it } from 'vitest';
import { parseMarkCell } from './cells.js';

/** QA suite, area D-07 and D-08: what a teacher can really type in a cell. */

describe('QA D-07 odd cell values', () => {
  it.each([
    ['ABS', 'ABSENT'],
    ['abs', 'ABSENT'],
    [' Abs ', 'ABSENT'],
  ])('%j is absent', (value, status) => {
    expect(parseMarkCell(value, '100')).toMatchObject({ kind: 'mark', status, mark: '0' });
  });

  it.each([
    [85, '85'],
    [0, '0'],
    [100, '100'],
    [99.999, '99.999'],
    [' 85 ', '85'],
    ['85.5', '85.5'],
    [-0, '0'],
  ])('%j is the mark %s', (value, mark) => {
    expect(parseMarkCell(value, '100')).toMatchObject({ kind: 'mark', status: 'RECORDED', mark });
  });

  it.each([[''], ['   '], [' '], [null], [undefined]])('%j is blank, never 0', (value) => {
    expect(parseMarkCell(value, '100')).toEqual({ kind: 'blank' });
  });

  it.each([
    [100.0001],
    [100.001],
    [-0.001],
    [-5],
    [120],
    ['120'],
    ['-5'],
    ['abc'],
    ['85%'],
    ['8,5'],
    ['1e2'],
    ['1E2'],
    ['0x10'],
    ['+85'],
    ['.5'],
    ['5.'],
    ['Infinity'],
    ['NaN'],
    ['#REF!'],
    ['#N/A'],
    ['#DIV/0!'],
    [true],
    [false],
    ['TRUE'],
    ['EX'],
    ['AB'],
    ['A B S'],
    ['ABS.'],
    ['85 90'],
    ['٨٥'], // Arabic-Indic digits
    ['８５'], // full-width digits
    ['2026-10-31'],
    [85.1234],
    [1e21],
    [1e-7],
    [Number.NaN],
    [Number.POSITIVE_INFINITY],
    ['85​'], // zero-width space that trim() does not remove
  ])('%j is rejected', (value) => {
    expect(parseMarkCell(value as never, '100').kind).toBe('invalid');
  });

  it('a formula result with float noise is rejected rather than rounded (recorded behavior)', () => {
    // =0.1*3*100 gives 30.000000000000004 in a spreadsheet. Documented: "Never rounds".
    expect(parseMarkCell(0.1 * 3 * 100, '100').kind).toBe('invalid');
  });
});

describe('QA D-08 student IDs', () => {
  it.each([
    ['PNC2027-001', 'PNC2027-001'],
    ['pnc2027-001', 'PNC2027-001'],
    ['  PNC2027-001  ', 'PNC2027-001'],
    [' PNC2027-001 ', 'PNC2027-001'],
    ['​PNC2027-001', 'PNC2027-001'],
    ['PNC2027-001﻿', 'PNC2027-001'],
  ])('%j normalizes to %s', (raw, value) => {
    expect(normalizeStudentId(raw)).toEqual({ ok: true, value });
  });

  it.each([
    ['PNC 2027-001'],
    ['PNC2027 001'],
    ['PNC2027/001'],
    ['-PNC'],
    ['X'.repeat(33)],
    ["PNC'; DROP TABLE users;--"],
    ['<script>'],
    ['ＰＮＣ２０２７'],
  ])('%j is refused', (raw) => {
    expect(normalizeStudentId(raw).ok).toBe(false);
  });

  it('blank is empty, not an error', () => {
    expect(normalizeStudentId('   ')).toMatchObject({ ok: false, reason: 'EMPTY' });
    expect(normalizeStudentId(null)).toMatchObject({ ok: false, reason: 'EMPTY' });
  });
});
