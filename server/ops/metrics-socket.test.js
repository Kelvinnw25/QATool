import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { lstat } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { createJobMetrics } from '../jobs/metrics.js';
import { startDemo, uploadForm, waitForState } from '../jobs/fixtures/demo.js';
import {
  MetricsSocketError,
  classifyExisting,
  createMetricsServer,
  isSocketLive,
  startMetricsSocket,
} from './metrics-socket.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const onWindows = process.platform === 'win32';
const skipWindows = onWindows
  ? 'Unix socket files do not exist on Windows; run on Linux or in the backend container'
  : false;

// --- the request rules, on any platform (served on a loopback test port instead of a socket) ---------

function listenForTest(snapshot, logger) {
  const server = createMetricsServer({ snapshot, logger });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }))
  );
}

function ask(port, { method = 'GET', url = '/snapshot', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: url, headers }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('the request rules', () => {
  const metrics = createJobMetrics();
  metrics.registerSource('jobs', () => ({
    queued: 2,
    processing: 1,
    completed: 3,
    failed: 0,
    cancelled: 1,
    workers_busy: 1,
    retained: 7,
  }));
  metrics.registerSource('workers', () => ({ configured: 1, effective: 1, busy: 1 }));
  metrics.inc('jobs_submitted', 7);
  let handle;
  const warnings = [];

  const ready = listenForTest(() => metrics.snapshot(), { warn: (...a) => warnings.push(a) }).then(
    (h) => (handle = h)
  );
  after(() => new Promise((resolve) => handle?.server.close(resolve)));

  test('GET /snapshot returns the actual metrics.snapshot() as JSON, and nothing else', async () => {
    await ready;
    const r = await ask(handle.port);
    assert.equal(r.status, 200);
    assert.match(r.headers['content-type'], /^application\/json/);
    assert.equal(r.headers['cache-control'], 'no-store');
    const body = JSON.parse(r.body);
    assert.equal(body.jobs.current.queued, 2);
    assert.equal(body.jobs.submitted, 7);
    assert.equal(body.workers.busy, 1);
    assert.deepEqual(Object.keys(body).sort(), Object.keys(metrics.snapshot()).sort());
  });

  test('every other method is refused', async () => {
    await ready;
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS']) {
      const r = await ask(handle.port, { method });
      assert.equal(r.status, 405, method);
      assert.equal(r.headers.allow, 'GET');
      assert.doesNotMatch(r.body, /queued/);
    }
  });

  test('every other path is refused, including near-misses', async () => {
    await ready;
    for (const url of [
      '/',
      '/metrics',
      '/snapshot/',
      '/snapshot?x=1',
      '/Snapshot',
      '/snapshot%2f',
      '//snapshot',
      '/api/jobs',
      '/healthz',
      '/../snapshot',
    ]) {
      const r = await ask(handle.port, { url });
      assert.equal(r.status, 404, url);
      assert.doesNotMatch(r.body, /queued/);
    }
  });

  test('no CORS headers and no cookie are ever sent', async () => {
    await ready;
    const r = await ask(handle.port, { headers: { origin: 'https://evil.example' } });
    for (const name of Object.keys(r.headers)) {
      assert.doesNotMatch(name, /^access-control-|^set-cookie$/);
    }
  });

  test('oversized request headers are refused', async () => {
    await ready;
    const r = await ask(handle.port, { headers: { 'x-pad': 'a'.repeat(8000) } });
    assert.equal(r.status, 431);
  });
});

describe('a snapshot that fails or is not safe is not served', () => {
  test('a throwing source gives a fixed 500 with no detail, and logs the reason once', async () => {
    const warnings = [];
    const { server, port } = await listenForTest(
      () => {
        throw new Error('boom TICKET_SECRET=hunter22222 at /app/server/x.js');
      },
      { warn: (...a) => warnings.push(a) }
    );
    try {
      for (let i = 0; i < 3; i++) {
        const r = await ask(port);
        assert.equal(r.status, 500);
        assert.equal(r.body, '{"error":"snapshot_unavailable"}');
      }
      assert.equal(warnings.length, 1, 'the same reason is not logged on every poll');
      assert.doesNotMatch(JSON.stringify(warnings), /hunter22222|\/app\/server/);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  test('a snapshot with a list, free text or a token is refused, never partly sent', async () => {
    for (const bad of [
      { sessions: ['sid-abc'] },
      { error_message: 'Bearer abcdefghijklmnop' },
      { ticket: 'eyJhbGciOiJIUzI1NiJ9.eyJzaWQiOiJhIn0.abcdefghij' },
    ]) {
      const { server, port } = await listenForTest(() => bad);
      try {
        const r = await ask(port);
        assert.equal(r.status, 500);
        assert.doesNotMatch(r.body, /sid-abc|Bearer|eyJ/);
      } finally {
        await new Promise((resolve) => server.close(resolve));
      }
    }
  });
});

test('classifyExisting: only a socket owned by this user is ever a candidate for removal', () => {
  const stat = (over = {}) => ({
    isSymbolicLink: () => false,
    isSocket: () => true,
    uid: 1000,
    ...over,
  });
  assert.equal(classifyExisting(null, 1000), 'absent');
  assert.equal(classifyExisting(stat(), 1000), 'probe');
  assert.equal(classifyExisting(stat({ isSymbolicLink: () => true }), 1000), 'refuse-symlink');
  assert.equal(classifyExisting(stat({ isSocket: () => false }), 1000), 'refuse-not-a-socket');
  assert.equal(classifyExisting(stat({ uid: 0 }), 1000), 'refuse-other-owner');
  // A symlink is refused even if it also reports as a socket.
  assert.equal(
    classifyExisting(stat({ isSymbolicLink: () => true, isSocket: () => true }), 1000),
    'refuse-symlink'
  );
});

test(
  'on Windows the feature refuses to start instead of creating a named pipe',
  { skip: !onWindows },
  async () => {
    await assert.rejects(
      startMetricsSocket({ socketPath: '/tmp/qatool-ops-metrics.sock', snapshot: () => ({}) }),
      (error) => error instanceof MetricsSocketError && /Windows/.test(error.message)
    );
  }
);

test('an unusable path is refused before anything is touched', async () => {
  for (const socketPath of ['relative.sock', '/tmp/../x.sock', '/etc/passwd', '']) {
    await assert.rejects(
      startMetricsSocket({ socketPath, snapshot: () => ({}) }),
      (error) => error instanceof MetricsSocketError
    );
  }
});

// --- the real socket file: Linux and macOS only ------------------------------------------------------

/**
 * Leaves a socket file with nothing behind it, as a crashed backend would: a child process starts
 * listening and is killed before it can clean up.
 */
function leaveDeadSocket(socketPath) {
  return new Promise((resolve, reject) => {
    const script =
      `require('net').createServer().listen(${JSON.stringify(socketPath)},` +
      `()=>process.kill(process.pid,'SIGKILL'))`;
    const child = spawn(process.execPath, ['-e', script], { stdio: 'ignore' });
    child.on('error', reject);
    child.on('exit', resolve);
  });
}

describe('the real Unix socket', { skip: skipWindows }, () => {
  const dir = onWindows ? null : mkdtempSync(path.join(os.tmpdir(), 'qatool-ops-'));
  after(() => dir && rmSync(dir, { recursive: true, force: true }));
  const sock = (name) => path.join(dir, name);

  const get = (socketPath, { method = 'GET', url = '/snapshot' } = {}) =>
    new Promise((resolve, reject) => {
      const req = http.request({ socketPath, method, path: url }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode, body }));
      });
      req.on('error', reject);
      req.end();
    });

  test('is created owner-only (0600), serves GET /snapshot, and is removed on close', async () => {
    const socketPath = sock('a.sock');
    const metrics = createJobMetrics();
    metrics.inc('jobs_submitted', 3);
    const handle = await startMetricsSocket({ socketPath, snapshot: () => metrics.snapshot() });

    const stat = await lstat(socketPath);
    assert.equal(stat.isSocket(), true);
    assert.equal(stat.mode & 0o777, 0o600);

    const ok = await get(socketPath);
    assert.equal(ok.status, 200);
    assert.equal(JSON.parse(ok.body).jobs.submitted, 3);
    assert.equal((await get(socketPath, { method: 'POST' })).status, 405);
    assert.equal((await get(socketPath, { url: '/other' })).status, 404);

    await handle.close();
    await assert.rejects(lstat(socketPath), { code: 'ENOENT' });
    await handle.close(); // closing twice is harmless
  });

  test('a stale socket left by a crash is replaced', async () => {
    const socketPath = sock('stale.sock');
    await leaveDeadSocket(socketPath);
    assert.equal((await lstat(socketPath)).isSocket(), true, 'precondition: a stale socket exists');

    const handle = await startMetricsSocket({ socketPath, snapshot: () => ({}) });
    assert.equal((await get(socketPath)).status, 200);
    await handle.close();
  });

  test('a live listener on the path is never removed, and the feature stays off', async () => {
    const socketPath = sock('live.sock');
    const other = net.createServer();
    await new Promise((resolve) => other.listen(socketPath, resolve));
    try {
      assert.equal(await isSocketLive(socketPath), true);
      await assert.rejects(
        startMetricsSocket({ socketPath, snapshot: () => ({}) }),
        (error) => error instanceof MetricsSocketError && /live listener/.test(error.message)
      );
      assert.equal((await lstat(socketPath)).isSocket(), true, 'the other listener keeps its file');
    } finally {
      await new Promise((resolve) => other.close(resolve));
    }
  });

  test('a regular file, a directory and a symlink are never touched', async () => {
    const victim = sock('victim.txt');
    writeFileSync(victim, 'precious');

    const regular = sock('regular.sock');
    writeFileSync(regular, 'not a socket');
    const directory = sock('dir.sock');
    mkdirSync(directory);
    const link = sock('link.sock');
    symlinkSync(victim, link);

    for (const socketPath of [regular, directory, link]) {
      await assert.rejects(
        startMetricsSocket({ socketPath, snapshot: () => ({}) }),
        (error) => error instanceof MetricsSocketError
      );
    }
    assert.equal(readFileSync(regular, 'utf8'), 'not a socket');
    assert.equal((await lstat(directory)).isDirectory(), true);
    assert.equal((await lstat(link)).isSymbolicLink(), true);
    assert.equal(readFileSync(victim, 'utf8'), 'precious');
  });

  test('a socket owned by someone else is refused', async () => {
    const socketPath = sock('foreign.sock');
    // Closing a server removes its file, so a dead socket must come from a killed process.
    await leaveDeadSocket(socketPath);
    // Pretend this process is a different user: the file is then "foreign".
    const me = process.getuid();
    await assert.rejects(
      startMetricsSocket({ socketPath, snapshot: () => ({}), uid: me + 1 }),
      (error) => error instanceof MetricsSocketError && /other-owner|owner/.test(error.message)
    );
  });
});

// --- end to end with a real job platform ----------------------------------------------------------------

test('the snapshot of a real demo app, after a real job, is served with true counts', async () => {
  const demo = await startDemo();
  try {
    const visitor = await demo.visitor('ops');
    const submitted = await demo.call('POST', '/api/jobs', {
      ticket: visitor.ticket,
      form: uploadForm(),
    });
    assert.equal(submitted.status, 202, JSON.stringify(submitted.body));
    await waitForState(demo, visitor, submitted.body.job.id, ['completed', 'failed']);

    const { server, port } = await listenForTest(() => demo.metrics.snapshot());
    try {
      const body = JSON.parse((await ask(port)).body);
      assert.equal(body.jobs.submitted, 1);
      assert.equal(body.jobs.completed + body.jobs.failed, 1);
      assert.equal(body.jobs.current.queued, 0);
      assert.equal(body.workers.configured, 1);
      // Counts only: no job id, no visitor, no ticket anywhere in the text.
      const text = JSON.stringify(body);
      assert.equal(text.includes(submitted.body.job.id), false);
      assert.equal(text.includes(visitor.ticket), false);
      assert.doesNotMatch(text, /Demo Project|U253|ADMI/);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }

    // The public API gained no way to read any of this.
    for (const url of ['/snapshot', '/metrics', '/api/metrics', '/api/snapshot', '/api/ops']) {
      const r = await demo.call('GET', url, { ticket: visitor.ticket });
      assert.ok([401, 404].includes(r.status), `${url} -> ${r.status}`);
      assert.doesNotMatch(JSON.stringify(r.body), /"submitted"/);
    }
  } finally {
    await demo.close();
  }
});

// --- guards on how the feature is wired -----------------------------------------------------------

test('disabled by default: the config is null and index.js loads the module only when it is set', async () => {
  const { config } = await import('../config.js');
  assert.equal(config.opsMetricsSocket, null, 'OPS_METRICS_SOCKET must be unset in the test run');

  const index = readFileSync(path.join(here, '..', 'index.js'), 'utf8');
  assert.doesNotMatch(index, /^import .*ops\//m, 'a static import would load it unconditionally');
  const dynamic = index.indexOf("import('./ops/metrics-socket.js')");
  const guarded = index.indexOf('if (config.opsMetricsSocket)');
  assert.ok(
    guarded > -1 && dynamic > guarded,
    'the module is imported only inside the config check'
  );
});

test('the socket module opens no TCP listener and mounts nothing on the app', () => {
  const source = readFileSync(path.join(here, 'metrics-socket.js'), 'utf8');
  assert.doesNotMatch(source, /\.listen\(\s*\d|0\.0\.0\.0|127\.0\.0\.1|localhost/);
  assert.doesNotMatch(source, /fastify|app\.(get|post|route|register)/i);
  assert.match(source, /server\.listen\(socketPath,/);
});

test('only the socket module touches the filesystem under server/ops, and only to stat, chmod, unlink', () => {
  const files = ['metrics-socket.js', 'read-metrics.js', 'snapshot-guard.js', 'socket-path.js'];
  const writes =
    /\b(writeFile|appendFile|createWriteStream|mkdir|rename|copyFile|rm|rmdir|truncate)\w*\b/;
  for (const file of files) {
    const source = readFileSync(path.join(here, file), 'utf8');
    const importsFs = /from 'node:fs(\/promises)?'/.test(source);
    assert.equal(importsFs, file === 'metrics-socket.js', `${file} filesystem access`);
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.doesNotMatch(code, writes, `${file} must not write data`);
  }
});
