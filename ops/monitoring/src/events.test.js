import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseApayeeHealth } from './adapters/parse.js';
import { detectEvents } from './events.js';

const facts = (over = {}) => ({
  components: { backend: 'up', apayee: 'up', frontend: 'unknown', tunnel: 'unknown', docker: 'up' },
  jobs: null,
  apayee: null,
  containers: [],
  ...over,
});
const jobs = (over = {}) => ({
  uptimeMs: 1000,
  total: { submitted: 0, completed: 0, failed: 0, cancelled: 0 },
  errorsByCode: {},
  rejections: {},
  breakerTrips: 0,
  ...over,
});
const gateway = (over = {}) => ({
  providerReady: true,
  providerState: 'ready',
  totals: { succeeded: 0, failed: 0, timedOut: 0, cancelled: 0, rejected: 0 },
  ...over,
});

test('no previous facts: nothing is reported, so a first poll is not a burst of "new" counters', () => {
  assert.deepEqual(
    detectEvents(
      null,
      facts({ jobs: jobs({ total: { submitted: 9, completed: 9, failed: 0, cancelled: 0 } }) })
    ),
    []
  );
});

test('component transitions carry severity', () => {
  const e = detectEvents(
    facts(),
    facts({ components: { ...facts().components, backend: 'down', apayee: 'degraded' } })
  );
  assert.deepEqual(
    e.map((x) => [x.kind, x.level]),
    [
      ['component_backend', 'critical'],
      ['component_apayee', 'warn'],
    ]
  );
  const back = detectEvents(
    facts({ components: { ...facts().components, backend: 'down' } }),
    facts()
  );
  assert.equal(back[0].level, 'info');
});

test('job counters become counts per state change, never per job', () => {
  const e = detectEvents(
    facts({ jobs: jobs() }),
    facts({
      jobs: jobs({
        uptimeMs: 5000,
        total: { submitted: 3, completed: 1, failed: 1, cancelled: 1 },
      }),
    })
  );
  assert.deepEqual(
    e.map((x) => x.text),
    ['3 jobs submitted.', '1 job completed.', '1 job failed.', '1 job cancelled.']
  );
});

test('failure categories, refusals and breaker trips', () => {
  const e = detectEvents(
    facts({ jobs: jobs({ errorsByCode: { PROVIDER_TIMEOUT: 1 }, rejections: { queue_full: 2 } }) }),
    facts({
      jobs: jobs({
        uptimeMs: 4000,
        errorsByCode: { PROVIDER_TIMEOUT: 3, NEW_CODE: 1 },
        rejections: { queue_full: 5 },
        breakerTrips: 1,
      }),
    })
  );
  const text = e.map((x) => x.text);
  assert.ok(text.includes('Failure category PROVIDER_TIMEOUT: 2 new.'));
  assert.ok(text.includes('Failure category NEW_CODE: 1 new.'));
  assert.ok(text.includes('3 submissions refused: queue_full.'));
  assert.equal(e.find((x) => x.kind === 'breaker').level, 'critical');
});

test('a backend restart is reported as a reset, not as negative jobs', () => {
  const e = detectEvents(
    facts({
      jobs: jobs({
        uptimeMs: 900_000,
        total: { submitted: 20, completed: 18, failed: 2, cancelled: 0 },
      }),
    }),
    facts({ jobs: jobs({ uptimeMs: 3_000 }) })
  );
  assert.equal(e.length, 1);
  assert.equal(e[0].kind, 'jobs_reset');
  assert.match(e[0].text, /restarted/);
});

test('Apayee counters, restarts and provider readiness', () => {
  const e = detectEvents(
    facts({ apayee: gateway() }),
    facts({
      apayee: gateway({
        providerReady: false,
        providerState: 'not_signed_in',
        totals: { succeeded: 5, failed: 2, timedOut: 1, cancelled: 0, rejected: 3 },
      }),
    })
  );
  const kinds = e.map((x) => x.kind);
  assert.deepEqual(kinds.sort(), [
    'apayee_failed',
    'apayee_rejected',
    'apayee_timedOut',
    'provider_not_ready',
  ]);

  const restart = detectEvents(
    facts({
      apayee: gateway({
        totals: { succeeded: 50, failed: 0, timedOut: 0, cancelled: 0, rejected: 0 },
      }),
    }),
    facts({ apayee: gateway() })
  );
  assert.equal(restart[0].kind, 'apayee_reset');
});

test('container restarts and OOM kills', () => {
  const c = (over) => ({ service: 'apayee', restarts: 0, oomKilled: false, ...over });
  const e = detectEvents(
    facts({ containers: [c()] }),
    facts({ containers: [c({ restarts: 1, oomKilled: true })] })
  );
  assert.deepEqual(
    e.map((x) => x.kind),
    ['container_restart', 'container_oom']
  );
});

test('event text is templates and numbers; the one gateway label in it is redacted by the parser first', () => {
  const parsed = parseApayeeHealth({
    status: 'ok',
    service: 'apayee',
    provider_status: { ready: false, state: 'TICKET_SECRET=hunter22222 C:\\Users\\kelvi\\x' },
    queue: { pending: 0, active: 0 },
  });
  const e = detectEvents(facts({ apayee: gateway() }), facts({ apayee: parsed }));
  assert.equal(e.length, 1);
  assert.doesNotMatch(e[0].text, /hunter22222|kelvi/);
});
