import type { UserRole } from '@ssrs/database';

/** The authenticated principal, derived only from a verified access token. */
export interface AuthUser {
  userId: string;
  role: UserRole;
  sessionId: string;
  mustChangePassword: boolean;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}
