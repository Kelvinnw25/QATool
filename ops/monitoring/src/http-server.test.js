import assert from 'node:assert/strict';
import { request } from 'node:http';
import { after, before, test } from 'node:test';

import { createCollector } from './collector.js';
import { loadConfig } from './config.js';
import { createMonitorServer } from './http-server.js';

const SECRET = 'hunter22222secret';
let app;
let port;
let polled = 0;

before(async () => {
  // Port 0 lets the OS pick; the allowed Host values are computed from the configured port, so
  // start on a fixed high port and fall back to retrying if it is taken.
  for (let candidate = 38_300; candidate < 38_340; candidate++) {
    const config = loadConfig({ MONITOR_PORT: String(candidate), MONITOR_POLL_MS: '3000' });
    const collector = createCollector({
      config,
      adapters: [
        {
          name: 'backend',
          timeoutMs: 500,
          collect: async () => {
            polled += 1;
            return { healthy: true, httpStatus: 200, latencyMs: 3 };
          },
        },
        {
          // A failing adapter whose error message contains credentials: they must not be served.
          name: 'apayee',
          timeoutMs: 500,
          collect: async () => {
            throw new Error(
              `failed Authorization: Bearer abcdefghijklmnop1234 TICKET_SECRET=${SECRET}`
            );
          },
        },
      ],
    });
    app = createMonitorServer({ config, collector });
    try {
      await app.listen();
      port = candidate;
      await collector.runOnce();
      return;
    } catch (error) {
      if (error.code !== 'EADDRINUSE') throw error;
    }
  }
  throw new Error('no free test port');
});

after(async () => {
  await app?.close();
});

/** A raw request, so the Host header and method can be set exactly. */
function call(path, { method = 'GET', headers = {}, host = `127.0.0.1:${port}` } = {}) {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port, path, method, headers: { host, ...headers } },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
      }
    );
    req.on('error', reject);
    req.end();
  });
}

test('it listens on the loopback only', () => {
  const address = app.server.address();
  assert.equal(address.address, '127.0.0.1');
  assert.equal(address.port, port);
});

test('it refuses to start on a non-loopback address', () => {
  assert.throws(() => loadConfig({ MONITOR_HOST: '0.0.0.0' }), /loopback/);
});

test('the page and its assets are served with strict headers and no CORS', async () => {
  for (const [path, type] of [
    ['/', 'text/html'],
    ['/app.js', 'text/javascript'],
    ['/app.css', 'text/css'],
    ['/format.js', 'text/javascript'],
  ]) {
    const r = await call(path);
    assert.equal(r.status, 200, path);
    assert.match(r.headers['content-type'], new RegExp(type));
    assert.equal(r.headers['cache-control'], 'no-store');
    assert.equal(r.headers['x-content-type-options'], 'nosniff');
    assert.equal(r.headers['x-frame-options'], 'DENY');
    assert.match(r.headers['content-security-policy'], /default-src 'none'/);
    assert.match(r.headers['content-security-policy'], /frame-ancestors 'none'/);
    assert.equal(r.headers['access-control-allow-origin'], undefined);
    assert.equal(r.headers['access-control-allow-credentials'], undefined);
  }
});

test('a foreign Host header is refused (DNS rebinding)', async () => {
  for (const host of [
    'evil.example',
    'evil.example:' + port,
    '192.168.1.5:' + port,
    `127.0.0.1:${port + 1}`,
    'qatool-staging.vercel.app',
  ]) {
    const r = await call('/api/status', { host });
    assert.equal(r.status, 403, host);
    assert.equal(r.body.includes('abcdefghijklmnop'), false);
  }
  assert.equal((await call('/api/status', { host: `localhost:${port}` })).status, 200);
});

test('/api/status returns the view, with credentials from a failing adapter masked', async () => {
  const r = await call('/api/status');
  assert.equal(r.status, 200);
  const view = JSON.parse(r.body);
  assert.equal(view.readings.backend.state, 'ok');
  assert.equal(view.readings.apayee.state, 'unavailable');
  assert.doesNotMatch(r.body, new RegExp(`${SECRET}|abcdefghijklmnop1234`));
});

test('the snapshot export is a download, sanitized, and has no secret-like key', async () => {
  const r = await call('/api/snapshot');
  assert.equal(r.status, 200);
  assert.match(
    r.headers['content-disposition'],
    /^attachment; filename="qatool-ops-snapshot-.*\.json"$/
  );
  const snap = JSON.parse(r.body);
  assert.equal(snap.kind, 'qatool-ops-snapshot');
  assert.ok(snap.exportedAt);
  assert.ok(snap.notice);
  assert.doesNotMatch(r.body, new RegExp(`${SECRET}|abcdefghijklmnop1234`));
  assert.doesNotMatch(r.body, /"(token|secret|password|authorization|ticket)"/i);
  assert.deepEqual(Object.keys(snap.readings).sort(), ['apayee', 'backend']);
});

test('monitoring cannot be used to change anything: only GET/HEAD and one POST that merely polls', async () => {
  for (const method of ['PUT', 'DELETE', 'PATCH', 'POST']) {
    for (const path of [
      '/api/status',
      '/api/snapshot',
      '/api/jobs',
      '/api/jobs/abc/cancel',
      '/api/restart',
      '/',
    ]) {
      const r = await call(path, { method, headers: { 'x-ops-monitor': '1' } });
      assert.ok([404, 405].includes(r.status), `${method} ${path} -> ${r.status}`);
    }
  }
  assert.equal((await call('/nope')).status, 404);
  assert.equal((await call('/../../etc/passwd')).status, 404);
  assert.equal((await call('/%2e%2e/%2e%2e/package.json')).status, 404);
});

test('POST /api/refresh needs the custom header and a same-origin (or no) Origin', async () => {
  assert.equal((await call('/api/refresh', { method: 'POST' })).status, 403);
  assert.equal(
    (
      await call('/api/refresh', {
        method: 'POST',
        headers: { 'x-ops-monitor': '1', origin: 'https://evil.example' },
      })
    ).status,
    403
  );
  assert.equal(
    (
      await call('/api/refresh', {
        method: 'POST',
        headers: { 'x-ops-monitor': '1', 'sec-fetch-site': 'cross-site' },
      })
    ).status,
    403
  );

  const before = polled;
  await new Promise((r) => setTimeout(r, 1100)); // past the minimum refresh gap
  const ok = await call('/api/refresh', {
    method: 'POST',
    headers: { 'x-ops-monitor': '1', origin: `http://127.0.0.1:${port}` },
  });
  assert.equal(ok.status, 200);
  assert.ok(JSON.parse(ok.body).monitor.cycles >= 2);
  assert.ok(polled > before);
});

test('GET /api/refresh is not a thing, and OPTIONS (a CORS preflight) is not answered', async () => {
  assert.equal((await call('/api/refresh')).status, 404);
  const pre = await call('/api/refresh', {
    method: 'OPTIONS',
    headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' },
  });
  assert.ok([404, 405].includes(pre.status));
  assert.equal(pre.headers['access-control-allow-origin'], undefined);
});

test('no route exposes QATOOL job control or the monitored systems', async () => {
  for (const path of [
    '/api/jobs',
    '/api/extract',
    '/v1/health',
    '/metrics',
    '/snapshot',
    '/apayee',
  ]) {
    assert.equal((await call(path)).status, 404, path);
  }
});

test('/healthz is the monitor itself being alive, and says nothing else', async () => {
  const r = await call('/healthz');
  assert.equal(r.status, 200);
  assert.equal(r.body, '{"status":"ok"}');
  assert.equal(
    (await call('/healthz', { method: 'POST', headers: { 'x-ops-monitor': '1' } })).status,
    405
  );
  // It is still behind the Host check.
  assert.equal((await call('/healthz', { host: 'evil.example' })).status, 403);
});
