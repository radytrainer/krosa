#!/usr/bin/env node
// Black-box checks against a running local stack: API, worker and web, as separate processes.
// Refuses to run unless every target is localhost. Seeded demo data only.
//
//   QA_API=http://localhost:4100 QA_WEB=http://localhost:3100 QA_ADMIN_PASSWORD=... \
//   QA_LOG_DIR=<folder with the server logs> node docs/qa/scripts/live-check.mjs [section...]
//
// Sections: headers proxy secrets outage limit. Prints one line per check: PASS or FAIL, with the
// evidence. Exit code 1 if anything failed.
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const API = process.env.QA_API ?? 'http://localhost:4100';
const WEB = process.env.QA_WEB ?? 'http://localhost:3100';
const ORIGIN = process.env.QA_ORIGIN ?? WEB;
const V1 = `${API}/api/v1`;
const STUDENT = { id: 'GEN26-0001', password: 'Student-Pass-2026x' };
for (const url of [API, WEB, ORIGIN]) {
  if (new URL(url).hostname !== 'localhost') throw new Error(`Not local: ${url}`);
}

let failures = 0;
function check(id, ok, evidence) {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${id} ${evidence}`);
}

class Session {
  cookies = new Map();
  constructor(base = V1) {
    this.base = base;
  }
  header() {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  }
  async req(method, url, body, headers = {}) {
    const res = await fetch(url.startsWith('http') ? url : `${this.base}${url}`, {
      method,
      redirect: 'manual',
      headers: {
        Origin: ORIGIN,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(this.cookies.has('ssrs_csrf')
          ? { 'X-CSRF-Token': decodeURIComponent(this.cookies.get('ssrs_csrf')) }
          : {}),
        Cookie: this.header(),
        ...headers,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const i = pair.indexOf('=');
      this.cookies.set(pair.slice(0, i), pair.slice(i + 1));
    }
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* not JSON */
    }
    return { status: res.status, headers: res.headers, text, json };
  }
  get = (url, headers) => this.req('GET', url, undefined, headers);
  post = (url, body, headers) => this.req('POST', url, body, headers);
}

async function signIn(identifier, password, base) {
  const s = new Session(base);
  const res = await s.post('/auth/login', { identifier, password });
  if (res.status !== 200) throw new Error(`sign-in ${identifier}: ${res.status} ${res.text}`);
  return s;
}

const docker = (...args) => execFileSync('docker', args, { stdio: 'pipe' }).toString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const sections = {
  async headers() {
    const api = await fetch(`${API}/api/v1/health`);
    const h = api.headers;
    console.log('API headers:', JSON.stringify(Object.fromEntries(h)));
    check('G-09a', !h.has('x-powered-by'), 'no x-powered-by on API');
    check('G-09b', h.get('x-content-type-options') === 'nosniff', 'nosniff');
    check(
      'G-09c',
      h.get('cache-control') === 'no-store',
      `cache-control ${h.get('cache-control')}`,
    );
    check('G-09d', Boolean(h.get('content-security-policy')), 'API has a CSP');
    check('G-09d2', Boolean(h.get('strict-transport-security')), 'API sends HSTS');

    const res = await fetch(`${WEB}/login`);
    const w = res.headers;
    console.log('Web headers:', JSON.stringify(Object.fromEntries(w)));
    const csp = w.get('content-security-policy') ?? '';
    check('G-09e', /script-src[^;]*nonce-/.test(csp), `web CSP nonce: ${csp.slice(0, 90)}`);
    check('G-09f', /frame-ancestors 'none'/.test(csp), 'frame-ancestors none');
    check(
      'G-09g',
      w.get('x-frame-options') === 'DENY',
      `x-frame-options ${w.get('x-frame-options')}`,
    );
    check('G-09h', w.get('x-content-type-options') === 'nosniff', 'web nosniff');
    check('G-09i', !w.has('x-powered-by'), `web x-powered-by ${w.get('x-powered-by')}`);
    const again = (await fetch(`${WEB}/login`)).headers.get('content-security-policy');
    check('G-09j', again !== csp, 'nonce differs per request');

    const cors = await fetch(`${V1}/health`, { headers: { Origin: 'http://evil.example' } });
    check('G-10', !cors.headers.has('access-control-allow-origin'), 'no CORS for a foreign origin');
    const preflight = await fetch(`${V1}/auth/login`, {
      method: 'OPTIONS',
      headers: { Origin: 'http://evil.example', 'Access-Control-Request-Method': 'POST' },
    });
    check(
      'G-10b',
      !preflight.headers.has('access-control-allow-origin'),
      `preflight ${preflight.status}`,
    );
  },

  async proxy() {
    const anon = new Session(`${WEB}/api/v1`);
    check(
      'B-17a',
      (await anon.get('/admin/dashboard')).status === 401,
      'no token through proxy: 401',
    );
    const s = await signIn(STUDENT.id, STUDENT.password, `${WEB}/api/v1`);
    const r = await s.get('/admin/dashboard');
    check('B-17b', r.status === 403, `student on admin through proxy: ${r.status}`);
    const mine = await s.get('/student/me/results');
    check(
      'B-17c',
      mine.status === 200 && mine.json.student.studentCode === STUDENT.id,
      'own results',
    );
    const page = await fetch(`${WEB}/admin`, {
      headers: { Cookie: s.header() },
      redirect: 'manual',
    });
    const html = await page.text();
    check(
      'B-18a',
      page.status >= 300 ? true : !/Dashboard|awaiting credentials/i.test(html),
      `student GET /admin: ${page.status} ${page.headers.get('location') ?? ''}`,
    );
    const spoof = await fetch(`${WEB}/api/v1/admin/dashboard`, {
      headers: {
        Cookie: s.header(),
        'X-Forwarded-Host': 'evil.example',
        'x-middleware-subrequest': 'src/proxy:src/proxy:src/proxy:src/proxy:src/proxy',
      },
    });
    check('B-17d', spoof.status === 403, `middleware bypass header: ${spoof.status}`);
    const traverse = await fetch(`${WEB}/api/v1/..%2f..%2f..%2fetc/passwd`, { redirect: 'manual' });
    check('B-17e', traverse.status >= 400, `path traversal through proxy: ${traverse.status}`);
    await s.post('/auth/logout');
  },

  async secrets() {
    const admin = await signIn('admin', process.env.QA_ADMIN_PASSWORD);
    const list = await admin.get('/admin/students?q=GEN26-0003');
    const student = list.json.data[0];
    const issued = await admin.post(`/admin/students/${student.id}/reset-password`);
    const temp = issued.json.temporaryPassword;
    check('F-02L', Boolean(temp) && issued.headers.get('cache-control') === 'no-store', 'issued');
    const s = await signIn(student.studentCode, temp);
    const fresh = 'Harbor-Violet-Compass-91';
    const changed = await s.post('/auth/change-password', {
      currentPassword: temp,
      newPassword: fresh,
    });
    check('F-02M', changed.status === 204, `change password ${changed.status}`);
    await sleep(500);
    const secrets = {
      temporary: temp,
      'new password': fresh,
      'admin password': process.env.QA_ADMIN_PASSWORD,
      'student password': STUDENT.password,
      'access token': s.cookies.get('ssrs_at'),
      'refresh token': decodeURIComponent(s.cookies.get('ssrs_rt') ?? ''),
    };
    const dir = process.env.QA_LOG_DIR;
    if (dir) {
      const files = readdirSync(dir).filter((f) => /^live-.*\.log$/.test(f));
      const logs = files.map((f) => readFileSync(path.join(dir, f), 'utf8')).join('\n');
      for (const [name, value] of Object.entries(secrets)) {
        check(
          'A-26',
          !logs.includes(value),
          `${name} absent from ${files.length} log files, ${logs.length} bytes`,
        );
      }
      check('A-26b', !/\$argon2/.test(logs), 'no Argon2 hash in logs');
    } else {
      check('A-26', false, 'QA_LOG_DIR not set: logs not scanned');
    }
    const password = process.env.QA_PG_PASSWORD;
    const dump = execFileSync(
      'docker',
      [
        'exec',
        '-e',
        `PGPASSWORD=${password}`,
        'ssrs-qa-postgres-1',
        'pg_dump',
        '-U',
        'ssrs',
        '-d',
        'ssrs',
        '--data-only',
      ],
      { maxBuffer: 1 << 28 },
    ).toString();
    for (const [name, value] of Object.entries(secrets)) {
      check(
        'F-03',
        !dump.includes(value),
        `${name} absent from a full database dump (${dump.length} bytes)`,
      );
    }
    await s.post('/auth/logout');
    await admin.post('/auth/logout');
  },

  async outage() {
    const redis = 'ssrs-qa-redis-1';
    const pg = 'ssrs-qa-postgres-1';
    const student = await signIn(STUDENT.id, STUDENT.password);
    const admin = await signIn('admin', process.env.QA_ADMIN_PASSWORD);
    const generation = (await admin.get('/admin/generations')).json.data[0];

    docker('stop', '-t', '0', redis);
    await sleep(1500);
    try {
      const ready = await fetch(`${V1}/health/ready`);
      check('G-18a', ready.status === 503, `readiness with Redis down: ${ready.status}`);
      const live = await fetch(`${V1}/health`);
      check('G-18b', live.status === 200, `liveness with Redis down: ${live.status}`);
      const t = Date.now();
      const read = await student.get('/student/me/results');
      check(
        'G-18c',
        read.status === 200,
        `student reads with Redis down: ${read.status} in ${Date.now() - t} ms`,
      );
      const t2 = Date.now();
      const sync = await admin.post('/admin/sync', {
        scope: 'GENERATION',
        generationId: generation.id,
      });
      check(
        'G-18d',
        sync.status === 503 || sync.json?.error?.code === 'NO_SOURCES',
        `sync with Redis down: ${sync.status} ${sync.json?.error?.code} in ${Date.now() - t2} ms`,
      );
      const login = await new Session().post('/auth/login', {
        identifier: 'nobody',
        password: 'x',
      });
      check('G-18e', login.status === 401, `sign-in with Redis down: ${login.status}`);
    } finally {
      docker('start', redis);
    }
    await sleep(3000);
    const back = await fetch(`${V1}/health/ready`);
    check('G-18f', back.status === 200, `readiness after Redis returns: ${back.status}`);

    docker('stop', '-t', '0', pg);
    await sleep(1500);
    try {
      const ready = await fetch(`${V1}/health/ready`);
      check('G-19a', ready.status === 503, `readiness with PostgreSQL down: ${ready.status}`);
      const read = await student.get('/admin/dashboard');
      check(
        'G-19b',
        read.status < 500 || read.status === 503,
        `API call: ${read.status} ${read.text.slice(0, 120)}`,
      );
      const results = await student.get('/student/me/results');
      check(
        'G-19c',
        results.status === 503 && !/prisma|postgres|ECONNREFUSED/i.test(results.text),
        `results with PostgreSQL down: ${results.status} ${results.text.slice(0, 120)}`,
      );
    } finally {
      docker('start', pg);
    }
    for (let i = 0; i < 40; i++) {
      if ((await fetch(`${V1}/health/ready`)).status === 200) break;
      await sleep(500);
    }
    const again = await student.get('/student/me');
    check('G-19d', again.status === 200, `recovers without a restart: ${again.status}`);
  },

  async limit() {
    const s = new Session();
    let first429 = 0;
    let retryAfter = null;
    for (let i = 1; i <= 340; i++) {
      const r = await fetch(`${V1}/auth/me`);
      if (r.status === 429) {
        first429 = i;
        retryAfter = r.headers.get('retry-after');
        break;
      }
    }
    check(
      'G-14a',
      first429 > 0 && Boolean(retryAfter),
      `429 on request ${first429}, Retry-After ${retryAfter}`,
    );
    const health = await fetch(`${V1}/health`);
    check('G-14b', health.status === 200, `health exempt: ${health.status}`);
    const web = await fetch(`${WEB}/api/v1/auth/me`);
    console.log(`Through the proxy after the limit: ${web.status}`);
    void s;
  },
};

const wanted = process.argv.length > 2 ? process.argv.slice(2) : Object.keys(sections);
for (const name of wanted) {
  console.log(`--- ${name}`);
  await sections[name]();
}
console.log(failures ? `${failures} FAILED` : 'ALL PASSED');
process.exit(failures ? 1 : 0);
