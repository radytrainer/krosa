import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { UserRole } from '@ssrs/database';
import { errors, jwtVerify, SignJWT } from 'jose';
import { API_ENV, type ApiEnv } from '../config/env.js';
import type { AuthUser } from './auth.types.js';

export const JWT_ISSUER = 'ssrs-api';
export const JWT_AUDIENCE = 'ssrs-web';

export type AccessTokenResult =
  { ok: true; user: AuthUser } | { ok: false; reason: 'EXPIRED' | 'INVALID' };

const ROLES: readonly UserRole[] = ['ADMIN', 'STUDENT'];

/** Constant-time comparison of two strings. */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

@Injectable()
export class TokenService {
  private readonly key: Uint8Array;
  private readonly csrfKey: Buffer;

  constructor(@Inject(API_ENV) private readonly env: ApiEnv) {
    this.key = new TextEncoder().encode(env.JWT_ACCESS_SECRET);
    // Domain-separated sub-key so CSRF tokens can never be confused with JWT signatures.
    this.csrfKey = createHmac('sha256', env.JWT_ACCESS_SECRET).update('ssrs:csrf:v1').digest();
  }

  get accessTokenTtlSeconds(): number {
    return this.env.ACCESS_TOKEN_TTL_SECONDS;
  }

  async signAccessToken(user: AuthUser, now = new Date()): Promise<string> {
    const iat = Math.floor(now.getTime() / 1000);
    return new SignJWT({ role: user.role, sid: user.sessionId, mcp: user.mustChangePassword })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setSubject(user.userId)
      .setIssuer(JWT_ISSUER)
      .setAudience(JWT_AUDIENCE)
      .setIssuedAt(iat)
      .setExpirationTime(iat + this.env.ACCESS_TOKEN_TTL_SECONDS)
      .sign(this.key);
  }

  async verifyAccessToken(token: string, now = new Date()): Promise<AccessTokenResult> {
    try {
      const { payload } = await jwtVerify(token, this.key, {
        issuer: JWT_ISSUER,
        audience: JWT_AUDIENCE,
        algorithms: ['HS256'],
        currentDate: now,
        requiredClaims: ['sub', 'exp', 'iat'],
      });
      const { sub, role, sid, mcp } = payload as Record<string, unknown>;
      if (
        typeof sub !== 'string' ||
        typeof sid !== 'string' ||
        typeof mcp !== 'boolean' ||
        !ROLES.includes(role as UserRole)
      ) {
        return { ok: false, reason: 'INVALID' };
      }
      return {
        ok: true,
        user: { userId: sub, role: role as UserRole, sessionId: sid, mustChangePassword: mcp },
      };
    } catch (err) {
      if (err instanceof errors.JWTExpired) return { ok: false, reason: 'EXPIRED' };
      return { ok: false, reason: 'INVALID' };
    }
  }

  /** 256-bit opaque refresh token (base64url). Only its hash is stored. */
  generateRefreshToken(): string {
    return randomBytes(32).toString('base64url');
  }

  hashRefreshToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  /** CSRF token bound to the session: HMAC(sessionId). Prevents cookie-tossing attacks. */
  csrfTokenForSession(sessionId: string): string {
    return createHmac('sha256', this.csrfKey).update(sessionId).digest('base64url');
  }

  verifyCsrfToken(sessionId: string, presented: string | undefined): boolean {
    if (!presented) return false;
    return safeEqual(this.csrfTokenForSession(sessionId), presented);
  }
}
