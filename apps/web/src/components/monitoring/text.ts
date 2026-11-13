import type { ProgramRef, SubjectAudience } from '@ssrs/shared';

/**
 * For names and titles that may be Khmer: the app font is Latin-only, so list Khmer-capable fonts
 * next, and wrap instead of truncating (frontend rules).
 */
export const KHMER_SAFE =
  "[font-family:var(--font-sans),'Noto_Sans_Khmer','Khmer_OS_System','Khmer_UI','Leelawadee_UI',sans-serif] break-words whitespace-normal";

export function programCodes(programs: ProgramRef[]): string {
  return programs.map((p) => p.code).join(', ');
}

/** "Shared · WEP, SNAC" or "WEP". */
export function audienceLabel(audience: SubjectAudience): string {
  const codes = programCodes(audience.programs);
  return audience.kind === 'SHARED' ? `Shared${codes ? ` · ${codes}` : ''}` : codes || '-';
}

/** "1.5" → "1.5%", null → "-". */
export function percent(value: string | null): string {
  return value === null ? '-' : `${value}%`;
}
