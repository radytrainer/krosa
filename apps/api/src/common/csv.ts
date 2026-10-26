/**
 * CSV encoding (RFC 4180) with protection against formula injection: cells that a spreadsheet
 * would interpret as a formula (=, +, -, @, tab, CR) are prefixed with a single quote (OWASP).
 */
const FORMULA_START = /^[=+\-@\t\r]/;
/** Byte-order mark, spelled out so formatters cannot turn it into an invisible literal. */
export const UTF8_BOM = String.fromCharCode(0xfeff);

export function csvCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '';
  let text = String(value);
  if (typeof value === 'string' && FORMULA_START.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(
  header: readonly string[],
  rows: readonly (readonly (string | number | null | undefined)[])[],
): string {
  // BOM so Excel opens UTF-8 names correctly; CRLF line endings per RFC 4180.
  return `${UTF8_BOM}${[header, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n')}\r\n`;
}
