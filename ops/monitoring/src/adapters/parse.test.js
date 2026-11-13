import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createJobMetrics } from '../../../../server/jobs/metrics.js';
import {
  parseApayeeHealth,
  parseDockerInspect,
  parseDockerPs,
  parseDockerStats,
  parseJobMetrics,
  parseSize,
} from './parse.js';

// What src/routes/health.js in Apayee returns (read from the source, not from documentation).
const APAYEE_BODY = {
  status: 'ok',
  service: 'apayee',
  version: '0.4.0',
  provider: 'claude',
  provider_status: { ready: true, state: 'ready', cli_version: '2.1.299' },
  queue: {
    length: 1,
    running: true,
    active: 2,
    max_active: 3,
    pending: 1,
    capacity: 20,
    abandoned: 0,
    totals: { succeeded: 40, failed: 2, timed_out: 1, cancelled: 3, rejected: 4 },
  },
};

test('Apayee health: fields are copied and typed', () => {
  const h = parseApayeeHealth(JSON.stringify(APAYEE_BODY));
  assert.equal(h.status, 'ok');
  assert.equal(h.provider, 'claude');
  assert.equal(h.providerReady, true);
  assert.equal(h.active, 2);
  assert.equal(h.maxActive, 3);
  assert.equal(h.pending, 1);
  assert.equal(h.capacity, 20);
  assert.deepEqual(h.totals, { succeeded: 40, failed: 2, timedOut: 1, cancelled: 3, rejected: 4 });
});

test('Apayee health: not-ready provider is reported, with its reason redacted', () => {
  const h = parseApayeeHealth({
    ...APAYEE_BODY,
    provider: 'claude_not_ready',
    provider_status: {
      ready: false,
      state: 'not_signed_in',
      reason: 'see C:\\Users\\kelvi\\.claude',
    },
  });
  assert.equal(h.providerReady, false);
  assert.equal(h.providerState, 'not_signed_in');
  assert.doesNotMatch(h.providerReason, /kelvi/);
});

test('Apayee health: an older body with only length/running still maps', () => {
  const h = parseApayeeHealth({
    status: 'ok',
    service: 'apayee',
    queue: { length: 4, running: true },
  });
  assert.equal(h.active, 1);
  assert.equal(h.pending, 4);
  assert.equal(h.maxActive, null);
  assert.equal(h.capacity, null);
});

test('Apayee health: extra fields are dropped, wrong shapes are errors', () => {
  const h = parseApayeeHealth({
    ...APAYEE_BODY,
    secret: 'x',
    queue: { ...APAYEE_BODY.queue, token: 'y' },
  });
  assert.equal('secret' in h, false);
  assert.equal(JSON.stringify(h).includes('"y"'), false);

  for (const bad of [
    'not json',
    '{}',
    '[]',
    JSON.stringify({ service: 'other', queue: {} }),
    JSON.stringify({ service: 'apayee' }),
  ]) {
    assert.throws(
      () => parseApayeeHealth(bad),
      (e) => e.code === 'BAD_SHAPE',
      String(bad)
    );
  }
});

/** A snapshot produced by the real QATOOL code, so a change to its shape fails here. */
function realSnapshot() {
  let t = 1_000_000;
  const metrics = createJobMetrics({ now: () => t });
  metrics.registerSource('jobs', () => ({
    queued: 3,
    processing: 1,
    completed: 5,
    failed: 1,
    cancelled: 2,
    workers_busy: 1,
    retained: 12,
  }));
  metrics.registerSource('workers', () => ({ configured: 1, effective: 1, busy: 1 }));
  metrics.registerSource('active_starts', () => [t - 5000]);
  metrics.registerSource('uploads', () => ({
    inflight: 0,
    inflight_max: 4,
    parsing: 0,
    waiting_to_parse: 0,
  }));
  metrics.registerSource('apayee', () => ({
    active: 1,
    max_active: 1,
    pending: 0,
    capacity: 20,
    reported: true,
    compatible: true,
    observed_at: '2026-11-05T00:00:00.000Z',
  }));
  for (const name of [
    'jobs_submitted',
    'jobs_submitted',
    'jobs_submitted',
    'jobs_completed',
    'jobs_failed',
    'jobs_cancelled',
    'rejected_queue_full',
    'breaker_trips',
    'job_error_PROVIDER_TIMEOUT',
    'tickets_minted',
  ]) {
    metrics.inc(name);
  }
  metrics.observe('processing_ms', 42_000);
  metrics.observe('processing_ms', 61_000);
  metrics.observe('queue_wait_ms', 3_000);
  metrics.touchSession('sid-must-never-appear');
  t += 90_000;
  return metrics.snapshot();
}

test('job metrics: parses a snapshot produced by the real createJobMetrics()', () => {
  const raw = realSnapshot();
  const j = parseJobMetrics(JSON.stringify(raw));
  assert.deepEqual(j.now, {
    queued: 3,
    processing: 1,
    completed: 5,
    failed: 1,
    cancelled: 2,
    retained: 12,
  });
  assert.equal(j.total.submitted, 3);
  assert.equal(j.total.completed, 1);
  assert.equal(j.workers.effective, 1);
  assert.equal(j.workers.busy, 1);
  assert.equal(j.durationsMs.processing.count, 2);
  assert.equal(j.durationsMs.processing.max, 61_000);
  assert.equal(j.rejections.queue_full, 1);
  assert.equal(j.errorsByCode.PROVIDER_TIMEOUT, 1);
  assert.equal(j.breakerTrips, 1);
  assert.equal(j.apayeeSeenByBackend.maxActive, 1);
  assert.equal(j.activeSessions, 1);
  assert.equal(j.uptimeMs, 90_000);
});

test('job metrics: no session id or other unknown field survives parsing', () => {
  const j = parseJobMetrics(realSnapshot());
  assert.doesNotMatch(JSON.stringify(j), /sid-must-never-appear/);
  const hostile = parseJobMetrics({ ...realSnapshot(), ticket: 'eyJsecret', sessions_list: ['a'] });
  assert.doesNotMatch(JSON.stringify(hostile), /eyJsecret/);
});

test('job metrics: missing sections become null, not zero', () => {
  const j = parseJobMetrics({ uptime_ms: 5, jobs: { current: {} }, workers: {} });
  assert.equal(j.workers.effective, null);
  assert.equal(j.apayeeSeenByBackend, null);
  assert.equal(j.uploads, null);
  assert.equal(j.durationsMs.processing, null);
  assert.throws(
    () => parseJobMetrics({ jobs: {} }),
    (e) => e.code === 'BAD_SHAPE'
  );
  assert.throws(
    () => parseJobMetrics('<html>'),
    (e) => e.code === 'BAD_SHAPE'
  );
});

test('job metrics: counter names are bounded to safe identifiers', () => {
  const j = parseJobMetrics({
    ...realSnapshot(),
    errors: { by_code: { ok_code: 2, '<script>': 9, ['x'.repeat(200)]: 1 } },
  });
  assert.deepEqual(j.errorsByCode, { ok_code: 2 });
});

test('docker ps: only validated short ids are returned', () => {
  const text = [
    `{"ID":"a1b2c3d4e5f6","Names":"qatool-apayee-1"}`,
    `{"ID":"0123456789ab","Names":"x"}`,
    '',
  ].join('\n');
  assert.deepEqual(parseDockerPs(text), ['a1b2c3d4e5f6', '0123456789ab']);
  assert.throws(
    () => parseDockerPs('{"ID":"rm -rf /"}'),
    (e) => e.code === 'BAD_SHAPE'
  );
  assert.throws(
    () => parseDockerPs('garbage'),
    (e) => e.code === 'BAD_SHAPE'
  );
});

const inspectLine = (service, state, extra = {}) =>
  JSON.stringify({
    id: 'a1b2c3d4e5f6a1b2c3d4',
    state,
    restarts: 2,
    labels: { 'com.docker.compose.service': service },
    mem_limit: 1073741824,
    ...extra,
  });

test('docker inspect: health, restarts, uptime and OOM are read; no health check shows as null', () => {
  const now = Date.parse('2026-11-05T10:00:00Z');
  const lines = [
    inspectLine('qatool-backend', {
      Status: 'running',
      Running: true,
      StartedAt: '2026-11-05T08:00:00Z',
      Health: { Status: 'healthy', Log: [{ Output: 'x' }] },
      OOMKilled: false,
      ExitCode: 0,
    }),
    inspectLine('qatool-frontend', {
      Status: 'exited',
      Running: false,
      StartedAt: '0001-01-01T00:00:00Z',
      OOMKilled: true,
      ExitCode: 137,
    }),
  ].join('\n');
  const [backend, frontend] = parseDockerInspect(lines, now);
  assert.equal(backend.service, 'qatool-backend');
  assert.equal(backend.health, 'healthy');
  assert.equal(backend.restarts, 2);
  assert.equal(backend.uptimeMs, 2 * 3600 * 1000);
  assert.equal(backend.memLimitBytes, 1073741824);
  assert.equal(frontend.running, false);
  assert.equal(frontend.health, null);
  assert.equal(frontend.uptimeMs, null);
  assert.equal(frontend.oomKilled, true);
  assert.equal('Log' in backend, false);
});

test('docker inspect: a container outside Compose is skipped, a bad shape is an error', () => {
  assert.deepEqual(
    parseDockerInspect(
      inspectLine('', { Running: true }).replace('com.docker.compose.service', 'other')
    ),
    []
  );
  assert.throws(
    () => parseDockerInspect('{"foo":1}'),
    (e) => e.code === 'BAD_SHAPE'
  );
});

test('sizes and docker stats', () => {
  assert.equal(parseSize('12.5MiB'), Math.round(12.5 * 1024 ** 2));
  assert.equal(parseSize('2GiB'), 2 * 1024 ** 3);
  assert.equal(parseSize('1.5kB'), 1500);
  assert.equal(parseSize('--'), null);
  assert.equal(parseSize(''), null);

  const stats = parseDockerStats(
    '{"ID":"a1b2c3d4e5f6","CPUPerc":"3.25%","MemUsage":"512MiB / 2GiB","MemPerc":"25.00%","PIDs":"31"}'
  );
  assert.deepEqual(stats.get('a1b2c3d4e5f6'), {
    cpuPercent: 3.25,
    memUsedBytes: 512 * 1024 ** 2,
    memLimitBytes: 2 * 1024 ** 3,
    memPercent: 25,
    pids: 31,
  });
  const odd = parseDockerStats('{"ID":"a1b2c3d4e5f6","CPUPerc":"--","MemUsage":"--"}').get(
    'a1b2c3d4e5f6'
  );
  assert.equal(odd.cpuPercent, null);
  assert.equal(odd.memUsedBytes, null);
});
