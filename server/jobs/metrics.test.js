import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createJobMetrics } from './metrics.js';

/**
 * The in-memory numbers a future owner-only dashboard will read. Counters and gauges are
 * checked against a fake clock; nothing here serves them anywhere.
 */

function clock(start = 1_000_000) {
  const state = { t: start };
  return Object.assign(() => state.t, {
    advance(ms) {
      state.t += ms;
    },
  });
}

describe('counters and sessions', () => {
  it('counts what it is told, from zero', () => {
    const metrics = createJobMetrics({ now: clock() });
    assert.equal(metrics.snapshot().jobs.submitted, 0);

    metrics.inc('jobs_submitted');
    metrics.inc('jobs_submitted', 4);
    metrics.inc('rejected_queue_full');
    const snapshot = metrics.snapshot();
    assert.equal(snapshot.jobs.submitted, 5);
    assert.equal(snapshot.rejections.queue_full, 1);
  });

  it('reports ticket failures by kind', () => {
    const metrics = createJobMetrics({ now: clock() });
    metrics.inc('tickets_minted', 3);
    metrics.inc('ticket_failed_replay');
    metrics.inc('ticket_failed_unavailable', 2);
    assert.deepEqual(metrics.snapshot().tickets, {
      minted: 3,
      failures: { replay: 1, unavailable: 2 },
    });
  });

  it('counts sessions seen in the last two minutes, each once', () => {
    const now = clock();
    const metrics = createJobMetrics({ now });

    for (const sid of ['a', 'b', 'a', 'c', 'a']) metrics.touchSession(sid);
    assert.equal(metrics.snapshot().sessions.active_last_2m, 3);

    now.advance(90_000);
    metrics.touchSession('b'); // b is seen again; a and c are 90 s old
    assert.equal(metrics.snapshot().sessions.active_last_2m, 3);

    now.advance(40_000); // a and c are now 130 s old
    assert.equal(metrics.snapshot().sessions.active_last_2m, 1);

    now.advance(200_000);
    assert.equal(metrics.snapshot().sessions.active_last_2m, 0);
  });

  it('bounds the sessions it remembers', () => {
    const metrics = createJobMetrics({ now: clock() });
    for (let i = 0; i < 6000; i += 1) metrics.touchSession(`sid-${i}`);
    assert.ok(metrics.snapshot().sessions.active_last_2m <= 5000);
  });
});

describe('durations', () => {
  it('reports count, p50, p95 and max over a bounded sample', () => {
    const metrics = createJobMetrics({ now: clock(), sampleSize: 100 });
    for (let value = 1; value <= 100; value += 1) metrics.observe('processing_ms', value);

    assert.deepEqual(metrics.snapshot().durations_ms.processing, {
      count: 100,
      p50: 50,
      p95: 95,
      max: 100,
    });
  });

  it('keeps only the most recent samples', () => {
    const metrics = createJobMetrics({ now: clock(), sampleSize: 10 });
    for (let value = 1; value <= 1000; value += 1) metrics.observe('queue_wait_ms', value);

    const { queue_wait } = metrics.snapshot().durations_ms;
    assert.equal(queue_wait.count, 10);
    assert.equal(queue_wait.max, 1000);
    assert.ok(queue_wait.p50 > 990, 'an old slow spell has aged out');
  });

  it('says null, not zero, when there is nothing to report', () => {
    assert.deepEqual(createJobMetrics({ now: clock() }).snapshot().durations_ms.processing, {
      count: 0,
      p50: null,
      p95: null,
      max: null,
    });
  });

  it('ignores a value that is not a number', () => {
    const metrics = createJobMetrics({ now: clock() });
    for (const bad of [NaN, Infinity, undefined, null, 'x']) metrics.observe('processing_ms', bad);
    assert.equal(metrics.snapshot().durations_ms.processing.count, 0);
  });
});

describe('worker utilization', () => {
  function withWorkers(now, { effective = 2, starts = [] } = {}) {
    const metrics = createJobMetrics({ now });
    metrics.registerSource('workers', () => ({ configured: 3, effective, busy: starts.length }));
    metrics.registerSource('active_starts', () => starts);
    return metrics;
  }

  it('is busy time over capacity in the window', () => {
    const now = clock();
    const metrics = withWorkers(now);

    // Two workers over a 60 s window is 120 s of capacity; 30 s of it was used.
    metrics.recordBusy(now() - 50_000, now() - 20_000);
    assert.equal(metrics.snapshot({ windowMs: 60_000 }).workers.utilization, 0.25);
  });

  it('counts work still in progress, up to now', () => {
    const now = clock();
    const metrics = withWorkers(now, { effective: 1, starts: [now() - 15_000] });
    assert.equal(metrics.snapshot({ windowMs: 60_000 }).workers.utilization, 0.25);
  });

  it('counts only the part of a stretch that falls in the window, and never exceeds 1', () => {
    const now = clock();
    const metrics = withWorkers(now, { effective: 1 });
    metrics.recordBusy(now() - 500_000, now() - 30_000);
    assert.equal(metrics.snapshot({ windowMs: 60_000 }).workers.utilization, 0.5);

    metrics.recordBusy(now() - 100_000, now());
    metrics.recordBusy(now() - 100_000, now());
    assert.equal(metrics.snapshot({ windowMs: 60_000 }).workers.utilization, 1);
  });

  it('reports configured and effective workers, and null before there is a source', () => {
    const metrics = withWorkers(clock(), { effective: 1, starts: [] });
    assert.deepEqual(
      [metrics.snapshot().workers.configured, metrics.snapshot().workers.effective],
      [3, 1]
    );

    const bare = createJobMetrics({ now: clock() }).snapshot();
    assert.equal(bare.workers.utilization, null);
    assert.equal(bare.workers.configured, null);
  });
});

describe('sources and the process', () => {
  it('reads gauges from the component that owns them, and survives one that throws', () => {
    const metrics = createJobMetrics({ now: clock() });
    metrics.registerSource('uploads', () => ({ inflight: 2 }));
    metrics.registerSource('apayee', () => {
      throw new Error('boom');
    });

    const snapshot = metrics.snapshot();
    assert.deepEqual(snapshot.uploads, { inflight: 2 });
    assert.equal(snapshot.apayee, null);
  });

  it('reports memory and, once sampling is on, event-loop delay', async () => {
    const metrics = createJobMetrics({ now: clock() });
    assert.equal(metrics.snapshot().process.event_loop_delay_ms, null);

    metrics.startRuntimeSampling();
    metrics.startRuntimeSampling(); // idempotent
    await new Promise((resolve) => setTimeout(resolve, 120));
    const { process: info } = metrics.snapshot();
    assert.ok(info.rss_bytes > 0 && info.heap_used_bytes > 0);
    assert.ok(info.event_loop_delay_ms.max >= 0);
    metrics.stopRuntimeSampling();
    assert.equal(metrics.snapshot().process.event_loop_delay_ms, null);
  });

  it('reports event-loop delay as the excess over the sampling interval: idle reads about zero, a blocked loop does not', async () => {
    const metrics = createJobMetrics({ now: clock() });
    metrics.startRuntimeSampling();

    await new Promise((resolve) => setTimeout(resolve, 200));
    const idle = metrics.snapshot().process.event_loop_delay_ms;
    // Windows timers tick about every 15 ms, which shows as ~10 ms of excess on an idle loop.
    assert.ok(idle.mean < 16, `an idle loop is not 20 ms late: mean ${idle.mean}`);

    const until = Date.now() + 150;
    while (Date.now() < until); // hold this thread
    await new Promise((resolve) => setTimeout(resolve, 60));
    const blocked = metrics.snapshot().process.event_loop_delay_ms;
    assert.ok(blocked.max >= 100, `a 150 ms block shows: max ${blocked.max}`);
    metrics.stopRuntimeSampling();
  });

  it('is plain data: it survives JSON and holds no function or handle', () => {
    const metrics = createJobMetrics({ now: clock() });
    metrics.inc('jobs_submitted');
    const snapshot = metrics.snapshot();
    assert.deepEqual(JSON.parse(JSON.stringify(snapshot)), snapshot);
  });
});
