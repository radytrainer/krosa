import { csvCell, toCsv, UTF8_BOM } from './csv.js';

describe('csv', () => {
  it('quotes separators, quotes and newlines', () => {
    expect(csvCell('plain')).toBe('plain');
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('line\nbreak')).toBe('"line\nbreak"');
    expect(csvCell(null)).toBe('');
    expect(csvCell(12.5)).toBe('12.5');
  });

  it('neutralizes spreadsheet formulas', () => {
    expect(csvCell('=HYPERLINK("http://evil")')).toBe('"\'=HYPERLINK(""http://evil"")"');
    expect(csvCell('+1')).toBe("'+1");
    expect(csvCell('-2')).toBe("'-2");
    expect(csvCell('@SUM(A1)')).toBe("'@SUM(A1)");
  });

  it('builds a document with BOM and CRLF', () => {
    expect(toCsv(['a', 'b'], [['1', '2']])).toBe(`${UTF8_BOM}a,b\r\n1,2\r\n`);
    expect(UTF8_BOM.charCodeAt(0)).toBe(0xfeff);
  });
});
