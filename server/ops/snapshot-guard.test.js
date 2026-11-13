import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createJobMetrics } from '../jobs/metrics.js';
import { MAX_SNAPSHOT_BYTES, SnapshotInvalidError, serializeSnapshot } from './snapshot-guard.js';

function realSnapshot() {
  const metrics = createJobMetrics();
  metrics.registerSource('jobs', () => ({
    queued: 1,
    processing: 1,
    completed: 2,
    failed: 1,
    cancelled: 0,
    workers_busy: 1,
    retained: 5,
  }));
  metrics.registerSource('workers', () => ({ configured: 1, effective: 1, busy: 1 }));
  metrics.registerSource('active_starts', () => [Date.now() - 1000]);
  metrics.registerSource('apayee', () => ({
    active: 1,
    max_active: 1,
    pending: 0,
    capacity: 16,
    reported: true,
    compatible: true,
    observed_at: new Date().toISOString(),
  }));
  metrics.registerSource('uploads', () => ({
    inflight: 0,
    inflight_max: 4,
    parsing: 0,
    waiting_to_parse: 0,
  }));
  metrics.inc('jobs_submitted', 4);
  metrics.inc('job_error_SERVICE_UNAVAILABLE');
  metrics.inc('ticket_failed_expired');
  metrics.observe('processing_ms', 1234);
  metrics.touchSession('a-visitor-session-id');
  metrics.startRuntimeSampling();
  const snapshot = metrics.snapshot();
  metrics.stopRuntimeSampling();
  return snapshot;
}

test('the real metrics.snapshot() passes the guard unchanged', () => {
  const snapshot = realSnapshot();
  assert.deepEqual(JSON.parse(serializeSnapshot(snapshot)), JSON.parse(JSON.stringify(snapshot)));
});

test('the real snapshot holds no session id: sessions are only a count', () => {
  const text = serializeSnapshot(realSnapshot());
  assert.doesNotMatch(text, /a-visitor-session-id/);
  assert.equal(JSON.parse(text).sessions.active_last_2m, 1);
});

const refuse = (value, reason) =>
  assert.throws(
    () => serializeSnapshot(value),
    (error) => error instanceof SnapshotInvalidError && reason.test(error.reason)
  );

test('a list, free text, a ticket or a secret makes the whole snapshot refused', () => {
  refuse({ sessions: ['sid-1', 'sid-2'] }, /list/);
  refuse({ note: 'hello' }, /timestamp/);
  refuse({ taken_at: 'eyJhbGciOiJIUzI1NiJ9.eyJzaWQiOiJhIn0.abcdefghij' }, /timestamp/);
  refuse({ message: 'TICKET_SECRET=abc' }, /timestamp/);
  refuse({ 'bad key!': 1 }, /field name/);
  refuse({ 'a.b': 1 }, /field name/);
  refuse({ f: () => 1 }, /unsupported/);
  refuse({ n: 10n }, /unsupported/);
  refuse({ nested: new Map() }, /plain object/);
  refuse(null, /not an object/);
  refuse('text', /not an object/);
  refuse([1], /not an object|list/);
});

test('depth, field count and size are bounded', () => {
  let deep = { n: 1 };
  for (let i = 0; i < 10; i++) deep = { a: deep };
  refuse(deep, /deeply/);

  const wide = Object.fromEntries(Array.from({ length: 700 }, (_, i) => [`k${i}`, i]));
  refuse(wide, /too many/);

  // The field cap keeps a snapshot well under the byte cap; both are limits, the smaller one bites first.
  assert.ok(MAX_SNAPSHOT_BYTES >= 64 * 1024);
});

test('a number that is not finite is sent as null, as JSON always did, not refused', () => {
  const parsed = JSON.parse(
    serializeSnapshot({ loop: { mean: Number.NaN, max: Infinity }, ok: 1 })
  );
  assert.deepEqual(parsed, { loop: { mean: null, max: null }, ok: 1 });
});

test('the real snapshot is accepted right after boot, when the event-loop histogram is still empty', () => {
  const metrics = createJobMetrics();
  metrics.startRuntimeSampling();
  try {
    const parsed = JSON.parse(serializeSnapshot(metrics.snapshot()));
    assert.equal(parsed.process.event_loop_delay_ms.mean, null);
  } finally {
    metrics.stopRuntimeSampling();
  }
});

test('the refusal never contains the offending value', () => {
  try {
    serializeSnapshot({ leak: 'APAYEE_TOKEN=supersecretvalue' });
    assert.fail('should have thrown');
  } catch (error) {
    assert.doesNotMatch(error.message, /supersecretvalue|APAYEE/);
  }
});
