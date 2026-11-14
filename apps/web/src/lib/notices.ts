/**
 * One-time notices passed to a page in its URL (`?notice=<code>`). Only the codes listed here
 * are shown, with their fixed text: the URL never carries a message or a redirect target.
 */
export const NOTICES = {
  /** Hidden, withdrawn, not enrolled or nonexistent: one wording, so nothing can be told apart. */
  'course-unavailable': 'This course is no longer available.',
} as const;

export type NoticeCode = keyof typeof NOTICES;

export const NOTICE_PARAM = 'notice';

/** How long a notice stays on screen. */
export const NOTICE_DURATION_MS = 6000;

/** The fixed internal route a student lands on when a course cannot be shown. */
export const COURSE_UNAVAILABLE_REDIRECT = `/student?${NOTICE_PARAM}=course-unavailable`;

export function noticeText(code: string | null): string | null {
  return code !== null && Object.hasOwn(NOTICES, code) ? NOTICES[code as NoticeCode] : null;
}
