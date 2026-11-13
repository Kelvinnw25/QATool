import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  componentStatus,
  computeCapacity,
  computeJobStats,
  computeWarnings,
  overallStatus,
} from './derive.js';

const jobs = (over = {}) => ({
  uptimeMs: 600_000,
  now: { queued: 0, processing: 1, completed: 0, failed: 0, cancelled: 0 },
  total: { submitted: 12, completed: 9, failed: 1, cancelled: 2 },
  workers: { configured: 1, effective: 1, busy: 1, utilization: 0.8 },
  durationsMs: { queueWait: { p50: 100, p95: 900 }, processing: { p50: 40_000, p95: 70_000 } },
  ...over,
});
const apayee = (over = {}) => ({
  status: 'ok',
  providerReady: true,
  providerState: 'ready',
  active: 1,
  maxActive: 1,
  pending: 0,
  capacity: 20,
  ...over,
});
const ok = (data, extra = {}) => ({ state: 'ok', stale: false, data, ...extra });

test('capacity: free workers and available slots are computed, unknowns stay null', () => {
  const c = computeCapacity(
    jobs({ workers: { configured: 3, effective: 2, busy: 1, utilization: null } }),
    apayee({ active: 1, maxActive: 3, pending: 5, capacity: 20 })
  );
  assert.equal(c.qatool.workersFree, 1);
  assert.equal(c.apayee.available, 2);
  assert.equal(c.apayee.pendingRatio, 0.25);
  assert.equal(c.apayee.saturated, false);

  const unknown = computeCapacity(
    jobs({ workers: { configured: 1, effective: null, busy: 0 } }),
    apayee({ maxActive: null, capacity: null })
  );
  assert.equal(unknown.qatool.workersFree, null);
  assert.equal(unknown.apayee.available, null);
  assert.equal(unknown.apayee.pendingRatio, null);
  assert.equal(unknown.apayee.saturated, false);

  assert.deepEqual(computeCapacity(null, null), { qatool: null, apayee: null });
});

test('capacity: free workers never go negative when a cancelled job still holds one', () => {
  const c = computeCapacity(jobs({ workers: { configured: 1, effective: 1, busy: 2 } }), null);
  assert.equal(c.qatool.workersFree, 0);
});

test('job stats: success rate excludes cancelled jobs and is null before any job finishes', () => {
  const s = computeJobStats(jobs());
  assert.equal(s.successRate, 0.9);
  assert.equal(s.failureRate, 0.1);
  assert.equal(s.cancelled, 2);
  assert.equal(
    computeJobStats(jobs({ total: { submitted: 3, completed: 0, failed: 0, cancelled: 3 } }))
      .successRate,
    null
  );
  assert.equal(computeJobStats(null), null);
});

test('component status: stale beats up; not-configured is unknown, not down', () => {
  assert.equal(componentStatus('backend', ok({ healthy: true })), 'up');
  assert.equal(componentStatus('backend', ok({ healthy: false })), 'down');
  assert.equal(componentStatus('backend', ok({ healthy: true }, { stale: true })), 'stale');
  assert.equal(componentStatus('backend', { state: 'unavailable' }), 'down');
  assert.equal(componentStatus('frontend', { state: 'not_configured' }), 'unknown');
  assert.equal(componentStatus('jobs', { state: 'no_source' }), 'unknown');
  assert.equal(componentStatus('apayee', ok({ healthy: false })), 'degraded');
  assert.equal(componentStatus('apayee', { state: 'unavailable' }), 'down');
  // Docker being unreadable is not evidence that the services are down.
  assert.equal(componentStatus('docker', { state: 'unavailable' }), 'unknown');
  assert.equal(componentStatus('backend', { state: 'pending' }), 'unknown');
});

test('component status: a stopped or unhealthy container degrades docker', () => {
  const container = (over) => ({
    service: 'x',
    running: true,
    health: 'healthy',
    oomKilled: false,
    ...over,
  });
  assert.equal(componentStatus('docker', ok({ containers: [container(), container()] })), 'up');
  assert.equal(
    componentStatus('docker', ok({ containers: [container({ running: false })] })),
    'degraded'
  );
  assert.equal(
    componentStatus('docker', ok({ containers: [container({ health: 'unhealthy' })] })),
    'degraded'
  );
  assert.equal(
    componentStatus('docker', ok({ containers: [container({ oomKilled: true })] })),
    'degraded'
  );
});

const warn = (readings, capacity) => computeWarnings({ readings, capacity });

test('warnings: saturation thresholds at 50% and 80% of the waiting room', () => {
  const at = (pending) => {
    const a = apayee({ pending, capacity: 20 });
    return warn({ apayee: ok(a) }, computeCapacity(null, a))
      .map((w) => w.code)
      .filter((code) => code.startsWith('apayee_queue'));
  };
  assert.deepEqual(at(9), []);
  assert.ok(at(10).includes('apayee_queue_filling'));
  assert.ok(at(16).includes('apayee_queue_saturated'));
});

test('warnings: queueing at full concurrency is informational and states the numbers', () => {
  const a = apayee({ active: 1, maxActive: 1, pending: 3 });
  const w = warn({ apayee: ok(a) }, computeCapacity(null, a));
  const info = w.find((x) => x.code === 'apayee_at_capacity');
  assert.equal(info.level, 'info');
  assert.match(info.text, /1 Apayee slot.*3 request/);
});

test('warnings: provider not ready and job queueing', () => {
  const a = apayee({ providerReady: false, providerState: 'not_signed_in' });
  const j = jobs({ now: { queued: 2, processing: 1 } });
  const w = warn({ apayee: ok(a) }, computeCapacity(j, a));
  assert.equal(w[0].code, 'provider_not_ready');
  assert.equal(w[0].level, 'critical');
  assert.ok(w.some((x) => x.code === 'jobs_queueing'));
});

test('warnings: container memory at 85% and 95%, stopped container, stale reading', () => {
  const c = (used, over = {}) => ({
    service: 'qatool-backend',
    running: true,
    health: 'healthy',
    oomKilled: false,
    status: 'running',
    resources: { memUsedBytes: used, memLimitBytes: 100 },
    ...over,
  });
  const run = (container) =>
    warn({ docker: ok({ containers: [container] }) }, computeCapacity(null, null)).map(
      (w) => w.code
    );
  assert.deepEqual(run(c(80)), []);
  assert.deepEqual(run(c(86)), ['memory_high']);
  assert.deepEqual(run(c(96)), ['memory_critical']);
  assert.ok(run(c(10, { running: false, status: 'exited' })).includes('container_stopped'));
  assert.ok(
    warn({ backend: ok({}, { stale: true }) }, computeCapacity(null, null)).some(
      (w) => w.code === 'stale'
    )
  );
});

test('warnings are ordered critical, warn, info', () => {
  const a = apayee({ providerReady: false, pending: 12, capacity: 20, active: 1, maxActive: 1 });
  const w = warn({ apayee: ok(a) }, computeCapacity(null, a));
  assert.deepEqual(
    w.map((x) => x.level),
    [...w.map((x) => x.level)].sort(
      (p, q) => ({ critical: 0, warn: 1, info: 2 })[p] - { critical: 0, warn: 1, info: 2 }[q]
    )
  );
});

test('overall: starting, ok, degraded, critical', () => {
  const all = (over = {}) => ({
    backend: 'up',
    apayee: 'up',
    frontend: 'up',
    tunnel: 'up',
    docker: 'up',
    ...over,
  });
  assert.equal(overallStatus({ components: all(), warnings: [], cycles: 0 }).status, 'starting');
  assert.equal(overallStatus({ components: all(), warnings: [], cycles: 3 }).status, 'ok');
  assert.equal(
    overallStatus({
      components: all({ frontend: 'unknown', tunnel: 'unknown' }),
      warnings: [],
      cycles: 3,
    }).status,
    'ok'
  );
  assert.equal(
    overallStatus({ components: all({ tunnel: 'down' }), warnings: [], cycles: 3 }).status,
    'degraded'
  );
  assert.equal(
    overallStatus({ components: all({ docker: 'stale' }), warnings: [], cycles: 3 }).status,
    'degraded'
  );
  assert.equal(
    overallStatus({ components: all({ backend: 'down' }), warnings: [], cycles: 3 }).status,
    'critical'
  );
  assert.equal(
    overallStatus({ components: all({ apayee: 'down' }), warnings: [], cycles: 3 }).status,
    'critical'
  );
  const withWarn = overallStatus({
    components: all(),
    warnings: [{ level: 'warn', text: 'memory' }],
    cycles: 3,
  });
  assert.equal(withWarn.status, 'degraded');
  assert.deepEqual(withWarn.reasons, ['memory']);
  // Informational notes never change the headline.
  assert.equal(
    overallStatus({ components: all(), warnings: [{ level: 'info', text: 'queueing' }], cycles: 3 })
      .status,
    'ok'
  );
});

test('apayee read through the backend: an unreadable socket is "unknown", a gateway that is down is "down"', () => {
  const failed = (code) => ({ state: 'unavailable', error: { code } });
  for (const code of ['SOCKET_UNREACHABLE', 'SOCKET_TIMEOUT', 'BAD_SNAPSHOT']) {
    assert.equal(componentStatus('apayee', failed(code)), 'unknown', code);
  }
  for (const code of ['APAYEE_UNREACHABLE', 'FAILED', 'TIMEOUT', undefined]) {
    assert.equal(componentStatus('apayee', failed(code)), 'down', String(code));
  }
  // The backend itself, on the other hand, is down when its probe fails.
  assert.equal(componentStatus('backend', failed('UNREACHABLE')), 'down');
});
