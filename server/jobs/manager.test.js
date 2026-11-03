import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { LlmError } from '../llm/provider.js';
import { ProviderUnavailableError } from '../llm/catalog.js';
import { createProviderBreaker } from './breaker.js';
import { JobManager } from './manager.js';
import { createJobMetrics } from './metrics.js';

/**
 * The job manager on its own: no HTTP, no documents, no model. The work is a fake run
 * that the test finishes, fails or lets be aborted, so every transition is deliberate.
 */

const MINUTE = 60_000;

/** Every manager a test built, so none is left holding a deadline timer open. */
const managers = [];
afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.shutdown({ graceMs: 200 })));
});

function clock(start = Date.UTC(2026, 10, 3, 12, 0, 0)) {
  const state = { t: start };
  return Object.assign(() => state.t, {
    advance(ms) {
      state.t += ms;
    },
  });
}

const settle = () => new Promise((resolve) => setImmediate(resolve));
const sid = (n) => String(n).padStart(22, 'S');

const defaults = {
  workers: 1,
  maxPending: 2,
  leaseMs: 45_000,
  deadlineMs: 60_000,
  retainCompletedMs: 15 * MINUTE,
  retainFailedMs: 5 * MINUTE,
  maxTerminal: 30,
  uploadInflightMax: 4,
  parseConcurrency: 1,
  pollIntervalMs: 2500,
  reservationTtlMs: 120_000,
};

/**
 * @param {object} [overrides]  settings
 * @param {object} [options]
 * @param {object | null} [options.capacity]  what the "gateway" reports; defaults to as many as workers
 */
function harness(overrides = {}, { capacity } = {}) {
  const now = clock();
  const metrics = createJobMetrics({ now });
  const breaker = createProviderBreaker({ cooldownMs: MINUTE, now });
  const runs = new Map();
  const startOrder = [];
  const aborted = [];

  const run = (context) =>
    new Promise((resolve, reject) => {
      runs.set(context.id, { context, resolve, reject });
      startOrder.push(context.id);
      context.signal.addEventListener(
        'abort',
        () => {
          aborted.push(context.id);
          reject(context.signal.reason);
        },
        { once: true }
      );
    });

  const settings = { ...defaults, ...overrides };
  const manager = new JobManager({ settings, run, breaker, metrics, now });
  managers.push(manager);
  manager.observeCapacity(
    capacity === undefined
      ? {
          reported: true,
          compatible: true,
          maxActive: settings.workers,
          active: 0,
          pending: 0,
          capacity: 16,
        }
      : capacity
  );

  /** Submits a job as visitor `n`. */
  const submit = (n, from = 'extract') => manager.reserve(sid(n)).commit({ from, input: { n } });

  return {
    now,
    metrics,
    breaker,
    manager,
    runs,
    startOrder,
    aborted,
    submit,
    async finish(id) {
      runs.get(id).resolve();
      await settle();
    },
    async fail(id, error) {
      runs.get(id).reject(error);
      await settle();
    },
    state: (n, id) => manager.status(sid(n), id).state,
  };
}

const code = (promiseOrFn, expected, status) => {
  try {
    (typeof promiseOrFn === 'function' ? promiseOrFn : () => promiseOrFn)();
  } catch (error) {
    assert.equal(error.code, expected);
    if (status) assert.equal(error.statusCode, status);
    return error;
  }
  assert.fail(`expected ${expected}`);
};

describe('scheduling', () => {
  it('runs jobs first in, first out, one worker at a time, with queue positions', async () => {
    const h = harness({ workers: 1, maxPending: 5 });
    const a = h.submit(1);
    const b = h.submit(2);
    const c = h.submit(3);
    const d = h.submit(4);

    assert.equal(a.state, 'processing');
    assert.equal(a.position, null);
    assert.deepEqual(
      [b, c, d].map(
        (job) => h.manager.status(sid(job === b ? 2 : job === c ? 3 : 4), job.id).position
      ),
      [1, 2, 3]
    );

    await h.finish(a.id);
    assert.deepEqual(h.startOrder, [a.id, b.id]);
    assert.equal(h.manager.status(sid(3), c.id).position, 1);

    await h.finish(b.id);
    await h.finish(c.id);
    await h.finish(d.id);
    assert.deepEqual(h.startOrder, [a.id, b.id, c.id, d.id], 'strict arrival order');
    assert.equal(h.state(4, d.id), 'completed');
  });

  it('with 3 workers: 3 processing and 7 pending from 10 simultaneous submissions', async () => {
    const h = harness({ workers: 3, maxPending: 10 });
    const jobs = Array.from({ length: 10 }, (_, i) => h.submit(i + 1));

    assert.deepEqual(
      jobs.map((job, i) => h.manager.status(sid(i + 1), job.id).state),
      ['processing', 'processing', 'processing', ...Array(7).fill('queued')]
    );
    assert.deepEqual(
      jobs.slice(3).map((job, i) => h.manager.status(sid(i + 4), job.id).position),
      [1, 2, 3, 4, 5, 6, 7]
    );
    assert.equal(h.manager.effectiveWorkers, 3);
  });

  it('accepts exactly workers + pending jobs, then answers 429 QUEUE_FULL with a retry time', () => {
    const h = harness({ workers: 3, maxPending: 10 });
    for (let i = 1; i <= 13; i += 1) h.submit(i);

    const refusal = code(() => h.manager.reserve(sid(14)), 'QUEUE_FULL', 429);
    assert.ok(Number.isInteger(refusal.retryAfterSeconds) && refusal.retryAfterSeconds >= 5);
  });

  it('frees a place when a job finishes', async () => {
    const h = harness({ workers: 1, maxPending: 1 });
    const a = h.submit(1);
    h.submit(2);
    code(() => h.manager.reserve(sid(3)), 'QUEUE_FULL');

    await h.finish(a.id);
    h.submit(3);
  });

  it('runs only as many jobs as the gateway says it can run at once', async () => {
    const h = harness(
      { workers: 3, maxPending: 10 },
      {
        capacity: {
          reported: true,
          compatible: true,
          maxActive: 1,
          active: 0,
          pending: 0,
          capacity: 16,
        },
      }
    );
    const jobs = [1, 2, 3, 4].map((n) => h.submit(n));

    assert.equal(h.manager.effectiveWorkers, 1);
    assert.equal(h.runs.size, 1, 'three workers configured, one allowed');

    // The gateway is raised to 2: the next waiting job starts at once.
    h.manager.observeCapacity({ reported: true, compatible: true, maxActive: 2, active: 1 });
    assert.equal(h.runs.size, 2);

    h.manager.observeCapacity({ reported: true, compatible: true, maxActive: 9, active: 2 });
    assert.equal(h.manager.effectiveWorkers, 3, 'never above the configured count');
    assert.equal(h.runs.size, 3);
    void jobs;
  });

  it('assumes one when the gateway never reported its capacity', () => {
    const h = harness({ workers: 3, maxPending: 4 }, { capacity: null });
    h.submit(1);
    h.submit(2);
    assert.equal(h.manager.effectiveWorkers, 1);
    assert.equal(h.runs.size, 1);

    // An older gateway: readQueue() returns maxActive 1 with reported:false.
    h.manager.observeCapacity({ reported: false, compatible: true, maxActive: 1 });
    assert.equal(h.runs.size, 1);
  });

  it('starts nothing and admits nothing when the gateway contract is not being followed', () => {
    const h = harness({ workers: 3, maxPending: 4 });
    h.manager.observeCapacity({ reported: false, compatible: false, maxActive: 1 });

    assert.equal(h.manager.effectiveWorkers, 0);
    code(() => h.manager.reserve(sid(1)), 'SERVICE_UNAVAILABLE', 503);
  });

  it('keeps a worker busy until a cancelled job has actually stopped', async () => {
    const h = harness({ workers: 1, maxPending: 2 });
    const a = h.submit(1);
    const b = h.submit(2);

    h.manager.cancel(sid(1), a.id);
    assert.equal(h.state(1, a.id), 'cancelled');
    assert.deepEqual(h.aborted, [a.id]);
    // The abort handler rejected the run, but until its promise has settled the slot is held.
    await settle();
    assert.equal(h.state(2, b.id), 'processing', 'the next job starts once the first has stopped');
  });
});

describe('admission', () => {
  it('allows one live job per visitor and tells them which', async () => {
    const h = harness({ workers: 1, maxPending: 5 });
    const first = h.submit(1);

    const refusal = code(() => h.manager.reserve(sid(1)), 'JOB_ALREADY_ACTIVE', 409);
    assert.deepEqual(refusal.details, { job_id: first.id });

    h.submit(2);
    await h.finish(first.id);
    h.submit(1);
  });

  it('counts an upload in progress as that visitor’s live job', () => {
    const h = harness();
    const reservation = h.manager.reserve(sid(1));

    const refusal = code(() => h.manager.reserve(sid(1)), 'JOB_ALREADY_ACTIVE', 409);
    assert.deepEqual(refusal.details, { job_id: null });

    reservation.release();
    h.manager.reserve(sid(1));
  });

  it('caps uploads in flight across all visitors', () => {
    const h = harness({ workers: 3, maxPending: 20, uploadInflightMax: 4 });
    const held = [1, 2, 3, 4].map((n) => h.manager.reserve(sid(n)));

    const refusal = code(() => h.manager.reserve(sid(5)), 'UPLOAD_BUSY', 429);
    assert.ok(refusal.retryAfterSeconds >= 1);

    held[0].release();
    h.manager.reserve(sid(5));
  });

  it('counts reservations against the queue, and gives them back on release', () => {
    const h = harness({ workers: 1, maxPending: 1, uploadInflightMax: 10 });
    const a = h.manager.reserve(sid(1));
    const b = h.manager.reserve(sid(2));
    code(() => h.manager.reserve(sid(3)), 'QUEUE_FULL');

    a.release();
    a.release(); // idempotent
    h.manager.reserve(sid(3));
    void b;
  });

  it('drops a reservation that never committed (a connection that died mid-upload)', () => {
    const h = harness({ workers: 1, maxPending: 0 + 1, reservationTtlMs: 120_000 });
    h.manager.reserve(sid(1));
    h.manager.reserve(sid(2));
    code(() => h.manager.reserve(sid(3)), 'QUEUE_FULL');

    h.now.advance(121_000);
    h.manager.sweep();
    h.manager.reserve(sid(3));
  });

  it('refuses to commit a reservation twice', () => {
    const h = harness();
    const reservation = h.manager.reserve(sid(1));
    reservation.commit({ from: 'extract', input: {} });
    assert.throws(() => reservation.commit({ from: 'extract', input: {} }));
  });

  it('counts each refusal reason', () => {
    const h = harness({ workers: 1, maxPending: 1, uploadInflightMax: 1 });
    const r = h.manager.reserve(sid(1));
    code(() => h.manager.reserve(sid(1)), 'JOB_ALREADY_ACTIVE');
    code(() => h.manager.reserve(sid(2)), 'UPLOAD_BUSY');
    r.release();
    h.submit(1);
    h.submit(2);
    code(() => h.manager.reserve(sid(3)), 'QUEUE_FULL');

    const { rejections } = h.metrics.snapshot();
    assert.equal(rejections.already_active, 1);
    assert.equal(rejections.upload_busy, 1);
    assert.equal(rejections.queue_full, 1);
  });
});

describe('ownership', () => {
  it('answers identically for an unknown job, an expired one and someone else’s', async () => {
    const h = harness({ workers: 1, maxPending: 5 });
    const mine = h.submit(1);
    const expired = h.submit(2);
    h.manager.cancel(sid(2), expired.id);
    h.now.advance(6 * MINUTE);
    h.manager.status(sid(1), mine.id); // keeps its lease; only `expired` is meant to age out
    h.manager.sweep();

    const answers = [];
    for (const attempt of [
      () => h.manager.status(sid(3), mine.id), // someone else's
      () => h.manager.status(sid(2), expired.id), // expired
      () => h.manager.status(sid(1), `j_${'x'.repeat(22)}`), // unknown
      () => h.manager.status(sid(1), 'not-a-job-id'), // malformed
      () => h.manager.status(sid(1), undefined),
      () => h.manager.result(sid(3), mine.id),
      () => h.manager.cancel(sid(3), mine.id),
    ]) {
      try {
        attempt();
        assert.fail('should have refused');
      } catch (error) {
        assert.equal(error.statusCode, 404);
        answers.push(JSON.stringify(error.toJSON()));
      }
    }
    assert.equal(new Set(answers).size, 1, 'the three cases cannot be told apart');
    assert.equal(h.state(1, mine.id), 'processing', 'a refused cancel changed nothing');
  });

  it('keeps ten visitors’ jobs apart', () => {
    const h = harness({ workers: 3, maxPending: 10 });
    const jobs = Array.from({ length: 10 }, (_, i) => h.submit(i + 1));

    for (let owner = 0; owner < 10; owner += 1) {
      for (let other = 0; other < 10; other += 1) {
        const attempt = () => h.manager.status(sid(other + 1), jobs[owner].id);
        if (owner === other) assert.doesNotThrow(attempt);
        else assert.throws(attempt, (error) => error.code === 'JOB_NOT_FOUND');
      }
    }
  });

  it('makes job ids that are random, not a sequence', () => {
    const h = harness({ workers: 3, maxPending: 100, uploadInflightMax: 200 });
    const ids = Array.from({ length: 50 }, (_, i) => h.submit(i + 1).id);
    assert.equal(new Set(ids).size, 50);
    for (const id of ids) assert.match(id, /^j_[A-Za-z0-9_-]{22}$/);
  });
});

describe('cancellation', () => {
  it('removes a queued job from the line and renumbers the rest', () => {
    const h = harness({ workers: 1, maxPending: 5 });
    h.submit(1);
    const b = h.submit(2);
    const c = h.submit(3);

    const view = h.manager.cancel(sid(2), b.id);
    assert.equal(view.state, 'cancelled');
    assert.equal(view.cancel_reason, 'user');
    assert.equal(h.manager.status(sid(3), c.id).position, 1);
    assert.equal(h.runs.has(b.id), false, 'it never started');
  });

  it('aborts a processing job’s signal and reports cancelled at once', async () => {
    const h = harness();
    const a = h.submit(1);

    const view = h.manager.cancel(sid(1), a.id);
    assert.equal(view.state, 'cancelled');
    assert.deepEqual(h.aborted, [a.id]);
    await settle();
    assert.equal(h.state(1, a.id), 'cancelled', 'the abort does not turn into a failure');
  });

  it('is idempotent, and leaves a finished job as it is', async () => {
    const h = harness({ maxPending: 3 });
    const a = h.submit(1);
    const b = h.submit(2);

    h.manager.cancel(sid(2), b.id);
    const again = h.manager.cancel(sid(2), b.id);
    assert.equal(again.state, 'cancelled');

    await h.finish(a.id);
    const done = h.manager.cancel(sid(1), a.id);
    assert.equal(done.state, 'completed');
    assert.equal(done.cancel_reason, null);
    assert.equal(h.metrics.snapshot().jobs.cancelled, 1, 'counted once');
  });

  it('lets the visitor start a new job as soon as they cancel', () => {
    const h = harness({ maxPending: 3 });
    const a = h.submit(1);
    h.manager.cancel(sid(1), a.id);
    h.submit(1);
  });
});

describe('the lease', () => {
  it('removes an abandoned queued job as if it had never been there', () => {
    const h = harness({ workers: 1, maxPending: 3 });
    h.submit(1);
    const queued = h.submit(2);

    h.now.advance(46_000);
    h.manager.status(sid(1), h.startOrder[0]); // only the first is polled
    h.manager.sweep();

    assert.throws(
      () => h.manager.status(sid(2), queued.id),
      (error) => error.code === 'JOB_NOT_FOUND'
    );
    h.submit(2); // its visitor is free again
    assert.equal(h.metrics.snapshot().jobs.cancelled_by_reason.abandoned, 1);
  });

  it('cancels an abandoned processing job, which stops the model work', async () => {
    const h = harness();
    const a = h.submit(1);

    h.now.advance(46_000);
    h.manager.sweep();

    assert.deepEqual(h.aborted, [a.id]);
    assert.equal(h.state(1, a.id), 'cancelled');
    assert.equal(h.manager.status(sid(1), a.id).cancel_reason, 'abandoned');
    await settle();
  });

  it('is renewed by every status poll, and only by a status poll', () => {
    const h = harness({ workers: 1, maxPending: 3 });
    const a = h.submit(1);

    for (let i = 0; i < 10; i += 1) {
      h.now.advance(30_000);
      h.manager.status(sid(1), a.id);
      h.manager.sweep();
      assert.equal(
        h.state(1, a.id),
        'processing',
        `still alive after ${(i + 1) * 30} s of polling`
      );
    }

    h.now.advance(30_000);
    h.manager.result(sid(1), a.id); // fetching a result does not renew it
    h.now.advance(20_000);
    h.manager.sweep();
    assert.equal(h.manager.status(sid(1), a.id).state, 'cancelled');
  });

  it('does not touch a finished job', async () => {
    const h = harness();
    const a = h.submit(1);
    await h.finish(a.id);

    h.now.advance(5 * MINUTE);
    h.manager.sweep();
    assert.equal(h.state(1, a.id), 'completed');
  });
});

describe('retention', () => {
  it('keeps a completed job 15 minutes and a failed or cancelled one 5', async () => {
    const h = harness({ workers: 3, maxPending: 5 });
    const done = h.submit(1);
    const failed = h.submit(2);
    const cancelled = h.submit(3);

    await h.finish(done.id);
    await h.fail(failed.id, new Error('boom'));
    h.manager.cancel(sid(3), cancelled.id);

    const keepPolling = () => {
      // Terminal jobs have no lease; polling is only to show they are still readable.
      return [
        [1, done.id],
        [2, failed.id],
        [3, cancelled.id],
      ].map(([n, id]) => {
        try {
          return h.manager.status(sid(n), id).state;
        } catch {
          return 'gone';
        }
      });
    };

    h.now.advance(4 * MINUTE);
    h.manager.sweep();
    assert.deepEqual(keepPolling(), ['completed', 'failed', 'cancelled']);

    h.now.advance(2 * MINUTE);
    h.manager.sweep();
    assert.deepEqual(keepPolling(), ['completed', 'gone', 'gone']);

    h.now.advance(10 * MINUTE);
    h.manager.sweep();
    assert.deepEqual(keepPolling(), ['gone', 'gone', 'gone']);
  });

  it('keeps at most 30 finished jobs, dropping the oldest', async () => {
    const h = harness({ workers: 1, maxPending: 2, maxTerminal: 30 });
    const ids = [];
    for (let i = 1; i <= 40; i += 1) {
      const job = h.submit(i);
      ids.push(job.id);
      await h.finish(job.id);
      h.now.advance(1000);
    }

    const alive = ids.filter((id, index) => {
      try {
        h.manager.status(sid(index + 1), id);
        return true;
      } catch {
        return false;
      }
    });
    assert.equal(alive.length, 30);
    assert.deepEqual(alive, ids.slice(10), 'the ten oldest are gone');
  });
});

describe('results and failures', () => {
  it('keeps the phases a failed job finished, and marks what did not run', async () => {
    const h = harness();
    const a = h.submit(1);
    const { context } = h.runs.get(a.id);

    context.beginPhase('extract');
    context.endPhase('extract', { requirements: [1, 2] });
    context.beginPhase('generate');
    await h.fail(
      a.id,
      new LlmError('LLM_UNAVAILABLE', 'Could not reach Apayee at http://apayee:4100', 503)
    );

    const { job, phases } = h.manager.result(sid(1), a.id);
    assert.equal(job.state, 'failed');
    assert.deepEqual(job.phases, { extract: 'done', generate: 'failed', validate: 'not_run' });
    assert.deepEqual(phases, { extract: { requirements: [1, 2] } });
    assert.equal(job.result_available, true);
    assert.equal(job.error.phase, 'generate');
    assert.equal(job.error.retryable, true);
  });

  it('marks the phases before `from` as skipped', () => {
    const h = harness({ workers: 3, maxPending: 5 });
    assert.deepEqual(h.submit(1, 'generate').phases, {
      extract: 'skipped',
      generate: 'pending',
      validate: 'pending',
    });
    assert.deepEqual(h.submit(2, 'validate').phases, {
      extract: 'skipped',
      generate: 'skipped',
      validate: 'pending',
    });
  });

  it('tells a visitor nothing about the provider, an address, a path or a setting', async () => {
    const leaks = [
      new Error('connect ECONNREFUSED 172.18.0.3:4100 at C:\\Users\\kelvi\\x.js'),
      new LlmError(
        'LLM_UNAVAILABLE',
        'Could not reach Apayee at http://apayee:4100 (ECONNREFUSED)',
        502
      ),
      new LlmError(
        'LLM_NOT_CONFIGURED',
        "Apayee's provider is not ready: the Claude CLI is signed out",
        503
      ),
      new ProviderUnavailableError('claude', {
        reason: 'Apayee is running with the mock provider',
        code: 'provider_not_ready',
      }),
    ];

    for (const error of leaks) {
      const h = harness();
      const a = h.submit(1);
      await h.fail(a.id, error);

      const text = JSON.stringify(h.manager.status(sid(1), a.id));
      for (const secret of [
        'Apayee',
        'apayee',
        'http://',
        '172.18',
        'C:\\',
        'ECONNREFUSED',
        'CLI',
        'claude',
        'mock',
      ]) {
        assert.ok(!text.includes(secret), `"${secret}" leaked: ${text}`);
      }
    }
  });

  it('describes an unexpected error as a generic internal error, and logs only its class', async () => {
    const lines = [];
    const h = harness();
    const logged = new JobManager({
      settings: { ...defaults },
      run: () => Promise.reject(new TypeError('document says: attack at dawn')),
      breaker: h.breaker,
      metrics: h.metrics,
      now: h.now,
      logger: { warn: (...args) => lines.push(JSON.stringify(args)) },
    });
    managers.push(logged);
    logged.observeCapacity({ maxActive: 1, compatible: true });
    const view = logged.reserve(sid(1)).commit({ from: 'extract', input: {} });
    await settle();

    const failed = logged.status(sid(1), view.id);
    assert.equal(failed.error.code, 'INTERNAL_ERROR');
    assert.ok(lines.length > 0);
    assert.ok(!lines.join('').includes('attack at dawn'), 'document text is not logged');
    assert.ok(lines.join('').includes('TypeError'));
  });

  it('exposes only the documented fields', () => {
    const h = harness();
    const view = h.submit(1);
    assert.deepEqual(Object.keys(view).sort(), [
      'boot_id',
      'cancel_reason',
      'completed_at',
      'created_at',
      'elapsed_ms',
      'error',
      'from',
      'id',
      'paused',
      'phase',
      'phases',
      'poll_after_ms',
      'position',
      'processing_ms',
      'queue',
      'queue_wait_ms',
      'result_available',
      'started_at',
      'state',
      'updated_at',
    ]);
  });
});

describe('time', () => {
  it('fails a job that runs past its deadline, and reports it retryable', async () => {
    const h = harness({ deadlineMs: 40 });
    const a = h.submit(1);

    await new Promise((resolve) => setTimeout(resolve, 120));
    const view = h.manager.status(sid(1), a.id);
    assert.equal(view.state, 'failed');
    assert.equal(view.error.code, 'JOB_DEADLINE_EXCEEDED');
    assert.equal(view.error.retryable, true);
    assert.deepEqual(h.aborted, [a.id], 'the model work was aborted');
  });

  it('starts the deadline when a worker picks the job up, not when it was queued', async () => {
    const h = harness({ workers: 1, maxPending: 3, deadlineMs: 150 });
    const a = h.submit(1);
    const b = h.submit(2);

    await new Promise((resolve) => setTimeout(resolve, 100));
    await h.finish(a.id);
    // b waited 100 ms of a 150 ms deadline, and still has all of it.
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(h.state(2, b.id), 'processing');
    await h.finish(b.id);
    assert.equal(h.state(2, b.id), 'completed');
  });

  it('tracks queue wait and processing time apart', async () => {
    const h = harness({ workers: 1, maxPending: 3 });
    const a = h.submit(1);
    const b = h.submit(2);

    h.now.advance(5000);
    await h.finish(a.id);
    h.now.advance(7000);
    await h.finish(b.id);

    const view = h.manager.status(sid(2), b.id);
    assert.equal(view.queue_wait_ms, 5000);
    assert.equal(view.processing_ms, 7000);
    assert.equal(view.elapsed_ms, 12_000);

    const { durations_ms } = h.metrics.snapshot();
    assert.deepEqual([durations_ms.queue_wait.count, durations_ms.processing.count], [2, 2]);
  });
});

describe('the provider breaker', () => {
  const outage = (upstreamCode) =>
    Object.assign(new LlmError('LLM_RATE_LIMITED', 'limit', 429), { upstreamCode });

  it('opens on a rate-limit or not-ready answer, and the job still fails with that answer', async () => {
    for (const upstreamCode of ['PROVIDER_RATE_LIMITED', 'PROVIDER_NOT_READY']) {
      const h = harness({ workers: 1, maxPending: 3 });
      const a = h.submit(1);
      await h.fail(a.id, outage(upstreamCode));

      assert.equal(h.state(1, a.id), 'failed');
      assert.equal(h.breaker.open, true, upstreamCode);
      assert.equal(h.metrics.snapshot().errors.provider_breaker_trips, 1);
    }
  });

  it('opens when the gateway was not ready before a call was even made', async () => {
    const h = harness();
    const a = h.submit(1);
    await h.fail(
      a.id,
      new ProviderUnavailableError('claude', { reason: 'down', code: 'gateway_offline' })
    );
    assert.equal(h.breaker.open, true);
  });

  it('does not open for an ordinary failure', async () => {
    const h = harness();
    const a = h.submit(1);
    await h.fail(a.id, new LlmError('LLM_MALFORMED_OUTPUT', 'bad', 502));
    assert.equal(h.breaker.open, false);
  });

  it('refuses new jobs with a retryable pause while open', async () => {
    const h = harness();
    const a = h.submit(1);
    await h.fail(a.id, outage('PROVIDER_RATE_LIMITED'));

    const refusal = code(() => h.manager.reserve(sid(2)), 'SERVICE_PAUSED', 503);
    assert.ok(refusal.retryAfterSeconds >= 1 && refusal.retryAfterSeconds <= 60);
    assert.equal(h.metrics.snapshot().rejections.paused, 1);
  });

  it('holds the queue instead of sending it into a known outage, then resumes by itself', async () => {
    // A long lease: the point here is the breaker, not abandonment.
    const h = harness({ workers: 1, maxPending: 5, leaseMs: 10 * MINUTE });
    const a = h.submit(1);
    const b = h.submit(2);
    const c = h.submit(3);

    await h.fail(a.id, outage('PROVIDER_RATE_LIMITED'));
    assert.equal(h.runs.has(b.id), false, 'the next job did not start');
    assert.equal(h.manager.status(sid(2), b.id).paused, true);
    assert.equal(h.state(3, c.id), 'queued');

    h.now.advance(MINUTE + 1);
    h.manager.sweep();
    assert.equal(h.state(2, b.id), 'processing');
    assert.equal(h.manager.status(sid(2), b.id).paused, false);
  });

  it('does not trip on a cancellation or a deadline', async () => {
    const h = harness({ deadlineMs: 30 });
    const a = h.submit(1);
    h.manager.cancel(sid(1), a.id);
    await settle();
    assert.equal(h.breaker.open, false);

    const b = h.submit(2);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(h.state(2, b.id), 'failed');
    assert.equal(h.breaker.open, false);
  });
});

describe('restart and shutdown', () => {
  it('gives each process its own boot id, which every view carries', () => {
    const first = harness();
    const second = harness();
    assert.match(first.manager.bootId, /^b_[A-Za-z0-9_-]{12}$/);
    assert.notEqual(first.manager.bootId, second.manager.bootId);
    assert.equal(first.submit(1).boot_id, first.manager.bootId);
  });

  it('loses every job on a restart: a new process knows none of the old ids', () => {
    const before = harness();
    const job = before.submit(1);
    const after = harness();
    assert.throws(
      () => after.manager.status(sid(1), job.id),
      (error) => error.code === 'JOB_NOT_FOUND'
    );
  });

  it('stops admission, cancels the queue, aborts what runs and waits for it', async () => {
    const h = harness({ workers: 1, maxPending: 3 });
    const running = h.submit(1);
    const queued = h.submit(2);

    await h.manager.shutdown();

    assert.deepEqual(h.aborted, [running.id]);
    assert.equal(h.manager.status(sid(1), running.id).cancel_reason, 'shutdown');
    assert.equal(h.manager.status(sid(2), queued.id).state, 'cancelled');
    assert.equal(h.runs.has(queued.id), false, 'the queued job never started');
    code(() => h.manager.reserve(sid(3)), 'SERVICE_SHUTTING_DOWN', 503);
    await h.manager.shutdown(); // idempotent
  });

  it('does not start queued work while shutting down', async () => {
    const h = harness({ workers: 1, maxPending: 3 });
    h.submit(1);
    h.submit(2);
    await h.manager.shutdown();
    assert.equal(h.startOrder.length, 1);
  });

  it('refuses to commit a reservation taken before shutdown', async () => {
    const h = harness();
    const reservation = h.manager.reserve(sid(1));
    await h.manager.shutdown();
    assert.throws(
      () => reservation.commit({ from: 'extract', input: {} }),
      (e) => e.code === 'SERVICE_SHUTTING_DOWN'
    );
  });
});

describe('parsing', () => {
  it('runs parses one at a time by default, in order', async () => {
    const h = harness({ parseConcurrency: 1 });
    const order = [];
    const gates = [];
    const parse = (label) =>
      h.manager.runParse(
        () =>
          new Promise((resolve) => {
            order.push(`start ${label}`);
            gates.push(() => {
              order.push(`end ${label}`);
              resolve(label);
            });
          })
      );

    const results = [parse('a'), parse('b'), parse('c')];
    await settle();
    assert.deepEqual(order, ['start a']);
    gates.shift()();
    await settle();
    gates.shift()();
    await settle();
    gates.shift()();
    assert.deepEqual(await Promise.all(results), ['a', 'b', 'c']);
    assert.deepEqual(order, ['start a', 'end a', 'start b', 'end b', 'start c', 'end c']);
  });

  it('allows two at once when configured, and releases the slot when a parse throws', async () => {
    const h = harness({ parseConcurrency: 2 });
    let active = 0;
    let peak = 0;
    const work = async () => {
      active += 1;
      peak = Math.max(peak, active);
      await settle();
      active -= 1;
    };
    await Promise.all([1, 2, 3, 4].map(() => h.manager.runParse(work)));
    assert.equal(peak, 2);

    await assert.rejects(h.manager.runParse(() => Promise.reject(new Error('bad file'))));
    await h.manager.runParse(work); // the slot came back
  });
});
