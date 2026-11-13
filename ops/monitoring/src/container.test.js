import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { createJobMetrics } from '../../../server/jobs/metrics.js';
import { readQueue } from '../../../server/llm/apayee.js';
import { createProviderAvailability } from '../../../server/llm/catalog.js';
import { createApayeeView } from '../../../server/ops/apayee-view.js';
import { serializeSnapshot } from '../../../server/ops/snapshot-guard.js';
import { createAdapters } from './adapters/index.js';
import { readSocket } from './adapters/socket.js';
import { createCollector } from './collector.js';
import { loadConfig } from './config.js';
import { isAllowedPeer } from './http-server.js';

const root = new URL('../../../', import.meta.url);
const read = (path) => readFileSync(new URL(path, root), 'utf8');

const containerEnv = {
  MONITOR_MODE: 'container',
  MONITOR_JOBS_SOURCE: 'socket',
  MONITOR_PUBLIC_PORT: '3301',
  MONITOR_ADAPTER_TIMEOUT_MS: '500',
};
const containerConfig = (extra = {}) =>
  loadConfig({ ...containerEnv, ...extra }, { platform: 'linux' });

// --- configuration ----------------------------------------------------------------------------------------

test('host mode is unchanged: loopback only, no way to bind elsewhere', () => {
  const host = loadConfig({}, { platform: 'linux' });
  assert.equal(host.mode, 'host');
  assert.equal(host.host, '127.0.0.1');
  assert.equal(host.publicPort, host.port);
  assert.equal(host.dockerStats, true);
  assert.equal(host.tunnelProcessCheck, true);
  assert.equal(host.apayeeSource, 'docker-exec');
  for (const value of ['0.0.0.0', '::', '10.0.0.4']) {
    assert.throws(() => loadConfig({ MONITOR_HOST: value }), /loopback/, value);
    // Naming the mode is not enough in host mode, and the container flag does not leak backwards.
    assert.throws(
      () => loadConfig({ MONITOR_MODE: 'host', MONITOR_HOST: value }),
      /loopback/,
      value
    );
  }
});

test('container mode: listens on all interfaces inside, expects the published port, no Docker, no process list', () => {
  const c = containerConfig();
  assert.equal(c.mode, 'container');
  assert.equal(c.host, ['0', '0', '0', '0'].join('.'));
  assert.equal(c.port, 3300);
  assert.equal(c.publicPort, 3301);
  assert.equal(c.jobsSource, 'socket');
  assert.equal(c.apayeeSource, 'socket');
  assert.equal(c.dockerStats, false);
  assert.equal(c.tunnelProcessCheck, false);
  assert.equal(c.backendUrl, 'http://qatool-backend:3001');
  assert.equal(c.metricsSocket, '/run/qatool-ops/metrics.sock');
});

test('container mode accepts no other non-loopback address, and no Docker source', () => {
  for (const host of ['192.168.1.20', '10.0.0.4', 'example.com', '8.8.8.8', '::']) {
    assert.throws(() => containerConfig({ MONITOR_HOST: host }), /MONITOR_HOST/, host);
  }
  assert.equal(containerConfig({ MONITOR_HOST: '127.0.0.1' }).host, '127.0.0.1');
  assert.throws(() => containerConfig({ MONITOR_JOBS_SOURCE: 'docker-exec' }), /no Docker CLI/);
  assert.throws(() => loadConfig({ MONITOR_MODE: 'pod' }), /MONITOR_MODE/);
});

test('without the socket source, container mode has neither jobs nor Apayee', () => {
  const c = containerConfig({ MONITOR_JOBS_SOURCE: 'none' });
  assert.equal(c.jobsSource, 'none');
  assert.equal(c.apayeeSource, 'none');
});

test('the socket source needs Unix sockets, so it is refused on a Windows host', () => {
  assert.throws(
    () => loadConfig({ MONITOR_JOBS_SOURCE: 'socket' }, { platform: 'win32' }),
    /Unix sockets/
  );
  assert.equal(
    loadConfig({ MONITOR_JOBS_SOURCE: 'socket' }, { platform: 'linux' }).jobsSource,
    'socket'
  );
});

test('the socket path must be an absolute, normalised .sock file', () => {
  for (const bad of [
    'relative.sock',
    '/run/x/../y.sock',
    '/run//x.sock',
    '/run/x',
    '/run/x y.sock',
  ]) {
    assert.throws(
      () => containerConfig({ MONITOR_METRICS_SOCKET: bad }),
      /MONITOR_METRICS_SOCKET/,
      bad
    );
  }
});

test('who may connect: the loopback anywhere; private Docker addresses only in a container', () => {
  for (const a of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
    assert.equal(isAllowedPeer(a, 'host'), true, a);
    assert.equal(isAllowedPeer(a, 'container'), true, a);
  }
  const bridge = [
    '172.18.0.1',
    '172.31.0.2',
    '10.1.2.3',
    '192.168.65.1',
    '::ffff:172.17.0.1',
    'fd12::1',
  ];
  for (const a of bridge) {
    assert.equal(isAllowedPeer(a, 'host'), false, `host ${a}`);
    assert.equal(isAllowedPeer(a, 'container'), true, `container ${a}`);
  }
  for (const a of [
    '8.8.8.8',
    '172.15.0.1',
    '172.32.0.1',
    '203.0.113.9',
    '2001:db8::1',
    '',
    undefined,
  ]) {
    assert.equal(isAllowedPeer(a, 'container'), false, String(a));
  }
});

// --- the adapters in container mode ----------------------------------------------------------------------

/** Adapters wired so that touching Docker or the process list is a test failure. */
function containerAdapters(readSocketImpl, extra = {}) {
  const forbidden = (what) => () => {
    throw new Error(`container mode must not use ${what}`);
  };
  const adapters = createAdapters(containerConfig(extra), {
    readSocket: readSocketImpl,
    runDocker: forbidden('the Docker CLI'),
    isProcessRunning: forbidden('the process list'),
    fetchImpl: async () => new Response('{"status":"ok"}', { status: 200 }),
  });
  return Object.fromEntries(adapters.map((a) => [a.name, a]));
}

function realSources() {
  const metrics = createJobMetrics();
  metrics.registerSource('jobs', () => ({
    queued: 2,
    processing: 1,
    completed: 4,
    failed: 1,
    cancelled: 0,
    workers_busy: 1,
    retained: 8,
  }));
  metrics.registerSource('workers', () => ({ configured: 1, effective: 1, busy: 1 }));
  metrics.registerSource('active_starts', () => []);
  metrics.inc('jobs_submitted', 8);
  metrics.inc('jobs_completed', 4);
  metrics.inc('jobs_failed', 1);

  const catalog = (outcome) =>
    createProviderAvailability({
      settings: () => ({
        provider: 'gemini',
        apayeeBaseUrl: 'http://apayee:4100',
        apayeeToken: 'unused',
      }),
      probe: async () => outcome,
    });
  const apayeeOutcome = {
    state: 'ready',
    provider: 'claude',
    queue: readQueue({ active: 1, max_active: 1, pending: 3, capacity: 16 }),
  };
  return { metrics, catalog, apayeeOutcome };
}

test('jobs: read from the socket path, parsed, and Docker is never touched', async () => {
  const { metrics } = realSources();
  const asked = [];
  const by = containerAdapters(async (socket, path) => {
    asked.push([socket, path]);
    return serializeSnapshot(metrics.snapshot());
  });
  const jobs = await by.jobs.collect();
  assert.deepEqual(asked, [['/run/qatool-ops/metrics.sock', '/snapshot']]);
  assert.equal(jobs.now.queued, 2);
  assert.equal(jobs.workers.busy, 1);
});

test('apayee: the backend reports it over the socket; the monitor holds no token and says what is missing', async () => {
  const { catalog, apayeeOutcome } = realSources();
  const view = createApayeeView(catalog(apayeeOutcome));
  const asked = [];
  const by = containerAdapters(async (socket, path) => {
    asked.push(path);
    return serializeSnapshot(await view(), { identifiers: true });
  });
  const apayee = await by.apayee.collect();
  assert.deepEqual(asked, ['/apayee']);
  assert.equal(apayee.healthy, true);
  assert.equal(apayee.provider, 'claude');
  assert.deepEqual(
    [apayee.active, apayee.maxActive, apayee.pending, apayee.capacity],
    [1, 1, 3, 16]
  );
  assert.equal(apayee.viaBackend, true);
  assert.equal(apayee.version, null);
  assert.deepEqual(Object.values(apayee.totals), [null, null, null, null, null]);
});

test('apayee: an unreachable gateway is an error (down); a reachable-but-wrong one is degraded data', async () => {
  const { catalog } = realSources();
  const offline = containerAdapters(async () =>
    serializeSnapshot(await createApayeeView(catalog({ state: 'offline' }))(), {
      identifiers: true,
    })
  );
  await assert.rejects(
    offline.apayee.collect(),
    (e) => e.code === 'APAYEE_UNREACHABLE' && /gateway_offline/.test(e.message)
  );

  const wrong = containerAdapters(async () =>
    serializeSnapshot(
      await createApayeeView(catalog({ state: 'ready', provider: 'mock', queue: readQueue({}) }))(),
      { identifiers: true }
    )
  );
  const data = await wrong.apayee.collect();
  assert.equal(data.healthy, false);
  assert.equal(data.providerState, 'provider_not_ready');
});

test('apayee: with the socket source off, it is "no source", not a guess', async () => {
  const by = containerAdapters(async () => '{}', { MONITOR_JOBS_SOURCE: 'none' });
  await assert.rejects(by.apayee.collect(), (e) => e.code === 'NO_SOURCE');
  await assert.rejects(by.jobs.collect(), (e) => e.code === 'NO_SOURCE');
});

test('docker statistics are explicitly unavailable, with the reason, and nothing is fabricated', async () => {
  const by = containerAdapters(async () => '{}');
  await assert.rejects(
    by.docker.collect(),
    (e) =>
      e.code === 'NO_SOURCE' && /Docker API/.test(e.message) && /no Docker socket/.test(e.message)
  );
});

test('tunnel: only the public address counts; unset means "not configured", never "down"', async () => {
  const unset = containerAdapters(async () => '{}');
  await assert.rejects(unset.tunnel.collect(), (e) => e.code === 'NOT_CONFIGURED');

  const set = containerAdapters(async () => '{}', {
    MONITOR_TUNNEL_URL: 'https://x.trycloudflare.com',
  });
  const r = await set.tunnel.collect();
  assert.equal(r.processRunning, null);
  assert.equal(r.healthy, true);
  assert.equal(r.public.healthy, true);
});

test('backend and frontend probes still work (HTTP only)', async () => {
  const by = containerAdapters(async () => '{}', {
    MONITOR_FRONTEND_URL: 'https://qatool-staging.vercel.app',
  });
  assert.equal((await by.backend.collect()).healthy, true);
  assert.equal((await by.frontend.collect()).healthy, true);
});

test('the whole chain in container mode: real metrics and the real catalog reach the view', async () => {
  const { metrics, catalog, apayeeOutcome } = realSources();
  const view = createApayeeView(catalog(apayeeOutcome));
  const adapters = createAdapters(containerConfig({ MONITOR_TUNNEL_URL: '' }), {
    readSocket: async (socket, path) =>
      path === '/snapshot'
        ? serializeSnapshot(metrics.snapshot())
        : serializeSnapshot(await view(), { identifiers: true }),
    runDocker: () => assert.fail('no Docker'),
    isProcessRunning: () => assert.fail('no process list'),
    fetchImpl: async () => new Response('{"status":"ok"}', { status: 200 }),
  });
  const collector = createCollector({ config: containerConfig(), adapters });
  await collector.runOnce();
  const v = collector.view();

  assert.equal(v.monitor.mode, 'container');
  assert.equal(v.readings.jobs.state, 'ok');
  assert.equal(v.readings.apayee.state, 'ok');
  assert.equal(v.readings.docker.state, 'no_source');
  assert.equal(v.readings.tunnel.state, 'not_configured');
  assert.equal(v.components.docker, 'unknown');
  assert.equal(v.components.tunnel, 'unknown');
  assert.equal(v.capacity.qatool.queued, 2);
  assert.equal(v.capacity.apayee.pending, 3);
  assert.equal(v.capacity.apayee.available, 0);
  assert.equal(v.overall.status, 'ok', JSON.stringify(v.overall.reasons));
  assert.doesNotMatch(JSON.stringify(v), /unused|apayee:4100|Bearer/);
});

// --- reading the socket -------------------------------------------------------------------------------------

/** A stand-in for http.request: `script(req, respond)` decides what the "socket" does. */
function fakeRequest(script) {
  return (options) => {
    const req = new EventEmitter();
    req.options = options;
    req.destroy = () => {};
    req.end = () =>
      setImmediate(() =>
        script(req, (status, ...chunks) => {
          const res = new EventEmitter();
          res.statusCode = status;
          res.destroy = () => {};
          req.emit('response', res);
          for (const chunk of chunks) res.emit('data', Buffer.from(chunk));
          res.emit('end');
        })
      );
    return req;
  };
}

test('readSocket: GET on the given path of the given socket, body returned', async () => {
  let seen;
  const body = await readSocket('/run/qatool-ops/metrics.sock', '/snapshot', {
    timeoutMs: 500,
    request: fakeRequest((req, respond) => {
      seen = req.options;
      respond(200, '{"a":', '1}');
    }),
  });
  assert.equal(body, '{"a":1}');
  assert.equal(seen.socketPath, '/run/qatool-ops/metrics.sock');
  assert.equal(seen.path, '/snapshot');
  assert.equal(seen.method, 'GET');
});

test('readSocket: every failure is a short coded error that names no path and no content', async () => {
  const run = (script, timeoutMs = 500) =>
    readSocket('/run/qatool-ops/metrics.sock', '/snapshot', {
      timeoutMs,
      request: fakeRequest(script),
    }).then(
      () => assert.fail('should have failed'),
      (error) => error
    );

  const refused = await run((req) =>
    req.emit(
      'error',
      Object.assign(new Error('connect ENOENT /run/qatool-ops/metrics.sock'), { code: 'ENOENT' })
    )
  );
  assert.equal(refused.code, 'SOCKET_UNREACHABLE');
  assert.doesNotMatch(refused.message, /\/run\/|ENOENT/);

  const bad = await run((req, respond) =>
    respond(500, '{"error":"snapshot_unavailable","token":"secret-value"}')
  );
  assert.equal(bad.code, 'BAD_SNAPSHOT');
  assert.doesNotMatch(bad.message, /secret-value/);

  const huge = await run((req, respond) => respond(200, 'x'.repeat(70 * 1024)));
  assert.equal(huge.code, 'BAD_SNAPSHOT');

  const slow = await run(() => {}, 60);
  assert.equal(slow.code, 'SOCKET_TIMEOUT');
});

// --- the container definition ------------------------------------------------------------------------------

/** The text of one top-level service in compose.yaml. */
function service(name) {
  const compose = read('compose.yaml');
  const start = compose.indexOf(`\n  ${name}:\n`);
  assert.ok(start >= 0, `${name} is defined`);
  const rest = compose.slice(start + 1);
  const end = rest.search(/\n(?:  [a-z][\w-]*:\n|[a-z]+:\n)/);
  return end < 0 ? rest : rest.slice(0, end + 1);
}

test('qatool-monitoring: a normal default service, built from its own folder, published on the loopback only', () => {
  const block = service('qatool-monitoring');
  assert.doesNotMatch(block, /profiles:/, 'not an optional profile');
  assert.match(block, /context: \.\/ops\/monitoring\n/);
  assert.doesNotMatch(block, /dockerfile:/, 'the Dockerfile is the one inside the context');
  assert.match(block, /image: qatool-monitoring:local/);

  const ports = [...block.matchAll(/^\s+- '([^']+)'$/gm)]
    .map((m) => m[1])
    .filter((p) => /:\d+:\d+$|^\d/.test(p));
  assert.deepEqual(
    ports.filter((p) => p.includes(':3300')),
    ['127.0.0.1:3301:3300']
  );
  assert.doesNotMatch(
    block.replace(/^\s*#.*$/gm, ''),
    /'(?:0\.0\.0\.0:)?\d+:\d+'/,
    'no port published on every interface'
  );
  assert.match(block, /MONITOR_PUBLIC_PORT: '3301'/);
  assert.match(block, /MONITOR_PORT: '3300'/);
});

test('qatool-monitoring: hardened, bounded, restarting, and holding no secret', () => {
  const block = service('qatool-monitoring');
  for (const required of [
    /restart: unless-stopped/,
    /read_only: true/,
    /cap_drop: \[ALL\]/,
    /no-new-privileges:true/,
    /mem_limit: 256m/,
    /cpus: 0\.5/,
    /pids_limit: 128/,
    /qatool-backend:\n\s+condition: service_healthy/,
  ]) {
    assert.match(block, required);
  }
  for (const forbidden of [
    /privileged/i,
    /cap_add/,
    /network_mode/,
    /pid:/,
    /user: *root/,
    /docker\.sock/,
    /\/var\/run/,
    /env_file/,
    /APAYEE/i,
    /(?:SECRET|TOKEN|PASSWORD|API_?KEY)\w*:/i,
  ]) {
    assert.doesNotMatch(block.replace(/^\s*#.*$/gm, ''), forbidden, String(forbidden));
  }
});

test('qatool-monitoring: its own network and a read-only view of the socket volume, nothing of Apayee', () => {
  const block = service('qatool-monitoring').replace(/^\s*#.*$/gm, '');
  assert.match(block, /networks: \[qatool-monitor-net\]/);
  assert.doesNotMatch(block, /qatool-net/);
  assert.match(block, /- qatool-ops-metrics:\/run\/qatool-ops:ro/);
  assert.match(block, /MONITOR_MODE: container/);
  assert.match(block, /MONITOR_JOBS_SOURCE: socket/);
  assert.match(block, /MONITOR_FRONTEND_URL: https:\/\/qatool-staging\.vercel\.app/);
  // The tunnel address changes on every start, so it is not written here: the monitor reads it from a file
  // that scripts/start-qatool.ps1 maintains, mounted read-only.
  assert.doesNotMatch(block, /MONITOR_TUNNEL_URL:/);
  assert.match(block, /MONITOR_TUNNEL_URL_FILE: \/run\/qatool-monitor\/tunnel-url/);
  assert.match(block, /- \.\/\.qatool-local\/monitor:\/run\/qatool-monitor:ro/);
});

test('the backend shares the socket volume read-write and the monitor network; nothing else about it changed', () => {
  const block = service('qatool-backend');
  const code = block.replace(/^\s*#.*$/gm, '');
  // qatool-ingress-net is the tunnel's: backend and cloudflared only (see tunnel.test.js).
  // Fixed address on the ingress network, so it can never take the one cloudflared needs (10.250.250.2).
  assert.match(
    code,
    /networks:\n\s+qatool-net:\n\s+qatool-monitor-net:\n\s+qatool-ingress-net:\n\s+ipv4_address: 10\.250\.250\.3\n/
  );
  assert.match(code, /- qatool-ops-metrics:\/run\/qatool-ops\n/);
  assert.doesNotMatch(code, /qatool-ops-metrics:\/run\/qatool-ops:ro/);
  assert.match(code, /- '127\.0\.0\.1:3001:3001'/);
  assert.doesNotMatch(
    code,
    /OPS_METRICS_SOCKET/,
    "the path stays in the owner's .env, not in this file"
  );
  assert.doesNotMatch(code, /docker\.sock|privileged/);
});

test('apayee and the frontend are as they were: no new network, no socket volume', () => {
  const apayee = service('apayee').replace(/^\s*#.*$/gm, '');
  assert.match(apayee, /networks: \[qatool-net\]/);
  assert.doesNotMatch(apayee, /monitor|qatool-ops|ports:/);
  assert.match(apayee, /apayee-claude-config:\/home\/node\/\.claude/);

  const frontend = service('qatool-frontend').replace(/^\s*#.*$/gm, '');
  assert.match(frontend, /networks: \[qatool-net\]/);
  assert.doesNotMatch(frontend, /monitor|qatool-ops/);
});

test('top level: the new network and volume, and the Claude sign-in volume still external', () => {
  const compose = read('compose.yaml').replace(/^\s*#.*$/gm, '');
  const networks = compose.slice(compose.indexOf('\nnetworks:'), compose.indexOf('\nvolumes:'));
  assert.match(networks, /qatool-net:/);
  assert.match(networks, /qatool-monitor-net:/);
  assert.doesNotMatch(networks, /internal:\s*false|driver: *host/);

  const volumes = compose.slice(compose.indexOf('\nvolumes:'));
  assert.match(volumes, /apayee-claude-config:\n\s+external: true\n\s+name: apayee-claude-config/);
  assert.match(volumes, /qatool-ops-metrics:\s*$/m);
  assert.doesNotMatch(volumes.slice(volumes.indexOf('qatool-ops-metrics')), /external/);
});

test('the monitor image: Node 22, non-root, no dependencies, a health check, no secrets, no Docker', () => {
  const dockerfile = read('ops/monitoring/Dockerfile');
  const code = dockerfile.replace(/^\s*#.*$/gm, '');
  assert.match(code, /^ARG NODE_VERSION=22\./m);
  assert.match(code, /^FROM node:\$\{NODE_VERSION\}-bookworm-slim$/m);
  assert.match(code, /^USER node$/m);
  assert.match(code, /^HEALTHCHECK /m);
  assert.match(code, /fetch\('http:\/\/127\.0\.0\.1:3300\/healthz'\)/);
  assert.match(code, /^CMD \["node", "server\.js"\]$/m);
  assert.doesNotMatch(
    code,
    /npm (ci|install)|apt-get|apk |curl|docker|\.env|ARG .*(TOKEN|SECRET|KEY)|ENV .*(TOKEN|SECRET|KEY)/i
  );
  // The only things copied are the application's own files.
  const copies = [...code.matchAll(/^COPY (.+)$/gm)].map((m) => m[1]);
  assert.deepEqual(copies, ['package.json server.js ./', 'src ./src', 'public ./public']);

  const ignore = read('ops/monitoring/.dockerignore');
  assert.match(ignore, /^\*$/m);
  assert.match(ignore, /^!package\.json$/m);
  assert.match(ignore, /^\*\*\/\*\.test\.js$/m);
});

test('the monitor is kept out of the backend image, the Vercel upload and the repository-root build', () => {
  assert.doesNotMatch(read('.dockerignore').replace(/^#.*$/gm, ''), /^!ops/m);
  assert.match(read('.vercelignore'), /^ops$/m);
});

test("the backend image makes the socket directory the node user's, and nobody else's", () => {
  const dockerfile = read('Dockerfile.backend');
  const mk = dockerfile.indexOf('mkdir -p /run/qatool-ops');
  assert.ok(mk > 0);
  assert.match(
    dockerfile.slice(mk, mk + 120),
    /mkdir -p \/run\/qatool-ops && chown node:node \/run\/qatool-ops && chmod 0700 \/run\/qatool-ops/
  );
  assert.ok(mk < dockerfile.indexOf('USER node'), 'created as root, before dropping to node');
});
