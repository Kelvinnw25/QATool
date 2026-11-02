import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { config, redactSecrets } from '../config.js';
import { classifyLlmError, LLM_ERROR_CATEGORIES } from '../lib/trace.js';
import { RESPONSE_SCHEMA } from '../generate/contract.js';
import { ApayeeProvider, validateApayeeSettings } from './apayee.js';
import { startFakeApayee } from './fixtures/fake-apayee.js';
import { GeminiProvider } from './gemini.js';
import { MockProvider } from './mock.js';
import {
  LLMProvider,
  LlmError,
  LLM_ERRORS,
  availableProviders,
  createProvider,
} from './provider.js';

/**
 * The Apayee adapter against a fake gateway on a loopback port.
 *
 * The transport is node:http, so there is nothing to stub: the adapter makes a
 * real request and the fake records exactly what arrived. The suite's network
 * guard covers http as well as fetch, so a mistake here cannot leave the machine.
 */

const TOKEN = 'unit-test-token-Zq81Lw4Rk7Vn2Xd9Bf6Ty3';

const SETTINGS = {
  provider: 'apayee',
  apayeeBaseUrl: 'http://127.0.0.1:4100',
  apayeeToken: '',
  apayeeQueueWaitMs: 200,
  timeoutMs: 5000,
};

const REQUEST = { system: 'INSTRUCTION', prompt: 'PROMPT', schema: RESPONSE_SCHEMA };

const open = [];
afterEach(async () => {
  while (open.length > 0) await open.pop().close();
});

async function gateway(options) {
  const fake = await startFakeApayee(options);
  open.push(fake);
  return fake;
}

function providerFor(fake, overrides = {}) {
  return new ApayeeProvider({ ...SETTINGS, apayeeBaseUrl: fake.baseUrl, ...overrides });
}

const answer =
  (result) =>
  (record, response, { send, success }) =>
    send(response, 200, success(record, result));

describe('what goes on the wire', () => {
  it('posts the request to /v1/generate with the prompt, system text and schema intact', async () => {
    const fake = await gateway({ reply: answer({ ok: true }) });

    await providerFor(fake).generateJson(REQUEST);

    const [call] = fake.requests;
    assert.equal(call.method, 'POST');
    assert.equal(call.url, '/v1/generate');
    assert.equal(call.headers['content-type'], 'application/json');
    assert.equal(call.body.system, 'INSTRUCTION');
    assert.equal(call.body.prompt, 'PROMPT');
    assert.deepEqual(call.body.schema, RESPONSE_SCHEMA, 'the schema is not translated or trimmed');
    assert.equal(call.body.task, 'generic');
  });

  it('sends only the fields Apayee accepts', async () => {
    const fake = await gateway({ reply: answer({ ok: true }) });

    await providerFor(fake).generateJson(REQUEST);

    assert.deepEqual(Object.keys(fake.requests[0].body).sort(), [
      'prompt',
      'request_id',
      'schema',
      'system',
      'task',
      'timeout_ms',
    ]);
  });

  it('bounds the call with LLM_TIMEOUT_MS as Apayee’s execution budget', async () => {
    const fake = await gateway({ reply: answer({ ok: true }) });

    await providerFor(fake, { timeoutMs: 123_456 }).generateJson(REQUEST);

    assert.equal(fake.requests[0].body.timeout_ms, 123_456);
  });

  it('gives every call its own request id, in the shape Apayee accepts', async () => {
    const fake = await gateway({ reply: answer({ ok: true }) });
    const provider = providerFor(fake);

    for (let call = 0; call < 5; call += 1) await provider.generateJson(REQUEST);

    const ids = fake.requests.map((request) => request.body.request_id);
    assert.equal(new Set(ids).size, 5);
    for (const id of ids) assert.match(id, /^[A-Za-z0-9._:-]{1,128}$/);
  });

  it('does not send a prompt that is large, or alter it', async () => {
    const fake = await gateway({ reply: answer({ ok: true }) });
    const prompt = `${'REQ-001 must hold. '.repeat(100_000)}END`;

    await providerFor(fake).generateJson({ ...REQUEST, prompt });

    assert.equal(fake.requests[0].body.prompt, prompt);
  });

  it('keeps a path prefix, for a gateway behind a reverse proxy', async () => {
    const fake = await gateway({ prefix: '/apayee', reply: answer({ ok: true }) });

    await providerFor(fake, { apayeeBaseUrl: `${fake.baseUrl}/` }).generateJson(REQUEST);

    assert.equal(fake.requests[0].url, '/apayee/v1/generate');
  });

  it('makes one request per call and never retries a failure', async () => {
    const fake = await gateway({
      reply: (record, response, { send, failure }) =>
        send(response, 503, failure('PROVIDER_UNAVAILABLE')),
    });

    await providerFor(fake)
      .generateJson(REQUEST)
      .catch(() => {});

    assert.equal(fake.requests.length, 1);
  });
});

describe('the reply', () => {
  it('maps result to data, and usage to QATOOL’s shape', async () => {
    const fake = await gateway({ reply: answer({ project: 'x', list: [1, 2] }) });

    const reply = await providerFor(fake).generateJson(REQUEST);

    assert.deepEqual(reply.data, { project: 'x', list: [1, 2] });
    assert.deepEqual(reply.usage, {
      input_tokens: 11,
      output_tokens: 22,
      thinking_tokens: null,
      total_tokens: 33,
    });
  });

  it('accepts an array result, which a schema may describe', async () => {
    const fake = await gateway({ reply: answer([{ a: 1 }]) });

    const { data } = await providerFor(fake).generateJson(REQUEST);

    assert.deepEqual(data, [{ a: 1 }]);
  });

  it('reports unknown usage as null, never as zero', async () => {
    const fake = await gateway({
      reply: (record, response, { send, success }) => {
        const body = success(record, { ok: true });
        delete body.metadata.usage;
        send(response, 200, body);
      },
    });

    const { usage } = await providerFor(fake).generateJson(REQUEST);

    assert.deepEqual(usage, {
      input_tokens: null,
      output_tokens: null,
      thinking_tokens: null,
      total_tokens: null,
    });
  });
});

describe('Apayee errors become QATOOL errors', () => {
  const cases = [
    ['UNAUTHORIZED', 401, LLM_ERRORS.AUTH_FAILED, 502],
    ['QUEUE_FULL', 429, LLM_ERRORS.RATE_LIMITED, 429],
    ['PROVIDER_TIMEOUT', 504, LLM_ERRORS.TIMEOUT, 504],
    ['QUEUE_TIMEOUT', 503, LLM_ERRORS.TIMEOUT, 504],
    ['INVALID_PROVIDER_RESPONSE', 502, LLM_ERRORS.MALFORMED_OUTPUT, 502],
    ['PROVIDER_UNAVAILABLE', 503, LLM_ERRORS.UNAVAILABLE, 503],
    ['PROVIDER_NOT_READY', 503, LLM_ERRORS.NOT_CONFIGURED, 503],
    ['PROVIDER_RATE_LIMITED', 429, LLM_ERRORS.RATE_LIMITED, 429],
    ['SERVICE_SHUTTING_DOWN', 503, LLM_ERRORS.UNAVAILABLE, 503],
    ['REQUEST_CANCELLED', 499, LLM_ERRORS.UNAVAILABLE, 502],
    ['INTERNAL_ERROR', 500, LLM_ERRORS.UNAVAILABLE, 502],
    ['INVALID_REQUEST', 400, LLM_ERRORS.NOT_CONFIGURED, 502],
    ['INVALID_SCHEMA', 400, LLM_ERRORS.NOT_CONFIGURED, 502],
    ['UNSUPPORTED_TASK', 400, LLM_ERRORS.NOT_CONFIGURED, 502],
    ['FORBIDDEN_ORIGIN', 403, LLM_ERRORS.NOT_CONFIGURED, 502],
    ['NOT_FOUND', 404, LLM_ERRORS.NOT_CONFIGURED, 502],
    ['DUPLICATE_REQUEST_ID', 409, LLM_ERRORS.NOT_CONFIGURED, 502],
    ['REQUEST_TOO_LARGE', 413, LLM_ERRORS.NOT_CONFIGURED, 502],
    ['UNSUPPORTED_MEDIA_TYPE', 415, LLM_ERRORS.NOT_CONFIGURED, 502],
  ];

  for (const [apayeeCode, httpStatus, code, statusCode] of cases) {
    it(`maps ${apayeeCode} to ${code}`, async () => {
      const fake = await gateway({
        reply: (record, response, { send, failure }) =>
          send(response, httpStatus, failure(apayeeCode)),
      });

      const error = await providerFor(fake)
        .generateJson(REQUEST)
        .catch((e) => e);

      assert.ok(error instanceof LlmError, String(error));
      assert.equal(error.code, code);
      assert.equal(error.statusCode, statusCode);
    });
  }

  it('does not relay the message Apayee sent', async () => {
    const fake = await gateway({
      reply: (record, response, { send, failure }) =>
        send(
          response,
          400,
          failure('INVALID_REQUEST', {
            error: {
              code: 'INVALID_REQUEST',
              message: 'echoed: PRD-CONTENT-CANARY',
              retryable: false,
            },
          })
        ),
    });

    const error = await providerFor(fake)
      .generateJson(REQUEST)
      .catch((e) => e);

    assert.ok(!error.message.includes('PRD-CONTENT-CANARY'));
    assert.match(error.message, /INVALID_REQUEST/);
  });

  it('points a rejected timeout at its likely cause', async () => {
    const fake = await gateway({
      reply: (record, response, { send, failure }) =>
        send(response, 400, failure('INVALID_REQUEST')),
    });

    const error = await providerFor(fake)
      .generateJson(REQUEST)
      .catch((e) => e);

    assert.match(error.message, /APAYEE_MAX_TIMEOUT_MS/);
  });

  it('classifies failures the way the pipeline traces them', async () => {
    const down = await startFakeApayee({ reply() {} });
    const baseUrl = down.baseUrl;
    await down.close();
    const busy = await gateway({
      reply: (record, response, { send, failure }) =>
        send(response, 503, failure('PROVIDER_UNAVAILABLE')),
    });

    const unreachable = await new ApayeeProvider({ ...SETTINGS, apayeeBaseUrl: baseUrl })
      .generateJson(REQUEST)
      .catch((e) => e);
    const overloaded = await providerFor(busy)
      .generateJson(REQUEST)
      .catch((e) => e);

    assert.equal(classifyLlmError(unreachable), LLM_ERROR_CATEGORIES.NETWORK_ERROR);
    assert.equal(classifyLlmError(overloaded), LLM_ERROR_CATEGORIES.UNAVAILABLE);
  });

  it('does not tell the operator to wait out a provider that is not ready or is at its limit', async () => {
    for (const [apayeeCode, httpStatus, pattern] of [
      ['PROVIDER_NOT_READY', 503, /Waiting will not fix this/],
      ['PROVIDER_RATE_LIMITED', 429, /do not retry straight away/],
    ]) {
      const fake = await gateway({
        reply: (record, response, { send, failure }) =>
          send(response, httpStatus, failure(apayeeCode)),
      });

      const error = await providerFor(fake)
        .generateJson(REQUEST)
        .catch((e) => e);

      assert.match(error.message, pattern, apayeeCode);
      assert.doesNotMatch(error.message, /overloaded|within a few minutes/i, apayeeCode);
    }
  });

  it('handles an unknown Apayee code by its HTTP status', async () => {
    const fake = await gateway({
      reply: (record, response, { send, failure }) => send(response, 429, failure('SOMETHING_NEW')),
    });

    const error = await providerFor(fake)
      .generateJson(REQUEST)
      .catch((e) => e);

    assert.equal(error.code, LLM_ERRORS.RATE_LIMITED);
  });

  it('handles a non-JSON error from something in front of Apayee', async () => {
    const fake = await gateway({
      reply: (record, response, { send }) => send(response, 502, '<html>Bad gateway</html>'),
    });

    const error = await providerFor(fake)
      .generateJson(REQUEST)
      .catch((e) => e);

    assert.equal(error.code, LLM_ERRORS.UNAVAILABLE);
    assert.ok(!error.message.includes('Bad gateway'));
  });

  it('treats a bare 401 or 403 as a credentials problem', async () => {
    for (const status of [401, 403]) {
      const fake = await gateway({
        reply: (record, response, { send }) => send(response, status, 'denied'),
      });

      const error = await providerFor(fake)
        .generateJson(REQUEST)
        .catch((e) => e);

      assert.equal(error.code, LLM_ERRORS.AUTH_FAILED, String(status));
    }
  });
});

describe('unusable replies', () => {
  const malformed = {
    'text that is not JSON': (record, response, { send }) => send(response, 200, 'ok'),
    'a JSON array in place of the envelope': (record, response, { send }) =>
      send(response, 200, '[]'),
    'an envelope without a status': (record, response, { send }) =>
      send(response, 200, { request_id: record.body.request_id, result: {} }),
    'a result that is a string': (record, response, { send, success }) =>
      send(response, 200, success(record, '{"ok":true}')),
    'a result that is null': (record, response, { send, success }) =>
      send(response, 200, success(record, null)),
    'an answer to a different request': (record, response, { send, success }) =>
      send(response, 200, { ...success(record, {}), request_id: 'someone-else' }),
    'a success envelope on a non-200 status': (record, response, { send, success }) =>
      send(response, 202, success(record, {})),
    'an error envelope with no error object': (record, response, { send }) =>
      send(response, 200, { status: 'error' }),
  };

  for (const [name, reply] of Object.entries(malformed)) {
    it(`rejects ${name}`, async () => {
      const fake = await gateway({ reply });

      const error = await providerFor(fake)
        .generateJson(REQUEST)
        .catch((e) => e);

      assert.ok(error instanceof LlmError, String(error));
      assert.equal(error.code, LLM_ERRORS.MALFORMED_OUTPUT);
      assert.equal(error.statusCode, 502);
    });
  }

  it('reports a reply cut off mid-body as unavailable', async () => {
    const fake = await gateway({
      reply: (record, response) => {
        response.writeHead(200, { 'content-type': 'application/json', 'content-length': '5000' });
        response.write('{"request_id":');
        setTimeout(() => response.socket.destroy(), 10);
      },
    });

    const error = await providerFor(fake)
      .generateJson(REQUEST)
      .catch((e) => e);

    assert.equal(error.code, LLM_ERRORS.UNAVAILABLE);
    assert.equal(error.statusCode, 502);
  });

  it('stops reading a reply that is far too large', async () => {
    const fake = await gateway({
      reply: (record, response) => {
        response.writeHead(200, { 'content-type': 'application/json' });
        const chunk = Buffer.alloc(1024 * 1024, 0x20);
        const write = () => {
          for (let sent = 0; sent < 40 && !response.destroyed; sent += 1) response.write(chunk);
        };
        write();
        response.end();
      },
    });

    const error = await providerFor(fake)
      .generateJson(REQUEST)
      .catch((e) => e);

    assert.equal(error.code, LLM_ERRORS.MALFORMED_OUTPUT);
    assert.match(error.message, /larger than QATOOL will read/);
  });
});

describe('connection failures', () => {
  it('reports Apayee not running as unavailable, and says where it looked', async () => {
    const stopped = await startFakeApayee({ reply() {} });
    const baseUrl = stopped.baseUrl;
    await stopped.close();

    const error = await new ApayeeProvider({ ...SETTINGS, apayeeBaseUrl: baseUrl })
      .generateJson(REQUEST)
      .catch((e) => e);

    assert.equal(error.code, LLM_ERRORS.UNAVAILABLE);
    assert.equal(error.statusCode, 502);
    assert.match(error.message, /ECONNREFUSED/);
    assert.ok(error.message.includes(baseUrl.replace(/\/$/, '')));
  });

  it('reports a connection that Apayee drops without replying', async () => {
    const fake = await gateway({ reply: (record, response) => response.socket.destroy() });

    const error = await providerFor(fake)
      .generateJson(REQUEST)
      .catch((e) => e);

    assert.equal(error.code, LLM_ERRORS.UNAVAILABLE);
    assert.equal(error.statusCode, 502);
  });
});

describe('timeout', () => {
  it('gives up when Apayee does not answer, and reports a timeout', async () => {
    const fake = await gateway({ reply() {} });

    const started = Date.now();
    const error = await providerFor(fake, { timeoutMs: 40, apayeeQueueWaitMs: 40 })
      .generateJson(REQUEST)
      .catch((e) => e);

    assert.equal(error.code, LLM_ERRORS.TIMEOUT);
    assert.equal(error.statusCode, 504);
    assert.ok(Date.now() - started < 2000, 'the deadline, not a default, ended the call');
  });

  it('closes the connection when it gives up, so Apayee can cancel the work', async () => {
    const fake = await gateway({ reply() {} });

    await providerFor(fake, { timeoutMs: 30, apayeeQueueWaitMs: 30 })
      .generateJson(REQUEST)
      .catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 50));

    assert.equal(fake.closedByClient.length, 1);
  });

  it('allows queue time on top of the execution budget', async () => {
    const fake = await gateway({
      reply: (record, response, { send, success }) => {
        setTimeout(() => send(response, 200, success(record, { ok: true })), 120);
      },
    });

    // Slower than timeout_ms alone, inside timeout_ms plus the queue allowance.
    const reply = await providerFor(fake, { timeoutMs: 60, apayeeQueueWaitMs: 400 }).generateJson(
      REQUEST
    );

    assert.deepEqual(reply.data, { ok: true });
  });

  it('reports a timeout when the deadline fires while the reply is arriving', async () => {
    const fake = await gateway({
      reply: (record, response) => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.write('{"request_id":');
      },
    });

    const error = await providerFor(fake, { timeoutMs: 40, apayeeQueueWaitMs: 40 })
      .generateJson(REQUEST)
      .catch((e) => e);

    assert.equal(error.code, LLM_ERRORS.TIMEOUT);
  });
});

describe('cancellation', () => {
  it('stops when the caller aborts, and tells Apayee by closing the connection', async () => {
    const fake = await gateway({ reply() {} });
    const controller = new AbortController();

    const pending = providerFor(fake).generateJson({ ...REQUEST, signal: controller.signal });
    while (fake.requests.length === 0) await new Promise((resolve) => setTimeout(resolve, 5));
    controller.abort();
    const error = await pending.catch((e) => e);
    await new Promise((resolve) => setTimeout(resolve, 50));

    assert.ok(error instanceof LlmError);
    assert.equal(error.code, LLM_ERRORS.UNAVAILABLE);
    assert.match(error.message, /cancelled/);
    assert.equal(fake.closedByClient.length, 1);
  });

  it('makes no request at all when the signal is already aborted', async () => {
    const fake = await gateway({ reply: answer({ ok: true }) });

    const error = await providerFor(fake)
      .generateJson({ ...REQUEST, signal: AbortSignal.abort() })
      .catch((e) => e);
    await new Promise((resolve) => setTimeout(resolve, 30));

    assert.match(error.message, /cancelled/);
    assert.equal(fake.requests.length, 0);
  });

  it('is unaffected by a signal that never fires', async () => {
    const fake = await gateway({ reply: answer({ ok: true }) });

    const reply = await providerFor(fake).generateJson({
      ...REQUEST,
      signal: new AbortController().signal,
    });

    assert.deepEqual(reply.data, { ok: true });
  });
});

describe('the bearer token', () => {
  it('is sent when configured, and the gateway accepts it', async () => {
    const fake = await gateway({ token: TOKEN, reply: answer({ ok: true }) });

    const reply = await providerFor(fake, { apayeeToken: TOKEN }).generateJson(REQUEST);

    assert.deepEqual(reply.data, { ok: true });
    assert.equal(fake.requests[0].headers.authorization, `Bearer ${TOKEN}`);
  });

  it('is not sent when none is configured', async () => {
    const fake = await gateway({ reply: answer({ ok: true }) });

    await providerFor(fake).generateJson(REQUEST);

    assert.equal(fake.requests[0].headers.authorization, undefined);
  });

  it('is never in the request body', async () => {
    const fake = await gateway({ token: TOKEN, reply: answer({ ok: true }) });

    await providerFor(fake, { apayeeToken: TOKEN }).generateJson(REQUEST);

    assert.ok(!fake.requests[0].raw.includes(TOKEN));
  });

  it('a wrong token is reported as an authentication failure without echoing it', async () => {
    const fake = await gateway({ token: TOKEN, reply: answer({ ok: true }) });
    const wrong = `${TOKEN}-wrong`;

    const error = await providerFor(fake, { apayeeToken: wrong })
      .generateJson(REQUEST)
      .catch((e) => e);

    assert.equal(error.code, LLM_ERRORS.AUTH_FAILED);
    assert.ok(!JSON.stringify(error.toJSON()).includes(wrong));
    assert.ok(!error.message.includes(wrong));
  });

  it('is scrubbed from any message by redactSecrets', () => {
    const original = config.llm.apayeeToken;
    config.llm.apayeeToken = TOKEN;
    try {
      assert.equal(redactSecrets(`failed with ${TOKEN} inside`), 'failed with [redacted] inside');
      const error = new LlmError(LLM_ERRORS.AUTH_FAILED, `rejected ${TOKEN}`, 502);
      assert.ok(!error.message.includes(TOKEN));
    } finally {
      config.llm.apayeeToken = original;
    }
  });

  it('leaves redactSecrets alone when no token is set', () => {
    assert.equal(redactSecrets('nothing to hide'), 'nothing to hide');
  });
});

describe('configuration is checked', () => {
  const good = { ...SETTINGS };
  const rejects = (overrides, pattern) =>
    assert.throws(
      () => validateApayeeSettings({ ...good, ...overrides }),
      (error) => {
        assert.ok(error instanceof LlmError);
        assert.equal(error.code, LLM_ERRORS.NOT_CONFIGURED);
        assert.equal(error.statusCode, 500);
        assert.match(error.message, pattern);
        return true;
      }
    );

  it('accepts the documented default', () => {
    const checked = validateApayeeSettings(good);
    assert.equal(checked.endpoint.href, 'http://127.0.0.1:4100/v1/generate');
  });

  it('accepts localhost and IPv6 loopback without a token', () => {
    for (const url of ['http://localhost:4100', 'http://[::1]:4100', 'http://127.0.0.2:4100']) {
      assert.doesNotThrow(() => validateApayeeSettings({ ...good, apayeeBaseUrl: url }), url);
    }
  });

  it('rejects an unparsable or unsupported URL', () => {
    rejects({ apayeeBaseUrl: 'not a url' }, /APAYEE_BASE_URL is not a valid URL/);
    rejects({ apayeeBaseUrl: '' }, /APAYEE_BASE_URL/);
    rejects({ apayeeBaseUrl: 'ftp://127.0.0.1:4100' }, /http:\/\/ or https:\/\//);
  });

  it('rejects credentials, a query string or a fragment in the URL, without quoting them', () => {
    rejects(
      { apayeeBaseUrl: 'http://user:secretpw@127.0.0.1:4100' },
      /must not contain credentials/
    );
    rejects({ apayeeBaseUrl: 'http://127.0.0.1:4100?token=abc' }, /query string/);
    rejects({ apayeeBaseUrl: 'http://127.0.0.1:4100#frag' }, /query string or fragment/);

    try {
      validateApayeeSettings({ ...good, apayeeBaseUrl: 'http://user:secretpw@127.0.0.1:4100' });
    } catch (error) {
      assert.ok(!error.message.includes('secretpw'));
    }
  });

  it('requires a token for any machine other than this one', () => {
    for (const url of [
      'http://192.168.1.20:4100',
      'http://apayee.internal:4100',
      'https://gw.example',
    ]) {
      rejects({ apayeeBaseUrl: url }, /needs APAYEE_TOKEN/);
    }
    assert.doesNotThrow(() =>
      validateApayeeSettings({
        ...good,
        apayeeBaseUrl: 'http://192.168.1.20:4100',
        apayeeToken: TOKEN,
      })
    );
  });

  it('is not fooled by a host that merely starts like a loopback address', () => {
    for (const url of ['http://127.0.0.1.example.com:4100', 'http://localhost.example.com:4100']) {
      rejects({ apayeeBaseUrl: url }, /needs APAYEE_TOKEN/);
    }
  });

  it('rejects a token that cannot be sent as a header, without quoting it', () => {
    rejects({ apayeeToken: 'has a space' }, /APAYEE_TOKEN contains/);
    rejects({ apayeeToken: 'line\r\nbreak' }, /APAYEE_TOKEN contains/);
    rejects({ apayeeToken: 'tökén' }, /APAYEE_TOKEN contains/);
  });

  it('rejects timeouts that are unusable', () => {
    rejects({ timeoutMs: 0 }, /LLM_TIMEOUT_MS/);
    rejects({ timeoutMs: -5 }, /LLM_TIMEOUT_MS/);
    rejects({ timeoutMs: Number.NaN }, /LLM_TIMEOUT_MS/);
    rejects({ apayeeQueueWaitMs: -1 }, /APAYEE_QUEUE_WAIT_MS/);
    rejects({ timeoutMs: 2_000_000_000, apayeeQueueWaitMs: 2_000_000_000 }, /too large/);
  });

  it('is checked when the provider is constructed', async () => {
    const error = await createProvider({ ...good, apayeeBaseUrl: 'nope' }).catch((e) => e);

    assert.equal(error.code, LLM_ERRORS.NOT_CONFIGURED);
  });
});

describe('the registry', () => {
  it('builds the Apayee provider by name', async () => {
    const provider = await createProvider(SETTINGS);

    assert.ok(provider instanceof ApayeeProvider);
    assert.ok(provider instanceof LLMProvider, 'it satisfies the same interface');
    assert.equal(provider.name, 'Apayee');
    assert.equal(typeof provider.model, 'string');
  });

  it('lists apayee alongside the existing providers', () => {
    assert.deepEqual(availableProviders().sort(), ['apayee', 'gemini', 'mock']);
  });

  it('still builds Gemini and the mock exactly as before', async () => {
    const gemini = await createProvider({
      provider: 'gemini',
      apiKey: 'AIzaTEST-not-a-real-key-000',
      model: 'gemini-3.8-flash',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      timeoutMs: 5000,
    });
    const mock = await createProvider({ provider: 'mock', responses: { hello: true } });

    assert.ok(gemini instanceof GeminiProvider);
    assert.ok(mock instanceof MockProvider);
    assert.deepEqual((await mock.generateJson({})).data, { hello: true });
  });

  it('names apayee when an unknown provider is requested', async () => {
    const error = await createProvider({ provider: 'wishful' }).catch((e) => e);

    assert.match(error.message, /apayee/);
  });
});

describe('default configuration', () => {
  const root = fileURLToPath(new URL('../..', import.meta.url));

  /** A fresh process, so this reads the real defaults and not a test's edits. */
  function settingsWith(env) {
    const { LLM_PROVIDER, APAYEE_BASE_URL, APAYEE_TOKEN, APAYEE_QUEUE_WAIT_MS, ...clean } =
      process.env;
    const script =
      "import('./server/config.js').then(({config}) => console.log(JSON.stringify(config.llm)))";
    return JSON.parse(
      execFileSync(process.execPath, ['-e', script], {
        cwd: root,
        env: { ...clean, ...env },
        encoding: 'utf8',
      })
    );
  }

  it('selects Gemini when LLM_PROVIDER is not set', () => {
    assert.equal(settingsWith({}).provider, 'gemini');
  });

  it('selects Apayee, Gemini or the mock by name alone', () => {
    for (const provider of ['apayee', 'gemini', 'mock']) {
      assert.equal(settingsWith({ LLM_PROVIDER: provider }).provider, provider);
    }
  });

  it('defaults to the port Apayee listens on, with no token', () => {
    const llm = settingsWith({});

    assert.equal(llm.apayeeBaseUrl, 'http://127.0.0.1:4100');
    assert.equal(llm.apayeeToken, '');
    assert.equal(llm.apayeeQueueWaitMs, 60_000);
  });

  it('reads the Apayee settings from the environment', () => {
    const llm = settingsWith({
      APAYEE_BASE_URL: ' http://10.0.0.5:4100 ',
      APAYEE_TOKEN: TOKEN,
      APAYEE_QUEUE_WAIT_MS: '90000',
    });

    assert.equal(llm.apayeeBaseUrl, 'http://10.0.0.5:4100');
    assert.equal(llm.apayeeToken, TOKEN);
    assert.equal(llm.apayeeQueueWaitMs, 90_000);
  });

  it('treats a blank APAYEE_BASE_URL as unset', () => {
    assert.equal(settingsWith({ APAYEE_BASE_URL: '  ' }).apayeeBaseUrl, 'http://127.0.0.1:4100');
  });
});
