#!/usr/bin/env node
// Load test of the results read path (docs/implementation-plan.md Phase 9).
//
//   node scripts/load-test.mjs --base http://localhost:4100 --password <student password> \
//     --admin-password <admin password> [--students 9] [--connections 50] [--duration 20]
//
// Needs an API whose WEB_ORIGIN is --origin, RATE_LIMIT_PER_MINUTE raised far above the request
// volume, and data where students GEN2026-1 … GEN2026-<students> share --password (see
// docs/progress.md, "Phase 9 verification"). Login itself stays limited to 10/min per IP, so
// at most 9 students plus the admin are signed in.
//
// Scenario A: GET /student/me/results, rotating through the signed-in students (cache path).
// Scenario B: GET /admin/students/:id/results over many students (never cached: full assembly).
import autocannon from 'autocannon';
import { parseArgs } from 'node:util';

const { values: opts } = parseArgs({
  options: {
    base: { type: 'string', default: 'http://localhost:4100' },
    origin: { type: 'string', default: 'http://localhost:3100' },
    password: { type: 'string' },
    'admin-user': { type: 'string', default: 'admin' },
    'admin-password': { type: 'string' },
    students: { type: 'string', default: '9' },
    connections: { type: 'string', default: '50' },
    duration: { type: 'string', default: '20' },
  },
});
if (!opts.password || !opts['admin-password']) {
  console.error('--password and --admin-password are required');
  process.exit(2);
}

async function login(identifier, password) {
  const res = await fetch(`${opts.base}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: opts.origin },
    body: JSON.stringify({ identifier, password }),
  });
  if (!res.ok) throw new Error(`login ${identifier}: ${res.status} ${await res.text()}`);
  const access = res.headers.getSetCookie().find((c) => c.startsWith('ssrs_at='));
  return access.split(';')[0];
}

async function run(title, requestFor) {
  let i = 0;
  const result = await autocannon({
    url: opts.base,
    connections: Number(opts.connections),
    duration: Number(opts.duration),
    requests: [
      {
        method: 'GET',
        setupRequest: (req) => {
          const { path, cookie } = requestFor(i++);
          return { ...req, path, headers: { ...req.headers, cookie } };
        },
      },
    ],
  });
  const { latency, requests, non2xx, errors } = result;
  console.log(
    `${title}\n  ${requests.total} requests, ${requests.average.toFixed(0)} req/s, ` +
      `latency p50 ${latency.p50} ms · p97.5 ${latency.p97_5} ms · p99 ${latency.p99} ms · max ${latency.max} ms, ` +
      `non-2xx ${non2xx}, errors ${errors}`,
  );
  return result;
}

const students = Number(opts.students);
const studentCookies = [];
for (let n = 1; n <= students; n++) studentCookies.push(await login(`GEN2026-${n}`, opts.password));
const adminCookie = await login(opts['admin-user'], opts['admin-password']);

// Student ids for scenario B (admin list, 100 per page).
const ids = [];
for (let page = 1; ids.length < 1000; page++) {
  const res = await fetch(`${opts.base}/api/v1/admin/students?pageSize=100&page=${page}`, {
    headers: { cookie: adminCookie },
  });
  const body = await res.json();
  if (!body.data?.length) break;
  ids.push(...body.data.map((s) => s.id));
}

const a = await run('A. GET /student/me/results (cached per student)', (i) => ({
  path: '/api/v1/student/me/results',
  cookie: studentCookies[i % studentCookies.length],
}));
const b = await run(
  `B. GET /admin/students/:id/results over ${ids.length} students (uncached)`,
  (i) => ({
    path: `/api/v1/admin/students/${ids[i % ids.length]}/results`,
    cookie: adminCookie,
  }),
);
process.exit(a.non2xx || b.non2xx || a.errors || b.errors ? 1 : 0);
