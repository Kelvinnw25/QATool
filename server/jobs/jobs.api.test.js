import assert from 'node:assert/strict';
import http from 'node:http';
import { Writable } from 'node:stream';
import { afterEach, describe, it } from 'node:test';

import { buildSampleCanonical } from '../export/fixtures/sample-canonical.js';
import { ProviderUnavailableError } from '../llm/catalog.js';
import { LlmError } from '../llm/provider.js';
import {
  fakeModel,
  fakeProviders,
  fakeSiteverify,
  HOSTNAME,
  ORIGIN,
  OTHER_ORIGIN,
  startDemo,
  TICKET_SECRET,
  TURNSTILE_SECRET,
  uploadForm,
  waitForState,
} from './fixtures/demo.js';

/**
 * The job API through a real HTTP listener, as a browser on the demo site would use it.
 * The model and Turnstile are fakes; everything between is the real code.
 */

const demos = [];
afterEach(async () => {
  await Promise.all(demos.splice(0).map((demo) => demo.close()));
});

async function demo(options) {
  const started = await startDemo(options);
  demos.push(started);
  return started;
}

const submit = (d, v, form = uploadForm()) =>
  d.call('POST', '/api/jobs', { ticket: v.ticket, form });
const slowModel = (delayMs = 300) => fakeProviders({ model: fakeModel({ delayMs }) });

/** The pieces of a response that must not differ between "not yours" and "not there". */
const shape = (reply) =>
  JSON.stringify({
    status: reply.status,
    body: { ...reply.body, error: { ...reply.body.error, run_id: undefined } },
  });

describe('minting a session', () => {
  it('returns a ticket, the upload limits and the poll interval, with nothing to cache or store', async () => {
    const d = await demo();
    const reply = await d.call('POST', '/api/session', { json: { turnstile_token: 'tok-1' } });

    assert.equal(reply.status, 200);
    assert.match(reply.body.ticket, /^[\w-]+\.[\w-]+\.[\w-]+$/);
    assert.ok(Date.parse(reply.body.expires_at) > Date.now());
    assert.deepEqual(reply.body.limits, {
      max_files: 30,
      max_file_bytes: 10 * 1024 * 1024,
      max_total_bytes: 20 * 1024 * 1024,
    });
    assert.equal(reply.body.poll_interval_ms, 2500);
    assert.match(reply.headers.get('cache-control'), /no-store/);
    assert.equal(reply.headers.get('set-cookie'), null, 'no cookies');
    assert.equal(
      reply.headers.get('access-control-allow-credentials'),
      null,
      'credentials are off'
    );
    assert.equal(reply.headers.get('access-control-allow-origin'), ORIGIN);
    assert.deepEqual(
      d.siteverify.calls.map((call) => call.response),
      ['tok-1']
    );
    assert.equal(d.siteverify.calls[0].secret, TURNSTILE_SECRET);
  });

  it('puts nothing about the provider or the setup in the reply', async () => {
    const d = await demo();
    const reply = await d.call('POST', '/api/session', { json: { turnstile_token: 'tok-1' } });
    assert.deepEqual(Object.keys(reply.body).sort(), [
      'expires_at',
      'limits',
      'poll_interval_ms',
      'ticket',
    ]);
  });

  it('fails closed: a failed, replayed, mis-hosted or unreachable check mints nothing', async () => {
    const verdicts = {
      'a token Cloudflare rejects': { success: false, 'error-codes': ['invalid-input-response'] },
      'the wrong hostname': {
        success: true,
        hostname: 'evil.example.net',
        action: 'qatool_demo',
        challenge_ts: new Date().toISOString(),
      },
      'the wrong action': {
        success: true,
        hostname: HOSTNAME,
        action: 'login',
        challenge_ts: new Date().toISOString(),
      },
      'a stale challenge': {
        success: true,
        hostname: HOSTNAME,
        action: 'qatool_demo',
        challenge_ts: '2020-01-01T00:00:00Z',
      },
    };
    for (const [label, verdict] of Object.entries(verdicts)) {
      const d = await demo({ siteverify: fakeSiteverify({ verdict: () => verdict }) });
      const reply = await d.call('POST', '/api/session', { json: { turnstile_token: 'tok' } });
      assert.equal(reply.status, 400, label);
      assert.equal(reply.body.error.code, 'TURNSTILE_FAILED', label);
      assert.equal(reply.body.ticket, undefined, label);
    }

    const down = await demo({
      siteverify: async () => {
        throw new TypeError('fetch failed');
      },
    });
    const unreachable = await down.call('POST', '/api/session', {
      json: { turnstile_token: 'tok' },
    });
    assert.equal(unreachable.status, 503);
    assert.equal(unreachable.body.error.code, 'CHALLENGE_UNAVAILABLE');
    assert.ok(Number(unreachable.headers.get('retry-after')) >= 1);
  });

  it('refuses a replayed token', async () => {
    const d = await demo();
    assert.equal(
      (await d.call('POST', '/api/session', { json: { turnstile_token: 'once' } })).status,
      200
    );
    const again = await d.call('POST', '/api/session', { json: { turnstile_token: 'once' } });
    assert.equal(again.status, 400);
    assert.equal(d.siteverify.calls.length, 1);
  });

  it('refuses a missing or malformed token without calling Cloudflare', async () => {
    const d = await demo();
    for (const json of [{}, { turnstile_token: 7 }, { turnstile_token: '' }, [], 'text']) {
      assert.equal((await d.call('POST', '/api/session', { json })).status, 400);
    }
    assert.equal((await d.call('POST', '/api/session')).status, 400);
    assert.equal(d.siteverify.calls.length, 0);
  });

  it('applies only a loose backstop per client address', async () => {
    const d = await demo({ env: { SESSION_MINT_PER_MINUTE_PER_IP: '3' } });
    for (let i = 0; i < 3; i += 1) {
      assert.equal(
        (await d.call('POST', '/api/session', { json: { turnstile_token: `t${i}` } })).status,
        200
      );
    }
    const limited = await d.call('POST', '/api/session', { json: { turnstile_token: 't3' } });
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers.get('retry-after')) >= 1);
    assert.equal(d.siteverify.calls.length, 3, 'a limited request costs no Turnstile call');
  });

  it('gives ten visitors on one address ten independent identities', async () => {
    const d = await demo();
    const visitors = await Promise.all(Array.from({ length: 10 }, (_, i) => d.visitor(`v${i}`)));

    const sids = visitors.map(
      ({ ticket }) => JSON.parse(Buffer.from(ticket.split('.')[1], 'base64url').toString()).sid
    );
    assert.equal(new Set(sids).size, 10);
  });
});

describe('who may call what', () => {
  it('requires a ticket on every job route, and on unknown paths too', async () => {
    const d = await demo();
    for (const [method, path] of [
      ['POST', '/api/jobs'],
      ['GET', `/api/jobs/j_${'a'.repeat(22)}`],
      ['GET', `/api/jobs/j_${'a'.repeat(22)}/result`],
      ['POST', `/api/jobs/j_${'a'.repeat(22)}/cancel`],
      ['POST', '/api/export'],
      ['POST', '/api/validate'],
      ['GET', '/api/health'],
      ['GET', '/api/meta/enums'],
      ['GET', '/api/nothing-here'],
    ]) {
      const reply = await d.call(method, path);
      assert.equal(reply.status, 401, `${method} ${path}`);
      assert.equal(reply.body.error.code, 'UNAUTHENTICATED');
    }
  });

  it('refuses a ticket that is expired, tampered, or minted for another site', async () => {
    let time = Date.now();
    const d = await demo({
      now: () => time,
      env: { ALLOWED_ORIGINS: `${ORIGIN},${OTHER_ORIGIN}` },
    });
    const v = await d.visitor();

    assert.equal((await d.call('GET', '/api/health', { ticket: v.ticket })).status, 200);

    const tampered = `${v.ticket.slice(0, -4)}AAAA`;
    assert.equal((await d.call('GET', '/api/health', { ticket: tampered })).status, 401);

    // Valid, but minted for ORIGIN and used from OTHER_ORIGIN, which is also allowed.
    const crossSite = await d.call('GET', '/api/health', {
      ticket: v.ticket,
      origin: OTHER_ORIGIN,
    });
    assert.equal(crossSite.status, 401);

    time += 31 * 60_000;
    assert.equal((await d.call('GET', '/api/health', { ticket: v.ticket })).status, 401);
  });

  it('never accepts the visitor’s identity from anywhere but the ticket', async () => {
    const d = await demo();
    const a = await d.visitor('a');
    const b = await d.visitor('b');
    const job = (await submit(d, a)).body.job;

    const forged = await d.call('GET', `/api/jobs/${job.id}`, {
      ticket: b.ticket,
      headers: { 'x-sid': 'anything', cookie: `sid=${a.ticket}`, 'x-forwarded-for': '1.2.3.4' },
    });
    assert.equal(forged.status, 404);
  });
});

describe('CORS and Origin', () => {
  it('answers a preflight from the allowed origin with Authorization allowed and no credentials', async () => {
    const d = await demo();
    const reply = await d.call('OPTIONS', '/api/jobs', {
      headers: {
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'authorization,content-type',
      },
    });

    assert.equal(reply.status, 204);
    assert.equal(reply.headers.get('access-control-allow-origin'), ORIGIN);
    assert.match(reply.headers.get('access-control-allow-headers').toLowerCase(), /authorization/);
    assert.match(reply.headers.get('access-control-allow-headers').toLowerCase(), /content-type/);
    assert.match(reply.headers.get('access-control-allow-methods'), /POST/);
    assert.equal(reply.headers.get('access-control-allow-credentials'), null);
  });

  it('refuses a preflight, and any request, from an origin that is not listed', async () => {
    const d = await demo();
    const v = await d.visitor();

    for (const origin of [
      OTHER_ORIGIN,
      'null',
      'https://demo.example.com.evil.test',
      'http://demo.example.com',
    ]) {
      const preflight = await d.call('OPTIONS', '/api/jobs', {
        origin,
        headers: { 'access-control-request-method': 'POST' },
      });
      assert.notEqual(preflight.headers.get('access-control-allow-origin'), origin, origin);

      const real = await d.call('GET', '/api/health', { ticket: v.ticket, origin });
      assert.equal(real.status, 403, origin);
      assert.equal(real.body.error.code, 'ORIGIN_FORBIDDEN');
    }
  });

  it('refuses a request with no Origin at all, on any method', async () => {
    const d = await demo();
    const v = await d.visitor();

    for (const [method, path] of [
      ['GET', '/api/health'],
      ['GET', `/api/jobs/j_${'a'.repeat(22)}`],
      ['POST', '/api/jobs'],
      ['POST', '/api/session'],
    ]) {
      const reply = await d.call(method, path, { ticket: v.ticket, origin: null });
      assert.equal(reply.status, 403, `${method} ${path}`);
      assert.equal(reply.body.error.code, 'ORIGIN_FORBIDDEN');
    }
  });

  it('leaves the liveness probe open, and says nothing else', async () => {
    const d = await demo();
    const reply = await d.call('GET', '/healthz', { origin: null });
    assert.equal(reply.status, 200);
    assert.deepEqual(reply.body, { status: 'ok' });
  });

  it('exposes Retry-After and the download headers to the page', async () => {
    const d = await demo();
    const reply = await d.call('POST', '/api/session', { json: { turnstile_token: 't' } });
    const exposed = reply.headers.get('access-control-expose-headers').toLowerCase();
    for (const name of ['retry-after', 'content-disposition', 'x-qatool-row-count']) {
      assert.ok(exposed.includes(name), name);
    }
  });

  it('adds CORS headers to a refusal too, so the page can read why', async () => {
    const d = await demo();
    const refused = await d.call('GET', '/api/health');
    assert.equal(refused.status, 401);
    assert.equal(refused.headers.get('access-control-allow-origin'), ORIGIN);
  });
});

describe('submitting a job', () => {
  it('answers 202 with the id, state, position, capacity, poll interval and boot id', async () => {
    const d = await demo({ providers: slowModel(150) });
    const v = await d.visitor();
    const reply = await submit(d, v);

    assert.equal(reply.status, 202);
    const { job } = reply.body;
    assert.equal(job.state, 'processing');
    assert.equal(job.queue.capacity, 10);
    assert.equal(job.poll_after_ms, 2500);
    assert.equal(job.boot_id, d.manager.bootId);
    assert.equal(job.position, null);
    assert.match(job.created_at, /^\d{4}-\d\d-\d\dT/);
  });

  it('no longer stops at five documents', async () => {
    const d = await demo();
    const v = await d.visitor();
    const reply = await submit(d, v, uploadForm({ files: 9 }));
    assert.equal(reply.status, 202, JSON.stringify(reply.body));
    const done = await waitForState(d, v, reply.body.job.id, ['completed', 'failed']);
    assert.equal(done.state, 'completed');
    const result = await d.call('GET', `/api/jobs/${done.id}/result`, { ticket: v.ticket });
    assert.equal(result.body.phases.extract.documents.length, 9);
  });

  it('answers 409 with the existing job id while the visitor has a live job', async () => {
    const d = await demo({ providers: slowModel(400) });
    const v = await d.visitor();
    const first = await submit(d, v);

    const second = await submit(d, v);
    assert.equal(second.status, 409);
    assert.equal(second.body.error.code, 'JOB_ALREADY_ACTIVE');
    assert.equal(second.body.error.details.job_id, first.body.job.id);

    await waitForState(d, v, first.body.job.id, 'completed');
    assert.equal((await submit(d, v)).status, 202, 'free again once it has finished');
  });

  it('answers 429 QUEUE_FULL with Retry-After when workers + pending places are taken', async () => {
    const d = await demo({
      providers: slowModel(500),
      env: { JOB_MAX_PENDING: '2' },
    });
    const visitors = await Promise.all([1, 2, 3, 4].map((n) => d.visitor(`v${n}`)));

    const replies = [];
    for (const v of visitors) replies.push(await submit(d, v));

    assert.deepEqual(
      replies.map((r) => r.status),
      [202, 202, 202, 429]
    );
    const full = replies[3];
    assert.equal(full.body.error.code, 'QUEUE_FULL');
    assert.ok(Number(full.headers.get('retry-after')) >= 5);
    assert.equal(
      full.headers.get('connection'),
      'close',
      'the body is not read for a queue that is full'
    );
  });

  it('refuses before reading the body: the answer arrives while the upload is still open', async () => {
    const d = await demo({ providers: slowModel(500), env: { JOB_MAX_PENDING: '1' } });
    const [a, b, c] = await Promise.all([d.visitor('a'), d.visitor('b'), d.visitor('c')]);
    await submit(d, a);
    await submit(d, b);

    // Headers promise 15 MB; only a few bytes are ever sent and the request is never ended.
    const status = await new Promise((resolve, reject) => {
      const request = http.request(
        `${d.baseUrl}/api/jobs`,
        {
          method: 'POST',
          headers: {
            origin: ORIGIN,
            authorization: `Bearer ${c.ticket}`,
            'content-type': 'multipart/form-data; boundary=x',
            'content-length': String(15 * 1024 * 1024),
          },
        },
        (response) => {
          response.resume();
          resolve(response.statusCode);
          request.destroy();
        }
      );
      request.on('error', (error) => (error.code === 'ECONNRESET' ? undefined : reject(error)));
      request.write('--x\r\n');
    });
    assert.equal(status, 429);
  });

  it('gives the place back when the documents cannot be read, so failures never leak capacity', async () => {
    const d = await demo({
      providers: slowModel(50),
      env: { JOB_MAX_PENDING: '1', UPLOAD_INFLIGHT_MAX: '1' },
    });
    const v = await d.visitor();

    for (let i = 0; i < 6; i += 1) {
      const form = new FormData();
      form.append('project_name', 'P');
      form.append('documents', new Blob(['this is not a document']), `junk-${i}.docx`);
      const bad = await submit(d, v, form);
      assert.equal(bad.status, 422, JSON.stringify(bad.body));
      assert.equal(bad.body.error.code, 'EXTRACTION_FAILED');
    }

    const good = await submit(d, v);
    assert.equal(good.status, 202, 'six failures later there is still room');
  });

  it('reports a missing or bad project name at submission', async () => {
    const d = await demo();
    const v = await d.visitor();
    for (const projectName of [null, '', '   ']) {
      const reply = await submit(d, v, uploadForm({ projectName }));
      assert.equal(reply.status, 400, JSON.stringify(projectName));
    }
    assert.equal(d.manager.status.length >= 0, true);
  });

  it('keeps the visitor’s limit for submissions apart from the limit for polling', async () => {
    const d = await demo({
      providers: slowModel(60),
      env: { JOB_SUBMIT_PER_MINUTE: '2', JOB_POLL_PER_MINUTE: '5000' },
    });
    const v = await d.visitor();
    const w = await d.visitor();

    const first = await submit(d, v);
    for (let i = 0; i < 30; i += 1) {
      assert.equal(
        (await d.call('GET', `/api/jobs/${first.body.job.id}`, { ticket: v.ticket })).status,
        200
      );
    }
    await waitForState(d, v, first.body.job.id, 'completed');

    // Thirty-odd polls used up none of the two submissions.
    const second = await submit(d, v);
    assert.equal(second.status, 202);
    await waitForState(d, v, second.body.job.id, 'completed');
    const third = await submit(d, v);
    assert.equal(third.status, 429);
    assert.equal(third.body.error.code, 'RATE_LIMITED');
    assert.ok(Number(third.headers.get('retry-after')) >= 1);

    // Another visitor on the same address is unaffected: identity is the ticket, not the IP.
    assert.equal((await submit(d, w)).status, 202);
  });

  it('limits polling on its own, per ticket, and a poll flood spends no submission', async () => {
    const d = await demo({
      env: { JOB_POLL_PER_MINUTE: '10', JOB_SUBMIT_PER_MINUTE: '2' },
      providers: slowModel(40),
    });
    const v = await d.visitor();
    const other = await d.visitor();
    const ghost = `/api/jobs/j_${'a'.repeat(22)}`;

    const codes = [];
    for (let i = 0; i < 14; i += 1)
      codes.push((await d.call('GET', ghost, { ticket: v.ticket })).status);
    assert.deepEqual(codes.slice(0, 10), Array(10).fill(404));
    assert.deepEqual(codes.slice(10), Array(4).fill(429));

    assert.equal((await submit(d, v)).status, 202, 'a throttled poller can still submit');
    assert.equal(
      (await d.call('GET', ghost, { ticket: other.ticket })).status,
      404,
      'others are untouched'
    );
  });
});

describe('the other routes have a burst limit per ticket too', () => {
  it('limits validation, export and the read-only routes per ticket, apart from job polling', async () => {
    const d = await demo({ env: { JOB_POLL_PER_MINUTE: '5' } });
    const v = await d.visitor();
    const other = await d.visitor();
    const ghost = `/api/jobs/j_${'a'.repeat(22)}`;

    const health = [];
    for (let i = 0; i < 8; i += 1)
      health.push((await d.call('GET', '/api/health', { ticket: v.ticket })).status);
    assert.deepEqual(health, [200, 200, 200, 200, 200, 429, 429, 429]);
    const limited = await d.call('GET', '/api/health', { ticket: v.ticket });
    assert.equal(limited.body.error.code, 'RATE_LIMITED');
    assert.ok(Number(limited.headers.get('retry-after')) >= 1);

    // Job polling is its own bucket: the throttled routes above spent none of it.
    for (let i = 0; i < 5; i += 1) {
      assert.equal((await d.call('GET', ghost, { ticket: v.ticket })).status, 404);
    }
    assert.equal((await d.call('GET', ghost, { ticket: v.ticket })).status, 429);

    assert.equal((await d.call('GET', '/api/health', { ticket: other.ticket })).status, 200);
  });
});

describe('isolation between visitors', () => {
  it('lets ten visitors see only their own job, and nothing else', async () => {
    const d = await demo({
      providers: fakeProviders({ model: fakeModel({ delayMs: 40 }), maxActive: 3 }),
      env: { JOB_WORKERS: '3', JOB_MAX_PENDING: '10' },
    });
    const visitors = await Promise.all(Array.from({ length: 10 }, (_, i) => d.visitor(`v${i}`)));

    const jobs = [];
    for (const [i, v] of visitors.entries()) {
      const reply = await submit(d, v, uploadForm({ tag: `v${i}-` }));
      assert.equal(reply.status, 202, JSON.stringify(reply.body));
      jobs.push(reply.body.job);
    }

    const unrelated = shape(
      await d.call('GET', `/api/jobs/j_${'z'.repeat(22)}`, { ticket: visitors[0].ticket })
    );
    for (let owner = 0; owner < 10; owner += 1) {
      for (let other = 0; other < 10; other += 1) {
        if (owner === other) continue;
        for (const [method, suffix] of [
          ['GET', ''],
          ['GET', '/result'],
          ['POST', '/cancel'],
        ]) {
          const reply = await d.call(method, `/api/jobs/${jobs[owner].id}${suffix}`, {
            ticket: visitors[other].ticket,
          });
          assert.equal(reply.status, 404, `visitor ${other} must not reach visitor ${owner}'s job`);
          assert.equal(shape(reply), unrelated, 'same answer as for a job that does not exist');
        }
      }
    }

    for (const [i, v] of visitors.entries()) {
      const done = await waitForState(d, v, jobs[i].id, ['completed', 'failed'], 20_000);
      assert.equal(done.state, 'completed');
      const result = await d.call('GET', `/api/jobs/${jobs[i].id}/result`, { ticket: v.ticket });
      const names = result.body.phases.extract.documents.map((document) => document.filename);
      assert.deepEqual(names.length, 1);
      assert.ok(names[0].includes(`v${i}-`), `visitor ${i} got their own document back`);
    }
  });

  it('treats a job id as a name only: without a ticket it is nothing', async () => {
    const d = await demo({ providers: slowModel(100) });
    const v = await d.visitor();
    const { job } = (await submit(d, v)).body;

    for (const suffix of ['', '/result', '/cancel']) {
      const reply = await d.call(
        suffix === '/cancel' ? 'POST' : 'GET',
        `/api/jobs/${job.id}${suffix}`
      );
      assert.equal(reply.status, 401);
    }
    assert.equal((await d.call('GET', `/api/jobs/${job.id}`, { ticket: v.ticket })).status, 200);
  });

  it('survives a restart: the ticket still works, the job is gone, and boot_id says so', async () => {
    const first = await demo({ providers: slowModel(200) });
    const v = await first.visitor();
    const { job } = (await submit(first, v)).body;

    const second = await demo();
    const reply = await second.call('GET', `/api/jobs/${job.id}`, { ticket: v.ticket });
    assert.equal(reply.status, 404, 'a ticket survives a restart; a job does not');
    assert.equal(reply.body.error.code, 'JOB_NOT_FOUND');

    const fresh = (await submit(second, v)).body.job;
    assert.notEqual(fresh.boot_id, job.boot_id, 'a client can tell the server restarted');
  });
});

describe('results, resume and cancellation', () => {
  it('returns every phase of a finished workflow, in the shapes of the routes they replace', async () => {
    const d = await demo();
    const v = await d.visitor();
    const { job } = (await submit(d, v)).body;
    await waitForState(d, v, job.id, 'completed');

    const { phases } = (await d.call('GET', `/api/jobs/${job.id}/result`, { ticket: v.ticket }))
      .body;
    assert.deepEqual(Object.keys(phases), ['extract', 'generate', 'validate']);
    assert.deepEqual(Object.keys(phases.extract).sort(), [
      'criteria',
      'documents',
      'metrics',
      'requirements',
      'structuring',
      'test_points',
      'warnings',
    ]);
    assert.deepEqual(Object.keys(phases.generate).sort(), [
      'metadata',
      'project',
      'test_cases',
      'warnings',
    ]);
    assert.ok('coverage' in phases.validate && 'semantic_warnings' in phases.validate);
  });

  it('keeps a failed workflow’s finished phases, and resumes from the one that failed', async () => {
    const providers = fakeProviders({
      model: fakeModel({
        before: (_request, call) => {
          if (call === 2)
            throw new LlmError(
              'LLM_UNAVAILABLE',
              'Could not reach Apayee at http://apayee:4100',
              503
            );
        },
      }),
    });
    const d = await demo({ providers });
    const v = await d.visitor();
    const { job } = (await submit(d, v)).body;

    const failed = await waitForState(d, v, job.id, ['failed', 'completed']);
    assert.equal(failed.state, 'failed');
    assert.deepEqual(failed.phases, { extract: 'done', generate: 'failed', validate: 'not_run' });
    assert.equal(failed.error.phase, 'generate');
    assert.equal(failed.error.retryable, true);

    const partial = (await d.call('GET', `/api/jobs/${job.id}/result`, { ticket: v.ticket })).body;
    assert.deepEqual(Object.keys(partial.phases), ['extract']);

    // The page holds the project; it resubmits from the phase that failed. The breaker is not
    // involved: this was an ordinary failure.
    const { extract } = partial.phases;
    const resume = await d.call('POST', '/api/jobs', {
      ticket: v.ticket,
      json: {
        from: 'generate',
        canonical: {
          project: { project_name: 'Demo Project', sit_scope: [] },
          documents: extract.documents,
          requirements: extract.requirements,
          test_cases: [],
        },
        test_points: extract.test_points,
      },
    });
    assert.equal(resume.status, 202, JSON.stringify(resume.body));
    assert.equal(resume.body.job.from, 'generate');
    assert.equal(resume.body.job.phases.extract, 'skipped');
    assert.equal(resume.body.job.phases.validate, 'pending');
    assert.ok(['pending', 'running'].includes(resume.body.job.phases.generate));

    const done = await waitForState(d, v, resume.body.job.id, ['completed', 'failed']);
    assert.equal(done.state, 'completed', JSON.stringify(done.error));
    const result = (await d.call('GET', `/api/jobs/${done.id}/result`, { ticket: v.ticket })).body;
    assert.deepEqual(Object.keys(result.phases), ['generate', 'validate']);
    assert.ok(result.phases.generate.test_cases.length > 0);
  });

  it('runs the semantic review alone as a validate job, and reports its result', async () => {
    const providers = fakeProviders();
    const d = await demo({ providers });
    const v = await d.visitor();

    const reply = await d.call('POST', '/api/jobs', {
      ticket: v.ticket,
      json: { from: 'validate', canonical: buildSampleCanonical(), test_points: [] },
    });
    assert.equal(reply.status, 202, JSON.stringify(reply.body));
    assert.equal(reply.body.job.from, 'validate');

    const done = await waitForState(d, v, reply.body.job.id, ['completed', 'failed']);
    assert.equal(done.state, 'completed', JSON.stringify(done.error));
    assert.equal(providers.model.state.calls, 1, 'one model call, the review');

    const { phases } = (await d.call('GET', `/api/jobs/${done.id}/result`, { ticket: v.ticket }))
      .body;
    assert.deepEqual(Object.keys(phases), ['validate']);
    assert.equal(phases.validate.semantic.llm, 'completed');
  });

  it('refuses a malformed resume at once, without a worker or a model call', async () => {
    const providers = fakeProviders();
    const d = await demo({ providers });
    const v = await d.visitor();
    const post = (json) => d.call('POST', '/api/jobs', { ticket: v.ticket, json });

    assert.equal((await post({})).status, 400);
    assert.equal(
      (await post({ from: 'extract', canonical: {} })).status,
      400,
      'documents start from extract'
    );
    assert.equal((await post({ from: 'other', canonical: {} })).status, 400);
    assert.equal((await post({ from: 'generate', canonical: 'text' })).status, 400);
    assert.equal((await post({ from: 'generate', canonical: { requirements: [] } })).status, 422);
    assert.equal(
      (await post({ from: 'generate', canonical: { requirements: [{ nope: 1 }] } })).status,
      400
    );
    assert.equal(
      (await post({ from: 'validate', canonical: {}, test_points: new Array(7000).fill(0) }))
        .status,
      400
    );
    assert.equal(providers.state.acquired, 0);
    assert.equal(providers.model.state.calls, 0);

    assert.equal(
      (await post({ from: 'validate', canonical: buildSampleCanonical() })).status,
      202,
      'and the visitor was not locked out'
    );
  });

  it('cancels a processing job: the model call is aborted and the result so far is kept', async () => {
    const providers = fakeProviders({ model: fakeModel({ delayMs: 5000 }) });
    const d = await demo({ providers });
    const v = await d.visitor();
    const { job } = (await submit(d, v)).body;

    while (providers.model.state.calls === 0)
      await new Promise((resolve) => setTimeout(resolve, 10));
    const cancelled = await d.call('POST', `/api/jobs/${job.id}/cancel`, { ticket: v.ticket });
    assert.equal(cancelled.status, 200);
    assert.equal(cancelled.body.job.state, 'cancelled');
    assert.equal(cancelled.body.job.cancel_reason, 'user');

    const deadline = Date.now() + 2000;
    while (providers.model.state.aborted === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(providers.model.state.aborted, 1, 'the call in flight was aborted');

    const again = await d.call('POST', `/api/jobs/${job.id}/cancel`, { ticket: v.ticket });
    assert.equal(again.status, 200, 'cancelling twice is fine');
    assert.equal(again.body.job.state, 'cancelled');
    assert.equal((await submit(d, v)).status, 202, 'free to start another');
  });

  it('cancels a queued job without it ever running', async () => {
    const providers = fakeProviders({ model: fakeModel({ delayMs: 300 }) });
    const d = await demo({ providers });
    const [a, b] = await Promise.all([d.visitor('a'), d.visitor('b')]);
    const first = (await submit(d, a)).body.job;
    const queued = (await submit(d, b)).body.job;
    assert.equal(queued.state, 'queued');
    assert.equal(queued.position, 1);

    const reply = await d.call('POST', `/api/jobs/${queued.id}/cancel`, { ticket: b.ticket });
    assert.equal(reply.body.job.state, 'cancelled');

    await waitForState(d, a, first.id, 'completed', 10_000);
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(providers.model.state.calls, 3, 'only the first visitor’s three calls were made');
  });

  it('abandons a job nobody polls: queued work is dropped, running work is stopped', async () => {
    const providers = fakeProviders({ model: fakeModel({ delayMs: 5000 }) });
    const d = await demo({ providers, env: { JOB_LEASE_MS: '1000' } });
    const [a, b] = await Promise.all([d.visitor('a'), d.visitor('b')]);
    const running = (await submit(d, a)).body.job;
    const queued = (await submit(d, b)).body.job;

    await new Promise((resolve) => setTimeout(resolve, 1200));
    d.manager.sweep();

    assert.equal(
      d.manager.status(JSON.parse(Buffer.from(a.ticket.split('.')[1], 'base64url')).sid, running.id)
        .state,
      'cancelled'
    );
    const gone = await d.call('GET', `/api/jobs/${queued.id}`, { ticket: b.ticket });
    assert.equal(gone.status, 404, 'a queued job nobody polled is simply gone');
    assert.equal(providers.model.state.aborted, 1, 'the model call stopped with the abandoned job');
  });

  it('keeps a polled job alive for as long as it is polled', async () => {
    const providers = fakeProviders({ model: fakeModel({ delayMs: 1800 }) });
    const d = await demo({ providers, env: { JOB_LEASE_MS: '1000' } });
    const v = await d.visitor();
    const { job } = (await submit(d, v)).body;

    const until = Date.now() + 1600;
    while (Date.now() < until) {
      const state = (await d.call('GET', `/api/jobs/${job.id}`, { ticket: v.ticket })).body.job
        .state;
      assert.equal(state, 'processing');
      d.manager.sweep();
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  });
});

describe('what a visitor can and cannot choose', () => {
  it('always uses the one server-chosen model, whatever the request says', async () => {
    const providers = fakeProviders();
    const d = await demo({ providers });
    const v = await d.visitor();

    const form = uploadForm();
    form.append('provider', 'gemini');
    form.append('model', 'something-else');
    const reply = await d.call('POST', '/api/jobs?provider=mock&model=x', {
      ticket: v.ticket,
      form,
      headers: { 'x-provider': 'apayee' },
    });
    assert.equal(reply.status, 202);
    await waitForState(d, v, reply.body.job.id, ['completed', 'failed']);

    assert.deepEqual([...new Set(providers.state.ids)], ['claude']);
  });

  it('has no direct route to a model: extract, generate and semantic validation are not served', async () => {
    const providers = fakeProviders();
    const d = await demo({ providers });
    const v = await d.visitor();

    const extract = await d.call('POST', '/api/extract', { ticket: v.ticket, form: uploadForm() });
    assert.equal(extract.status, 404);
    const generate = await d.call('POST', '/api/generate', {
      ticket: v.ticket,
      json: buildSampleCanonical(),
    });
    assert.equal(generate.status, 404);

    const semantic = await d.call('POST', '/api/validate?semantic=true', {
      ticket: v.ticket,
      json: buildSampleCanonical(),
    });
    assert.equal(semantic.status, 400);
    assert.equal(semantic.body.error.code, 'USE_JOBS');

    const providerList = await d.call('GET', '/api/llm/providers', { ticket: v.ticket });
    assert.equal(providerList.status, 404, 'no provider list, no readiness, for visitors');

    assert.equal(providers.state.acquired, 0, 'none of that touched a provider');
    assert.equal(providers.model.state.calls, 0);
  });

  it('still serves deterministic validation and export, behind a ticket', async () => {
    const d = await demo();
    const v = await d.visitor();

    const validate = await d.call('POST', '/api/validate', {
      ticket: v.ticket,
      json: buildSampleCanonical(),
    });
    assert.equal(validate.status, 200);
    assert.equal(validate.body.valid, true);

    const exported = await d.call('POST', '/api/export', {
      ticket: v.ticket,
      json: buildSampleCanonical(),
    });
    assert.equal(exported.status, 200);
    assert.match(exported.headers.get('content-disposition'), /\.xlsx/);

    assert.equal(
      (await d.call('POST', '/api/export', { json: buildSampleCanonical() })).status,
      401
    );
  });
});

describe('the provider, as a visitor can observe it', () => {
  it('pauses admission with a retryable error when the gateway cannot take work', async () => {
    const providers = fakeProviders({ available: false });
    const d = await demo({ providers });
    const v = await d.visitor();

    const reply = await submit(d, v);
    assert.equal(reply.status, 503);
    assert.equal(reply.body.error.code, 'SERVICE_UNAVAILABLE');
    assert.ok(Number(reply.headers.get('retry-after')) >= 1);
    assert.equal(reply.headers.get('connection'), 'close');
    assert.equal(providers.state.acquired, 0);

    providers.state.available = true;
    assert.equal((await submit(d, v)).status, 202, 'and recovers when the gateway does');
  });

  it('trips the breaker when the provider says it is out of allowance, and tells nothing else', async () => {
    const providers = fakeProviders();
    providers.state.acquireError = new ProviderUnavailableError('claude', {
      reason: 'Apayee reported a usage limit',
      code: 'provider_not_ready',
    });
    const d = await demo({ providers, env: { PROVIDER_BREAKER_COOLDOWN_MS: '60000' } });
    const [a, b] = await Promise.all([d.visitor('a'), d.visitor('b')]);

    const { job } = (await submit(d, a)).body;
    const failed = await waitForState(d, a, job.id, 'failed');
    assert.equal(failed.error.code, 'SERVICE_UNAVAILABLE');
    assert.ok(!JSON.stringify(failed).match(/apayee|claude|usage limit/i), JSON.stringify(failed));

    const paused = await submit(d, b);
    assert.equal(paused.status, 503);
    assert.equal(paused.body.error.code, 'SERVICE_PAUSED');
    assert.ok(Number(paused.headers.get('retry-after')) >= 1);
    assert.equal(providers.state.acquired, 1, 'the second visitor never reached the provider');
  });

  it('runs no more jobs at once than the gateway says it can', async () => {
    const providers = fakeProviders({ model: fakeModel({ delayMs: 60 }), maxActive: 1 });
    const d = await demo({ providers, env: { JOB_WORKERS: '3', JOB_MAX_PENDING: '6' } });
    const visitors = await Promise.all(Array.from({ length: 4 }, (_, i) => d.visitor(`v${i}`)));
    const jobs = [];
    for (const v of visitors) jobs.push((await submit(d, v)).body.job);

    for (const [i, v] of visitors.entries())
      await waitForState(d, v, jobs[i].id, 'completed', 20_000);
    assert.equal(providers.model.state.peak, 1, 'three workers configured, the gateway runs one');
  });
});

describe('what a visitor is never shown', () => {
  it('has no provider, model, usage, address, path or secret anywhere in a finished job', async () => {
    const d = await demo();
    const v = await d.visitor();
    const { job } = (await submit(d, v)).body;
    await waitForState(d, v, job.id, 'completed');

    const everything = JSON.stringify([
      (await d.call('GET', `/api/jobs/${job.id}`, { ticket: v.ticket })).body,
      (await d.call('GET', `/api/jobs/${job.id}/result`, { ticket: v.ticket })).body,
    ]);
    for (const forbidden of [
      'FakeModel',
      'fake-model',
      'Apayee',
      'apayee',
      'usage',
      '"provider"',
      '"model"',
      TICKET_SECRET,
      TURNSTILE_SECRET,
      '127.0.0.1',
      'C:\\',
    ]) {
      assert.ok(!everything.includes(forbidden), `"${forbidden}" appears in a visitor's job`);
    }

    const { structuring } = JSON.parse(everything)[1].phases.extract;
    assert.equal('provider' in structuring, false);
    assert.equal('model' in structuring, false);
  });

  it('turns a provider failure inside a stage into a fixed sentence, even where the stage writes it into a result', async () => {
    // Structuring absorbs a provider failure into its fallback reason and a warning; the
    // review absorbs one into its status. Both end up in results a visitor reads.
    const providers = fakeProviders({
      model: fakeModel({
        before: (_request, call) => {
          if (call === 1 || call === 3) {
            throw new LlmError(
              'LLM_UNAVAILABLE',
              'Could not reach Apayee at http://apayee:4100 (ECONNREFUSED)',
              502
            );
          }
        },
      }),
    });
    const d = await demo({ providers });
    const v = await d.visitor();
    const { job } = (await submit(d, v)).body;
    const done = await waitForState(d, v, job.id, ['completed', 'failed']);
    assert.equal(done.state, 'completed', JSON.stringify(done.error));

    const result = JSON.stringify(
      (await d.call('GET', `/api/jobs/${job.id}/result`, { ticket: v.ticket })).body
    );
    assert.match(result, /deterministic extraction/, 'the fallback really happened');
    for (const leak of ['Apayee', 'apayee', 'ECONNREFUSED', 'http://']) {
      assert.ok(!result.includes(leak), `"${leak}" reached a visitor`);
    }
  });

  it('logs metadata only: no document text, ticket, token, secret or session id', async () => {
    let logs = '';
    const stream = new Writable({
      write(chunk, _encoding, done) {
        logs += chunk;
        done();
      },
    });
    const d = await demo({ logger: { level: 'info', stream } });
    const v = await d.visitor();
    const token = 'turnstile-token-that-must-not-be-logged';
    const minted = await d.call('POST', '/api/session', { json: { turnstile_token: token } });

    const { job } = (await submit(d, v, uploadForm({ projectName: 'Confidential Project Name' })))
      .body;
    await waitForState(d, v, job.id, 'completed');
    await d.call('GET', `/api/jobs/${job.id}`, { ticket: v.ticket });

    const sid = JSON.parse(Buffer.from(v.ticket.split('.')[1], 'base64url').toString()).sid;
    for (const secret of [
      'Suspended participant',
      'ADMI 002',
      'Confidential Project Name',
      v.ticket,
      minted.body.ticket,
      token,
      sid,
      TICKET_SECRET,
      TURNSTILE_SECRET,
      'PRD 0.docx',
    ]) {
      assert.ok(!logs.includes(secret), `"${secret.slice(0, 24)}" was logged`);
    }
    assert.match(
      logs,
      /RUN QATOOL-\d{8}-[0-9A-F]{6} \| status=SUCCESS/,
      'the job has its summary line'
    );
  });
});

describe('upload limits at submission', () => {
  it('refuses too many files, a file too large and a total too large, each with its own 413', async () => {
    const d = await demo({
      env: { UPLOAD_MAX_FILES: '3', UPLOAD_MAX_FILE_BYTES: '4000', UPLOAD_MAX_TOTAL_BYTES: '6000' },
    });
    const v = await d.visitor();

    const many = await submit(d, v, uploadForm({ files: 4 }));
    assert.equal(many.status, 413);
    assert.equal(many.body.error.code, 'TOO_MANY_FILES');

    const big = new FormData();
    big.append('project_name', 'P');
    big.append('documents', new Blob([Buffer.alloc(5000, 1)]), 'big.docx');
    const large = await submit(d, v, big);
    assert.equal(large.status, 413);
    assert.equal(large.body.error.code, 'FILE_TOO_LARGE');

    const total = new FormData();
    total.append('project_name', 'P');
    for (let i = 0; i < 3; i += 1)
      total.append('documents', new Blob([Buffer.alloc(3000, 1)]), `f${i}.docx`);
    const together = await submit(d, v, total);
    assert.equal(together.status, 413);
    assert.equal(together.body.error.code, 'UPLOAD_TOO_LARGE');

    assert.equal(d.metrics.snapshot().rejections.upload_limits, 3);
    assert.equal((await submit(d, v)).status, 202, 'and none of them left the visitor locked out');
  });

  it('refuses documents with more text than a pending job may hold', async () => {
    const d = await demo({ env: { PARSED_TEXT_MAX_CHARS: '1000' } });
    const v = await d.visitor();
    const form = new FormData();
    form.append('project_name', 'P');
    form.append('documents', new Blob([Buffer.from('x')]), 'tiny.docx');
    const tiny = await submit(d, v, uploadForm());
    assert.equal(tiny.status, 202, 'a small document is fine');
    await waitForState(d, v, tiny.body.job.id, 'completed');

    const { buildDocx } = await import('../extract/fixtures/build.js');
    const paragraphs = Array.from({ length: 80 }, (_, i) => ({
      text: `Requirement ${i}: the system must reject transaction ${i} with reason code U${i} when suspended.`,
    }));
    const big = new FormData();
    big.append('project_name', 'P');
    big.append('documents', new Blob([buildDocx(paragraphs)]), 'long.docx');
    const reply = await submit(d, v, big);
    assert.equal(reply.status, 422);
    assert.equal(reply.body.error.code, 'DOCUMENT_TOO_COMPLEX');
  });

  it('holds a place for an upload in progress, refuses others past the global cap, and frees it when the upload dies', async () => {
    const d = await demo({ env: { UPLOAD_INFLIGHT_MAX: '1' } });
    const [a, b] = await Promise.all([d.visitor('a'), d.visitor('b')]);

    // Visitor A starts an upload that never finishes.
    const stalled = http.request(`${d.baseUrl}/api/jobs`, {
      method: 'POST',
      headers: {
        origin: ORIGIN,
        authorization: `Bearer ${a.ticket}`,
        'content-type': 'multipart/form-data; boundary=x',
        'content-length': '100000',
      },
    });
    stalled.on('error', () => {});
    stalled.write('--x\r\n');
    while (d.metrics.snapshot().uploads.inflight === 0) await new Promise((r) => setTimeout(r, 10));

    const busy = await submit(d, b);
    assert.equal(busy.status, 429);
    assert.equal(busy.body.error.code, 'UPLOAD_BUSY');

    stalled.destroy();
    const deadline = Date.now() + 3000;
    while (d.metrics.snapshot().uploads.inflight !== 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(d.metrics.snapshot().uploads.inflight, 0, 'the dead upload gave its place back');
    assert.equal((await submit(d, b)).status, 202);
  });
});

describe('shutting down', () => {
  it('stops admission, aborts running model calls and finishes closing', async () => {
    const providers = fakeProviders({ model: fakeModel({ delayMs: 10_000 }) });
    const d = await demo({ providers });
    const [a, b] = await Promise.all([d.visitor('a'), d.visitor('b')]);
    await submit(d, a);
    await submit(d, b);
    while (providers.model.state.calls === 0)
      await new Promise((resolve) => setTimeout(resolve, 10));

    const started = Date.now();
    await d.app.close();
    demos.splice(demos.indexOf(d), 1);

    assert.ok(Date.now() - started < 4000, 'closing did not wait for the model');
    assert.equal(providers.model.state.aborted, 1, 'the call in flight was aborted');
    assert.equal(providers.model.state.active, 0);
  });
});
