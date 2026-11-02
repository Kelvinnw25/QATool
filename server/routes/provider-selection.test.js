import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { buildApp } from '../app.js';
import { config } from '../config.js';
import { buildSampleCanonical } from '../export/fixtures/sample-canonical.js';
import { buildDocx } from '../extract/fixtures/build.js';
import { sampleCanonicalInput, sampleLlmResponse } from '../generate/fixtures/sample-input.js';
import { providerAvailability } from '../llm/catalog.js';
import {
  closedPort,
  generateReply,
  healthReply,
  startFakeGateway,
} from '../llm/fixtures/fake-gateway.js';

/**
 * Choosing a model per request.
 *
 * Claude is whatever a gateway on a loopback port says it is, so every test
 * here runs against a fake one speaking the documented health and generate
 * contracts. Nothing reaches a real model: the suite's network guard refuses
 * anything but loopback, and the Gemini cases replace fetch.
 */

const TOKEN = 'route-test-token-Zq81Lw4Rk7Vn2Xd9Bf6Ty3';
const GEMINI_KEY = 'AIzaROUTETESTKEY0123456789ABCD';

let app;
let saved;
const gateways = [];

beforeEach(() => {
  app = buildApp();
  saved = { ...config.llm };
  providerAvailability.forget();
});

afterEach(async () => {
  Object.assign(config.llm, saved);
  delete config.llm.responses;
  providerAvailability.forget();
  await app.close();
  await Promise.all(gateways.splice(0).map((gateway) => gateway.close()));
});

async function gateway(options) {
  const started = await startFakeGateway(options);
  gateways.push(started);
  return started;
}

/** Points the server at a gateway. Everything else keeps the real defaults. */
function configure(overrides) {
  Object.assign(config.llm, { provider: 'gemini', apiKey: '', apayeeToken: '', ...overrides });
}

/** A gateway whose generate endpoint answers with a fixed result. */
async function gatewayAnswering(result, options = {}) {
  return gateway({
    ...options,
    generate: (record) =>
      generateReply(record.body.request_id, result, { provider: options.provider ?? 'claude' }),
  });
}

/** Replaces fetch so a fallback to Gemini would be seen, and cannot leave the machine. */
async function watchingFetch(body) {
  const realFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return new Response(JSON.stringify({ error: { message: 'stub' } }), { status: 400 });
  };
  try {
    return { result: await body(), calls };
  } finally {
    globalThis.fetch = realFetch;
  }
}

async function multipart(form) {
  const response = new Response(form);
  return {
    payload: Buffer.from(await response.arrayBuffer()),
    headers: { 'content-type': response.headers.get('content-type') },
  };
}

async function extractRequest(query = '') {
  const form = new FormData();
  form.append(
    'documents',
    new Blob([
      buildDocx([
        { heading: 'Business Rules', level: 1 },
        {
          text: 'Transactions from a Suspended participant must be rejected with reason code U253.',
        },
      ]),
    ]),
    'PRD.docx'
  );
  return { method: 'POST', url: `/api/extract${query}`, ...(await multipart(form)) };
}

const generateRequest = (query = '') => ({
  method: 'POST',
  url: `/api/generate${query}`,
  payload: sampleCanonicalInput(),
});

const validateRequest = (query = '') => ({
  method: 'POST',
  url: `/api/validate${query}`,
  payload: buildSampleCanonical(),
});

const generatePosts = (g) => g.count('POST', '/v1/generate');

describe('GET /api/llm/providers', () => {
  it('lists gemini and claude, with gemini the default', async () => {
    const g = await gateway({ provider: 'claude' });
    configure({ apiKey: GEMINI_KEY, apayeeBaseUrl: g.baseUrl });

    const response = await app.inject({ method: 'GET', url: '/api/llm/providers' });

    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.deepEqual(response.json(), {
      default: 'gemini',
      providers: [
        { id: 'gemini', label: 'Gemini', available: true, reason: null, code: null },
        { id: 'claude', label: 'Claude via Apayee', available: true, reason: null, code: null },
      ],
    });
  });

  it('keeps Claude unavailable while Apayee runs its mock provider', async () => {
    const g = await gateway({ provider: 'mock' });
    configure({ apiKey: GEMINI_KEY, apayeeBaseUrl: g.baseUrl });

    const { providers } = (await app.inject({ method: 'GET', url: '/api/llm/providers' })).json();

    assert.equal(providers[0].available, true);
    assert.equal(providers[1].available, false);
    assert.match(providers[1].reason, /mock provider/);
  });

  it('reports Gemini unavailable when the server has no key', async () => {
    const g = await gateway();
    configure({ apiKey: '', apayeeBaseUrl: g.baseUrl });

    const { providers } = (await app.inject({ method: 'GET', url: '/api/llm/providers' })).json();
    assert.equal(providers[0].available, false);
    assert.match(providers[0].reason, /Gemini is not configured/);
  });

  it('exposes neither the gateway address, the token nor the key', async () => {
    const g = await gateway({ token: TOKEN, provider: 'mock' });
    configure({ apiKey: GEMINI_KEY, apayeeBaseUrl: g.baseUrl, apayeeToken: TOKEN });

    const body = (await app.inject({ method: 'GET', url: '/api/llm/providers' })).body;

    for (const secret of [TOKEN, GEMINI_KEY, g.baseUrl, String(g.port), '127.0.0.1']) {
      assert.ok(!body.includes(secret), `the response contains ${secret}`);
    }
  });

  it('has no default for a legacy apayee configuration, without changing what it means', async () => {
    const g = await gateway({ provider: 'mock' });
    configure({ provider: 'apayee', apayeeBaseUrl: g.baseUrl });

    const body = (await app.inject({ method: 'GET', url: '/api/llm/providers' })).json();
    assert.equal(body.default, null);
    assert.equal(body.default_label, 'Server default (Apayee gateway)');
    assert.match(body.default_note, /currently running the "mock" provider/);
    assert.equal(body.providers[1].available, false, 'a mock gateway is still not Claude');
  });

  it('lets that same server run through the gateway from the browser’s “Server default”', async () => {
    // The connectivity test path: LLM_PROVIDER=apayee, nothing selected, the
    // gateway running mock. It must work, and it must not be called Claude.
    const g = await gatewayAnswering(sampleLlmResponse(), { provider: 'mock', token: TOKEN });
    configure({ provider: 'apayee', apayeeBaseUrl: g.baseUrl, apayeeToken: TOKEN });

    const listed = (await app.inject({ method: 'GET', url: '/api/llm/providers' })).json();
    assert.equal(listed.default, null);
    assert.equal(listed.providers[1].available, false);

    const response = await app.inject(generateRequest());

    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().metadata.provider, 'Apayee');
    assert.equal(g.requests.filter((r) => r.url === '/v1/generate').length, 1);
    assert.equal(g.requests.at(-1).headers.authorization, `Bearer ${TOKEN}`);
  });
});

describe('the provider parameter', () => {
  it('is rejected with 400 when it is not in the allowlist, on every route', async () => {
    const g = await gateway({ provider: 'claude' });
    configure({ apiKey: GEMINI_KEY, apayeeBaseUrl: g.baseUrl });

    for (const bad of [
      'mock',
      'apayee',
      'Claude',
      'claude,gemini',
      '',
      '__proto__',
      'a&provider=b',
    ]) {
      const query = `?provider=${encodeURIComponent(bad)}`;
      const requests = [
        await extractRequest(query),
        generateRequest(query),
        validateRequest(query),
        validateRequest(`${query}&semantic=true`),
      ];

      for (const request of requests) {
        const response = await app.inject(request);
        assert.equal(response.statusCode, 400, `${request.url} accepted ${bad}`);
        assert.equal(response.json().error.code, 'UNKNOWN_PROVIDER');
      }
    }

    const twice = await app.inject(generateRequest('?provider=gemini&provider=claude'));
    assert.equal(twice.statusCode, 400);

    assert.equal(g.requests.length, 0, 'nothing was sent anywhere');
  });
});

describe('routing', () => {
  it('sends "claude" to the gateway, with the server token, and never to Gemini', async () => {
    const g = await gatewayAnswering(sampleLlmResponse(), { token: TOKEN });
    configure({ apiKey: GEMINI_KEY, apayeeBaseUrl: g.baseUrl, apayeeToken: TOKEN });

    const { result: response, calls } = await watchingFetch(() =>
      app.inject(generateRequest('?provider=claude'))
    );

    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().metadata.provider, 'Apayee');
    assert.equal(generatePosts(g), 1);
    assert.equal(g.requests.at(-1).headers.authorization, `Bearer ${TOKEN}`);
    assert.deepEqual(calls, [], 'Gemini was not called');
  });

  it('sends "gemini" to Gemini and never to the gateway, whatever LLM_PROVIDER says', async () => {
    const g = await gateway({ provider: 'claude' });
    configure({ provider: 'apayee', apiKey: GEMINI_KEY, apayeeBaseUrl: g.baseUrl });

    const { calls } = await watchingFetch(() => app.inject(generateRequest('?provider=gemini')));

    assert.equal(calls.length, 1);
    assert.ok(calls[0].startsWith(config.llm.baseUrl), 'the request went to the Gemini endpoint');
    assert.equal(g.requests.length, 0);
  });

  it('gives all three LLM stages the one selected provider', async () => {
    const g = await gateway({
      provider: 'claude',
      generate: (record) => {
        // Each stage is told apart by the schema it sends, so the assertions
        // below are about the three stages and not about request counts.
        const schema = JSON.stringify(record.body.schema);
        const result = schema.includes('issues')
          ? { issues: [] }
          : schema.includes('test_cases')
            ? sampleLlmResponse()
            : {};
        return generateReply(record.body.request_id, result, { provider: 'claude' });
      },
    });
    configure({ apiKey: GEMINI_KEY, apayeeBaseUrl: g.baseUrl });

    const { calls } = await watchingFetch(async () => {
      const extract = await app.inject(await extractRequest('?provider=claude'));
      assert.equal(extract.statusCode, 200, extract.body);
      const afterExtract = generatePosts(g);
      assert.ok(afterExtract >= 1, 'structuring (call 1) reached the gateway');

      const generate = await app.inject(generateRequest('?provider=claude'));
      assert.equal(generate.statusCode, 200, generate.body);
      const afterGenerate = generatePosts(g);
      assert.ok(afterGenerate > afterExtract, 'generation (call 2) reached the gateway');

      const validate = await app.inject(validateRequest('?semantic=true&provider=claude'));
      assert.equal(validate.statusCode, 200, validate.body);
      assert.equal(validate.json().semantic.llm, 'completed');
      assert.ok(generatePosts(g) > afterGenerate, 'the semantic review (call 3) reached it');
    });

    assert.deepEqual(calls, [], 'no stage touched Gemini');
  });

  it('keeps today’s behaviour when no provider is given', async () => {
    const g = await gateway({ provider: 'claude' });
    configure({ provider: 'mock', responses: [sampleLlmResponse()], apayeeBaseUrl: g.baseUrl });

    const response = await app.inject(generateRequest());

    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().metadata.provider, 'Mock');
    assert.equal(g.requests.length, 0, 'the gateway was not even asked about its health');
  });

  it('keeps LLM_PROVIDER=apayee meaning exactly what it meant, with no availability check', async () => {
    // A gateway running mock: selecting "claude" would be refused, but an
    // operator who configured apayee asked for whatever the gateway runs.
    const g = await gatewayAnswering(sampleLlmResponse(), { provider: 'mock' });
    configure({ provider: 'apayee', apayeeBaseUrl: g.baseUrl });

    const response = await app.inject(generateRequest());

    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().metadata.provider, 'Apayee');
    assert.equal(g.count('GET', '/v1/health'), 0);
    assert.equal(generatePosts(g), 1);
  });

  it('changes no global configuration to serve a request', async () => {
    const g = await gatewayAnswering(sampleLlmResponse());
    configure({ apiKey: GEMINI_KEY, apayeeBaseUrl: g.baseUrl });
    const before = { ...config.llm };
    const env = { ...process.env };

    await app.inject(generateRequest('?provider=claude'));

    assert.deepEqual({ ...config.llm }, before);
    assert.deepEqual({ ...process.env }, env);
  });
});

describe('an unavailable choice fails visibly and never falls back', () => {
  async function assertRefused(response, { reasonCode, pattern }) {
    assert.equal(response.statusCode, 503, response.body);
    const { error } = response.json();
    assert.equal(error.code, 'PROVIDER_UNAVAILABLE');
    assert.equal(error.provider, 'claude');
    assert.equal(error.reason_code, reasonCode);
    assert.match(error.message, pattern);
  }

  it('refuses Claude when Apayee is running its mock provider, on all three stages', async () => {
    const g = await gatewayAnswering(sampleLlmResponse(), { provider: 'mock' });
    // A working Gemini key is configured: a fallback would succeed, loudly or not.
    configure({ apiKey: GEMINI_KEY, apayeeBaseUrl: g.baseUrl });

    const { result: responses, calls } = await watchingFetch(async () => [
      await app.inject(await extractRequest('?provider=claude')),
      await app.inject(generateRequest('?provider=claude')),
      await app.inject(validateRequest('?semantic=true&provider=claude')),
    ]);

    for (const response of responses) {
      await assertRefused(response, { reasonCode: 'provider_not_ready', pattern: /mock provider/ });
    }
    assert.equal(generatePosts(g), 0, 'the mock was never sent a document');
    assert.deepEqual(calls, [], 'and Gemini was not used instead');
  });

  it('does not let structuring degrade to deterministic extraction behind a 200', async () => {
    // Structuring absorbs provider failures, so this is the stage where a quiet
    // switch to deterministic extraction would otherwise happen.
    configure({ apiKey: GEMINI_KEY, apayeeBaseUrl: await offlineUrl() });

    const response = await app.inject(await extractRequest('?provider=claude'));

    await assertRefused(response, {
      reasonCode: 'gateway_offline',
      pattern: /not running or not reachable/,
    });
  });

  it('reports an offline Apayee distinctly', async () => {
    configure({ apiKey: GEMINI_KEY, apayeeBaseUrl: await offlineUrl() });
    const response = await app.inject(generateRequest('?provider=claude'));
    await assertRefused(response, {
      reasonCode: 'gateway_offline',
      pattern: /Apayee is not running/,
    });
  });

  it('reports rejected credentials distinctly', async () => {
    const g = await gateway({ token: TOKEN });
    configure({ apiKey: GEMINI_KEY, apayeeBaseUrl: g.baseUrl, apayeeToken: 'x'.repeat(40) });

    const response = await app.inject(generateRequest('?provider=claude'));
    await assertRefused(response, { reasonCode: 'gateway_auth_failed', pattern: /rejected/ });
    assert.ok(!response.body.includes('x'.repeat(40)));
  });

  it('reports a Gemini that is not configured distinctly', async () => {
    configure({ apiKey: '' });
    const response = await app.inject(generateRequest('?provider=gemini'));

    assert.equal(response.statusCode, 503);
    assert.equal(response.json().error.provider, 'gemini');
    assert.equal(response.json().error.reason_code, 'not_configured');
    assert.match(response.json().error.message, /Gemini is not configured/);
  });

  it('refuses a run whose gateway stopped being Claude between two steps', async () => {
    const g = await gatewayAnswering(sampleLlmResponse(), { provider: 'claude' });
    configure({ apiKey: GEMINI_KEY, apayeeBaseUrl: g.baseUrl });

    const first = await app.inject(generateRequest('?provider=claude'));
    assert.equal(first.statusCode, 200, first.body);

    // Apayee restarted with its mock provider while the user read the results.
    g.health = () => healthReply({ provider: 'mock' });
    const sent = generatePosts(g);

    const second = await app.inject(validateRequest('?semantic=true&provider=claude'));

    await assertRefused(second, { reasonCode: 'provider_not_ready', pattern: /mock provider/ });
    assert.equal(generatePosts(g), sent, 'nothing was sent after it changed');
  });

  it('refuses a reply that comes from another provider than the one checked', async () => {
    // Healthy and Claude when asked, then a different provider when called.
    const g = await gateway({
      provider: 'claude',
      generate: (record) =>
        generateReply(record.body.request_id, sampleLlmResponse(), { provider: 'mock' }),
    });
    configure({ apiKey: GEMINI_KEY, apayeeBaseUrl: g.baseUrl });

    const response = await app.inject(generateRequest('?provider=claude'));

    assert.equal(response.statusCode, 503, response.body);
    assert.equal(response.json().error.code, 'LLM_UNAVAILABLE');
    assert.match(response.json().error.message, /different provider/);
  });

  it('tells an execution failure apart from an unavailable provider', async () => {
    const g = await gateway({
      provider: 'claude',
      generate: (record) => ({
        status: 500,
        body: {
          request_id: record.body.request_id,
          status: 'error',
          error: { code: 'INTERNAL_ERROR', retryable: false },
        },
      }),
    });
    configure({ apiKey: GEMINI_KEY, apayeeBaseUrl: g.baseUrl });

    const response = await app.inject(generateRequest('?provider=claude'));

    assert.equal(response.statusCode, 502, response.body);
    assert.equal(response.json().error.code, 'LLM_UNAVAILABLE');
    assert.equal(response.json().error.reason_code, undefined);
  });

  it('does not probe, or fail, a validation that asks for no model', async () => {
    const g = await gateway({ provider: 'mock' });
    configure({ apiKey: GEMINI_KEY, apayeeBaseUrl: g.baseUrl });

    const response = await app.inject(validateRequest('?provider=claude'));

    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().semantic.llm, 'not_requested');
    assert.equal(g.requests.length, 0);
  });
});

/** An address with nothing listening on it. */
async function offlineUrl() {
  return `http://127.0.0.1:${await closedPort()}`;
}
