/**
 * Sheets just connected in this browser tab, whose tabs are read once, automatically, when their
 * page opens (decisions.md TD1). Kept in memory only: a reload, a saved link or another tab never
 * starts a detection, so it never runs on page loads. The "Detect tabs" button stays for later.
 */
const justConnected = new Set<string>();

export function requestAutoDetect(sourceId: string): void {
  justConnected.add(sourceId);
}

/** True once for a sheet just connected; the request is used up at the same time. */
export function takeAutoDetect(sourceId: string): boolean {
  return justConnected.delete(sourceId);
}
