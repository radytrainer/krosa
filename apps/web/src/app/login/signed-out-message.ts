/** The login page's note after the server ended a session (`/login?reason=...`). */

const DEFAULT_IDLE_MINUTES = 15;

function minutesText(idleTimeoutSeconds: number | null): string {
  const minutes =
    idleTimeoutSeconds && Number.isFinite(idleTimeoutSeconds) && idleTimeoutSeconds >= 60
      ? Math.round(idleTimeoutSeconds / 60)
      : DEFAULT_IDLE_MINUTES;
  return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`;
}

/**
 * The message for a `reason` query value, or null for none or an unknown one.
 * `idleTimeoutSeconds` comes from configuration when the browser still knows it.
 */
export function signedOutMessage(
  reason: string | null,
  idleTimeoutSeconds: number | null,
): string | null {
  if (reason === 'elsewhere') {
    return 'You were signed out because your account was signed in on another browser or device.';
  }
  if (reason === 'idle') {
    return `You were signed out after ${minutesText(idleTimeoutSeconds)} of inactivity.`;
  }
  return null;
}
