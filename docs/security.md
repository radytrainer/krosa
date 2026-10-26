# Security Design

## 1. Threat model (summary)

| Asset                   | Threat                            | Primary controls                                                                                                          |
| ----------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Student results         | Another student reads them (IDOR) | Identity from session only; student routes take no student identifier; 404 on foreign resources; tests                    |
| Admin functions         | Student escalates                 | `RolesGuard` on every admin controller (deny by default); tests enumerate all admin routes                                |
| Accounts                | Brute force / credential stuffing | Throttling (IP + identifier), progressive lockout, Argon2id, generic errors                                               |
| Sessions                | Token theft / replay              | HttpOnly cookies, short access TTL, refresh rotation with reuse detection, revocation denylist                            |
| Browser                 | CSRF / XSS                        | SameSite + session-bound CSRF token + Origin check; CSP via Next.js headers; React escaping; no `dangerouslySetInnerHTML` |
| Google credentials      | Leak                              | Server-only env/secret file, read-only scope, never logged or returned                                                    |
| Academic data integrity | Bad import                        | Validate-then-apply, unique constraints, revisions, draft schemes, generation-code guard                                  |
| Logs                    | Secret leakage                    | pino redaction paths, Sentry `beforeSend` scrubbing, audit metadata allowlist                                             |

## 2. Authentication

- **Hashing**: Argon2id (`argon2` package), parameters m=19 MiB, t=2, p=1 (OWASP minimum), stored
  as PHC strings (parameters upgradeable; rehash on login when parameters change).
- **Login**: `identifier` is trimmed and matched case-insensitively (`users.username` is citext;
  student usernames are the normalized student code). When the account doesn't exist, a full
  Argon2 verification against a dummy hash equalizes timing, and the response is identical to a
  wrong password (`INVALID_CREDENTIALS`). Status-specific errors (`ACCOUNT_DISABLED`,
  `ACCOUNT_PENDING`, `TEMPORARY_PASSWORD_EXPIRED`) are only returned after the password has been
  verified, so they reveal nothing to someone guessing passwords.
- **Lockout**: the 5th consecutive failure locks the account for 1 min, and each further failure doubles
  the lock (2, 4, 8 min), capped at 15 min. The counter is incremented atomically and reset on success
  or password change. A locked account returns 429 `ACCOUNT_LOCKED` with `Retry-After`. Admins unlock
  an account by resetting its password (Phase 3).
- **Access token**: JWT HS256, `JWT_ACCESS_SECRET` (≥ 32 random bytes), 15 min, claims
  `sub, role, sid, mcp (mustChangePassword)`, `iss`/`aud` validated.
- **Refresh token**: 32 random bytes base64url, cookie only, SHA-256 hash stored. Rotation on every
  refresh; old token marked used. Presenting a used token revokes the whole session (reuse
  detection). Absolute session lifetime 7 days. No `JWT_REFRESH_SECRET` is needed because refresh
  tokens are opaque, not JWTs.
- **Revocation**: logout / password change / disable / reuse detection set `auth_sessions.revoked_at`
  and write `ssrs:v1:auth:revoked:{sid}` to Redis with TTL = access TTL. The JWT guard rejects
  revoked `sid`s. If Redis is unavailable the guard falls back to a DB lookup (fail closed, not open).
- **Forced password change**: `MustChangePasswordGuard` allows only routes marked
  `@AllowWhenPasswordChangeRequired` (`/auth/me`, `/auth/change-password`; login, refresh and logout are
  public) while `mcp` is true. A successful change re-issues the access cookie with `mcp=false` and
  revokes the user's other sessions.
  Temporary passwords past `password_expires_at` cannot log in (admin must re-issue).
- **Password policy**: min 10 chars, max 128, rejects username/student ID and a bundled list of
  common passwords. No composition rules (NIST 800-63B).

## 3. Cookies, CSRF, CORS

- Same-origin deployment (`/api` behind the same host as the web app). Cookies `Secure` in
  production, `HttpOnly` for tokens, `SameSite=Lax` (access) / `Strict` (refresh).
- CSRF has two layers, applied to every unsafe method by the global `CsrfGuard`:
  1. `Origin` (or `Referer`) must equal `WEB_ORIGIN`. A missing Origin is rejected. This also stops
     login CSRF.
  2. Authenticated requests must send `X-CSRF-Token` equal to `HMAC-SHA256(k_csrf, sessionId)`, where
     `k_csrf` is derived from `JWT_ACCESS_SECRET` with a domain label. The token is delivered in the
     JS-readable `ssrs_csrf` cookie and compared in constant time. Binding it to the session (rather
     than comparing a random cookie with a header) defeats cookie-tossing from a sibling subdomain.
     `/auth/refresh` and `/auth/logout` verify the token against the session that owns the refresh
     cookie, because the access token may already have expired.
- A refresh that fails CSRF does **not** clear cookies, so a forged request can't log the victim out.
- CORS: disabled by default (same origin). If `CORS_ORIGINS` is set, only those exact origins with
  `credentials: true`; never `*` (rejected at startup). The CSRF Origin check accepts the same list.
  Verified by `apps/api/test/security.integration-spec.ts`.

## 4. Authorization

- Global guards order: IpThrottle → Auth (skipped for `@Public()`) → UserThrottle → Csrf →
  MustChangePassword → Roles.
- Controllers under `/admin/*` carry `@Roles('ADMIN')` at class level; `/student/*` carry
  `@Roles('STUDENT')`. A unit test walks Nest's route metadata to fail CI if any non-public route
  lacks a role decorator.
- Student services accept the `AuthUser` principal, never a raw ID from the request.

## 5. Google credentials

Preferred: mount the service-account JSON as a file (Docker secret) and set
`GOOGLE_APPLICATION_CREDENTIALS=/run/secrets/google-sa.json`. Alternative for platforms without
file secrets: `GOOGLE_SERVICE_ACCOUNT_EMAIL` + `GOOGLE_PRIVATE_KEY` (with `\n` escapes). Exactly one
mechanism must be configured. Startup validation enforces this. Scope:
`https://www.googleapis.com/auth/spreadsheets.readonly`. The worker needs the credentials; the API
needs them only for registration checks.

## 6. Transport & headers

- HTTPS terminated by Caddy (automatic Let's Encrypt), HSTS 1 year.
- API: Helmet defaults, `Cache-Control: no-store` on all authenticated responses.
- Web: CSP set per request in `apps/web/src/proxy.ts`: `script-src 'self' 'nonce-…' 'strict-dynamic'`
  (fresh nonce per request; Next.js stamps it on its own scripts), `style-src 'self' 'unsafe-inline'`
  (toast and chart libraries inject `<style>` at runtime), `object-src 'none'`, `base-uri 'self'`,
  `form-action 'self'`, `frame-ancestors 'none'`, `connect-src 'self'`. Because a nonce only exists at
  request time, pages are rendered per request (root layout: `connection()` + `instant = false`); a
  prerendered shell would carry no nonce. Subresource Integrity alone was tried and rejected: it
  covers script files but not the inline scripts Next.js uses to stream page data. Plus
  `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy`
  minimal, `X-Content-Type-Options: nosniff`.

## 7. Rate limiting

Redis fixed-window counters (`RateLimiter`), keyed by a hash of the subject so raw usernames and IPs
never sit in Redis. If Redis is unavailable every limiter fails **open**; the database-backed account
lockout still protects accounts. Responses: 429 `RATE_LIMITED` with `Retry-After`.

| Scope                                        | Limit                               | Where                                                       |
| -------------------------------------------- | ----------------------------------- | ----------------------------------------------------------- |
| Every request, per client IP                 | 300/min (`RATE_LIMIT_PER_MINUTE`)   | `IpThrottleGuard`, before authentication; `/health*` exempt |
| `/auth/login`                                | 10/min per IP, 5/min per identifier | `AuthService`                                               |
| `/auth/refresh`                              | 30/min per IP                       | `@Throttle` (IP guard)                                      |
| `/auth/change-password`                      | 5/min per user                      | `AuthService`                                               |
| Credential issuance + resets (shared budget) | 20/min per admin                    | `@Throttle` (user guard, after authentication)              |
| `POST /admin/sync`                           | 10/min per admin                    | `SyncService`                                               |

The plan named `@nestjs/throttler`; the project's own limiter was extended instead (one mechanism,
same fail-open behaviour, no extra storage adapter). Route limits are declared with
`@Throttle({ bucket, perIp?, perUser? })`. Client IPs honour `TRUST_PROXY_HOPS`.

## 8. Logging, audit, monitoring

- `nestjs-pino` JSON logs, `requestId` (from `X-Request-Id` or generated) on every line; worker logs
  carry `syncJobId`. Redaction: `req.headers.cookie`, `req.headers.authorization`, `*.password`,
  `*.newPassword`, `*.currentPassword`, `*.temporaryPassword`, `*.token`, `*.privateKey`.
- Sentry (`@ssrs/shared/node`, API 5xx that are not deliberate HTTP errors, worker final failures):
  off unless `SENTRY_DSN` is set. Sentry 11 collects request data and **stack-frame local
  variables** by default; every `dataCollection` option is turned off (a frame of the password
  service would otherwise carry the plain password). `beforeSend` keeps only the request method and
  path; HTTP breadcrumbs are dropped; no tracing.
- Audit logs: append-only, metadata via allowlisted fields, retained 3 years (configurable).
  Only admins can read them.

## 9. Data protection & retention

- Academic records retained indefinitely by default (institutional policy may override); archived,
  never auto-deleted.
- Sync error rows retained 1 year, application logs 30 days, backups 30 daily + 12 monthly.
- Test fixtures use synthetic data only.
- PostgreSQL and Redis reachable only on the internal Docker network; Redis requires a password
  (`requirepass`) and has dangerous commands renamed/disabled.

## 10. Administrator bootstrap

There are no default credentials. The first admin is created with
`pnpm admin:create --username <name> [--display-name "…"]`. The password is prompted without echo
(or read from piped stdin for automation), must pass the password policy, is never logged, and
creation is audited as `admin.created` (actor SYSTEM).

## 11. Student provisioning and credential delivery (PROV-01…04)

- **Provisioning (sync).** A new student gets a STUDENT user in status PENDING with
  `must_change_password = true` and the password hash `!locked:<random>`, the Unix convention for a
  locked password. It is not a PHC string, so verification always fails. PENDING accounts are refused at
  login anyway. Generating the marker costs nothing, while Argon2-hashing a throwaway password for
  2,000 students would take minutes. Each provisioning is audited (`student.provisioned`, actor
  SYSTEM). Existing accounts are never modified by sync: password, status and sessions stay untouched.
- **Issuing credentials (admin).** `POST /admin/students/:id/reset-password` (one student) or
  `POST /admin/students/issue-credentials` (≤ 500 per request, CSV download) generates 16-character
  random temporary passwords (~79 bits, no look-alike characters). They are hashed with Argon2id,
  expire after `TEMP_PASSWORD_TTL_DAYS`, force a password change at first login, and revoke existing
  sessions. Plain passwords exist only in that single response (`Cache-Control: no-store`). They are
  never stored, logged or audited. The audit records who issued credentials to whom.
- **Default is non-destructive.** Bulk issuance only targets PENDING accounts unless
  `onlyPending: false` is sent explicitly, so repeating it never resets passwords that students
  already use.
- **CSV safety.** Cells starting with `= + - @`, tab or CR are prefixed with `'` so spreadsheet
  programs never evaluate them as formulas (OWASP CSV injection).
- **Operational requirement.** The downloaded file contains live credentials. Hand it to the class
  teacher through an approved channel (in person or via the institution's secure file share), delete it
  after distribution, and never email it as a plain attachment. Lost or expired temporary passwords are
  re-issued per student with reset-password.

## 12. Secrets

All secrets via environment or Docker secrets, validated at startup (Zod). `.env` is git-ignored;
`.env.example` contains placeholders only. Rotation: changing `JWT_ACCESS_SECRET` invalidates
access tokens (users silently refresh); revoking all sessions is available via an admin CLI script.
