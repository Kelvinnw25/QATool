import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createCollector } from './collector.js';
import { loadConfig } from './config.js';
import { Unavailable } from './errors.js';

const config = (env = {}) => loadConfig({ MONITOR_POLL_MS: '3000', ...env });

function clock(start = 1_000_000) {
  let t = start;
  const now = () => t;
  now.advance = (ms) => (t += ms);
  return now;
}

const backendOk = { healthy: true, httpStatus: 200, latencyMs: 5 };
const gateway = (over = {}) => ({
  status: 'ok',
  providerReady: true,
  providerState: 'ready',
  healthy: true,
  active: 0,
  maxActive: 1,
  pending: 0,
  capacity: 20,
  totals: { succeeded: 0, failed: 0, timedOut: 0, cancelled: 0, rejected: 0 },
  ...over,
});

function adapter(name, collect, timeoutMs = 500) {
  return { name, timeoutMs, collect };
}

test('one cycle polls every adapter once and fills the view', async () => {
  const now = clock();
  const calls = [];
  const c = createCollector({
    config: config(),
    now,
    adapters: [
      adapter('backend', async () => (calls.push('backend'), backendOk)),
      adapter('apayee', async () => (calls.push('apayee'), gateway())),
    ],
  });
  await c.runOnce();
  assert.deepEqual(calls.sort(), ['apayee', 'backend']);
  const v = c.view();
  assert.equal(v.monitor.cycles, 1);
  assert.equal(v.components.backend, 'up');
  assert.equal(v.overall.status, 'ok');
  assert.equal(v.readings.backend.state, 'ok');
  assert.equal(v.capacity.apayee.available, 1);
});

test('a failing, hanging and unconfigured adapter do not stop the others', async () => {
  const now = clock();
  const c = createCollector({
    config: config(),
    now,
    adapters: [
      adapter('backend', async () => backendOk),
      adapter('apayee', async () => {
        throw Object.assign(new Error('command failed'), { code: 'FAILED' });
      }),
      adapter('docker', () => new Promise(() => {}), 50), // never settles
      adapter('frontend', async () => {
        throw new Unavailable('NOT_CONFIGURED', 'Set MONITOR_FRONTEND_URL.');
      }),
      adapter('jobs', async () => {
        throw new Unavailable('NO_SOURCE', 'No source.');
      }),
    ],
  });
  await c.runOnce();
  const v = c.view();
  assert.equal(v.readings.backend.state, 'ok');
  assert.equal(v.readings.apayee.state, 'unavailable');
  assert.equal(v.readings.apayee.error.code, 'FAILED');
  assert.equal(v.readings.docker.state, 'unavailable');
  assert.equal(v.readings.docker.error.code, 'TIMEOUT');
  assert.equal(v.readings.frontend.state, 'not_configured');
  assert.equal(v.readings.jobs.state, 'no_source');
  assert.equal(v.components.apayee, 'down');
  assert.equal(v.components.frontend, 'unknown');
  assert.equal(v.overall.status, 'critical');
});

test('after a failure the last good value is kept but marked as last known, not current', async () => {
  const now = clock();
  let fail = false;
  const c = createCollector({
    config: config(),
    now,
    adapters: [
      adapter('apayee', async () => {
        if (fail) throw new Error('boom');
        return gateway({ active: 1 });
      }),
    ],
  });
  await c.runOnce();
  assert.equal(c.view().readings.apayee.data.active, 1);

  fail = true;
  now.advance(4000);
  await c.runOnce();
  const r = c.view().readings.apayee;
  assert.equal(r.state, 'unavailable');
  assert.equal(r.data, null);
  assert.equal(r.lastKnown.active, 1);
  assert.equal(r.lastSuccessAgeMs, 4000);
  assert.equal(c.view().capacity.apayee, null, 'capacity is not derived from old data');
});

test('stale: a reading older than three polls is flagged, and the collector itself can be stale', async () => {
  const now = clock();
  const c = createCollector({
    config: config(),
    now,
    adapters: [adapter('backend', async () => backendOk)],
  });
  await c.runOnce();
  assert.equal(c.view().readings.backend.stale, false);

  now.advance(9000); // exactly three polls: still fresh
  assert.equal(c.view().readings.backend.stale, false);
  now.advance(1000);
  const v = c.view();
  assert.equal(v.readings.backend.stale, true);
  assert.equal(v.components.backend, 'stale');
  assert.equal(v.monitor.stale, true);
  assert.equal(v.overall.status, 'degraded');
});

test('history is bounded and keeps the newest points', async () => {
  const now = clock();
  const c = createCollector({
    config: config({ MONITOR_HISTORY_POINTS: '10' }),
    now,
    adapters: [adapter('apayee', async () => gateway({ pending: now() % 7 }))],
  });
  for (let i = 0; i < 25; i++) {
    now.advance(3000);
    await c.runOnce();
  }
  const { history } = c.view();
  assert.equal(history.length, 10);
  assert.equal(history.at(-1).t, now());
  assert.ok(history[0].t < history.at(-1).t);
});

test('events are bounded, newest first, and the first poll creates none', async () => {
  const now = clock();
  let up = true;
  const c = createCollector({
    config: config({ MONITOR_EVENT_LIMIT: '10' }),
    now,
    adapters: [adapter('backend', async () => ({ ...backendOk, healthy: up }))],
  });
  await c.runOnce();
  assert.equal(c.view().events.length, 0);
  for (let i = 0; i < 30; i++) {
    up = !up;
    now.advance(3000);
    await c.runOnce();
  }
  const { events } = c.view();
  assert.equal(events.length, 10);
  assert.ok(events[0].id > events[1].id);
});

test('QATOOL restart is detected from uptime going backwards and counted', async () => {
  const now = clock();
  let uptime = 600_000;
  const snap = () => ({
    uptimeMs: uptime,
    activeSessions: 1,
    ticketsMinted: 1,
    now: { queued: 0, processing: 0, completed: 0, failed: 0, cancelled: 0 },
    total: { submitted: 4, completed: 4, failed: 0, cancelled: 0, cancelledByReason: {} },
    workers: { configured: 1, effective: 1, busy: 0, utilization: 0 },
    durationsMs: { queueWait: null, processing: null },
    rejections: {},
    errorsByCode: {},
    breakerTrips: 0,
  });
  const c = createCollector({
    config: config(),
    now,
    adapters: [adapter('jobs', async () => snap())],
  });
  await c.runOnce();
  uptime = 2_000;
  now.advance(3000);
  await c.runOnce();
  const v = c.view();
  assert.equal(v.monitor.backendResetsSeen, 1);
  assert.match(v.events[0].text, /restarted/);
});

test('a manual refresh joins a running cycle instead of starting another', async () => {
  const now = clock();
  let started = 0;
  let release;
  const gate = new Promise((r) => (release = r));
  const c = createCollector({
    config: config(),
    now,
    adapters: [
      adapter('backend', async () => {
        started += 1;
        await gate;
        return backendOk;
      }),
    ],
  });
  const first = c.runOnce();
  const second = c.refresh();
  const third = c.refresh();
  release();
  await Promise.all([first, second, third]);
  assert.equal(started, 1);
});

test('a manual refresh within a second of the last poll reuses it', async () => {
  const now = clock();
  let started = 0;
  const c = createCollector({
    config: config(),
    now,
    adapters: [adapter('backend', async () => (started++, backendOk))],
  });
  await c.runOnce();
  now.advance(300);
  await c.refresh();
  assert.equal(started, 1);
  now.advance(1500);
  await c.refresh();
  assert.equal(started, 2);
});

test('the loop schedules the next poll only after the previous one finished', async () => {
  const c = createCollector({
    config: config({ MONITOR_POLL_MS: '3000' }),
    adapters: [adapter('backend', async () => backendOk)],
  });
  c.start();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(c.view().monitor.cycles, 1);
  c.stop();
});

test('the view carries no field that could hold a credential', async () => {
  const now = clock();
  const c = createCollector({
    config: config(),
    now,
    adapters: [
      adapter('apayee', async () => {
        throw new Error(
          'failed: Authorization: Bearer abcdefghijklmnop123456 TICKET_SECRET=hunter22222'
        );
      }),
    ],
  });
  await c.runOnce();
  const text = JSON.stringify(c.view());
  assert.doesNotMatch(text, /abcdefghijklmnop123456|hunter22222/);
});

test('a backend that crashed and came back is recognised as a restart, though nothing was read in between', async () => {
  const now = clock();
  let phase = 'up1';
  const snap = (uptimeMs, submitted) => ({
    uptimeMs,
    activeSessions: 0,
    ticketsMinted: 0,
    now: { queued: 0, processing: 0, completed: 0, failed: 0, cancelled: 0 },
    total: { submitted, completed: submitted, failed: 0, cancelled: 0, cancelledByReason: {} },
    workers: { configured: 1, effective: 1, busy: 0, utilization: 0 },
    durationsMs: { queueWait: null, processing: null },
    rejections: {},
    errorsByCode: {},
    breakerTrips: 0,
  });
  const c = createCollector({
    config: config(),
    now,
    adapters: [
      adapter('jobs', async () => {
        if (phase === 'down') throw Object.assign(new Error('x'), { code: 'SOCKET_UNREACHABLE' });
        return phase === 'up1' ? snap(900_000, 25) : snap(6_000, 0);
      }),
    ],
  });

  await c.runOnce();
  phase = 'down';
  now.advance(4000);
  await c.runOnce();
  now.advance(4000);
  await c.runOnce();
  phase = 'up2';
  now.advance(4000);
  await c.runOnce();

  const v = c.view();
  assert.equal(v.monitor.backendResetsSeen, 1);
  assert.ok(v.events.some((e) => e.kind === 'jobs_reset' && /restarted/.test(e.text)));
  assert.equal(
    v.events.some((e) => /-\d/.test(e.text)),
    false,
    'no negative deltas'
  );
  assert.equal(v.jobs.submitted, 0, 'the new, lower figure is shown as it is');
});
