import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildSnapshot } from './snapshot.js';

const view = (over = {}) => ({
  monitor: { startedAt: '2026-11-05T00:00:00.000Z', cycles: 3 },
  overall: { status: 'ok', reasons: [] },
  components: { backend: 'up' },
  capacity: { qatool: null, apayee: null },
  jobs: null,
  warnings: [],
  events: [{ id: 1, t: 'x', level: 'info', kind: 'k', text: 'ok' }],
  history: [],
  readings: {
    backend: {
      state: 'ok',
      stale: false,
      ageMs: 10,
      lastSuccessAgeMs: 10,
      durationMs: 4,
      error: null,
      data: { healthy: true },
      lastKnown: null,
    },
  },
  ...over,
});

test('the snapshot has a version, a timestamp and a notice about what is not collected', () => {
  const s = buildSnapshot(view(), () => Date.parse('2026-11-05T12:00:00Z'));
  assert.equal(s.kind, 'qatool-ops-snapshot');
  assert.equal(s.version, 1);
  assert.equal(s.exportedAt, '2026-11-05T12:00:00.000Z');
  assert.match(s.notice, /No document content/);
  assert.match(s.notice, /reset on restart/);
});

test('a credential smuggled into any field is masked or dropped by the export itself', () => {
  const dirty = view({
    events: [
      {
        id: 1,
        t: 'x',
        level: 'info',
        kind: 'k',
        text: 'APAYEE_TOKEN=tok_abcdef123456 and Bearer abcdefghijklmnop12345',
      },
    ],
    readings: {
      backend: {
        state: 'unavailable',
        stale: false,
        ageMs: 1,
        lastSuccessAgeMs: null,
        durationMs: 1,
        error: { code: 'X', message: 'TICKET_SECRET=hunter22222' },
        data: {
          healthy: true,
          apiKey: 'AIzaSyA1234567890123456789012345678901234',
          ticket: 'eyJa.eyJb.sig',
        },
        lastKnown: null,
      },
    },
  });
  const text = JSON.stringify(buildSnapshot(dirty));
  for (const leaked of [
    'tok_abcdef123456',
    'abcdefghijklmnop12345',
    'hunter22222',
    'AIzaSyA1234',
    'eyJa.eyJb',
  ]) {
    assert.equal(text.includes(leaked), false, leaked);
  }
  assert.doesNotMatch(text, /"apiKey"|"ticket"/);
});

test('current values and session aggregates stay distinct fields', () => {
  const s = buildSnapshot(
    view({
      jobs: {
        sinceBootMs: 5000,
        submitted: 4,
        completed: 3,
        failed: 1,
        cancelled: 0,
        successRate: 0.75,
      },
      capacity: { qatool: { queued: 2 }, apayee: null },
    })
  );
  assert.equal(s.jobs.sinceBootMs, 5000);
  assert.equal(s.capacity.qatool.queued, 2);
});
