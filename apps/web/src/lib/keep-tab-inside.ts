import type { KeyboardEvent } from 'react';

const FOCUSABLE = 'a[href], button, input, select, textarea, [tabindex]';

/**
 * Wraps Tab at the edges of a modal popup. Base UI only wraps from a guard element one frame
 * later, so a second quick Tab would land on the page behind the popup.
 */
export function keepTabInside(event: KeyboardEvent<HTMLElement>): void {
  if (event.key !== 'Tab') return;
  const popup = event.currentTarget;
  const items = [...popup.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (el) => el.tabIndex >= 0 && !el.matches(':disabled') && el.getClientRects().length > 0,
  );
  const first = items[0];
  const last = items.at(-1);
  if (!first || !last) return;
  const active = popup.ownerDocument.activeElement;
  const atEdge = event.shiftKey ? active === first || active === popup : active === last;
  if (!atEdge) return;
  event.preventDefault();
  (event.shiftKey ? last : first).focus();
}
