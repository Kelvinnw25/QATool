import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ApiError, createApi, parseRetryAfter } from './api.js';

/**
 * The client in public-demo trim: where URLs point, when the ticket is sent, and what a failure
 * looks like. The local, unconfigured client is covered by api.test.js and api.provider.test.js,
 * which this file does not touch.
 */

function recorder(reply = () => new Response('{}', { status: 200 })) {
  const calls = [];
  return {
    calls,
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init });
      return reply(url, init);
    },
  };
}

const headerOf = (call, name) => new Headers(call.init.headers).get(name);

const errorResponse = (status, code, headers = {}) =>
  new Response(JSON.stringify({ error: { code, message: `${code} message` } }), {
    status,
    headers,
  });

describe('API base URL', () => {
  it('prefixes every path with the configured origin', async () => {
    const { calls, fetchImpl } = recorder();
    const api = createApi({ baseUrl: 'https://api.example.com', fetchImpl, getTicket: () => 't' });

    await api.createSession('x');
    await api.submitResume({ from: 'validate', canonical: {} });
    await api.jobStatus('j_1');
    await api.jobResult('j_1');
    await api.cancelJob('j_1');
    await api.validate({});
    await api.exportWorkbook({}).catch(() => {});

    assert.equal(calls.length, 7);
    for (const call of calls) assert.match(call.url, /^https:\/\/api\.example\.com\/api\//);
  });

  it('keeps relative URLs when no base is set (the local Vite proxy)', async () => {
    const { calls, fetchImpl } = recorder();
    const api = createApi({ fetchImpl });
    await api.validate({});
    await api.jobStatus('j_1');
    assert.deepEqual(
      calls.map((c) => c.url),
      ['/api/validate', '/api/jobs/j_1']
    );
  });

  it('encodes a job id into the path', async () => {
    const { calls, fetchImpl } = recorder();
    await createApi({ fetchImpl }).jobStatus('a/b?c');
    assert.equal(calls[0].url, '/api/jobs/a%2Fb%3Fc');
  });
});

describe('the ticket', () => {
  it('rides on every protected call as a bearer header', async () => {
    const { calls, fetchImpl } = recorder();
    const api = createApi({ fetchImpl, getTicket: () => 'the-ticket' });

    await api.submitDocuments([new File(['x'], 'a.docx')], 'P');
    await api.submitResume({ from: 'generate', canonical: {}, testPoints: [] });
    await api.jobStatus('j_1');
    await api.jobResult('j_1');
    await api.cancelJob('j_1');
    await api.validate({});
    await api.exportWorkbook({}).catch(() => {});

    assert.equal(calls.length, 7);
    for (const call of calls) assert.equal(headerOf(call, 'authorization'), 'Bearer the-ticket');
  });

  it('is not sent to the session endpoint, which mints it', async () => {
    const { calls, fetchImpl } = recorder();
    await createApi({ fetchImpl, getTicket: () => 'the-ticket' }).createSession('tok');
    assert.equal(headerOf(calls[0], 'authorization'), null);
    assert.deepEqual(JSON.parse(calls[0].init.body), { turnstile_token: 'tok' });
  });

  it('is absent when there is none (the local tool)', async () => {
    const { calls, fetchImpl } = recorder();
    await createApi({ fetchImpl }).validate({});
    assert.equal(headerOf(calls[0], 'authorization'), null);
  });

  it('puts no cookie or credentials option on a request', async () => {
    const { calls, fetchImpl } = recorder();
    await createApi({ fetchImpl, getTicket: () => 't' }).jobStatus('j_1');
    assert.equal(calls[0].init.credentials, undefined);
    assert.equal(headerOf(calls[0], 'cookie'), null);
  });

  it('a 401 on a call that carried a ticket tells the page the ticket is dead', async () => {
    let rejected = 0;
    const { fetchImpl } = recorder(() => errorResponse(401, 'UNAUTHENTICATED'));
    const api = createApi({
      fetchImpl,
      getTicket: () => 't',
      onUnauthorized: () => (rejected += 1),
    });
    await assert.rejects(api.jobStatus('j_1'), { status: 401, code: 'UNAUTHENTICATED' });
    assert.equal(rejected, 1);

    // Without a ticket there is nothing to declare dead.
    const bare = createApi({ fetchImpl, onUnauthorized: () => (rejected += 1) });
    await assert.rejects(bare.jobStatus('j_1'));
    assert.equal(rejected, 1);
  });
});

describe('job requests', () => {
  it('sends documents as multipart with the project name and no model', async () => {
    const { calls, fetchImpl } = recorder();
    await createApi({ fetchImpl }).submitDocuments([new File(['x'], 'a.docx')], 'My project');
    const form = calls[0].init.body;
    assert.ok(form instanceof FormData);
    assert.equal(form.get('project_name'), 'My project');
    assert.equal(form.getAll('documents').length, 1);
    assert.deepEqual([...new Set(form.keys())].sort(), ['documents', 'project_name']);
    assert.equal(headerOf(calls[0], 'content-type'), null, 'the browser adds the boundary');
    assert.equal(calls[0].url, '/api/jobs');
  });

  it('builds a new FormData for every call', async () => {
    const { calls, fetchImpl } = recorder();
    const api = createApi({ fetchImpl });
    const files = [new File(['x'], 'a.docx')];
    await api.submitDocuments(files, 'P');
    await api.submitDocuments(files, 'P');
    assert.notEqual(calls[0].init.body, calls[1].init.body);
  });

  it('sends a resume as { from, canonical, test_points }', async () => {
    const { calls, fetchImpl } = recorder();
    const canonical = { project: {}, documents: [], requirements: [], test_cases: [] };
    await createApi({ fetchImpl }).submitResume({
      from: 'generate',
      canonical,
      testPoints: [{ a: 1 }],
    });
    assert.deepEqual(JSON.parse(calls[0].init.body), {
      from: 'generate',
      canonical,
      test_points: [{ a: 1 }],
    });
    assert.equal(calls[0].init.method, 'POST');
    assert.equal(calls[0].url, '/api/jobs');
  });

  it('uses the documented paths and methods', async () => {
    const { calls, fetchImpl } = recorder();
    const api = createApi({ fetchImpl });
    await api.jobStatus('j_1');
    await api.jobResult('j_1');
    await api.cancelJob('j_1');
    assert.deepEqual(
      calls.map((c) => `${c.init.method} ${c.url}`),
      ['GET /api/jobs/j_1', 'GET /api/jobs/j_1/result', 'POST /api/jobs/j_1/cancel']
    );
  });
});

describe('failures', () => {
  it('turns a failed fetch into an offline error that names no development server', async () => {
    const { fetchImpl } = recorder(() => {
      throw new TypeError('Failed to fetch');
    });
    const error = await createApi({ fetchImpl, demo: true })
      .jobStatus('j_1')
      .catch((e) => e);

    assert.ok(error instanceof ApiError);
    assert.equal(error.networkFailure, true);
    assert.equal(error.code, 'NETWORK_ERROR');
    assert.equal(error.status, 0);
    assert.doesNotMatch(error.message, /vite|development|proxy|node --watch/i);
    assert.match(error.message, /demo service/);
  });

  it('describes a bodyless gateway error without the dev-server story in the demo', async () => {
    const { fetchImpl } = recorder(() => new Response('', { status: 502 }));
    const error = await createApi({ fetchImpl, demo: true })
      .jobStatus('j_1')
      .catch((e) => e);
    assert.equal(error.unanswered, true);
    assert.doesNotMatch(error.message, /development|restarts whenever a server file changes/);
    assert.match(error.message, /HTTP 502/);
  });

  it('lets an abort through untouched', async () => {
    const { fetchImpl } = recorder(() => {
      throw new DOMException('aborted', 'AbortError');
    });
    await assert.rejects(createApi({ fetchImpl }).jobStatus('j_1'), { name: 'AbortError' });
  });

  it('reads Retry-After as seconds', async () => {
    assert.equal(parseRetryAfter('12'), 12);
    assert.equal(parseRetryAfter(' 3 '), 3);
    assert.equal(parseRetryAfter('Wed, 21 Oct 2026 07:28:00 GMT'), null);
    assert.equal(parseRetryAfter(null), null);

    const { fetchImpl } = recorder(() => errorResponse(429, 'QUEUE_FULL', { 'Retry-After': '9' }));
    const error = await createApi({ fetchImpl })
      .submitResume({ from: 'validate', canonical: {} })
      .catch((e) => e);
    assert.equal(error.retryAfterSeconds, 9);
    assert.equal(error.code, 'QUEUE_FULL');
  });

  it('attaches the ticket to an export, and reads the filename and counts', async () => {
    const { calls, fetchImpl } = recorder(
      () =>
        new Response(new Uint8Array([1, 2]), {
          status: 200,
          headers: {
            'content-disposition': 'attachment; filename="SIT Script.xlsx"',
            'x-qatool-row-count': '4',
          },
        })
    );
    const out = await createApi({ fetchImpl, getTicket: () => 'tk' }).exportWorkbook({ a: 1 });
    assert.equal(headerOf(calls[0], 'authorization'), 'Bearer tk');
    assert.equal(out.filename, 'SIT Script.xlsx');
    assert.equal(out.rowCount, 4);
  });
});
