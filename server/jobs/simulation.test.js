import assert from 'node:assert/strict';
import http from 'node:http';
import { afterEach, describe, it } from 'node:test';

import { config } from '../config.js';
import { probeGateway } from '../llm/apayee.js';
import { createProviderAvailability } from '../llm/catalog.js';
import { healthReply } from '../llm/fixtures/fake-gateway.js';
import { scriptedReply } from '../llm/fixtures/scripted-replies.js';
import { startDemo, uploadForm, waitForState } from './fixtures/demo.js';

/**
 * Ten visitors at once, against the whole stack: the real HTTP server, the real tickets,
 * the real job manager and runner, the real Apayee adapter and provider catalog. Only the
 * ends are fakes: Turnstile, and a gateway on a loopback port that behaves the way
 * Apayee's contract says it does - it reports `max_active`, it can hold a call for as long
 * as a test wants, and it notices when a client closes its connection.
 *
 * No real model and no real Apayee is involved.
 */

const GATEWAY_TOKEN = 'gateway-test-token-Zq81Lw4Rk7Vn2Xd9Bf6Ty3';

/** Apayee's surface, with controls. */
async function startGateway({ maxActive = 3, latencyMs = 0 } = {}) {
  const stats = {
    active: 0,
    peak: 0,
    calls: 0,
    disconnected: 0,
    health: 0,
    bad: 0,
    /** request ids, in the order the gateway received them */
    order: [],
  };
  const control = {
    maxActive,
    latencyMs,
    /** resolves when a test lets calls proceed */
    hold: Promise.resolve(),
    /** called for each generate request; return a failure envelope to fail the call */
    fail: null,
    health: null,
  };
  const sockets = new Set();

  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', async () => {
      if (request.headers.authorization !== `Bearer ${GATEWAY_TOKEN}`) {
        stats.bad += 1;
        response.writeHead(401, { 'content-type': 'application/json' });
        return response.end(JSON.stringify({ status: 'error', error: { code: 'UNAUTHORIZED' } }));
      }

      const send = (status, body) => {
        response.writeHead(status, { 'content-type': 'application/json' });
        response.end(JSON.stringify(body));
      };

      if (request.method === 'GET' && request.url === '/v1/health') {
        stats.health += 1;
        const reply =
          control.health?.() ??
          healthReply({
            queue: {
              length: 0,
              running: stats.active > 0,
              active: stats.active,
              max_active: control.maxActive,
              pending: 0,
              capacity: 16,
            },
          });
        return send(reply.status, reply.body);
      }

      if (request.method === 'POST' && request.url === '/v1/generate') {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        stats.calls += 1;
        stats.order.push(body.request_id);
        stats.active += 1;
        stats.peak = Math.max(stats.peak, stats.active);

        let finished = false;
        response.on('close', () => {
          if (!finished) stats.disconnected += 1;
        });

        try {
          await control.hold;
          await new Promise((resolve) => setTimeout(resolve, control.latencyMs));
          const failure = control.fail?.(body, stats.calls);
          if (failure) {
            finished = true;
            return send(failure.status ?? 503, {
              request_id: body.request_id,
              status: 'error',
              error: { code: failure.code, message: 'gateway text', retryable: false },
            });
          }
          finished = true;
          return send(200, {
            request_id: body.request_id,
            status: 'success',
            provider: 'claude',
            result: scriptedReply(body),
            metadata: { queue_wait_ms: 0, execution_time_ms: 1, total_time_ms: 1 },
          });
        } finally {
          stats.active -= 1;
        }
      }

      send(404, { status: 'error', error: { code: 'NOT_FOUND' } });
    });
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  return {
    stats,
    control,
    baseUrl,
    close: () =>
      new Promise((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(resolve);
      }),
  };
}

/** The provider catalog pointed at that gateway, exactly as the app builds its own. */
function catalogFor(gateway, overrides = {}) {
  return createProviderAvailability({
    settings: () => ({
      ...config.llm,
      provider: 'gemini',
      apiKey: '',
      apayeeBaseUrl: gateway.baseUrl,
      apayeeToken: GATEWAY_TOKEN,
      apayeeQueueWaitMs: 2000,
      timeoutMs: 20_000,
      ...overrides,
    }),
    probe: (current) => probeGateway(current, { timeoutMs: 1000 }),
    ttlMs: 50,
  });
}

const things = [];
afterEach(async () => {
  await Promise.all(things.splice(0).map((close) => close()));
});

async function simulation({ gateway: gatewayOptions, env = {}, catalogOverrides } = {}) {
  const gateway = await startGateway(gatewayOptions);
  things.push(() => gateway.close());
  const d = await startDemo({
    env,
    providers: catalogFor(gateway, catalogOverrides),
  });
  things.push(() => d.close());
  return { gateway, d };
}

/**
 * What the page does with a 429 UPLOAD_BUSY: wait a moment, send the same thing again. With
 * ten visitors pressing the button in the same instant and room for four uploads at a time,
 * some are told to wait; this counts how many.
 */
async function submitPatiently(d, visitor, makeForm, busy) {
  const until = Date.now() + 30_000;
  for (;;) {
    const reply = await d.call('POST', '/api/jobs', { ticket: visitor.ticket, form: makeForm() });
    if (reply.status !== 429 || reply.body.error.code !== 'UPLOAD_BUSY') return reply;
    assert.ok(Number(reply.headers.get('retry-after')) >= 1, 'it says when to come back');
    busy.count += 1;
    if (Date.now() > until) throw new Error('still busy after 30 s');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

const sidOf = (visitor) => JSON.parse(Buffer.from(visitor.ticket.split('.')[1], 'base64url')).sid;
const states = (d, visitors, jobs) =>
  jobs.map((job, i) => d.manager.status(sidOf(visitors[i]), job.id).state);

describe('ten visitors at once, three workers, a gateway that runs three', () => {
  const env = { JOB_WORKERS: '3', JOB_MAX_PENDING: '10', JOB_LEASE_MS: '60000' };

  it('admits all ten as 3 processing and 7 pending, then completes every one in order', async () => {
    const { gateway, d } = await simulation({ env });
    const visitors = await Promise.all(Array.from({ length: 10 }, (_, i) => d.visitor(`v${i}`)));

    // Every call is held at the gateway, so the first three jobs stay in flight while the
    // other seven are admitted behind them.
    let release;
    gateway.control.hold = new Promise((resolve) => (release = resolve));

    const busy = { count: 0 };
    const replies = await Promise.all(
      visitors.map((v, i) => submitPatiently(d, v, () => uploadForm({ tag: `v${i}-` }), busy))
    );
    assert.deepEqual(
      replies.map((r) => r.status),
      Array(10).fill(202),
      JSON.stringify(replies.map((r) => r.body))
    );
    const jobs = replies.map((r) => r.body.job);

    const snapshot = states(d, visitors, jobs);
    assert.equal(snapshot.filter((s) => s === 'processing').length, 3, `states: ${snapshot}`);
    assert.equal(snapshot.filter((s) => s === 'queued').length, 7, `states: ${snapshot}`);

    // Queue positions are 1..7, and they are in the order the jobs were admitted.
    const admitted = jobs.map((job, i) => ({
      i,
      at: d.manager.status(sidOf(visitors[i]), job.id).created_at,
    }));
    const queued = jobs
      .map((job, i) => ({ i, view: d.manager.status(sidOf(visitors[i]), job.id) }))
      .filter(({ view }) => view.state === 'queued')
      .sort((a, b) => a.view.position - b.view.position);
    assert.deepEqual(
      queued.map(({ view }) => view.position),
      [1, 2, 3, 4, 5, 6, 7]
    );
    const createdOrder = queued.map(({ view }) => view.created_at);
    assert.deepEqual(createdOrder, [...createdOrder].sort(), 'FIFO: first admitted, first in line');
    void admitted;

    assert.equal(gateway.stats.peak <= 3, true);
    // Room for four uploads at once and ten arriving together: the cap was really exercised.
    assert.ok(busy.count > 0, 'some of the ten were asked to wait for an upload slot');
    assert.equal(d.metrics.snapshot().rejections.upload_busy, busy.count);
    release();

    for (const [i, v] of visitors.entries()) {
      const done = await waitForState(d, v, jobs[i].id, ['completed', 'failed'], 30_000);
      assert.equal(done.state, 'completed', `visitor ${i}: ${JSON.stringify(done.error)}`);
    }

    assert.ok(
      gateway.stats.peak <= 3,
      `at most three model calls at once, saw ${gateway.stats.peak}`
    );
    assert.equal(gateway.stats.calls, 30, 'ten jobs, three model calls each, none repeated');
    assert.equal(gateway.stats.bad, 0, 'every gateway call carried the server-side token');
    assert.equal(gateway.stats.disconnected, 0);

    // Each visitor got their own document back, nobody else's.
    for (const [i, v] of visitors.entries()) {
      const result = await d.call('GET', `/api/jobs/${jobs[i].id}/result`, { ticket: v.ticket });
      const names = result.body.phases.extract.documents.map((document) => document.filename);
      assert.deepEqual(names, [`PRD v${i}-0.docx`]);
    }

    // Jobs that waited were started in the order they were admitted.
    const startedAt = jobs.map((job, i) => d.manager.status(sidOf(visitors[i]), job.id).started_at);
    const byCreation = jobs
      .map((job, i) => ({
        i,
        created: d.manager.status(sidOf(visitors[i]), job.id).created_at,
        started: startedAt[i],
      }))
      .sort((a, b) => (a.created < b.created ? -1 : a.created > b.created ? 1 : a.i - b.i));
    const started = byCreation.map(({ started: at }) => at);
    assert.deepEqual(started, [...started].sort(), 'jobs start in arrival order');
  });

  it('refuses the 14th submission while 13 places are taken, and no one is hurt', async () => {
    const { gateway, d } = await simulation({ env });
    let release;
    gateway.control.hold = new Promise((resolve) => (release = resolve));

    const visitors = await Promise.all(Array.from({ length: 14 }, (_, i) => d.visitor(`v${i}`)));
    const replies = [];
    for (const [i, v] of visitors.entries()) {
      replies.push(
        await d.call('POST', '/api/jobs', { ticket: v.ticket, form: uploadForm({ tag: `v${i}-` }) })
      );
    }

    assert.deepEqual(
      replies.slice(0, 13).map((r) => r.status),
      Array(13).fill(202)
    );
    assert.equal(replies[13].status, 429);
    assert.equal(replies[13].body.error.code, 'QUEUE_FULL');
    assert.ok(Number(replies[13].headers.get('retry-after')) >= 5);

    release();
    for (const [i, v] of visitors.slice(0, 13).entries()) {
      const done = await waitForState(
        d,
        v,
        replies[i].body.job.id,
        ['completed', 'failed'],
        60_000
      );
      assert.equal(done.state, 'completed');
    }
    assert.ok(gateway.stats.peak <= 3);
    assert.equal(gateway.stats.calls, 39);
  });

  it('never leaks the gateway token, address or provider to any visitor, in any response', async () => {
    const { gateway, d } = await simulation({ env });
    const visitors = await Promise.all(Array.from({ length: 3 }, (_, i) => d.visitor(`v${i}`)));
    const seen = [];
    const record = (reply) => {
      seen.push(JSON.stringify([reply.body, [...reply.headers]]));
      return reply;
    };

    const jobs = [];
    for (const [i, v] of visitors.entries()) {
      const reply = record(
        await d.call('POST', '/api/jobs', { ticket: v.ticket, form: uploadForm({ tag: `v${i}-` }) })
      );
      jobs.push(reply.body.job);
    }
    for (const [i, v] of visitors.entries()) {
      await waitForState(d, v, jobs[i].id, 'completed', 20_000);
      record(await d.call('GET', `/api/jobs/${jobs[i].id}`, { ticket: v.ticket }));
      record(await d.call('GET', `/api/jobs/${jobs[i].id}/result`, { ticket: v.ticket }));
    }
    record(await d.call('GET', '/api/health', { ticket: visitors[0].ticket }));

    const everything = seen.join('\n');
    const port = String(new URL(gateway.baseUrl).port);
    for (const forbidden of [
      GATEWAY_TOKEN,
      `127.0.0.1:${port}`,
      gateway.baseUrl,
      'apayee',
      'Apayee',
      '"claude"',
      'max_active',
    ]) {
      assert.ok(!everything.includes(forbidden), `"${forbidden}" reached a visitor`);
    }
  });
});

describe('a gateway that runs fewer calls than QATOOL has workers', () => {
  it('holds the pool to the gateway’s max_active, though three workers are configured', async () => {
    const { gateway, d } = await simulation({
      gateway: { maxActive: 1, latencyMs: 40 },
      env: { JOB_WORKERS: '3', JOB_MAX_PENDING: '10', JOB_LEASE_MS: '60000' },
    });
    const visitors = await Promise.all(Array.from({ length: 6 }, (_, i) => d.visitor(`v${i}`)));
    const jobs = [];
    for (const [i, v] of visitors.entries()) {
      jobs.push(
        (
          await d.call('POST', '/api/jobs', {
            ticket: v.ticket,
            form: uploadForm({ tag: `v${i}-` }),
          })
        ).body.job
      );
    }
    for (const [i, v] of visitors.entries())
      await waitForState(d, v, jobs[i].id, 'completed', 60_000);

    assert.equal(gateway.stats.peak, 1, 'never more than the gateway runs');
    assert.equal(d.manager.effectiveWorkers, 1);
  });

  it('follows the gateway when it is raised, without a restart', async () => {
    const { gateway, d } = await simulation({
      gateway: { maxActive: 1 },
      env: { JOB_WORKERS: '3', JOB_MAX_PENDING: '10', JOB_LEASE_MS: '60000' },
    });
    let release;
    gateway.control.hold = new Promise((resolve) => (release = resolve));

    const first = await d.visitor('a');
    const second = await d.visitor('b');
    await d.call('POST', '/api/jobs', { ticket: first.ticket, form: uploadForm({ tag: 'a-' }) });
    const queued = (
      await d.call('POST', '/api/jobs', { ticket: second.ticket, form: uploadForm({ tag: 'b-' }) })
    ).body.job;
    assert.equal(queued.state, 'queued', 'one running, the gateway allows no more');

    gateway.control.maxActive = 2;
    await new Promise((resolve) => setTimeout(resolve, 80)); // the cached health answer expires
    const third = await d.visitor('c');
    await d.call('POST', '/api/jobs', { ticket: third.ticket, form: uploadForm({ tag: 'c-' }) });

    assert.equal(d.manager.effectiveWorkers, 2);
    assert.equal(
      d.manager.status(sidOf(second), queued.id).state,
      'processing',
      'the waiting job started'
    );
    release();
  });

  it('refuses work when the gateway’s contract is not being followed', async () => {
    const { gateway, d } = await simulation({
      env: { JOB_WORKERS: '3', JOB_LEASE_MS: '60000' },
    });
    gateway.control.health = () =>
      healthReply({ queue: { max_active: 0, active: 0, pending: 0, capacity: 16 } });
    const v = await d.visitor();

    const reply = await d.call('POST', '/api/jobs', { ticket: v.ticket, form: uploadForm() });
    assert.equal(reply.status, 503);
    assert.equal(reply.body.error.code, 'SERVICE_UNAVAILABLE');
    assert.equal(gateway.stats.calls, 0);
  });
});

describe('cancellation, timeouts and no retries, all the way to the gateway', () => {
  const env = { JOB_LEASE_MS: '60000', JOB_WORKERS: '1' };

  it('closes the gateway connection when the visitor cancels, so the gateway can cancel too', async () => {
    const { gateway, d } = await simulation({ env, gateway: { maxActive: 1 } });
    gateway.control.hold = new Promise(() => {}); // the gateway never answers
    const v = await d.visitor();
    const { job } = (await d.call('POST', '/api/jobs', { ticket: v.ticket, form: uploadForm() }))
      .body;

    while (gateway.stats.calls === 0) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(gateway.stats.active, 1);

    await d.call('POST', `/api/jobs/${job.id}/cancel`, { ticket: v.ticket });
    const until = Date.now() + 3000;
    while (gateway.stats.disconnected === 0 && Date.now() < until) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(gateway.stats.disconnected, 1, 'the gateway saw the client leave');
    assert.equal(gateway.stats.calls, 1, 'and nothing was sent again');
  });

  it('stops the model work when the job deadline passes, and reports it as retryable', async () => {
    const { gateway, d } = await simulation({
      env: { ...env, JOB_DEADLINE_MS: '600' },
      gateway: { maxActive: 1 },
    });
    gateway.control.hold = new Promise(() => {});
    const v = await d.visitor();
    const { job } = (await d.call('POST', '/api/jobs', { ticket: v.ticket, form: uploadForm() }))
      .body;

    const failed = await waitForState(d, v, job.id, 'failed', 10_000);
    assert.equal(failed.error.code, 'JOB_DEADLINE_EXCEEDED');
    assert.equal(failed.error.retryable, true);
    assert.equal(failed.error.phase, 'extract');

    const until = Date.now() + 3000;
    while (gateway.stats.disconnected === 0 && Date.now() < until) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(gateway.stats.disconnected, 1);
    assert.equal(gateway.stats.calls, 1, 'no retry after the abort');
  });

  it('stops a job nobody is polling, and the gateway sees it go', async () => {
    const { gateway, d } = await simulation({
      env: { ...env, JOB_LEASE_MS: '1000' },
      gateway: { maxActive: 1 },
    });
    gateway.control.hold = new Promise(() => {});
    const v = await d.visitor();
    const { job } = (await d.call('POST', '/api/jobs', { ticket: v.ticket, form: uploadForm() }))
      .body;
    while (gateway.stats.calls === 0) await new Promise((resolve) => setTimeout(resolve, 10));

    await new Promise((resolve) => setTimeout(resolve, 1200));
    d.manager.sweep();

    assert.equal(d.manager.status(sidOf(v), job.id).cancel_reason, 'abandoned');
    const until = Date.now() + 3000;
    while (gateway.stats.disconnected === 0 && Date.now() < until) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(gateway.stats.disconnected, 1);
  });

  it('does not retry a failed model call: one request, one failure', async () => {
    const { gateway, d } = await simulation({ env, gateway: { maxActive: 1 } });
    gateway.control.fail = (_body, call) =>
      call === 2 ? { code: 'PROVIDER_TIMEOUT', status: 504 } : null;
    const v = await d.visitor();
    const { job } = (await d.call('POST', '/api/jobs', { ticket: v.ticket, form: uploadForm() }))
      .body;

    const failed = await waitForState(d, v, job.id, 'failed', 10_000);
    assert.equal(failed.error.phase, 'generate');
    assert.equal(failed.error.retryable, true);
    assert.equal(gateway.stats.calls, 2, 'extract, then the one generate call, and no third');
  });

  it('finishes closing promptly with work in flight, cancelling the gateway calls', async () => {
    const { gateway, d } = await simulation({ env, gateway: { maxActive: 1 } });
    gateway.control.hold = new Promise(() => {});
    const v = await d.visitor();
    await d.call('POST', '/api/jobs', { ticket: v.ticket, form: uploadForm() });
    while (gateway.stats.calls === 0) await new Promise((resolve) => setTimeout(resolve, 10));

    const started = Date.now();
    await d.app.close();
    assert.ok(Date.now() - started < 4000);
    const until = Date.now() + 3000;
    while (gateway.stats.disconnected === 0 && Date.now() < until) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(gateway.stats.disconnected, 1);
  });
});

describe('the provider breaker, against a gateway that is out of allowance', () => {
  it('fails the job that found out, pauses admission, holds the queue, then resumes by itself', async () => {
    const { gateway, d } = await simulation({
      gateway: { maxActive: 1, latencyMs: 20 },
      env: {
        JOB_WORKERS: '1',
        JOB_MAX_PENDING: '5',
        JOB_LEASE_MS: '60000',
        PROVIDER_BREAKER_COOLDOWN_MS: '1000',
      },
    });
    let limited = true;
    // Hold the gateway until all three are admitted: the first failure must find the others
    // already waiting, as it would with a real crowd.
    let allAdmitted;
    gateway.control.hold = new Promise((resolve) => (allAdmitted = resolve));
    gateway.control.fail = () => (limited ? { code: 'PROVIDER_RATE_LIMITED', status: 429 } : null);

    const [a, b, c, late] = await Promise.all([
      d.visitor('a'),
      d.visitor('b'),
      d.visitor('c'),
      d.visitor('late'),
    ]);
    const first = (
      await d.call('POST', '/api/jobs', { ticket: a.ticket, form: uploadForm({ tag: 'a-' }) })
    ).body.job;
    const second = (
      await d.call('POST', '/api/jobs', { ticket: b.ticket, form: uploadForm({ tag: 'b-' }) })
    ).body.job;
    const third = (
      await d.call('POST', '/api/jobs', { ticket: c.ticket, form: uploadForm({ tag: 'c-' }) })
    ).body.job;

    allAdmitted();
    const failed = await waitForState(d, a, first.id, 'failed', 10_000);
    assert.equal(failed.error.retryable, true);
    assert.ok(
      !JSON.stringify(failed).match(/usage|apayee|claude|gateway text/i),
      JSON.stringify(failed)
    );

    // Admission is paused with a retry time; the waiting jobs are held, not sent to a provider
    // that has just said no.
    const paused = await d.call('POST', '/api/jobs', {
      ticket: late.ticket,
      form: uploadForm({ tag: 'l-' }),
    });
    assert.equal(paused.status, 503);
    assert.equal(paused.body.error.code, 'SERVICE_PAUSED');
    assert.ok(Number(paused.headers.get('retry-after')) >= 1);
    const callsWhilePaused = gateway.stats.calls;
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(gateway.stats.calls, callsWhilePaused, 'nothing reached the gateway while paused');
    assert.equal(d.manager.status(sidOf(b), second.id).state, 'queued');
    assert.equal(d.manager.status(sidOf(b), second.id).paused, true);

    // The provider recovers and the cooldown ends: the queue drains with no one doing anything.
    limited = false;
    await new Promise((resolve) => setTimeout(resolve, 700));
    for (const [visitor, job] of [
      [b, second],
      [c, third],
    ]) {
      const done = await waitForState(d, visitor, job.id, ['completed', 'failed'], 20_000);
      assert.equal(done.state, 'completed', JSON.stringify(done.error));
    }
    const admitted = await d.call('POST', '/api/jobs', {
      ticket: late.ticket,
      form: uploadForm({ tag: 'l-' }),
    });
    assert.equal(admitted.status, 202, 'and admission is open again');
  });
});

describe('metrics, as the future dashboard will read them', () => {
  it('describes the whole run without a name, a filename or a document', async () => {
    const { gateway, d } = await simulation({
      gateway: { maxActive: 3, latencyMs: 30 },
      env: { JOB_WORKERS: '3', JOB_MAX_PENDING: '10', JOB_LEASE_MS: '60000' },
    });
    const visitors = await Promise.all(Array.from({ length: 5 }, (_, i) => d.visitor(`v${i}`)));
    const jobs = [];
    for (const [i, v] of visitors.entries()) {
      jobs.push(
        (
          await d.call('POST', '/api/jobs', {
            ticket: v.ticket,
            form: uploadForm({ tag: `secret-${i}-` }),
          })
        ).body.job
      );
    }
    for (const [i, v] of visitors.entries())
      await waitForState(d, v, jobs[i].id, 'completed', 30_000);

    const snapshot = d.metrics.snapshot();
    assert.equal(snapshot.sessions.active_last_2m, 5);
    assert.equal(snapshot.tickets.minted, 5);
    assert.equal(snapshot.jobs.submitted, 5);
    assert.equal(snapshot.jobs.completed, 5);
    assert.deepEqual(snapshot.jobs.current, {
      queued: 0,
      processing: 0,
      completed: 5,
      failed: 0,
      cancelled: 0,
      workers_busy: 0,
      retained: 5,
    });
    assert.equal(snapshot.workers.configured, 3);
    assert.equal(snapshot.workers.effective, 3);
    assert.equal(snapshot.durations_ms.processing.count, 5);
    assert.equal(snapshot.durations_ms.queue_wait.count, 5);
    assert.ok(snapshot.durations_ms.processing.p95 >= snapshot.durations_ms.processing.p50);
    assert.ok(snapshot.workers.utilization > 0 && snapshot.workers.utilization <= 1);
    assert.equal(snapshot.apayee.max_active, 3);
    assert.equal(snapshot.uploads.inflight, 0);
    assert.ok(snapshot.process.rss_bytes > 0);
    assert.equal(gateway.stats.calls, 15);

    const text = JSON.stringify(snapshot);
    for (const secret of [
      'secret-',
      'PRD',
      'Suspended',
      ...visitors.map(sidOf),
      ...jobs.map((job) => job.id),
    ]) {
      assert.ok(!text.includes(secret), `"${secret}" is in the metrics`);
    }
  });

  it('is not served by any route', async () => {
    const { d } = await simulation();
    const v = await d.visitor();
    for (const path of [
      '/api/metrics',
      '/api/admin/metrics',
      '/api/jobs/metrics',
      '/metrics',
      '/api/stats',
    ]) {
      const reply = await d.call('GET', path, { ticket: v.ticket });
      assert.equal(reply.status, 404, path);
    }
  });
});
