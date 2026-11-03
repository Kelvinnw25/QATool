import assert from 'node:assert/strict';
import { afterEach, before, beforeEach, describe, it } from 'node:test';

import { buildApp } from '../app.js';
import { config } from '../config.js';
import { buildSampleCanonical } from '../export/fixtures/sample-canonical.js';
import { sampleCanonicalInput, sampleLlmResponse } from '../generate/fixtures/sample-input.js';
import { providerAvailability } from '../llm/catalog.js';
import {
  closedPort,
  generateReply,
  healthReply,
  startFakeGateway,
} from '../llm/fixtures/fake-gateway.js';
import { identityLabel } from './access.js';
import { createAccessFixture, ORIGIN, OWNER, publicSecurity } from './fixtures/access.js';
import { loadSecuritySettings } from './settings.js';

/**
 * Public mode, end to end through the real app.
 *
 * Real RS256 signatures from a key pair made for the test; the public half stands
 * in for Cloudflare's published key set, so nothing leaves the machine. The model
 * gateway is a fake on a loopback port that records every request, which is how
 * "an unauthorised request never reaches Apayee" is checked: not by trusting the
 * code, but by counting what arrived.
 */

const GATEWAY_TOKEN = 'public-mode-gateway-token-Zq81Lw4Rk7Vn2Xd9Bf6Ty3';
const SECRET_FILENAME = 'Acme-Secret-Merger-PRD.docx';

let fixture;
let gateway;
let savedLlm;
const apps = [];

before(async () => {
  fixture = await createAccessFixture();
});

beforeEach(async () => {
  gateway = await startFakeGateway({ token: GATEWAY_TOKEN, provider: 'claude' });
  savedLlm = { ...config.llm };
  Object.assign(config.llm, {
    provider: 'gemini',
    apiKey: '',
    apayeeBaseUrl: gateway.baseUrl,
    apayeeToken: GATEWAY_TOKEN,
  });
  providerAvailability.forget();
});

afterEach(async () => {
  Object.assign(config.llm, savedLlm);
  providerAvailability.forget();
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await gateway.close();
});

async function makeApp(overrides = {}, options = {}) {
  const app = buildApp({
    security: publicSecurity(overrides),
    accessKeys: fixture.keys,
    ...options,
  });
  apps.push(app);
  return app;
}

/** The headers a request from the owner's page carries once Access has let it through. */
async function asOwner(extra = {}, tokenOptions) {
  return {
    'cf-access-jwt-assertion': await fixture.token(tokenOptions),
    origin: ORIGIN,
    ...extra,
  };
}

const body = (response) => response.json();
const errorOf = (response) => response.json().error;

async function multipartRequest(files, { query = '', headers = {} } = {}) {
  const form = new FormData();
  for (const { name, bytes } of files) form.append('documents', new Blob([bytes]), name);
  const wrapped = new Response(form);
  return {
    method: 'POST',
    url: `/api/extract${query}`,
    payload: Buffer.from(await wrapped.arrayBuffer()),
    headers: { 'content-type': wrapped.headers.get('content-type'), ...headers },
  };
}

/** Replaces fetch so a fallback to Gemini would be seen, and cannot leave the machine. */
async function watchingFetch(run) {
  const realFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return new Response('{}', { status: 400 });
  };
  try {
    return { result: await run(), calls };
  } finally {
    globalThis.fetch = realFetch;
  }
}

describe('authentication', () => {
  it('refuses every route without a token, unknown paths included', async () => {
    const app = await makeApp();
    const routes = [
      ['GET', '/api/health'],
      ['GET', '/api/llm/providers'],
      ['GET', '/api/meta/enums'],
      ['GET', '/api/meta/sample-canonical'],
      ['POST', '/api/extract'],
      ['POST', '/api/generate'],
      ['POST', '/api/validate'],
      ['POST', '/api/export'],
      ['GET', '/api/nope'],
      ['GET', '/nope'],
      ['GET', '/'],
    ];

    for (const [method, url] of routes) {
      const response = await app.inject({
        method,
        url,
        headers: { origin: ORIGIN },
        ...(method === 'POST' ? { payload: {} } : {}),
      });
      assert.equal(response.statusCode, 401, `${method} ${url}`);
      assert.equal(errorOf(response).code, 'UNAUTHENTICATED', `${method} ${url}`);
    }
  });

  it('answers /healthz without a token and says nothing about the system', async () => {
    const app = await makeApp();
    const response = await app.inject({ method: 'GET', url: '/healthz' });

    assert.equal(response.statusCode, 200);
    assert.deepEqual(body(response), { status: 'ok' });
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.equal(gateway.requests.length, 0, '/healthz calls nothing');
  });

  it('keeps the fuller /api/health behind the token', async () => {
    const app = await makeApp();
    assert.equal((await app.inject({ method: 'GET', url: '/api/health' })).statusCode, 401);

    const response = await app.inject({
      method: 'GET',
      url: '/api/health',
      headers: await asOwner(),
    });
    assert.equal(response.statusCode, 200);
    assert.equal(body(response).status, 'ok');
  });

  it('is decided before the body is read', async () => {
    const app = await makeApp();
    const response = await app.inject({
      method: 'POST',
      url: '/api/validate',
      headers: { origin: ORIGIN, 'content-type': 'application/json' },
      payload: '{"this is": not json',
    });
    assert.equal(response.statusCode, 401, 'not a 400 from the parser');
  });

  it('refuses a token that is wrong in any single way, always with the same answer', async () => {
    const app = await makeApp();
    const now = Math.floor(Date.now() / 1000);
    const wrong = {
      'wrong audience': { audience: 'some-other-application' },
      'wrong issuer': { issuer: 'https://evil.cloudflareaccess.com' },
      expired: { expiresAt: now - 120 },
      'signed by another key': { signedByStranger: true },
      'algorithm none': { alg: 'none' },
      'algorithm HS256': { alg: 'HS256' },
      'not yet valid': { notBefore: now + 3600 },
      'no email claim': { email: null },
      'unknown key id': { kid: 'not-in-the-key-set' },
    };

    const seen = new Set();
    for (const [label, options] of Object.entries(wrong)) {
      const response = await app.inject({
        method: 'GET',
        url: '/api/health',
        headers: await asOwner({}, options),
      });
      assert.equal(response.statusCode, 401, label);
      const { code, message } = errorOf(response);
      seen.add(`${code}|${message}`);
    }
    assert.equal(seen.size, 1, 'the reason must not be visible to the caller');
  });

  it('refuses tokens that are not tokens', async () => {
    const app = await makeApp();
    for (const token of ['not.a.jwt', 'x', 'a.b.c', 'a'.repeat(9000), ' ', 'Bearer abc']) {
      const response = await app.inject({
        method: 'GET',
        url: '/api/health',
        headers: { 'cf-access-jwt-assertion': token, origin: ORIGIN },
      });
      assert.equal(response.statusCode, 401, token.slice(0, 20));
    }
  });

  it('forbids an authenticated account that is not an owner', async () => {
    const app = await makeApp();
    const response = await app.inject({
      method: 'GET',
      url: '/api/health',
      headers: await asOwner({}, { email: 'someone-else@example.com' }),
    });
    assert.equal(response.statusCode, 403);
    assert.equal(errorOf(response).code, 'FORBIDDEN');
  });

  it('matches the owner email exactly, apart from case', async () => {
    const app = await makeApp();
    const status = async (email) =>
      (
        await app.inject({
          method: 'GET',
          url: '/api/health',
          headers: await asOwner({}, { email }),
        })
      ).statusCode;

    assert.equal(await status(OWNER.toUpperCase()), 200, 'case does not matter');
    for (const near of [
      `${OWNER}.evil.io`,
      `x${OWNER}`,
      ` ${OWNER}`,
      OWNER.replace('@', '+x@'),
      `evil@${OWNER}`,
    ]) {
      assert.equal(await status(near), 403, near);
    }
  });

  it("trusts neither the cookie nor Access's identity headers on their own", async () => {
    const app = await makeApp();
    const token = await fixture.token();

    const cookie = await app.inject({
      method: 'GET',
      url: '/api/health',
      headers: { origin: ORIGIN, cookie: `CF_Authorization=${token}` },
    });
    assert.equal(cookie.statusCode, 401, 'only the header is read');

    const forged = await app.inject({
      method: 'GET',
      url: '/api/health',
      headers: {
        origin: ORIGIN,
        'cf-access-authenticated-user-email': OWNER,
        'x-forwarded-user': OWNER,
      },
    });
    assert.equal(forged.statusCode, 401);
  });

  it('fails closed, with 503, when the signing keys cannot be fetched', async () => {
    for (const code of ['ERR_JWKS_TIMEOUT', 'ERR_JOSE_GENERIC']) {
      const unreachable = async () => {
        throw Object.assign(new Error('fetch failed'), { code });
      };
      const app = await makeApp({}, { accessKeys: unreachable });
      const response = await app.inject({
        method: 'GET',
        url: '/api/health',
        headers: await asOwner(),
      });
      assert.equal(response.statusCode, 503, code);
      assert.equal(errorOf(response).code, 'AUTH_UNAVAILABLE');
    }
  });

  it('does not let an unknown key id through just because keys are present', async () => {
    const app = await makeApp();
    const response = await app.inject({
      method: 'GET',
      url: '/api/health',
      headers: await asOwner({}, { kid: 'attacker-key' }),
    });
    assert.equal(response.statusCode, 401);
  });
});

describe('an unauthorised request never reaches the gateway', () => {
  it('stops every model route and the provider list before Apayee is contacted', async () => {
    const app = await makeApp();
    const upload = await multipartRequest([{ name: 'a.docx', bytes: Buffer.from('x') }], {
      query: '?provider=claude',
      headers: { origin: ORIGIN },
    });

    const attempts = [
      { method: 'GET', url: '/api/llm/providers', headers: { origin: ORIGIN } },
      upload,
      {
        method: 'POST',
        url: '/api/generate?provider=claude',
        headers: { origin: ORIGIN },
        payload: sampleCanonicalInput(),
      },
      {
        method: 'POST',
        url: '/api/validate?semantic=true&provider=claude',
        headers: { origin: ORIGIN },
        payload: buildSampleCanonical(),
      },
    ];

    for (const attempt of attempts) {
      const response = await app.inject(attempt);
      assert.equal(response.statusCode, 401, `${attempt.method} ${attempt.url}`);
    }
    assert.equal(gateway.requests.length, 0, 'Apayee must not have been contacted');
  });

  it('stops a request from an unlisted origin, and from a non-owner, the same way', async () => {
    const app = await makeApp();

    const foreign = await app.inject({
      method: 'GET',
      url: '/api/llm/providers',
      headers: await asOwner({ origin: 'https://evil.example.net' }),
    });
    assert.equal(foreign.statusCode, 403);

    const stranger = await app.inject({
      method: 'GET',
      url: '/api/llm/providers',
      headers: await asOwner({}, { email: 'stranger@example.com' }),
    });
    assert.equal(stranger.statusCode, 403);

    assert.equal(gateway.requests.length, 0);
  });

  it('does reach it for the owner, which proves the counting works', async () => {
    const app = await makeApp();
    const response = await app.inject({
      method: 'GET',
      url: '/api/llm/providers',
      headers: await asOwner(),
    });
    assert.equal(response.statusCode, 200);
    assert.equal(gateway.count('GET', '/v1/health'), 1);
  });
});

describe('origin and CORS', () => {
  it('lets the allowed origin read replies, with credentials, and nothing wider', async () => {
    const app = await makeApp();
    const response = await app.inject({
      method: 'GET',
      url: '/api/health',
      headers: await asOwner(),
    });

    assert.equal(
      response.headers['access-control-allow-origin'],
      ORIGIN,
      'the exact origin, not *'
    );
    assert.equal(response.headers['access-control-allow-credentials'], 'true');
    assert.match(String(response.headers.vary), /Origin/i);
    assert.match(String(response.headers['access-control-expose-headers']), /Content-Disposition/);
    assert.match(String(response.headers['access-control-expose-headers']), /X-QATOOL-Row-Count/);
  });

  it('refuses an origin that is not listed, without CORS headers', async () => {
    const app = await makeApp();
    const response = await app.inject({
      method: 'GET',
      url: '/api/health',
      headers: await asOwner({ origin: 'https://evil.example.net' }),
    });

    assert.equal(response.statusCode, 403);
    assert.equal(errorOf(response).code, 'ORIGIN_FORBIDDEN');
    assert.equal(response.headers['access-control-allow-origin'], undefined);
  });

  it('matches origins exactly: no prefix, suffix, scheme or slash tricks', async () => {
    const app = await makeApp();
    const lookalikes = [
      `${ORIGIN}.evil.io`,
      'https://evil-demo.example.com',
      'https://demo.example.com:8443',
      'http://demo.example.com',
      `${ORIGIN}/`,
      ORIGIN.toUpperCase(),
      'null',
      '',
    ];
    for (const origin of lookalikes) {
      const response = await app.inject({
        method: 'GET',
        url: '/api/health',
        headers: await asOwner({ origin }),
      });
      assert.equal(response.statusCode, 403, JSON.stringify(origin));
      assert.equal(
        response.headers['access-control-allow-origin'],
        undefined,
        JSON.stringify(origin)
      );
    }
  });

  it('refuses a state-changing request that carries no Origin (the CSRF guard)', async () => {
    const app = await makeApp();
    const headers = await asOwner();
    delete headers.origin;

    for (const request of [
      { method: 'POST', url: '/api/validate', payload: buildSampleCanonical() },
      { method: 'POST', url: '/api/export', payload: buildSampleCanonical() },
      await multipartRequest([{ name: 'a.docx', bytes: Buffer.from('x') }]),
    ]) {
      const response = await app.inject({
        ...request,
        headers: { ...headers, ...request.headers },
      });
      assert.equal(response.statusCode, 403, request.url);
      assert.equal(errorOf(response).code, 'ORIGIN_FORBIDDEN', request.url);
    }
  });

  it('still lets a read with no Origin through, which is how same-origin pages and Docker call', async () => {
    const app = await makeApp();
    const headers = await asOwner();
    delete headers.origin;
    assert.equal(
      (await app.inject({ method: 'GET', url: '/api/health', headers })).statusCode,
      200
    );
  });

  it('answers a preflight from the allowed origin with no credentials and no data', async () => {
    const app = await makeApp();
    const response = await app.inject({
      method: 'OPTIONS',
      url: '/api/generate',
      headers: {
        origin: ORIGIN,
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type',
      },
    });

    assert.equal(response.statusCode, 204, 'no token is needed or read for a preflight');
    assert.equal(response.headers['access-control-allow-origin'], ORIGIN);
    assert.equal(response.headers['access-control-allow-credentials'], 'true');
    assert.match(String(response.headers['access-control-allow-methods']), /POST/);
    assert.match(String(response.headers['access-control-allow-headers']), /content-type/i);
    assert.equal(response.body, '');
    assert.equal(gateway.requests.length, 0);
  });

  it('gives a preflight from any other origin nothing to work with', async () => {
    const app = await makeApp();
    const response = await app.inject({
      method: 'OPTIONS',
      url: '/api/generate',
      headers: {
        origin: 'https://evil.example.net',
        'access-control-request-method': 'POST',
      },
    });

    assert.equal(response.headers['access-control-allow-origin'], undefined);
    assert.equal(response.headers['access-control-allow-credentials'], undefined);
    assert.equal(response.body === '' || errorOf(response) !== undefined, true);
  });

  it('does not answer a bare OPTIONS with data', async () => {
    const app = await makeApp();
    const response = await app.inject({
      method: 'OPTIONS',
      url: '/api/health',
      headers: { origin: ORIGIN },
    });
    assert.notEqual(response.statusCode, 200);
    assert.doesNotMatch(response.body, /stateless|"status":"ok"/);
  });

  it("lets the owner's page read a refusal, so it can show a message", async () => {
    const app = await makeApp();
    const response = await app.inject({
      method: 'GET',
      url: '/api/health',
      headers: { origin: ORIGIN },
    });
    assert.equal(response.statusCode, 401);
    assert.equal(response.headers['access-control-allow-origin'], ORIGIN);
  });
});

describe('model providers', () => {
  it('lets the owner choose Claude explicitly, and calls the gateway once', async () => {
    const app = await makeApp();
    const { result, calls } = await watchingFetch(async () =>
      app.inject({
        method: 'POST',
        url: '/api/validate?semantic=true&provider=claude',
        headers: await asOwner(),
        payload: buildSampleCanonical(),
      })
    );

    assert.equal(result.statusCode, 200);
    assert.equal(gateway.count('GET', '/v1/health'), 1, 'availability was checked first');
    assert.equal(gateway.count('POST', '/v1/generate'), 1, 'the chosen provider did the work');
    assert.deepEqual(calls, [], 'nothing fell back to Gemini');
  });

  it('refuses an unavailable Claude with a coarse reason and no fallback', async () => {
    gateway.health = () => healthReply({ provider: 'mock' });
    const app = await makeApp();

    const { result, calls } = await watchingFetch(async () =>
      app.inject({
        method: 'POST',
        url: '/api/validate?semantic=true&provider=claude',
        headers: await asOwner(),
        payload: buildSampleCanonical(),
      })
    );

    assert.equal(result.statusCode, 503);
    const error = errorOf(result);
    assert.equal(error.code, 'PROVIDER_UNAVAILABLE');
    assert.equal(error.provider, 'claude');
    assert.equal(error.reason_code, 'unavailable');
    assert.doesNotMatch(
      JSON.stringify(error),
      /mock|apayee|gateway/i,
      "the gateway's state is not relayed"
    );
    assert.equal(gateway.count('POST', '/v1/generate'), 0);
    assert.deepEqual(calls, [], 'no silent switch to another provider');
  });

  it('does not accept the raw registry name as a choice', async () => {
    const app = await makeApp();
    const response = await app.inject({
      method: 'POST',
      url: '/api/validate?provider=apayee',
      headers: await asOwner(),
      payload: buildSampleCanonical(),
    });
    assert.equal(response.statusCode, 400);
    assert.equal(errorOf(response).code, 'UNKNOWN_PROVIDER');
  });

  it('describes availability without describing the gateway', async () => {
    const offline = await closedPort();
    const results = [];
    for (const setup of [
      () => healthReply({ provider: 'mock' }),
      () => ({ status: 401, body: { status: 'error' } }),
      null, // gateway unreachable
    ]) {
      if (setup) gateway.health = setup;
      else config.llm.apayeeBaseUrl = `http://127.0.0.1:${offline}`;
      providerAvailability.forget();

      const app = await makeApp();
      const response = await app.inject({
        method: 'GET',
        url: '/api/llm/providers',
        headers: await asOwner(),
      });
      assert.equal(response.statusCode, 200);
      results.push(body(response));
    }

    for (const list of results) {
      const claude = list.providers.find((provider) => provider.id === 'claude');
      assert.equal(claude.available, false);
      assert.equal(claude.reason, 'Not available right now.');
      assert.equal(claude.code, 'unavailable');
      assert.equal('default_note' in list, false);
      assert.doesNotMatch(
        JSON.stringify(list.providers.map((p) => [p.reason, p.code])),
        /mock|credential|gateway|offline/i
      );
    }
    // Three different gateway states, one answer: the state is not a side channel.
    assert.deepEqual(new Set(results.map((list) => JSON.stringify(list.providers))).size, 1);
  });

  it('keeps showing the full reasons when not in public mode', async () => {
    gateway.health = () => healthReply({ provider: 'mock' });
    const app = buildApp({ security: loadSecuritySettings({}) });
    apps.push(app);

    const response = await app.inject({ method: 'GET', url: '/api/llm/providers' });
    const claude = body(response).providers.find((provider) => provider.id === 'claude');
    assert.match(claude.reason, /mock provider/);
  });
});

describe('error and log hygiene', () => {
  const failingGenerate = {
    status: 503,
    body: { status: 'error', error: { code: 'PROVIDER_NOT_READY' } },
  };

  it('describes a failed model call by its kind in public mode, and in full locally', async () => {
    gateway.generate = () => failingGenerate;
    const request = (headers) => ({
      method: 'POST',
      url: '/api/generate?provider=claude',
      headers,
      payload: sampleCanonicalInput(),
    });

    const publicApp = await makeApp();
    const hidden = await publicApp.inject(request(await asOwner()));
    assert.equal(hidden.statusCode, 503);
    assert.equal(errorOf(hidden).code, 'LLM_NOT_CONFIGURED');
    assert.doesNotMatch(
      errorOf(hidden).message,
      /apayee|cli|claude|signed out|provider is not ready/i
    );

    providerAvailability.forget();
    const localApp = buildApp({ security: loadSecuritySettings({}) });
    apps.push(localApp);
    const shown = await localApp.inject(request({}));
    assert.match(errorOf(shown).message, /Apayee/, 'locally the full message is kept');
  });

  it("does not repeat a parser's complaint about the request body", async () => {
    const app = await makeApp();
    const response = await app.inject({
      method: 'POST',
      url: '/api/validate',
      headers: await asOwner({ 'content-type': 'application/json' }),
      payload: '{"requirements": "secret-client-text" oops',
    });
    assert.equal(response.statusCode, 400);
    assert.doesNotMatch(response.body, /secret-client-text|Unexpected|JSON at position/);
  });

  it('masks the uploaded filename in an extraction failure, but keeps the field', async () => {
    const app = await makeApp();
    const request = await multipartRequest([
      { name: SECRET_FILENAME, bytes: Buffer.from('plain text, not a document') },
    ]);
    const response = await app.inject({
      ...request,
      headers: { ...request.headers, ...(await asOwner()) },
    });

    assert.equal(response.statusCode, 422);
    const error = errorOf(response);
    assert.equal(error.code, 'EXTRACTION_FAILED');
    assert.doesNotMatch(error.message, /Acme/);
    assert.doesNotMatch(JSON.stringify(error.details.map((d) => d.message)), /Acme/);
    assert.equal(error.details[0].filename, SECRET_FILENAME);
  });

  it('sets no-store and the security headers on every kind of reply', async () => {
    const app = await makeApp();
    const replies = [
      await app.inject({ method: 'GET', url: '/api/health', headers: await asOwner() }),
      await app.inject({ method: 'GET', url: '/api/health' }), // a refusal
      await app.inject({ method: 'GET', url: '/healthz' }),
      await app.inject({
        method: 'POST',
        url: '/api/export',
        headers: await asOwner(),
        payload: buildSampleCanonical(),
      }),
    ];

    for (const response of replies) {
      assert.equal(response.headers['cache-control'], 'no-store', response.statusCode);
      assert.equal(response.headers['x-content-type-options'], 'nosniff');
      assert.equal(response.headers['referrer-policy'], 'no-referrer');
      assert.match(String(response.headers['content-security-policy']), /default-src 'none'/);
      assert.equal(response.headers['x-frame-options'], 'DENY');
    }
  });

  it('logs identity, route and outcome, and none of the secrets or content', async () => {
    const lines = [];
    const app = await makeApp(
      { TRUSTED_PROXY_PEERS: '172.18.0.1' },
      { logger: { level: 'info', stream: { write: (line) => lines.push(line) } } }
    );

    const token = await fixture.token();
    const ok = await app.inject({
      method: 'GET',
      url: '/api/health',
      headers: {
        'cf-access-jwt-assertion': token,
        origin: ORIGIN,
        'cf-connecting-ip': '198.51.100.7',
      },
      remoteAddress: '172.18.0.1',
    });
    assert.equal(ok.statusCode, 200);

    await app.inject({
      method: 'GET',
      url: '/api/health',
      headers: { origin: ORIGIN, 'cf-connecting-ip': '203.0.113.99' },
      remoteAddress: '192.0.2.50', // not a trusted peer: the header is only text
    });

    const upload = await multipartRequest([
      { name: SECRET_FILENAME, bytes: Buffer.from('not a document at all') },
    ]);
    await app.inject({ ...upload, headers: { ...upload.headers, ...(await asOwner()) } });

    const log = lines.join('\n');
    assert.ok(log.length > 0, 'something was logged');

    // What must never appear.
    for (const forbidden of [
      token,
      OWNER,
      SECRET_FILENAME,
      'Acme-Secret',
      GATEWAY_TOKEN,
      'cf-access-jwt-assertion',
    ]) {
      assert.ok(!log.includes(forbidden), `the log contains ${forbidden.slice(0, 12)}...`);
    }

    // What should: who (as a label), what, and where it came from.
    assert.ok(log.includes(identityLabel(OWNER)), 'the identity label is logged');
    assert.match(log, /request_authenticated/);
    assert.match(log, /"reason":"missing_token"/);
    assert.match(log, /"client_ip":"198\.51\.100\.7"/, "a trusted peer's header is believed");
    assert.ok(!log.includes('203.0.113.99'), "an untrusted peer's header is not");
    assert.match(log, /"peer_ip":"192\.0\.2\.50"/);
    assert.match(log, /"run_id":"QATOOL-/);
  });
});

describe('upload limits through the route', () => {
  const limits = {
    UPLOAD_MAX_FILES: '2',
    UPLOAD_MAX_FILE_BYTES: '600',
    UPLOAD_MAX_TOTAL_BYTES: '1000',
  };
  const bytes = (n) => Buffer.alloc(n, 0x41);

  async function post(app, files, headers) {
    const request = await multipartRequest(files);
    return app.inject({
      ...request,
      headers: { ...request.headers, ...(headers ?? (await asOwner())) },
    });
  }

  it('refuses too many files', async () => {
    const app = await makeApp(limits);
    const response = await post(
      app,
      [1, 2, 3].map((i) => ({ name: `f${i}.pdf`, bytes: bytes(10) }))
    );
    assert.equal(response.statusCode, 413);
    assert.equal(errorOf(response).code, 'TOO_MANY_FILES');
  });

  it('refuses a file over the per-file limit', async () => {
    const app = await makeApp(limits);
    const response = await post(app, [{ name: 'big.pdf', bytes: bytes(601) }]);
    assert.equal(response.statusCode, 413);
    assert.equal(errorOf(response).code, 'FILE_TOO_LARGE');
  });

  it('refuses files that are each acceptable but too large together', async () => {
    const app = await makeApp(limits);
    const response = await post(app, [
      { name: 'a.pdf', bytes: bytes(550) },
      { name: 'b.pdf', bytes: bytes(550) },
    ]);
    assert.equal(response.statusCode, 413);
    assert.equal(errorOf(response).code, 'UPLOAD_TOO_LARGE');
  });

  it('closes the connection after refusing, so the rest of the upload is not read', async () => {
    const app = await makeApp(limits);
    const response = await post(app, [{ name: 'big.pdf', bytes: bytes(601) }]);
    assert.match(String(response.headers.connection), /close/i);
  });

  it('refuses an upload whose declared size is far over the total before reading it', async () => {
    const app = await makeApp(limits);
    const response = await post(app, [{ name: 'huge.pdf', bytes: bytes(400_000) }]);
    assert.equal(response.statusCode, 413);
    assert.ok(['UPLOAD_TOO_LARGE', 'FILE_TOO_LARGE'].includes(errorOf(response).code));
  });

  it('does none of this before authentication', async () => {
    const app = await makeApp(limits);
    const response = await post(app, [{ name: 'big.pdf', bytes: bytes(601) }], { origin: ORIGIN });
    assert.equal(
      response.statusCode,
      401,
      'the size is never examined for a caller who is not the owner'
    );
  });

  it('lets a normal upload through to extraction', async () => {
    const app = await makeApp();
    const response = await post(app, [{ name: 'tiny.pdf', bytes: bytes(20) }]);
    // Not a PDF, so extraction fails on the document, not on a limit.
    assert.equal(response.statusCode, 422);
    assert.equal(errorOf(response).code, 'EXTRACTION_FAILED');
  });
});

describe('the whole-API rate, concurrency and the deadline', () => {
  it('limits the request rate per identity and says when to retry', async () => {
    const app = await makeApp({ RATE_LIMIT_PER_MINUTE: '3' });
    const get = async () =>
      app.inject({ method: 'GET', url: '/api/health', headers: await asOwner() });

    for (let i = 0; i < 3; i += 1) assert.equal((await get()).statusCode, 200);
    const limited = await get();
    assert.equal(limited.statusCode, 429);
    assert.equal(errorOf(limited).code, 'RATE_LIMITED');
    assert.ok(Number(limited.headers['retry-after']) >= 1);

    assert.equal(
      (await app.inject({ method: 'GET', url: '/healthz' })).statusCode,
      200,
      'liveness is exempt'
    );
  });

  it('counts no model requests: only rate and concurrency limit them', async () => {
    // There used to be an hourly and a daily budget here. The only quota on the model is the
    // provider's own, so however many requests an owner makes, none is refused for the count.
    const app = await makeApp({ RATE_LIMIT_PER_MINUTE: '0' });
    const generate = async () =>
      app.inject({
        method: 'POST',
        url: '/api/generate?provider=claude',
        headers: await asOwner(),
        payload: sampleCanonicalInput(),
      });
    gateway.generate = (record) => generateReply(record.body.request_id, sampleLlmResponse());

    for (let i = 0; i < 6; i += 1) assert.equal((await generate()).statusCode, 200);

    const validate = await app.inject({
      method: 'POST',
      url: '/api/validate',
      headers: await asOwner(),
      payload: buildSampleCanonical(),
    });
    assert.equal(validate.statusCode, 200);
  });

  it('runs one model call at a time and refuses a second at once when the queue is empty', async () => {
    let release;
    const held = new Promise((resolve) => (release = resolve));
    gateway.generate = async (record) => {
      await held;
      return generateReply(record.body.request_id, sampleLlmResponse());
    };

    const app = await makeApp({ LLM_MAX_CONCURRENT: '1', LLM_QUEUE_MAX: '0' });
    const generate = async () =>
      app.inject({
        method: 'POST',
        url: '/api/generate?provider=claude',
        headers: await asOwner(),
        payload: sampleCanonicalInput(),
      });

    const first = generate();
    while (gateway.count('POST', '/v1/generate') === 0) await new Promise((r) => setTimeout(r, 10));

    const second = await generate();
    assert.equal(second.statusCode, 429);
    assert.equal(errorOf(second).code, 'SERVER_BUSY');
    assert.equal(gateway.count('POST', '/v1/generate'), 1, 'the second never reached Apayee');

    release();
    assert.equal((await first).statusCode, 200, 'the first finishes normally');
  });

  it('stops a call that outlives the deadline and answers 504 before a proxy would', async () => {
    gateway.generate = () => new Promise(() => {});
    const app = await makeApp({ REQUEST_DEADLINE_MS: '300' });

    const started = Date.now();
    const response = await app.inject({
      method: 'POST',
      url: '/api/generate?provider=claude',
      headers: await asOwner(),
      payload: sampleCanonicalInput(),
    });

    assert.equal(response.statusCode, 504);
    assert.equal(errorOf(response).code, 'REQUEST_DEADLINE_EXCEEDED');
    assert.ok(Date.now() - started < 3000);
    assert.equal(gateway.count('POST', '/v1/generate'), 1, 'the call had started');
  });

  it('ends a semantic review that outlives the deadline the same way, not as a soft failure', async () => {
    gateway.generate = () => new Promise(() => {});
    const app = await makeApp({ REQUEST_DEADLINE_MS: '300' });

    const response = await app.inject({
      method: 'POST',
      url: '/api/validate?semantic=true&provider=claude',
      headers: await asOwner(),
      payload: buildSampleCanonical(),
    });

    assert.equal(response.statusCode, 504);
    assert.equal(errorOf(response).code, 'REQUEST_DEADLINE_EXCEEDED');
  });

  it('lets a validation that calls no model finish normally under the same deadline', async () => {
    const app = await makeApp({ REQUEST_DEADLINE_MS: '300' });
    const response = await app.inject({
      method: 'POST',
      url: '/api/validate',
      headers: await asOwner(),
      payload: buildSampleCanonical(),
    });
    assert.equal(response.statusCode, 200);
  });
});

describe('local mode is unchanged', () => {
  it('needs no token, no origin and no limits', async () => {
    const app = buildApp({ security: loadSecuritySettings({}) });
    apps.push(app);

    assert.equal((await app.inject({ method: 'GET', url: '/api/health' })).statusCode, 200);
    assert.equal((await app.inject({ method: 'GET', url: '/healthz' })).statusCode, 200);
    const post = await app.inject({
      method: 'POST',
      url: '/api/export',
      payload: buildSampleCanonical(),
    });
    assert.equal(post.statusCode, 200, 'a POST with no Origin is fine locally');
  });

  it('sends no CORS headers unless origins are configured', async () => {
    const app = buildApp({ security: loadSecuritySettings({}) });
    apps.push(app);
    const response = await app.inject({
      method: 'GET',
      url: '/api/health',
      headers: { origin: 'https://anything.example' },
    });
    assert.equal(response.headers['access-control-allow-origin'], undefined);
    assert.equal(response.statusCode, 200);
  });

  it('serves the same health body as before', async () => {
    const app = buildApp({ security: loadSecuritySettings({}) });
    apps.push(app);
    const health = body(await app.inject({ method: 'GET', url: '/api/health' }));
    assert.equal(health.status, 'ok');
    assert.equal(health.stateless, true);
  });
});
