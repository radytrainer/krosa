import type { Request } from 'express';

export interface RequestMeta {
  ip: string | null;
  userAgent: string | null;
  requestId: string | null;
}

/** Client metadata for audit logs and sessions. `req.ip` honours TRUST_PROXY_HOPS. */
export function requestMeta(req: Request): RequestMeta {
  const ua = req.headers['user-agent'];
  const id = (req as Request & { id?: unknown }).id;
  return {
    ip: req.ip ?? null,
    userAgent: typeof ua === 'string' ? ua.slice(0, 256) : null,
    requestId: typeof id === 'string' ? id : null,
  };
}
