import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'node:test';

import { createProviderAvailability } from '../llm/catalog.js';
import { readQueue } from '../llm/apayee.js';
import { createApayeeView } from './apayee-view.js';
import { createMetricsServer } from './metrics-socket.js';
import { SnapshotInvalidError, serializeSnapshot } from './snapshot-guard.js';

const TOKEN = 'apayee-token-that-must-never-leave-the-backend';
const settings = () => ({
  provider: 'gemini',
  apayeeBaseUrl: 'http://apayee:4100',
  apayeeToken: TOKEN,
});

/** The real catalog, with only the network probe replaced. */
const viewFor = (outcome) =>
  createApayeeView(
    createProviderAvailability({ settings, probe: async () => outcome, now: () => 1_000_000 }),
    () => 1_000_000
  );

const ready = {
  state: 'ready',
  provider: 'claude',
  queue: readQueue({
    active: 1,
    max_active: 3,
    pending: 2,
    capacity: 16,
    length: 2,
    running: true,
  }),
};

test('a ready Claude gateway: capacity as numbers, no code', async () => {
  assert.deepEqual(await viewFor(ready)(), {
    taken_at: '1970-01-01T00:16:40.000Z',
    available: true,
    code: null,
    capacity_reported: true,
    capacity_compatible: true,
    max_active: 3,
    active: 1,
    pending: 2,
    capacity: 16,
  });
});

test('each way the gateway can be unusable becomes a fixed identifier and no numbers', async () => {
  const cases = {
    offline: ['gateway_offline', { state: 'offline' }],
    timeout: ['gateway_timeout', { state: 'timeout' }],
    unauthorized: ['gateway_auth_failed', { state: 'unauthorized' }],
    shutting_down: ['gateway_shutting_down', { state: 'shutting_down' }],
    unexpected: ['gateway_unexpected_reply', { state: 'unexpected' }],
    misconfigured: ['not_configured', { state: 'misconfigured' }],
    not_claude: ['provider_not_ready', { state: 'ready', provider: 'mock', queue: readQueue({}) }],
  };
  for (const [label, [code, outcome]] of Object.entries(cases)) {
    const view = await viewFor(outcome)();
    assert.equal(view.available, false, label);
    assert.equal(view.code, code, label);
    if (label !== 'not_claude') {
      assert.deepEqual(
        [view.max_active, view.active, view.pending, view.capacity],
        [null, null, null, null],
        label
      );
    }
  }
});

test('the view holds no token, url, version or free text, and passes the identifier guard', async () => {
  for (const outcome of [ready, { state: 'offline' }]) {
    const view = await viewFor(outcome)();
    const text = JSON.stringify(view);
    assert.doesNotMatch(text, new RegExp(`${TOKEN}|apayee:4100|http|Bearer|version`));
    assert.doesNotThrow(() => serializeSnapshot(view, { identifiers: true }));
  }
});

test('a failing catalog is reported as probe_failed, never thrown at the monitor', async () => {
  const view = await createApayeeView({
    capacity: async () => {
      throw new Error(`boom ${TOKEN}`);
    },
  })();
  assert.equal(view.available, false);
  assert.equal(view.code, 'probe_failed');
  assert.doesNotMatch(JSON.stringify(view), new RegExp(TOKEN));
});

test('odd values from the catalog become null, not numbers the monitor would trust', async () => {
  const view = await createApayeeView({
    capacity: async () => ({
      status: { available: true, code: null },
      capacity: {
        reported: true,
        compatible: true,
        maxActive: -4,
        active: 1.5,
        pending: '2',
        capacity: Number.NaN,
      },
    }),
  })();
  assert.deepEqual(
    [view.max_active, view.active, view.pending, view.capacity],
    [null, null, null, null]
  );
});

// --- the route -------------------------------------------------------------------------------------------

function serve(options) {
  const server = createMetricsServer(options);
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }))
  );
}

function get(port, { url = '/apayee', method = 'GET' } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: url, method }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

const stop = (server) => new Promise((resolve) => server.close(resolve));

test('GET /apayee serves the view; /snapshot is still served; nothing else is', async () => {
  const { server, port } = await serve({
    snapshot: () => ({ jobs: { submitted: 1 } }),
    apayee: viewFor(ready),
  });
  try {
    const a = await get(port);
    assert.equal(a.status, 200);
    assert.equal(JSON.parse(a.body).max_active, 3);
    assert.equal(JSON.parse((await get(port, { url: '/snapshot' })).body).jobs.submitted, 1);

    for (const url of [
      '/apayee/',
      '/apayee?x=1',
      '/Apayee',
      '/v1/health',
      '/health',
      '/tokens',
      '/',
    ]) {
      assert.equal((await get(port, { url })).status, 404, url);
    }
    for (const method of ['POST', 'PUT', 'DELETE', 'HEAD']) {
      assert.equal((await get(port, { method })).status, 405, method);
    }
  } finally {
    await stop(server);
  }
});

test('without a view, /apayee does not exist', async () => {
  const { server, port } = await serve({ snapshot: () => ({}) });
  try {
    assert.equal((await get(port)).status, 404);
  } finally {
    await stop(server);
  }
});

test('free text or a secret in the view is refused; the job snapshot never accepts identifiers', async () => {
  for (const bad of [
    { note: 'Bearer abcdefghijklmnop' },
    { code: `TOKEN=${TOKEN}` },
    { code: 'Gateway Offline' },
    { list: ['a'] },
  ]) {
    const { server, port } = await serve({ snapshot: () => ({}), apayee: () => bad });
    try {
      const r = await get(port);
      assert.equal(r.status, 500, JSON.stringify(bad));
      assert.equal(r.body, '{"error":"snapshot_unavailable"}');
    } finally {
      await stop(server);
    }
  }

  // The same identifier that /apayee admits is refused on /snapshot, which stays strict.
  const { server, port } = await serve({ snapshot: () => ({ code: 'gateway_offline' }) });
  try {
    assert.equal((await get(port, { url: '/snapshot' })).status, 500);
  } finally {
    await stop(server);
  }
});

test('a rejecting view gives a fixed 500, and is logged once with no detail', async () => {
  const warnings = [];
  const { server, port } = await serve({
    snapshot: () => ({}),
    apayee: async () => {
      throw new Error(`down ${TOKEN}`);
    },
    logger: { warn: (...a) => warnings.push(a) },
  });
  try {
    for (let i = 0; i < 3; i++) assert.equal((await get(port)).status, 500);
    assert.equal(warnings.length, 1);
    assert.doesNotMatch(JSON.stringify(warnings), new RegExp(TOKEN));
    assert.ok(new SnapshotInvalidError('x'));
  } finally {
    await stop(server);
  }
});
