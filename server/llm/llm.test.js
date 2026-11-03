import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import {
  LLMProvider,
  LlmError,
  LLM_ERRORS,
  availableProviders,
  createProvider,
} from './provider.js';
import { GeminiProvider, toGeminiSchema } from './gemini.js';
import { MockProvider } from './mock.js';
import { redactSecrets } from '../config.js';
import { RESPONSE_SCHEMA } from '../generate/contract.js';

/**
 * The provider boundary, with the network replaced by a stub.
 *
 * Nothing here reaches Google. The transport is `fetch`, so `fetch` is what
 * gets replaced - which also means these tests check the request QATOOL
 * actually puts on the wire, including where the API key is and is not.
 */

const SETTINGS = {
  provider: 'gemini',
  apiKey: 'AIzaTEST-not-a-real-key-000',
  model: 'gemini-3.8-flash',
  baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
  timeoutMs: 5000,
  maxOutputTokens: 4096,
  temperature: null,
};

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Captures the outgoing request and replies with whatever the test wants. */
function stubFetch(reply) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return typeof reply === 'function' ? reply() : reply;
  };
  return calls;
}

function geminiReply(payload, { status = 200 } = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function candidate(json) {
  return {
    candidates: [{ content: { parts: [{ text: JSON.stringify(json) }] }, finishReason: 'STOP' }],
    usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 20, totalTokenCount: 30 },
  };
}

describe('the abstraction', () => {
  it('is a contract, not a suggestion', async () => {
    class Incomplete extends LLMProvider {}
    const provider = new Incomplete({ name: 'Incomplete', model: 'x' });

    await assert.rejects(() => provider.generateJson({}), /must implement generateJson/);
  });

  it('builds the configured provider by name', async () => {
    const provider = await createProvider(SETTINGS);

    assert.ok(provider instanceof GeminiProvider);
    assert.ok(provider instanceof LLMProvider, 'adapters satisfy the interface');
    assert.equal(provider.name, 'Gemini');
  });

  it('refuses a provider nothing implements, and names the ones that exist', async () => {
    const error = await createProvider({ ...SETTINGS, provider: 'wishful' }).catch((e) => e);

    assert.equal(error.code, LLM_ERRORS.NOT_CONFIGURED);
    for (const name of availableProviders()) assert.match(error.message, new RegExp(name));
  });

  it('refuses to construct a provider with no API key', async () => {
    const error = await createProvider({ ...SETTINGS, apiKey: '' }).catch((e) => e);

    assert.equal(error.code, LLM_ERRORS.NOT_CONFIGURED);
    assert.equal(error.statusCode, 500);
    assert.match(error.message, /GEMINI_API_KEY/);
  });

  it('lets the mock provider stand in for a real one', async () => {
    const provider = await createProvider({ provider: 'mock', responses: { hello: true } });

    const { data } = await provider.generateJson({ system: 's', prompt: 'p', schema: {} });
    assert.deepEqual(data, { hello: true });
  });
});

describe('what goes on the wire', () => {
  it('sends the key as a header, never in the URL', async () => {
    const calls = stubFetch(geminiReply(candidate({ ok: true })));
    const provider = new GeminiProvider(SETTINGS);

    await provider.generateJson({ system: 'sys', prompt: 'user', schema: RESPONSE_SCHEMA });

    const [call] = calls;
    assert.ok(!call.url.includes(SETTINGS.apiKey), 'the key is not in the URL');
    assert.ok(!call.url.includes('key='), 'no key query parameter at all');
    assert.equal(call.init.headers['x-goog-api-key'], SETTINGS.apiKey);
  });

  it('asks the provider to enforce JSON', async () => {
    const calls = stubFetch(geminiReply(candidate({ ok: true })));

    await new GeminiProvider(SETTINGS).generateJson({
      system: 'sys',
      prompt: 'user',
      schema: RESPONSE_SCHEMA,
    });

    const { generationConfig } = calls[0].body;
    assert.equal(generationConfig.responseMimeType, 'application/json');
    assert.ok(generationConfig.responseSchema, 'a response schema is sent');
    assert.ok(
      !('temperature' in generationConfig),
      'temperature is left to the model default unless configured'
    );
  });

  it('sends a temperature only when one is explicitly configured', async () => {
    const calls = stubFetch(geminiReply(candidate({ ok: true })));

    await new GeminiProvider({ ...SETTINGS, temperature: 0.7 }).generateJson({
      system: 's',
      prompt: 'p',
      schema: {},
    });

    assert.equal(calls[0].body.generationConfig.temperature, 0.7);
  });

  it('puts the instruction and the prompt where they belong', async () => {
    const calls = stubFetch(geminiReply(candidate({ ok: true })));

    await new GeminiProvider(SETTINGS).generateJson({
      system: 'INSTRUCTION',
      prompt: 'PROMPT',
      schema: {},
    });

    assert.equal(calls[0].body.systemInstruction.parts[0].text, 'INSTRUCTION');
    assert.equal(calls[0].body.contents[0].parts[0].text, 'PROMPT');
  });

  it('returns the parsed JSON and the token usage', async () => {
    stubFetch(geminiReply(candidate({ project: 'x' })));

    const { data, usage } = await new GeminiProvider(SETTINGS).generateJson({
      system: 's',
      prompt: 'p',
      schema: {},
    });

    assert.deepEqual(data, { project: 'x' });
    assert.deepEqual(usage, {
      input_tokens: 10,
      output_tokens: 20,
      thinking_tokens: null,
      total_tokens: 30,
    });
  });

  it('ignores thought parts, which are not the answer', async () => {
    stubFetch(
      geminiReply({
        candidates: [
          {
            content: {
              parts: [
                { text: 'Let me consider the requirements first...', thought: true },
                { text: JSON.stringify({ answer: 1 }) },
              ],
            },
            finishReason: 'STOP',
          },
        ],
      })
    );

    const { data } = await new GeminiProvider(SETTINGS).generateJson({
      system: 's',
      prompt: 'p',
      schema: {},
    });

    assert.deepEqual(data, { answer: 1 });
  });
});

describe('translating the schema to this vendor dialect', () => {
  it('upper-cases types and turns a nullable union into a flag', () => {
    const translated = toGeminiSchema({
      type: 'object',
      properties: { a: { type: 'string' }, b: { type: ['string', 'null'], enum: ['x'] } },
      required: ['a'],
    });

    assert.equal(translated.type, 'OBJECT');
    assert.equal(translated.properties.a.type, 'STRING');
    assert.equal(translated.properties.b.type, 'STRING');
    assert.equal(translated.properties.b.nullable, true);
    assert.deepEqual(translated.required, ['a']);
  });

  it('drops keywords this vendor rejects', () => {
    const translated = toGeminiSchema({
      type: 'object',
      additionalProperties: false,
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      properties: { a: { type: 'string', pattern: '^x$' } },
    });

    assert.ok(!('additionalProperties' in translated));
    assert.ok(!('$schema' in translated));
    assert.ok(!('pattern' in translated.properties.a));
  });

  it('carries the real contract through without losing its shape', () => {
    const translated = toGeminiSchema(RESPONSE_SCHEMA);

    assert.equal(translated.type, 'OBJECT');
    assert.deepEqual(translated.required, ['project', 'test_cases', 'warnings']);

    const testCase = translated.properties.test_cases.items;
    assert.equal(testCase.properties.case_type.type, 'STRING');
    assert.deepEqual(testCase.properties.case_type.enum, ['Positive', 'Negative', 'Edge']);
    assert.equal(testCase.properties.edge_polarity.nullable, true);

    // Conditional, so it is deliberately absent from `required`. Demanding it
    // on every case told the model to pick one of valid|invalid even for a
    // Positive case, which is what broke a live run; the rule that it belongs
    // only to Edge cases lives in applyEdgePolarityRule, not here.
    assert.ok(!testCase.required.includes('edge_polarity'));
    assert.ok(testCase.required.includes('case_type'));

    // case_id and source_references are application-owned; the model is never
    // offered a field for either.
    assert.ok(!('case_id' in testCase.properties));
    assert.ok(!('source_references' in testCase.properties));
  });
});

describe('provider failures become QATOOL errors', () => {
  const statusCases = [
    [401, LLM_ERRORS.AUTH_FAILED, 502],
    [403, LLM_ERRORS.AUTH_FAILED, 502],
    [429, LLM_ERRORS.RATE_LIMITED, 429],
    [404, LLM_ERRORS.NOT_CONFIGURED, 502],
    [500, LLM_ERRORS.UNAVAILABLE, 502],
    [503, LLM_ERRORS.UNAVAILABLE, 503],
  ];

  for (const [status, code, statusCode] of statusCases) {
    it(`maps HTTP ${status} to ${code}`, async () => {
      stubFetch(geminiReply({ error: { message: 'vendor detail' } }, { status }));

      const error = await new GeminiProvider(SETTINGS)
        .generateJson({ system: 's', prompt: 'p', schema: {} })
        .catch((e) => e);

      assert.ok(error instanceof LlmError);
      assert.equal(error.code, code);
      assert.equal(error.statusCode, statusCode);
    });
  }

  it('tells the user a 503 is overload worth waiting out', async () => {
    stubFetch(geminiReply({ error: { status: 'UNAVAILABLE' } }, { status: 503 }));

    const error = await new GeminiProvider(SETTINGS)
      .generateJson({ system: 's', prompt: 'p', schema: {} })
      .catch((e) => e);

    assert.match(error.message, /temporarily overloaded/);
    assert.match(error.message, /wait, then retry/);
  });

  it('does not relay the vendor error body, which can quote the request', async () => {
    stubFetch(
      geminiReply(
        { error: { message: `failed for key ${SETTINGS.apiKey} on document text` } },
        { status: 500 }
      )
    );

    const error = await new GeminiProvider(SETTINGS)
      .generateJson({ system: 's', prompt: 'p', schema: {} })
      .catch((e) => e);

    assert.ok(!error.message.includes(SETTINGS.apiKey));
    assert.ok(!error.message.includes('document text'));
  });

  it('reports a network failure as unavailable', async () => {
    globalThis.fetch = async () => {
      throw new TypeError('fetch failed');
    };

    const error = await new GeminiProvider(SETTINGS)
      .generateJson({ system: 's', prompt: 'p', schema: {} })
      .catch((e) => e);

    assert.equal(error.code, LLM_ERRORS.UNAVAILABLE);
  });

  it('reports a timeout as a timeout', async () => {
    const provider = new GeminiProvider({ ...SETTINGS, timeoutMs: 20 });
    globalThis.fetch = (url, init) =>
      new Promise((resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(init.signal.reason));
      });

    // The provider's timeout is AbortSignal.timeout(), whose timer Node unrefs, so
    // while this test waits on it nothing keeps the event loop alive. The runner then
    // sees "promise still pending, event loop resolved" and cancels this test and
    // every test after it in the file. A referenced timer held for the length of the
    // wait fixes the test's lifecycle only; the 20 ms timeout under test is untouched.
    const holdEventLoopOpen = setTimeout(() => {}, 5000);
    let error;
    try {
      error = await provider.generateJson({ system: 's', prompt: 'p', schema: {} }).catch((e) => e);
    } finally {
      clearTimeout(holdEventLoopOpen);
    }

    assert.equal(error.code, LLM_ERRORS.TIMEOUT);
    assert.equal(error.statusCode, 504);
  });
});

describe('unusable replies', () => {
  it('rejects a reply that is not JSON', async () => {
    stubFetch(
      new Response('Here is the JSON you asked for:', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    );

    const error = await new GeminiProvider(SETTINGS)
      .generateJson({ system: 's', prompt: 'p', schema: {} })
      .catch((e) => e);

    assert.equal(error.code, LLM_ERRORS.MALFORMED_OUTPUT);
  });

  it('rejects text that is not JSON even when the envelope is', async () => {
    stubFetch(
      geminiReply({
        candidates: [
          { content: { parts: [{ text: 'sorry, no JSON today' }] }, finishReason: 'STOP' },
        ],
      })
    );

    const error = await new GeminiProvider(SETTINGS)
      .generateJson({ system: 's', prompt: 'p', schema: {} })
      .catch((e) => e);

    assert.equal(error.code, LLM_ERRORS.MALFORMED_OUTPUT);
  });

  it('calls a truncated reply truncated, not malformed', async () => {
    stubFetch(
      geminiReply({
        candidates: [{ content: { parts: [{ text: '{"project":' }] }, finishReason: 'MAX_TOKENS' }],
      })
    );

    const error = await new GeminiProvider(SETTINGS)
      .generateJson({ system: 's', prompt: 'p', schema: {} })
      .catch((e) => e);

    assert.equal(error.code, LLM_ERRORS.TRUNCATED);
    assert.match(error.message, /LLM_MAX_OUTPUT_TOKENS/);
  });

  it('reports a blocked prompt as a refusal', async () => {
    stubFetch(geminiReply({ promptFeedback: { blockReason: 'SAFETY' } }));

    const error = await new GeminiProvider(SETTINGS)
      .generateJson({ system: 's', prompt: 'p', schema: {} })
      .catch((e) => e);

    assert.equal(error.code, LLM_ERRORS.REFUSED);
  });

  it('reports an empty candidate list', async () => {
    stubFetch(geminiReply({ candidates: [] }));

    const error = await new GeminiProvider(SETTINGS)
      .generateJson({ system: 's', prompt: 'p', schema: {} })
      .catch((e) => e);

    assert.equal(error.code, LLM_ERRORS.MALFORMED_OUTPUT);
  });
});

describe('secrets', () => {
  it('redacts anything key-shaped', () => {
    assert.equal(redactSecrets('token AIzaSyABCDEFGHIJKLMNOP here'), 'token [redacted] here');
    assert.equal(redactSecrets('https://x/y?key=abcdef123456'), 'https://x/y?key=[redacted]');
    assert.equal(redactSecrets('Bearer sk-abcdef1234567890'), 'Bearer [redacted]');
  });

  it('survives an empty or missing input', () => {
    assert.equal(redactSecrets(undefined), '');
    assert.equal(redactSecrets(''), '');
  });

  it('scrubs an LlmError message on construction', () => {
    const error = new LlmError(LLM_ERRORS.AUTH_FAILED, 'rejected AIzaSyABCDEFGHIJKLMNOP', 502);
    assert.ok(!error.message.includes('AIzaSy'));
  });
});

describe('the mock provider', () => {
  it('records what it was asked', async () => {
    const provider = new MockProvider({ responses: { a: 1 } });
    await provider.generateJson({ system: 'S', prompt: 'P', schema: {} });

    assert.equal(provider.calls.length, 1);
    assert.equal(provider.calls[0].prompt, 'P');
  });

  it('plays a script in order and then repeats the last entry', async () => {
    const provider = new MockProvider({ responses: [{ n: 1 }, { n: 2 }] });

    assert.deepEqual((await provider.generateJson({})).data, { n: 1 });
    assert.deepEqual((await provider.generateJson({})).data, { n: 2 });
    assert.deepEqual((await provider.generateJson({})).data, { n: 2 });
  });
});
