import * as Sentry from '@sentry/node';

/**
 * Error reporting (docs/security.md §8, OBS-04). Disabled unless a DSN is configured. Events are
 * scrubbed before leaving the process: no cookies, headers, bodies, query strings or user data.
 */
export interface SentryOptions {
  dsn: string | undefined;
  environment: string;
  service: 'api' | 'worker';
}

let enabled = false;

/** Keeps only the method and path of the request; drops everything that may hold secrets. */
export function scrubEvent<E extends Sentry.Event>(event: E): E {
  if (event.request) {
    const url = event.request.url?.split('?')[0];
    event.request = { method: event.request.method, url };
  }
  delete event.user;
  if (event.breadcrumbs) {
    event.breadcrumbs = event.breadcrumbs.map(({ data: _data, ...crumb }) => crumb);
  }
  return event;
}

export function initSentry(options: SentryOptions): boolean {
  if (!options.dsn) return false;
  Sentry.init({
    dsn: options.dsn,
    environment: options.environment,
    // Sentry 11 collects request data, query data and local variables by default. Collect none
    // of it: a stack frame of the password service would otherwise carry the plain password.
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      httpBodies: [],
      urlQueryParams: false,
      databaseQueryData: false,
      queues: false,
      stackFrameVariables: false,
      graphQL: { document: false, variables: false },
      genAI: { inputs: false, outputs: false },
    },
    // Errors only; no performance tracing (it would record URLs and timings of every request).
    tracesSampleRate: 0,
    initialScope: { tags: { service: options.service } },
    beforeSend: (event) => scrubEvent(event),
    beforeBreadcrumb: (crumb) => {
      // HTTP breadcrumbs can contain URLs with tokens or Google API details.
      if (crumb.category === 'http' || crumb.category === 'fetch') return null;
      return crumb;
    },
  });
  enabled = true;
  return true;
}

/** Reports an unexpected error with a few safe tags. No-op when Sentry is disabled. */
export function reportError(error: unknown, tags: Record<string, string | undefined> = {}): void {
  if (!enabled) return;
  Sentry.withScope((scope) => {
    for (const [key, value] of Object.entries(tags)) if (value) scope.setTag(key, value);
    Sentry.captureException(error);
  });
}

/** Sends buffered events before the process exits. */
export async function flushSentry(timeoutMs = 2000): Promise<void> {
  if (enabled) await Sentry.flush(timeoutMs);
}
