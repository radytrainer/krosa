import 'reflect-metadata';
import { RequestMethod, type DynamicModule, type Type } from '@nestjs/common';
import { METHOD_METADATA, MODULE_METADATA, PATH_METADATA } from '@nestjs/common/constants.js';
import { AppModule } from '../app.module.js';
import { ANY_AUTHENTICATED, IS_PUBLIC, ROLES } from '../auth/decorators.js';
import { loadApiEnv } from '../config/env.js';

/**
 * Deny-by-default is enforced at runtime by RolesGuard; this test fails CI earlier, when a route
 * is added without an explicit access policy or with the wrong role for its area
 * (docs/security.md §4). It reads Nest's route metadata, so no app or database is started.
 */

type ModuleRef = Type<unknown> | DynamicModule | Promise<DynamicModule>;

function collectControllers(root: ModuleRef, seen = new Set<unknown>()): Type<unknown>[] {
  if (root instanceof Promise || seen.has(root)) return [];
  seen.add(root);
  const isDynamic = typeof root === 'object' && 'module' in root;
  const moduleClass = isDynamic ? root.module : root;
  const read = (key: string) => (Reflect.getMetadata(key, moduleClass) as unknown[]) ?? [];
  const controllers = [
    ...(read(MODULE_METADATA.CONTROLLERS) as Type<unknown>[]),
    ...((isDynamic ? root.controllers : []) ?? []),
  ];
  const imports = [...read(MODULE_METADATA.IMPORTS), ...((isDynamic ? root.imports : []) ?? [])];
  for (const imported of imports) {
    controllers.push(...collectControllers(imported as ModuleRef, seen));
  }
  return controllers;
}

interface Route {
  method: string;
  path: string;
  isPublic: boolean;
  roles: string[] | undefined;
  anyAuthenticated: boolean;
}

function routesOf(controller: Type<unknown>): Route[] {
  const base = String(Reflect.getMetadata(PATH_METADATA, controller) ?? '');
  const proto = controller.prototype as Record<string, unknown>;
  return Object.getOwnPropertyNames(proto).flatMap((name) => {
    const handler = proto[name];
    if (typeof handler !== 'function' || name === 'constructor') return [];
    const sub = Reflect.getMetadata(PATH_METADATA, handler) as string | undefined;
    if (sub === undefined) return [];
    const method = RequestMethod[Reflect.getMetadata(METHOD_METADATA, handler) as number] ?? '?';
    const meta = <T>(key: string): T | undefined =>
      (Reflect.getMetadata(key, handler) as T | undefined) ??
      (Reflect.getMetadata(key, controller) as T | undefined);
    return [
      {
        method,
        path: `/${[base, sub].filter((p) => p && p !== '/').join('/')}`.replaceAll('//', '/'),
        isPublic: meta<boolean>(IS_PUBLIC) ?? false,
        roles: meta<string[]>(ROLES),
        anyAuthenticated: meta<boolean>(ANY_AUTHENTICATED) ?? false,
      },
    ];
  });
}

const env = loadApiEnv({
  DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
  REDIS_URL: 'redis://localhost:6379/0',
  WEB_ORIGIN: 'http://localhost:3000',
  JWT_ACCESS_SECRET: 'x'.repeat(32),
});
const routes = collectControllers(AppModule.forRoot(env)).flatMap(routesOf);
const label = (r: Route) => `${r.method} ${r.path}`;

describe('route access policies', () => {
  it('finds the application routes', () => {
    expect(routes.length).toBeGreaterThan(50);
    expect(routes.map(label)).toContain('GET /student/me/results');
  });

  it('gives every route exactly one explicit policy', () => {
    const offenders = routes
      .filter(
        (r) => [r.isPublic, r.roles !== undefined, r.anyAuthenticated].filter(Boolean).length !== 1,
      )
      .map(label);
    expect(offenders).toEqual([]);
  });

  it('restricts /admin routes to ADMIN and /student routes to STUDENT', () => {
    const wrong = routes
      .filter(
        (r) =>
          (r.path.startsWith('/admin') && JSON.stringify(r.roles) !== '["ADMIN"]') ||
          (r.path.startsWith('/student') && JSON.stringify(r.roles) !== '["STUDENT"]'),
      )
      .map(label);
    expect(wrong).toEqual([]);
  });

  it('keeps the public surface to sign-in, refresh, logout and health', () => {
    const publicRoutes = routes
      .filter((r) => r.isPublic)
      .map(label)
      .toSorted();
    expect(publicRoutes).toEqual(
      [
        'GET /health',
        'GET /health/ready',
        'POST /auth/login',
        'POST /auth/logout',
        'POST /auth/refresh',
      ].toSorted(),
    );
  });
});
