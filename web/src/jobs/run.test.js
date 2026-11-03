import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createApi } from '../api.js';
import { createTicketStore } from '../session/ticket-store.js';
import { createSessionManager } from '../session/session.js';
import { fakeBackend, fakeClock, GOOD_TOKEN } from './fixtures/fake-backend.js';
import {
  LEASE_MS,
  MAX_POLL_MS,
  MAX_UPLOAD_BUSY_ATTEMPTS,
  createJobHandle,
  followJob,
  pollDelay,
  runJobPipeline,
} from './run.js';

/**
 * The job runner against a stand-in backend that speaks the real job API.
 *
 * Everything real except the network: the real api client builds the requests, the real session
 * manager holds the ticket, the real runner polls. The clock is fake and `sleep` moves it, so
 * a 45-second lease or a Retry-After costs no time.
 */

const emptyCanonical = () => ({
  project: {
    project_name: 'Demo project',
    project_description: null,
    project_summary: null,
    qa_guidance: null,
    project_background: null,
    sit_scope: [],
  },
  documents: [],
  requirements: [],
  test_cases: [],
});

const file = (name = 'prd.docx') => new File(['content'], name);

async function setup(options = {}) {
  const clock = fakeClock();
  const backend = fakeBackend({ now: clock.now, ...options });
  const store = createTicketStore({ now: clock.now });
  const api = createApi({
    demo: true,
    fetchImpl: backend.fetch,
    getTicket: () => store.get(),
    onUnauthorized: () => store.clear('rejected'),
  });
  const session = createSessionManager({
    api,
    store,
    now: clock.now,
    setTimer: () => null,
    clearTimer: () => {},
  });
  assert.equal(await session.start(GOOD_TOKEN), true);
  return { clock, backend, store, api, session };
}

/** Collects every callback the runner makes, in order. */
function recorder() {
  const events = [];
  const on = new Proxy(
    {},
    {
      get:
        (_, name) =>
        (...args) =>
          events.push([name, ...args]),
    }
  );
  return { events, on, names: () => events.map(([name]) => name) };
}

const run = (ctx, extra = {}) =>
  runJobPipeline({
    from: 'extract',
    canonical: emptyCanonical(),
    files: [file()],
    projectName: 'Demo project',
    api: ctx.api,
    sleep: ctx.clock.sleep,
    now: ctx.clock.now,
    random: () => 0,
    ...extra,
  });

describe('a successful job', () => {
  it('submits, polls to completion and applies every phase in order', async () => {
    const ctx = await setup();
    const { events, on, names } = recorder();

    const outcome = await run(ctx, { on });

    assert.equal(outcome.completed, true);
    assert.deepEqual(
      names().filter((n) => ['extracted', 'generated', 'validated'].includes(n)),
      ['extracted', 'generated', 'validated']
    );
    assert.deepEqual(
      events.filter(([n]) => n === 'completed').map(([, phase]) => phase),
      ['extract', 'generate', 'validate']
    );
    // The same merge the local runner does: requirements and test cases reach the project.
    assert.equal(outcome.canonical.requirements.length, 1);
    assert.equal(outcome.canonical.test_cases.length, 1);
    assert.equal(outcome.testPoints.length, 1);
  });

  it('retrieves results only once the job has ended', async () => {
    const ctx = await setup();
    await run(ctx);

    const order = ctx.backend.calls.map((c) => `${c.method} ${c.path.replace(/j_\w+/, ':id')}`);
    const firstResult = order.indexOf('GET /api/jobs/:id/result');
    const lastStatus = order.lastIndexOf('GET /api/jobs/:id');
    assert.ok(firstResult > lastStatus, 'no result is fetched while the job still runs');
    assert.equal(order.filter((o) => o.endsWith('/result')).length, 1);
  });

  it('never sends a provider or model, and never asks which exist', async () => {
    const ctx = await setup();
    await run(ctx);
    await run(ctx, { from: 'validate', canonical: { ...emptyCanonical() } });

    for (const { path, request } of ctx.backend.calls) {
      assert.doesNotMatch(path, /llm|provider/);
      assert.doesNotMatch(request.url, /provider|model/);
    }
  });
});

describe('queue position and phases', () => {
  it('reports the position while queued, counting down first come first served', async () => {
    const ctx = await setup();
    ctx.backend.state.queuedAhead = 3; // three jobs are ahead of this one
    const { events, on } = recorder();

    await run(ctx, { on });

    const queued = events
      .filter(([n, job]) => n === 'progress' && job.state === 'queued')
      .map(([, job]) => job.position);
    assert.deepEqual(queued, [3, 2, 1].slice(0, queued.length));
    assert.ok(queued.length >= 2, 'the position is seen changing');
    assert.deepEqual(
      [...queued].sort((a, b) => b - a),
      queued,
      'it only goes down'
    );
  });

  it('shows the backend phase, not an invented one', async () => {
    const ctx = await setup();
    const { events, on } = recorder();
    await run(ctx, { on });

    const phases = events
      .filter(([n, job]) => n === 'progress' && job.state === 'processing')
      .map(([, job]) => job.phase);
    assert.deepEqual(phases, ['extract', 'generate', 'validate']);
  });
});

describe('resume from a later phase', () => {
  it('sends the project as JSON from "generate" and only runs generate and validate', async () => {
    const ctx = await setup();
    const { events, on } = recorder();
    const canonical = { ...emptyCanonical(), requirements: [{ requirement_id: 'REQ-001' }] };

    const outcome = await run(ctx, { from: 'generate', canonical, testPoints: [{ a: 1 }], on });

    assert.equal(outcome.completed, true);
    const post = ctx.backend.calls.find((c) => c.method === 'POST' && c.path === '/api/jobs');
    assert.match(post.request.headers.get('content-type'), /application\/json/);
    assert.ok(!events.some(([n]) => n === 'extracted'));
    assert.ok(events.some(([n]) => n === 'generated'));
  });

  it('runs a semantic review as a job from "validate"', async () => {
    const ctx = await setup();
    const { events, on } = recorder();
    await run(ctx, { from: 'validate', canonical: emptyCanonical(), on });

    assert.deepEqual(events.filter(([n]) => n === 'validated').length, 1);
    // No direct route: the browser never calls /api/validate?semantic.
    assert.ok(!ctx.backend.calls.some((c) => c.path === '/api/validate'));
  });
});

describe('partial results and failure', () => {
  it('applies the phases that finished before a failure, then reports the failed phase', async () => {
    const ctx = await setup();
    ctx.backend.state.failAfter = 'extract';
    const { events, on } = recorder();

    const outcome = await run(ctx, { on });

    assert.equal(outcome.completed, false);
    assert.ok(
      events.some(([n]) => n === 'extracted'),
      'extraction was kept'
    );
    const failed = events.find(([n]) => n === 'failed');
    assert.equal(failed[1], 'generate');
    assert.equal(failed[2].code, 'LLM_UNAVAILABLE');
    assert.equal(failed[2].retryable, true);
    assert.equal(outcome.canonical.requirements.length, 1);
  });
});

describe('cancellation', () => {
  it('calls the cancel endpoint only when the handle is told to, and ends as cancelled', async () => {
    const ctx = await setup();
    const handle = createJobHandle(ctx.api);
    const { events, on } = recorder();

    // Cancel as soon as the first status has been seen.
    const sleep = async (ms) => {
      await ctx.clock.sleep(ms);
      if (handle.jobId && !handle.cancelRequested) await handle.cancel();
    };
    const outcome = await run(ctx, { handle, on, sleep });

    assert.equal(outcome.cancelled, true);
    assert.equal(outcome.completed, false);
    assert.ok(events.some(([n]) => n === 'cancelled'));
    assert.equal(ctx.backend.calls.filter((c) => c.path.endsWith('/cancel')).length, 1);
  });

  it('does not cancel when the caller simply stops caring (a superseded run)', async () => {
    const ctx = await setup();
    let current = true;
    const sleep = async (ms) => {
      await ctx.clock.sleep(ms);
      current = false; // the page moved on
    };

    const outcome = await run(ctx, { isCurrent: () => current, sleep });

    assert.equal(outcome.superseded, true);
    assert.ok(!ctx.backend.calls.some((c) => c.path.endsWith('/cancel')));
  });
});

describe('a job the server stopped', () => {
  /** A status reply for a job the server cancelled, as manager.js reports it. */
  const cancelledBy =
    (ctx, reason) =>
    async (request, { jobs, state }) => {
      const job = [...jobs.values()][0];
      return ctx.backend.json(200, {
        job: {
          id: job.id,
          state: 'cancelled',
          from: 'extract',
          phase: null,
          phases: { extract: 'cancelled', generate: 'not_run', validate: 'not_run' },
          position: null,
          paused: false,
          poll_after_ms: 2500,
          result_available: false,
          cancel_reason: reason,
          error: null,
          boot_id: state.boot,
        },
      });
    };

  it('a shutdown is a failure with restart guidance, never a user cancellation', async () => {
    const ctx = await setup();
    ctx.backend.override('GET /api/jobs/:id', cancelledBy(ctx, 'shutdown'));
    const { events, on } = recorder();

    const outcome = await run(ctx, { on });

    assert.equal(outcome.completed, false);
    assert.equal(outcome.cancelled, false);
    assert.ok(!events.some(([n]) => n === 'cancelled'), 'not reported as cancelled');
    const failed = events.find(([n]) => n === 'failed');
    assert.equal(failed[1], 'extract', 'the step to run again');
    assert.equal(failed[2].kind, 'shutdown');
  });

  it('an abandoned job is still the inactivity message', async () => {
    const ctx = await setup();
    ctx.backend.override('GET /api/jobs/:id', cancelledBy(ctx, 'abandoned'));
    const { events, on } = recorder();
    await run(ctx, { on });
    assert.equal(events.find(([n]) => n === 'failed')[2].kind, 'inactive');
  });

  it('a cancellation the visitor asked for is still a cancellation', async () => {
    const ctx = await setup();
    ctx.backend.override('GET /api/jobs/:id', cancelledBy(ctx, 'user'));
    const { events, on } = recorder();
    const outcome = await run(ctx, { on });
    assert.equal(outcome.cancelled, true);
    assert.ok(events.some(([n]) => n === 'cancelled'));
    assert.ok(!events.some(([n]) => n === 'failed'));
  });
});

describe('polling and the lease', () => {
  it('polls at the backend interval, and never slower than 10 seconds', async () => {
    assert.equal(pollDelay({ poll_after_ms: 2500 }), 2500);
    assert.equal(pollDelay({ poll_after_ms: 120_000 }), MAX_POLL_MS);
    assert.equal(pollDelay({ poll_after_ms: 5 }), 1000);
    assert.equal(pollDelay({}), 2500);
    assert.equal(pollDelay(null), 2500);
    assert.ok(MAX_POLL_MS * 4 < LEASE_MS, 'comfortably below the lease');

    const ctx = await setup();
    await run(ctx);
    assert.ok(ctx.clock.slept.every((ms) => ms <= MAX_POLL_MS));
  });

  it('runs one loop: status requests never overlap', async () => {
    const ctx = await setup();
    let inflight = 0;
    let peak = 0;
    const inner = ctx.backend.fetch;
    const api = createApi({
      demo: true,
      getTicket: () => ctx.store.get(),
      fetchImpl: async (...args) => {
        inflight += 1;
        peak = Math.max(peak, inflight);
        try {
          return await inner(...args);
        } finally {
          inflight -= 1;
        }
      },
    });
    await run(ctx, { api });
    assert.equal(peak, 1);
  });

  it('stops polling at a terminal state', async () => {
    const ctx = await setup();
    await run(ctx);
    const before = ctx.backend.calls.length;
    // Nothing is running any more: no timer, no request.
    await ctx.clock.sleep(120_000);
    assert.equal(ctx.backend.calls.length, before);
  });

  it('reports a long silence between answers instead of hiding it', async () => {
    const ctx = await setup();
    const { events, on } = recorder();
    let slept = 0;
    // The first wait stands in for a throttled background tab: 40 s pass before the poll.
    const sleep = async (ms) => {
      slept += 1;
      await ctx.clock.sleep(slept === 1 ? 40_000 : ms);
    };
    await run(ctx, { on, sleep });

    const gap = events.find(([n]) => n === 'leaseGap');
    assert.ok(gap && gap[1] >= 40_000);
  });

  it('says the job expired from inactivity when it is gone after a long silence', async () => {
    const ctx = await setup();
    const { events, on } = recorder();
    let slept = 0;
    const sleep = async (ms) => {
      slept += 1;
      await ctx.clock.sleep(slept === 1 ? 50_000 : ms);
    };
    ctx.backend.override('GET /api/jobs/:id', () =>
      ctx.backend.fail(404, 'JOB_NOT_FOUND', 'The job was not found.')
    );

    const outcome = await run(ctx, { on, sleep });

    assert.equal(outcome.completed, false);
    assert.equal(events.find(([n]) => n === 'failed')[2].kind, 'inactive');
  });

  it('calls a prompt 404 "lost", not "inactive"', async () => {
    const ctx = await setup();
    const { events, on } = recorder();
    ctx.backend.override('GET /api/jobs/:id', () =>
      ctx.backend.fail(404, 'JOB_NOT_FOUND', 'The job was not found.')
    );
    await run(ctx, { on });
    assert.equal(events.find(([n]) => n === 'failed')[2].kind, 'lost');
  });
});

describe('restart detection with boot_id', () => {
  it('notices that a later job was accepted by a restarted backend', async () => {
    const ctx = await setup();
    const boot = { current: null };
    await run(ctx, { boot });
    const first = boot.current;
    assert.ok(first);

    ctx.backend.restart();
    // The ticket is still valid after a restart (same signing key), the job table is empty.
    const { events, on } = recorder();
    await run(ctx, { boot, on });

    assert.notEqual(boot.current, first);
    const accepted = events.find(([n]) => n === 'accepted');
    assert.equal(accepted[2].restarted, true);
  });

  it('is not a restart when the boot id is unchanged', async () => {
    const ctx = await setup();
    const boot = { current: null };
    await run(ctx, { boot });
    const { events, on } = recorder();
    await run(ctx, { boot, on });
    assert.equal(events.find(([n]) => n === 'accepted')[2].restarted, false);
  });

  it('stops with "restarted" if a job suddenly reports a different boot id', async () => {
    const ctx = await setup();
    const { events, on } = recorder();
    ctx.backend.override('GET /api/jobs/:id', async (request, { jobs, state }) => {
      state.boot = 'b_other';
      return null; // fall through to the default reply, now with the new boot id
    });
    await run(ctx, { on });
    assert.equal(events.find(([n]) => n === 'failed')[2].kind, 'restarted');
  });
});

describe('submission retries', () => {
  it('retries UPLOAD_BUSY, honouring Retry-After, with a fresh upload each time', async () => {
    const ctx = await setup();
    const busy = () =>
      ctx.backend.fail(
        429,
        'UPLOAD_BUSY',
        'Other uploads are being processed.',
        {},
        { 'Retry-After': '3' }
      );
    ctx.backend.override('POST /api/jobs', busy, busy);
    const { events, on } = recorder();
    const bodies = [];
    const inner = ctx.backend.fetch;
    const api = createApi({
      demo: true,
      getTicket: () => ctx.store.get(),
      fetchImpl: (url, init) => {
        if (init.method === 'POST' && init.body instanceof FormData) bodies.push(init.body);
        return inner(url, init);
      },
    });

    const outcome = await run(ctx, { api, on });

    assert.equal(outcome.completed, true);
    assert.equal(
      ctx.backend.calls.filter((c) => c.method === 'POST' && c.path === '/api/jobs').length,
      3
    );
    assert.equal(new Set(bodies).size, 3, 'a new FormData for every attempt');
    for (const form of bodies) {
      assert.equal(form.getAll('documents').length, 1, 'the file is in every rebuilt form');
      assert.equal(form.get('project_name'), 'Demo project');
    }
    const waits = events.filter(([n]) => n === 'waiting');
    assert.equal(waits.length, 2);
    assert.equal(waits[0][1].seconds, 3);
    assert.equal(ctx.clock.slept[0], 3000);
  });

  it('gives up on UPLOAD_BUSY after a bounded number of attempts', async () => {
    const ctx = await setup();
    const busy = () => ctx.backend.fail(429, 'UPLOAD_BUSY', 'busy', {}, { 'Retry-After': '1' });
    ctx.backend.override('POST /api/jobs', ...Array(10).fill(busy));
    const { events, on } = recorder();

    const outcome = await run(ctx, { on });

    assert.equal(outcome.completed, false);
    assert.equal(
      ctx.backend.calls.filter((c) => c.path === '/api/jobs').length,
      MAX_UPLOAD_BUSY_ATTEMPTS
    );
    assert.equal(events.find(([n]) => n === 'failed')[2].code, 'UPLOAD_BUSY');
  });

  for (const [code, status] of [
    ['QUEUE_FULL', 429],
    ['SERVICE_PAUSED', 503],
    ['RATE_LIMITED', 429],
  ]) {
    it(`does not retry ${code} by itself, and keeps the Retry-After for the page`, async () => {
      const ctx = await setup();
      ctx.backend.override('POST /api/jobs', () =>
        ctx.backend.fail(status, code, 'no', {}, { 'Retry-After': '12' })
      );
      const { events, on } = recorder();

      const outcome = await run(ctx, { on });

      assert.equal(outcome.completed, false);
      assert.equal(ctx.backend.calls.filter((c) => c.path === '/api/jobs').length, 1);
      const failure = events.find(([n]) => n === 'failed');
      assert.equal(failure[1], 'extract');
      assert.equal(failure[2].code, code);
      assert.equal(failure[2].retryAfterSeconds, 12);
    });
  }

  it('keeps the input after a refusal: the caller can submit the same files again', async () => {
    const ctx = await setup();
    ctx.backend.override('POST /api/jobs', () =>
      ctx.backend.fail(429, 'QUEUE_FULL', 'full', {}, { 'Retry-After': '5' })
    );
    const files = [file('a.docx'), file('b.pdf')];
    await run(ctx, { files });
    const again = await run(ctx, { files });
    assert.equal(again.completed, true);
  });
});

describe('an ambiguous network failure', () => {
  it('is never retried by itself, and is marked ambiguous', async () => {
    const ctx = await setup();
    let posts = 0;
    const inner = ctx.backend.fetch;
    const api = createApi({
      demo: true,
      getTicket: () => ctx.store.get(),
      fetchImpl: (url, init) => {
        if (init.method === 'POST') {
          posts += 1;
          throw new TypeError('Failed to fetch');
        }
        return inner(url, init);
      },
    });
    const { events, on } = recorder();

    const outcome = await run(ctx, { api, on });

    assert.equal(outcome.completed, false);
    assert.equal(posts, 1, 'exactly one attempt, no silent resend');
    const cause = events.find(([n]) => n === 'failed')[2];
    assert.equal(cause.ambiguous, true);
    assert.equal(cause.networkFailure, true);
  });

  it('recovers through JOB_ALREADY_ACTIVE instead of creating a duplicate', async () => {
    const ctx = await setup();
    // The first submission reached the backend, but its answer was lost on the way back.
    const inner = ctx.backend.fetch;
    let lost = false;
    const lossy = createApi({
      demo: true,
      getTicket: () => ctx.store.get(),
      fetchImpl: async (url, init) => {
        const reply = await inner(url, init);
        if (init.method === 'POST' && !lost) {
          lost = true;
          throw new TypeError('Failed to fetch');
        }
        return reply;
      },
    });

    const first = await run(ctx, { api: lossy });
    assert.equal(first.completed, false);
    assert.equal(ctx.backend.jobs.size, 1, 'the backend did accept it');

    // The visitor presses "check and try again".
    const { events, on } = recorder();
    const second = await run(ctx, { api: ctx.api, on });

    assert.equal(second.completed, true);
    assert.equal(ctx.backend.jobs.size, 1, 'still one job: nothing was duplicated');
    assert.equal(events.find(([n]) => n === 'accepted')[2].recovered, true);
  });

  it('reports a conflict when the active job is a different step', async () => {
    const ctx = await setup();
    await ctx.api.submitResume({ from: 'validate', canonical: emptyCanonical() });
    const { events, on } = recorder();

    const outcome = await run(ctx, { on }); // wants extract

    assert.equal(outcome.completed, false);
    assert.equal(events.find(([n]) => n === 'failed')[2].code, 'JOB_ALREADY_ACTIVE');
  });
});

describe('trouble while polling', () => {
  it('retries a failed poll a bounded number of times and carries on', async () => {
    const ctx = await setup();
    const { events, on } = recorder();
    const down = () => {
      throw new TypeError('Failed to fetch');
    };
    // Reads are retried: two dropped polls, then the job finishes.
    const inner = ctx.backend.fetch;
    let dropped = 0;
    const api = createApi({
      demo: true,
      getTicket: () => ctx.store.get(),
      fetchImpl: (url, init) => {
        if (init.method === 'GET' && /j_\w+$/.test(url) && dropped < 2) {
          dropped += 1;
          return down();
        }
        return inner(url, init);
      },
    });

    const outcome = await run(ctx, { api, on });

    assert.equal(outcome.completed, true);
    assert.equal(events.filter(([n]) => n === 'pollTrouble').length, 2);
  });

  it('gives up after repeated failures but offers to follow the same job again', async () => {
    const ctx = await setup();
    const { events, on } = recorder();
    const inner = ctx.backend.fetch;
    let offline = false;
    const api = createApi({
      demo: true,
      getTicket: () => ctx.store.get(),
      fetchImpl: (url, init) => {
        if (offline && init.method === 'GET') throw new TypeError('Failed to fetch');
        return inner(url, init);
      },
    });
    // Go offline once the job has been accepted.
    const sleep = async (ms) => {
      await ctx.clock.sleep(ms);
      offline = true;
    };

    const outcome = await run(ctx, { api, on, sleep });
    assert.equal(outcome.completed, false);
    const cause = events.find(([n]) => n === 'failed')[2];
    assert.ok(cause.jobId, 'the job id is kept for a reconnect');

    // Back online: follow the same job, submit nothing.
    const postsBefore = ctx.backend.calls.filter((c) => c.method === 'POST').length;
    offline = false;
    const resumed = await run(ctx, { attach: outcome.job });
    assert.equal(resumed.completed, true);
    assert.equal(ctx.backend.calls.filter((c) => c.method === 'POST').length, postsBefore);
  });

  it('honours Retry-After on a poll rate limit', async () => {
    const ctx = await setup();
    ctx.backend.override('GET /api/jobs/:id', () =>
      ctx.backend.fail(429, 'RATE_LIMITED', 'slow', {}, { 'Retry-After': '7' })
    );
    const outcome = await run(ctx);
    assert.equal(outcome.completed, true);
    assert.ok(ctx.clock.slept.includes(7000));
  });
});

describe('a session that ends', () => {
  it('stops a poll that gets 401, clears the ticket and asks for a fresh session', async () => {
    const ctx = await setup();
    const { events, on } = recorder();
    ctx.backend.override('GET /api/jobs/:id', () =>
      ctx.backend.fail(401, 'UNAUTHENTICATED', 'Authentication is required.')
    );

    const outcome = await run(ctx, { on });

    assert.equal(outcome.completed, false);
    assert.equal(events.find(([n]) => n === 'failed')[2].status, 401);
    assert.equal(ctx.store.get(), null);
    assert.equal(ctx.session.getState().status, 'expired');
  });
});

describe('followJob on its own', () => {
  it('does not poll a job that is already finished', async () => {
    const ctx = await setup();
    const done = (await run(ctx)).job;
    const before = ctx.backend.calls.length;
    const outcome = await followJob({
      api: ctx.api,
      job: done,
      from: 'extract',
      canonical: emptyCanonical(),
      sleep: ctx.clock.sleep,
    });
    assert.equal(outcome.completed, true);
    // One request: the result. No status polls.
    assert.equal(ctx.backend.calls.length - before, 1);
  });
});
