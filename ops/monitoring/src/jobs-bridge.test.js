import assert from 'node:assert/strict';
import { test } from 'node:test';

import { startDemo, uploadForm, waitForState } from '../../../server/jobs/fixtures/demo.js';
import { createJobMetrics } from '../../../server/jobs/metrics.js';
import { serializeSnapshot } from '../../../server/ops/snapshot-guard.js';
import { createAdapters } from './adapters/index.js';
import { createCollector } from './collector.js';
import { loadConfig } from './config.js';
import { isAllowedDockerCommand } from './exec.js';

/**
 * The whole bridge except Docker itself: the real metrics -> the backend's snapshot guard (what the
 * socket serves and the reader prints) -> the monitor's adapter, collector and view. `docker compose
 * exec` is replaced by a function that returns the reader's stdout.
 */

const config = loadConfig({
  MONITOR_JOBS_SOURCE: 'docker-exec',
  MONITOR_ADAPTER_TIMEOUT_MS: '500',
  MONITOR_POLL_MS: '3000',
});

function clock(start = 5_000_000) {
  let t = start;
  const now = () => t;
  now.advance = (ms) => (t += ms);
  return now;
}

/** A collector with only the jobs adapter, fed by `reader()`. */
function bridge(reader, now = clock()) {
  const commands = [];
  const adapters = createAdapters(config, {
    now,
    runDocker: async (bin, args) => {
      commands.push(args);
      return reader();
    },
  }).filter((a) => a.name === 'jobs');
  const collector = createCollector({ config, adapters, now });
  return { collector, commands, now };
}

test('a real job in a real demo app reaches the dashboard view with true counts', async () => {
  const demo = await startDemo();
  try {
    const visitor = await demo.visitor('bridge');
    const submitted = await demo.call('POST', '/api/jobs', {
      ticket: visitor.ticket,
      form: uploadForm(),
    });
    assert.equal(submitted.status, 202);
    const done = await waitForState(demo, visitor, submitted.body.job.id, ['completed', 'failed']);

    // What the reader prints: the backend's own guard around the real snapshot.
    const { collector, commands } = bridge(() => serializeSnapshot(demo.metrics.snapshot()));
    await collector.runOnce();
    const view = collector.view();

    assert.equal(view.readings.jobs.state, 'ok');
    const jobs = view.readings.jobs.data;
    assert.equal(jobs.total.submitted, 1);
    assert.equal(jobs.total[done.state], 1);
    assert.equal(jobs.now.queued, 0);
    assert.equal(jobs.now.processing, 0);
    assert.equal(jobs.workers.configured, 1);
    assert.equal(view.capacity.qatool.workersFree, 1);
    assert.equal(view.jobs.submitted, 1);
    assert.equal(view.jobs.completed + view.jobs.failed, 1);

    // The job id and the visitor's ticket never reached the monitor.
    const everything = JSON.stringify(view);
    assert.equal(everything.includes(submitted.body.job.id), false);
    assert.equal(everything.includes(visitor.ticket), false);

    // Exactly one command, and it is the allow-listed reader.
    assert.equal(commands.length, 1);
    assert.equal(isAllowedDockerCommand(commands[0]), true);
  } finally {
    await demo.close();
  }
});

test('zero jobs is a real zero; every unavailable source is not a number at all', async () => {
  // A platform that is running and idle: the honest answer is 0.
  const idle = createJobMetrics();
  idle.registerSource('jobs', () => ({
    queued: 0,
    processing: 0,
    completed: 0,
    failed: 0,
    cancelled: 0,
    workers_busy: 0,
    retained: 0,
  }));
  idle.registerSource('workers', () => ({ configured: 1, effective: 1, busy: 0 }));
  const running = bridge(() => serializeSnapshot(idle.snapshot()));
  await running.collector.runOnce();
  const zero = running.collector.view();
  assert.equal(zero.readings.jobs.state, 'ok');
  assert.equal(zero.readings.jobs.data.now.processing, 0);
  assert.equal(zero.jobs.successRate, null, 'no finished jobs: the rate is unknown, not 0%');
  assert.equal(zero.capacity.qatool.queued, 0);

  // Everything below is "we do not know", and must carry no figure.
  const reasons = {
    'socket disabled (exit 2)': () => {
      throw Object.assign(new Error('x'), { code: 'FAILED', exitStatus: 2 });
    },
    'socket unreachable (exit 3)': () => {
      throw Object.assign(new Error('x'), { code: 'FAILED', exitStatus: 3 });
    },
    'bad answer (exit 4)': () => {
      throw Object.assign(new Error('x'), { code: 'FAILED', exitStatus: 4 });
    },
    'docker stopped': () => {
      throw Object.assign(new Error('x'), { code: 'FAILED', exitStatus: 1 });
    },
    garbage: () => 'not json',
    'no job platform': () => JSON.stringify({ uptime_ms: 9, jobs: { current: null }, workers: {} }),
  };
  for (const [label, reader] of Object.entries(reasons)) {
    const { collector } = bridge(reader);
    await collector.runOnce();
    const view = collector.view();
    assert.notEqual(view.readings.jobs.state, 'ok', label);
    assert.equal(view.readings.jobs.data, null, label);
    assert.equal(view.jobs, null, label);
    assert.equal(view.capacity.qatool, null, label);
    assert.ok(view.readings.jobs.error?.message, `${label} says why`);
  }
});

test('the monitor-side states are named: disabled socket, no platform, unreachable', async () => {
  const state = async (reader) => {
    const { collector } = bridge(reader);
    await collector.runOnce();
    const r = collector.view().readings.jobs;
    return [r.state, r.error.code];
  };
  assert.deepEqual(
    await state(() => {
      throw Object.assign(new Error('x'), { code: 'FAILED', exitStatus: 2 });
    }),
    ['no_source', 'NO_SOURCE']
  );
  assert.deepEqual(
    await state(() => JSON.stringify({ uptime_ms: 9, jobs: { current: null }, workers: {} })),
    ['no_source', 'NO_SOURCE']
  );
  assert.deepEqual(
    await state(() => {
      throw Object.assign(new Error('x'), { code: 'FAILED', exitStatus: 3 });
    }),
    ['unavailable', 'SOCKET_UNREACHABLE']
  );
});

test('a hanging reader times out; the last good reading is kept as last known, not shown as current', async () => {
  let hang = false;
  const metrics = createJobMetrics();
  metrics.registerSource('jobs', () => ({
    queued: 4,
    processing: 1,
    completed: 0,
    failed: 0,
    cancelled: 0,
    workers_busy: 1,
    retained: 5,
  }));
  metrics.registerSource('workers', () => ({ configured: 1, effective: 1, busy: 1 }));
  const { collector, now } = bridge(() =>
    hang ? new Promise(() => {}) : serializeSnapshot(metrics.snapshot())
  );

  await collector.runOnce();
  assert.equal(collector.view().readings.jobs.data.now.queued, 4);

  hang = true;
  now.advance(4000);
  const started = Date.now();
  await collector.runOnce();
  assert.ok(Date.now() - started < 3000, 'the loop is not held up by the hung reader');

  const view = collector.view();
  assert.equal(view.readings.jobs.state, 'unavailable');
  assert.equal(view.readings.jobs.error.code, 'TIMEOUT');
  assert.equal(view.readings.jobs.data, null);
  assert.equal(view.readings.jobs.lastKnown.now.queued, 4);
  assert.equal(view.readings.jobs.lastSuccessAgeMs, 4000);
  assert.equal(view.capacity.qatool, null, 'nothing is derived from the old reading');
});

test('a reading that stops being refreshed is marked stale after three polls', async () => {
  const metrics = createJobMetrics();
  metrics.registerSource('jobs', () => ({
    queued: 0,
    processing: 0,
    completed: 0,
    failed: 0,
    cancelled: 0,
    workers_busy: 0,
    retained: 0,
  }));
  metrics.registerSource('workers', () => ({ configured: 1, effective: 1, busy: 0 }));
  const { collector, now } = bridge(() => serializeSnapshot(metrics.snapshot()));
  await collector.runOnce();
  assert.equal(collector.view().readings.jobs.stale, false);

  now.advance(config.staleAfterMs + 1);
  const view = collector.view();
  assert.equal(view.readings.jobs.stale, true);
  assert.ok(view.warnings.some((w) => w.code === 'stale' && /jobs/.test(w.text)));
});

test('a backend restart shows up as a reset, and the counters are not stitched together', async () => {
  const before = createJobMetrics({ now: () => 1_000_000 });
  const after = createJobMetrics({ now: () => 1_000_000 });
  for (const m of [before, after]) {
    m.registerSource('jobs', () => ({
      queued: 0,
      processing: 0,
      completed: 0,
      failed: 0,
      cancelled: 0,
      workers_busy: 0,
      retained: 0,
    }));
    m.registerSource('workers', () => ({ configured: 1, effective: 1, busy: 0 }));
  }
  before.inc('jobs_submitted', 20);
  before.inc('jobs_completed', 20);

  let current = before;
  let uptime = 900_000;
  const read = () => serializeSnapshot({ ...current.snapshot(), uptime_ms: uptime });
  const { collector, now } = bridge(read);
  await collector.runOnce();

  current = after; // the restarted process: counters back to zero
  uptime = 4_000;
  now.advance(4000);
  await collector.runOnce();

  const view = collector.view();
  assert.equal(view.monitor.backendResetsSeen, 1);
  assert.match(view.events[0].text, /restarted/);
  assert.equal(view.jobs.submitted, 0, 'the new, lower figure is shown as it is');
  assert.equal(
    view.events.some((e) => /-\d/.test(e.text)),
    false,
    'no negative deltas'
  );
});

test('secrets and hostile text from the reader or from a failure never reach the view', async () => {
  const hostile = JSON.stringify({
    uptime_ms: 10,
    jobs: { current: { queued: 1 }, submitted: 1 },
    workers: { configured: 1, effective: 1, busy: 0 },
    ticket: 'eyJhbGciOiJIUzI1NiJ9.eyJzaWQiOiJ4In0.abcdefghij',
    sessions: ['sid-abc'],
    errors: { by_code: { 'TICKET_SECRET=hunter22222': 1, OK_CODE: 2 } },
  });
  const a = bridge(() => hostile);
  await a.collector.runOnce();
  const text = JSON.stringify(a.collector.view());
  assert.doesNotMatch(text, /eyJhbGci|sid-abc|hunter22222/);
  assert.equal(a.collector.view().readings.jobs.data.errorsByCode.OK_CODE, 2);

  const b = bridge(() => {
    throw new Error(
      'exec failed: Authorization: Bearer abcdefghijklmnop1234 TICKET_SECRET=hunter22222'
    );
  });
  await b.collector.runOnce();
  assert.doesNotMatch(JSON.stringify(b.collector.view()), /abcdefghijklmnop1234|hunter22222/);
});

test('the monitor stays read-only: only the fixed reader command is ever issued', async () => {
  const metrics = createJobMetrics();
  metrics.registerSource('jobs', () => ({
    queued: 0,
    processing: 0,
    completed: 0,
    failed: 0,
    cancelled: 0,
    workers_busy: 0,
    retained: 0,
  }));
  metrics.registerSource('workers', () => ({ configured: 1, effective: 1, busy: 0 }));
  const { collector, commands, now } = bridge(() => serializeSnapshot(metrics.snapshot()));
  for (let i = 0; i < 5; i++) {
    now.advance(4000);
    await collector.runOnce();
  }
  assert.equal(commands.length, 5);
  for (const args of commands) {
    assert.equal(isAllowedDockerCommand(args), true);
    assert.deepEqual(args.slice(-4), [
      '-T',
      'qatool-backend',
      'node',
      '/app/server/ops/read-metrics.js',
    ]);
    assert.doesNotMatch(args.join(' '), /\b(restart|stop|kill|rm|down|up|run|cp|prune)\b/);
  }
});

test('the reader path the monitor runs matches the backend image: WORKDIR, COPY, user, and not ignored', async () => {
  const { readFileSync, existsSync } = await import('node:fs');
  const { BACKEND_READER_PATH } = await import('./exec.js');
  const root = new URL('../../../', import.meta.url);
  const dockerfile = readFileSync(new URL('Dockerfile.backend', root), 'utf8');
  const dockerignore = readFileSync(new URL('.dockerignore', root), 'utf8');

  // /app + server/ops/read-metrics.js, with server/ copied to ./server
  assert.match(dockerfile, /^WORKDIR \/app$/m);
  assert.match(dockerfile, /^COPY --chown=node:node server \.\/server$/m);
  assert.equal(BACKEND_READER_PATH, '/app/server/ops/read-metrics.js');
  assert.equal(existsSync(new URL('server/ops/read-metrics.js', root)), true);

  // exec runs as the image's user, the same one that owns the socket.
  assert.match(dockerfile, /^USER node$/m);

  // The build context is an allow-list; nothing in it removes server/ops or the reader.
  assert.match(dockerignore, /^!server\/$/m);
  assert.doesNotMatch(dockerignore, /^[^#\n]*\b(ops|read-metrics|metrics-socket)\b/m);
});
