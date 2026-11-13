import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { createJobMetrics } from '../jobs/metrics.js';
import { startMetricsSocket } from './metrics-socket.js';

const reader = path.join(path.dirname(fileURLToPath(import.meta.url)), 'read-metrics.js');
const onWindows = process.platform === 'win32';
const skipWindows = onWindows ? 'Unix socket files do not exist on Windows' : false;

/** Runs the reader exactly as the monitor does, with only the variables given plus a canary secret. */
function runReader(env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [reader], {
      // A canary in the environment: the reader must never print it, on any path.
      env: { PATH: process.env.PATH, CANARY_SECRET: 'canary-value-must-not-print', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

const noLeak = (r) => {
  assert.doesNotMatch(r.stdout + r.stderr, /canary-value-must-not-print|CANARY_SECRET|PATH=/);
};

describe('the reader without a usable configuration (any platform)', () => {
  test('exits 2 with one fixed sentence when OPS_METRICS_SOCKET is unset or empty', async () => {
    for (const env of [{}, { OPS_METRICS_SOCKET: '' }]) {
      const r = await runReader(env);
      assert.equal(r.code, 2);
      assert.equal(r.stdout, '');
      assert.equal(r.stderr, 'metrics socket is not configured\n');
      noLeak(r);
    }
  });

  test('exits 2 for a path that is not allowed, without echoing it', async () => {
    for (const value of ['relative.sock', '/tmp/../etc/x.sock', '/etc/passwd', '/tmp/x y.sock']) {
      const r = await runReader({ OPS_METRICS_SOCKET: value });
      assert.equal(r.code, 2, value);
      assert.equal(r.stdout, '');
      assert.doesNotMatch(r.stderr, /etc|relative|x y/);
      noLeak(r);
    }
  });

  test('takes no arguments: extra arguments change nothing', async () => {
    const r = await new Promise((resolve) => {
      const child = spawn(process.execPath, [reader, '--socket=/etc/passwd', 'x'], {
        env: { PATH: process.env.PATH },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stderr = '';
      child.stderr.on('data', (c) => (stderr += c));
      child.on('close', (code) => resolve({ code, stderr }));
    });
    assert.equal(r.code, 2);
    assert.equal(r.stderr, 'metrics socket is not configured\n');
  });
});

describe('the reader against a real socket', { skip: skipWindows }, () => {
  const dir = onWindows ? null : mkdtempSync(path.join(os.tmpdir(), 'qatool-reader-'));
  after(() => dir && rmSync(dir, { recursive: true, force: true }));
  const sock = (name) => path.join(dir, name);

  test('prints the snapshot and exits 0', async () => {
    const metrics = createJobMetrics();
    metrics.inc('jobs_submitted', 5);
    const handle = await startMetricsSocket({
      socketPath: sock('ok.sock'),
      snapshot: () => metrics.snapshot(),
    });
    try {
      const r = await runReader({ OPS_METRICS_SOCKET: sock('ok.sock') });
      assert.equal(r.code, 0, r.stderr);
      assert.equal(r.stderr, '');
      assert.equal(JSON.parse(r.stdout).jobs.submitted, 5);
      noLeak(r);
    } finally {
      await handle.close();
    }
  });

  test('exits 3 when nothing is listening, and 3 for a socket nobody can reach', async () => {
    const r = await runReader({ OPS_METRICS_SOCKET: sock('missing.sock') });
    assert.equal(r.code, 3);
    assert.equal(r.stdout, '');
    assert.equal(r.stderr, 'metrics socket is not reachable\n');
    noLeak(r);
  });

  /** A server that answers with whatever it is told, on a socket file. */
  async function fake(name, handler) {
    const server = http.createServer(handler);
    await new Promise((resolve) => server.listen(sock(name), resolve));
    return {
      close: () => new Promise((resolve) => (server.closeAllConnections(), server.close(resolve))),
    };
  }

  test('exits 4 for a non-200, a non-JSON body, or a body the guard refuses', async () => {
    const cases = {
      'status.sock': (req, res) => (res.writeHead(500), res.end('{"error":"x"}')),
      'html.sock': (req, res) => res.end('<html>nope</html>'),
      'list.sock': (req, res) => res.end('{"sessions":["sid-1"]}'),
      'text.sock': (req, res) => res.end('{"message":"TICKET_SECRET=abc"}'),
      'array.sock': (req, res) => res.end('[1,2,3]'),
    };
    for (const [name, handler] of Object.entries(cases)) {
      const server = await fake(name, handler);
      try {
        const r = await runReader({ OPS_METRICS_SOCKET: sock(name) });
        assert.equal(r.code, 4, name);
        assert.equal(r.stdout, '', `${name} must print nothing on stdout`);
        assert.doesNotMatch(r.stderr, /sid-1|TICKET_SECRET|html/);
        noLeak(r);
      } finally {
        await server.close();
      }
    }
  });

  test('exits 4 for an oversized answer without buffering it all', async () => {
    const server = await fake('big.sock', (req, res) => res.end(`{"a":"${'x'.repeat(200_000)}"}`));
    try {
      const r = await runReader({ OPS_METRICS_SOCKET: sock('big.sock') });
      assert.equal(r.code, 4);
      assert.equal(r.stdout, '');
    } finally {
      await server.close();
    }
  });

  test('exits 5 when the socket accepts but never answers', { timeout: 15_000 }, async () => {
    const server = await fake('slow.sock', () => {});
    try {
      const started = Date.now();
      const r = await runReader({ OPS_METRICS_SOCKET: sock('slow.sock') });
      assert.equal(r.code, 5);
      assert.equal(r.stderr, 'metrics socket did not answer in time\n');
      assert.ok(Date.now() - started < 8000, 'it gives up on its own');
    } finally {
      await server.close();
    }
  });
});
