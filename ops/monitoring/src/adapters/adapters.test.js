import assert from 'node:assert/strict';
import { test } from 'node:test';

import { loadConfig } from '../config.js';
import { Unavailable } from '../errors.js';
import {
  APAYEE_HEALTH_SCRIPT,
  BACKEND_READER_PATH,
  INSPECT_FORMAT,
  isAllowedDockerCommand,
} from '../exec.js';
import { createAdapters } from './index.js';
import { probe } from './http.js';

const config = (env = {}) => loadConfig({ MONITOR_ADAPTER_TIMEOUT_MS: '500', ...env });
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });

function build(env, io = {}) {
  const calls = [];
  const adapters = createAdapters(config(env), {
    fetchImpl: async (url) => {
      calls.push(String(url));
      return json({ status: 'ok' });
    },
    runDocker: async () => {
      throw Object.assign(new Error('command failed'), { code: 'FAILED' });
    },
    isProcessRunning: async () => true,
    ...io,
  });
  return { by: Object.fromEntries(adapters.map((a) => [a.name, a])), calls };
}

test('backend: polls /healthz on the loopback and reports latency', async () => {
  const { by, calls } = build({});
  const r = await by.backend.collect();
  assert.deepEqual(calls, ['http://127.0.0.1:3001/healthz']);
  assert.equal(r.healthy, true);
  assert.equal(r.httpStatus, 200);
});

test('backend: a 503 or a wrong body is unhealthy; no answer throws', async () => {
  let { by } = build({}, { fetchImpl: async () => json({ status: 'ok' }, 503) });
  assert.equal((await by.backend.collect()).healthy, false);

  ({ by } = build({}, { fetchImpl: async () => json({ status: 'nope' }) }));
  assert.equal((await by.backend.collect()).healthy, false);

  ({ by } = build(
    {},
    {
      fetchImpl: async () => {
        throw new TypeError('fetch failed');
      },
    }
  ));
  await assert.rejects(by.backend.collect(), (e) => e.code === 'UNREACHABLE');
});

test('backend: a hung request times out instead of waiting forever', async () => {
  const { by } = build(
    {},
    {
      fetchImpl: (url, init) =>
        new Promise((_, reject) =>
          init.signal.addEventListener('abort', () => reject(init.signal.reason))
        ),
    }
  );
  const started = Date.now();
  await assert.rejects(by.backend.collect(), (e) => e.code === 'TIMEOUT');
  assert.ok(Date.now() - started < 2000);
});

test('frontend: not configured is "unavailable", not a failure', async () => {
  const { by } = build({});
  await assert.rejects(
    by.frontend.collect(),
    (e) => e instanceof Unavailable && e.code === 'NOT_CONFIGURED'
  );
});

test('frontend: configured, reads only the status of the page', async () => {
  const { by, calls } = build(
    { MONITOR_FRONTEND_URL: 'https://demo.example.app' },
    {
      fetchImpl: async (url) => new Response('<html>secret page body</html>', { status: 200 }),
    }
  );
  const r = await by.frontend.collect();
  assert.equal(r.healthy, true);
  assert.equal(JSON.stringify(r).includes('secret page body'), false);
  assert.deepEqual(calls, []);
});

test('tunnel: process and public address are separate facts', async () => {
  let { by } = build({ MONITOR_TUNNEL_URL: 'https://x.trycloudflare.com' });
  let r = await by.tunnel.collect();
  assert.deepEqual([r.processRunning, r.public.healthy, r.healthy], [true, true, true]);

  ({ by } = build(
    { MONITOR_TUNNEL_URL: 'https://x.trycloudflare.com' },
    { isProcessRunning: async () => false }
  ));
  r = await by.tunnel.collect();
  assert.deepEqual([r.processRunning, r.healthy], [false, false]);

  ({ by } = build(
    { MONITOR_TUNNEL_URL: 'https://x.trycloudflare.com' },
    {
      fetchImpl: async () => {
        throw new TypeError('x');
      },
    }
  ));
  r = await by.tunnel.collect();
  assert.equal(r.public.healthy, false);
  assert.equal(r.public.error, 'UNREACHABLE');
});

test('tunnel: with no address and no way to see the process, nothing is invented', async () => {
  const { by } = build(
    {},
    {
      isProcessRunning: async () => {
        throw new Error('no tasklist');
      },
    }
  );
  await assert.rejects(by.tunnel.collect(), (e) => e.code === 'NOT_CONFIGURED');

  const withProcess = build({}).by;
  const r = await withProcess.tunnel.collect();
  assert.equal(r.public, null);
  assert.equal(r.publicConfigured, false);
});

const APAYEE = {
  status: 'ok',
  service: 'apayee',
  provider: 'claude',
  provider_status: { ready: true, state: 'ready' },
  queue: { active: 1, max_active: 1, pending: 0, capacity: 20, totals: {} },
};

test('apayee: asked through an allowed, fixed docker compose exec; token never handled here', async () => {
  const seen = [];
  const { by } = build(
    {},
    {
      runDocker: async (bin, args) => {
        seen.push(args);
        return JSON.stringify(APAYEE);
      },
    }
  );
  const r = await by.apayee.collect();
  assert.equal(r.healthy, true);
  assert.equal(seen.length, 1);
  assert.ok(seen[0].includes(APAYEE_HEALTH_SCRIPT));
  assert.equal(isAllowedDockerCommand(seen[0]), true);
  assert.doesNotMatch(JSON.stringify(seen), /Bearer [A-Za-z0-9]{8,}/);
});

test('apayee: reachable but provider not ready is unhealthy; Docker down throws', async () => {
  let { by } = build(
    {},
    {
      runDocker: async () =>
        JSON.stringify({
          ...APAYEE,
          provider: 'claude_not_ready',
          provider_status: { ready: false, state: 'not_signed_in' },
        }),
    }
  );
  assert.equal((await by.apayee.collect()).healthy, false);

  ({ by } = build({}));
  await assert.rejects(by.apayee.collect(), (e) => e.code === 'FAILED');

  ({ by } = build({}, { runDocker: async () => 'upstream connect error' }));
  await assert.rejects(by.apayee.collect(), (e) => e.code === 'BAD_SHAPE');
});

test('docker: ps, inspect and stats are chained; a stats failure keeps the container list', async () => {
  const id = 'a1b2c3d4e5f6';
  const inspect = JSON.stringify({
    id,
    state: {
      Status: 'running',
      Running: true,
      StartedAt: new Date().toISOString(),
      Health: { Status: 'healthy' },
    },
    restarts: 0,
    labels: { 'com.docker.compose.service': 'apayee' },
    mem_limit: 2147483648,
  });
  const seen = [];
  const { by } = build(
    {},
    {
      runDocker: async (bin, args) => {
        seen.push(args);
        if (args[0] === 'ps') return `{"ID":"${id}"}`;
        if (args[0] === 'inspect') return inspect;
        throw Object.assign(new Error('timed out'), { code: 'TIMEOUT' });
      },
    }
  );
  const r = await by.docker.collect();
  assert.equal(r.containers.length, 1);
  assert.equal(r.containers[0].health, 'healthy');
  assert.equal(r.containers[0].resources, null);
  assert.equal(r.resourcesError, 'TIMEOUT');
  assert.ok(seen.every((a) => isAllowedDockerCommand(a)));
  assert.equal(seen[1][2], INSPECT_FORMAT);
});

test('docker: daemon down surfaces as an error; empty project is "no source"', async () => {
  let { by } = build({});
  await assert.rejects(by.docker.collect(), (e) => e.code === 'FAILED');
  ({ by } = build({}, { runDocker: async () => '' }));
  await assert.rejects(by.docker.collect(), (e) => e instanceof Unavailable);
});

test('jobs: by default there is no source, and nothing is run', async () => {
  let ran = false;
  const { by } = build(
    {},
    {
      runDocker: async () => {
        ran = true;
        return '{}';
      },
    }
  );
  await assert.rejects(
    by.jobs.collect(),
    (e) => e instanceof Unavailable && e.code === 'NO_SOURCE'
  );
  assert.equal(ran, false);
});

test('jobs: the docker-exec source runs exactly the fixed reader and parses the snapshot', async () => {
  const seen = [];
  const { by } = build(
    { MONITOR_JOBS_SOURCE: 'docker-exec' },
    {
      runDocker: async (bin, args) => {
        seen.push(args);
        return JSON.stringify({
          uptime_ms: 10,
          jobs: { current: { queued: 1 } },
          workers: { configured: 1, effective: 1, busy: 0 },
        });
      },
    }
  );
  const r = await by.jobs.collect();
  assert.equal(r.now.queued, 1);
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0], [
    'compose',
    '-p',
    'qatool',
    'exec',
    '-T',
    'qatool-backend',
    'node',
    BACKEND_READER_PATH,
  ]);
  assert.equal(isAllowedDockerCommand(seen[0]), true);
});

test('jobs: the old name docker-socket still works and means docker-exec', async () => {
  const { by } = build(
    { MONITOR_JOBS_SOURCE: 'docker-socket' },
    { runDocker: async () => JSON.stringify({ uptime_ms: 1, jobs: { current: {} }, workers: {} }) }
  );
  assert.equal((await by.jobs.collect()).now.queued, 0);
});

test("jobs: each of the reader's exit codes becomes its own specific state", async () => {
  const failWith = (exitStatus) => async () => {
    throw Object.assign(new Error('command failed'), { code: 'FAILED', exitStatus });
  };
  const run = async (exitStatus) => {
    const { by } = build(
      { MONITOR_JOBS_SOURCE: 'docker-exec' },
      { runDocker: failWith(exitStatus) }
    );
    return by.jobs.collect().then(
      () => assert.fail('should not succeed'),
      (error) => error
    );
  };

  const disabled = await run(2);
  assert.ok(disabled instanceof Unavailable);
  assert.match(disabled.message, /OPS_METRICS_SOCKET/);

  assert.equal((await run(3)).code, 'SOCKET_UNREACHABLE');
  assert.equal((await run(4)).code, 'BAD_SNAPSHOT');
  assert.equal((await run(5)).code, 'SOCKET_TIMEOUT');

  // Docker stopped, container not running, or an image without the reader: just "failed".
  for (const status of [1, 125, 126, 127, null]) {
    const error = await run(status);
    assert.equal(error.code, 'FAILED');
    assert.equal(error instanceof Unavailable, false);
  }
});

test('jobs: a backend without the job platform is "no source", never zero jobs', async () => {
  // The real shape of snapshot() when PUBLIC_DEMO is off: the job sources were never registered.
  const noPlatform = JSON.stringify({
    uptime_ms: 5000,
    jobs: { current: null, submitted: 0, completed: 0, failed: 0, cancelled: 0 },
    workers: { configured: null, effective: null, busy: null },
  });
  const { by } = build(
    { MONITOR_JOBS_SOURCE: 'docker-exec' },
    { runDocker: async () => noPlatform }
  );
  await assert.rejects(
    by.jobs.collect(),
    (e) => e instanceof Unavailable && /PUBLIC_DEMO/.test(e.message)
  );
});

test('jobs: an invalid or hostile reply is an error, and nothing from it is kept', async () => {
  for (const reply of ['', 'not json', '[]', '{"jobs":{}}', '<html>proxy error</html>']) {
    const { by } = build({ MONITOR_JOBS_SOURCE: 'docker-exec' }, { runDocker: async () => reply });
    await assert.rejects(by.jobs.collect(), (e) => e.code === 'BAD_SHAPE', reply);
  }
});

test('probe never reads a page body unless asked, and cancels it', async () => {
  let cancelled = false;
  const body = new ReadableStream({
    cancel() {
      cancelled = true;
    },
  });
  const r = await probe('http://x.invalid', {
    timeoutMs: 500,
    fetchImpl: async () => new Response(body, { status: 200 }),
  });
  assert.equal(r.ok, true);
  assert.equal(r.json, null);
  assert.equal(cancelled, true);
});

test('probe refuses to parse an oversized health body', async () => {
  const r = await probe('http://x.invalid', {
    timeoutMs: 500,
    readJson: true,
    fetchImpl: async () => new Response(JSON.stringify({ a: 'x'.repeat(5000) })),
  });
  assert.equal(r.json, null);
});
