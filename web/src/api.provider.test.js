import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { api } from './api.js';

/**
 * What the browser puts on the wire. The server reads the model from the query
 * string, so the URLs are the contract. Without a choice they must be exactly
 * what they were before models could be chosen.
 */

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function stubFetch() {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify({}), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  return calls;
}

const project = { project: {}, documents: [], requirements: [], test_cases: [] };
const file = new File(['x'], 'prd.docx');

describe('the provider reaches all three LLM requests', () => {
  it('adds ?provider= to extract, generate and a semantic validate', async () => {
    const calls = stubFetch();

    await api.extract([file], { provider: 'claude' });
    await api.generate(project, [], { provider: 'claude' });
    await api.validate(project, { semantic: true, provider: 'claude' });

    assert.deepEqual(
      calls.map((call) => call.url),
      [
        '/api/extract?provider=claude',
        '/api/generate?provider=claude',
        '/api/validate?semantic=true&provider=claude',
      ]
    );
  });

  it('uses the same model for every call it is given it for', async () => {
    const calls = stubFetch();

    for (const provider of ['gemini', 'claude']) {
      await api.extract([file], { provider });
      await api.generate(project, [], { provider });
      await api.validate(project, { semantic: true, provider });
    }

    const models = calls.map((call) => new URL(call.url, 'http://x').searchParams.get('provider'));
    assert.deepEqual(models, ['gemini', 'gemini', 'gemini', 'claude', 'claude', 'claude']);
  });

  it('adds it to a plain validate too, so the server can reject a typo', async () => {
    const calls = stubFetch();
    await api.validate(project, { provider: 'gemini' });
    assert.equal(calls[0].url, '/api/validate?provider=gemini');
  });
});

describe('without a choice, nothing changes', () => {
  it('sends the URLs it always sent', async () => {
    const calls = stubFetch();

    await api.extract([file]);
    await api.generate(project);
    await api.validate(project);
    await api.validate(project, { semantic: true });
    await api.extract([file], { provider: null });
    await api.generate(project, [], { provider: null });
    await api.validate(project, { semantic: true, provider: null });

    assert.deepEqual(
      calls.map((call) => call.url),
      [
        '/api/extract',
        '/api/generate',
        '/api/validate',
        '/api/validate?semantic=true',
        '/api/extract',
        '/api/generate',
        '/api/validate?semantic=true',
      ]
    );
  });
});

describe('discovery', () => {
  it('asks the backend which models exist; it does not hard-code any', async () => {
    const calls = stubFetch();
    await api.providers();

    assert.equal(calls[0].url, '/api/llm/providers');
    assert.equal(calls[0].init.method, 'GET');
  });
});
