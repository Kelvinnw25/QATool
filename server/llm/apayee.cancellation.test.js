import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { sampleCanonicalInput } from '../generate/fixtures/sample-input.js';
import { startFakeApayee } from './fixtures/fake-apayee.js';
import {
  STAGE_REQUESTS,
  llmSettingsFor,
  runPipeline,
  startQatool,
  waitFor,
  withLlm,
} from './fixtures/pipeline-run.js';
import { scriptedReply } from './fixtures/scripted-replies.js';

/**
 * A client closing the connection must stop the model call it was waiting on.
 *
 *   client leaves -> QATOOL route -> AbortSignal -> Apayee adapter
 *                 -> Apayee request closes -> the gateway sees the disconnect
 *
 * These run QATOOL's real server on a real socket against a fake gateway that
 * holds a call open until the test lets it go. "Held open" is how a slow model
 * looks from outside. What the real Apayee then does with the disconnect - free
 * its queue slot - is covered by the opt-in smoke test, which needs its project.
 */

const open = [];
afterEach(async () => {
  while (open.length > 0) await open.pop()();
});

/** A gateway that answers normally unless `holdWhen` says to leave the call open. */
async function holdingGateway() {
  const state = { holdWhen: () => false };
  const fake = await startFakeApayee({
    reply(record, response, { send, success }) {
      if (state.holdWhen(record.body)) return;
      send(response, 200, success(record, scriptedReply(record.body)));
    },
  });
  open.push(() => fake.close());
  return { fake, state };
}

async function qatool() {
  const server = await startQatool();
  open.push(() => server.close());
  return server;
}

const isStructuring = (body) => 'requirements' in body.schema.properties;
const isGeneration = (body) => 'test_cases' in body.schema.properties;
const isReview = (body) => 'issues' in body.schema.properties;

const STAGES = STAGE_REQUESTS.map((stage, index) => ({
  ...stage,
  holds: [isStructuring, isGeneration, isReview][index],
}));

describe('a disconnect stops the model call', () => {
  for (const stage of STAGES) {
    it(`during ${stage.name}: Apayee sees the disconnect, and it is a cancellation, not a failure`, async () => {
      const { fake, state } = await holdingGateway();
      const server = await qatool();

      await withLlm(llmSettingsFor(fake.baseUrl), async () => {
        const { canonical } = await runPipeline();
        const callsBefore = fake.requests.length;

        state.holdWhen = stage.holds;
        const client = new AbortController();
        const pending = stage.send(server, client.signal, canonical).catch((e) => e);
        await waitFor(() => fake.requests.length === callsBefore + 1, 'the call to reach Apayee');

        client.abort();
        const outcome = await pending;

        assert.equal(outcome.name, 'AbortError');
        await waitFor(() => fake.closedByClient.length === 1, 'Apayee to see the disconnect');
        await waitFor(() => server.logged(/REQUEST_CANCELLED/), 'the cancellation to be logged');
        assert.equal(fake.requests.length, callsBefore + 1, 'nothing was retried');

        // The two fail-soft stages must not turn a cancellation into their fallback.
        assert.ok(!server.logged(/deterministic_fallback_used/), 'no deterministic fallback');
        assert.ok(!server.logged(/gemini_1_failed/), 'structuring did not "fail"');
        assert.ok(!server.logged(/gemini_3_failed/), 'the review did not "fail"');
      });
    });

    it(`leaves the service ready for the next ${stage.name} request`, async () => {
      const { fake, state } = await holdingGateway();
      const server = await qatool();

      await withLlm(llmSettingsFor(fake.baseUrl), async () => {
        const { canonical } = await runPipeline();
        state.holdWhen = stage.holds;

        const client = new AbortController();
        const abandoned = stage.send(server, client.signal, canonical).catch((e) => e);
        await waitFor(() => fake.requests.length > 3, 'the call to reach Apayee');
        client.abort();
        await abandoned;
        await waitFor(() => fake.closedByClient.length === 1, 'Apayee to see the disconnect');

        state.holdWhen = () => false;
        const retry = await stage.send(server, undefined, canonical);

        assert.equal(retry.status, 200, await retry.text());
      });
    });
  }
});

describe('a completed request is never cancelled', () => {
  it('runs the whole pipeline over real sockets without Apayee seeing a disconnect', async () => {
    const { fake } = await holdingGateway();
    const server = await qatool();

    await withLlm(llmSettingsFor(fake.baseUrl), async () => {
      const extracted = await (await server.extract()).json();
      const canonical = {
        project: { project_name: 'Gateway Test', sit_scope: [] },
        documents: extracted.documents,
        requirements: extracted.requirements,
        test_cases: [],
        test_points: extracted.test_points,
      };

      const generateResponse = await server.postJson('/api/generate', canonical);
      assert.equal(generateResponse.status, 200);
      const generated = await generateResponse.json();
      const whole = { ...canonical, ...generated };
      delete whole.warnings;
      delete whole.metadata;

      const validated = await (await server.postJson('/api/validate?semantic=true', whole)).json();
      const exported = await server.postJson('/api/export', whole);

      assert.equal(extracted.structuring.mode, 'ai');
      assert.equal(validated.semantic.llm, 'completed');
      assert.equal(exported.status, 200);
      await exported.arrayBuffer();
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(fake.requests.length, 3, 'structuring, generation and review');
    assert.equal(fake.closedByClient.length, 0, 'no call was cut off');
    assert.ok(!server.logged(/REQUEST_CANCELLED/));
  });

  it('is not cancelled by the client disconnecting after the answer arrived', async () => {
    const { fake } = await holdingGateway();
    const server = await qatool();

    await withLlm(llmSettingsFor(fake.baseUrl), async () => {
      const response = await server.extract();
      await response.json();
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    assert.equal(fake.closedByClient.length, 0);
    assert.ok(!server.logged(/REQUEST_CANCELLED/));
  });

  it('keeps a slow call running while its client stays connected', async () => {
    const server = await qatool();
    const slowGateway = await startFakeApayee({
      reply: (record, response, { send, success }) => {
        setTimeout(() => send(response, 200, success(record, scriptedReply(record.body))), 250);
      },
    });
    open.push(() => slowGateway.close());

    await withLlm(llmSettingsFor(slowGateway.baseUrl), async () => {
      const response = await server.postJson('/api/generate', sampleCanonicalInput());

      assert.equal(response.status, 200, await response.text());
    });

    assert.equal(slowGateway.closedByClient.length, 0);
    assert.ok(!server.logged(/REQUEST_CANCELLED/));
  });
});

describe('cancelling one request leaves others alone', () => {
  it('only the request whose client left is cancelled', async () => {
    const { fake, state } = await holdingGateway();
    const server = await qatool();

    await withLlm(llmSettingsFor(fake.baseUrl), async () => {
      const held = [];
      state.holdWhen = (body) => {
        if (!isGeneration(body)) return false;
        held.push(body.request_id);
        return held.length === 1; // the first generation hangs, the second answers
      };

      const leaving = new AbortController();
      const first = server
        .postJson('/api/generate', sampleCanonicalInput(), leaving.signal)
        .catch((e) => e);
      await waitFor(() => held.length === 1, 'the first call');
      const staying = server.postJson('/api/generate', sampleCanonicalInput());
      await waitFor(() => held.length === 2, 'the second call');

      leaving.abort();
      const [outcomeOfFirst, outcomeOfSecond] = await Promise.all([first, staying]);

      assert.equal(outcomeOfFirst.name, 'AbortError');
      assert.equal(outcomeOfSecond.status, 200);
      await waitFor(() => fake.closedByClient.length === 1, 'exactly one disconnect');
      assert.equal(fake.closedByClient[0].body.request_id, held[0]);
    });
  });
});

describe('the same cancellation for Gemini, the default provider', () => {
  const GEMINI = {
    provider: 'gemini',
    apiKey: 'AIzaTEST-not-a-real-key-000',
    model: 'gemini-3.8-flash',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    timeoutMs: 20_000,
    maxOutputTokens: 1024,
    temperature: null,
  };

  /** Replaces fetch for Gemini's host only; the test client's own calls pass through. */
  function stubGemini(onCall) {
    const realFetch = globalThis.fetch;
    const calls = [];
    globalThis.fetch = (input, init) => {
      if (!String(input?.url ?? input).startsWith(GEMINI.baseUrl)) return realFetch(input, init);
      calls.push(init);
      return onCall(init);
    };
    open.push(() => {
      globalThis.fetch = realFetch;
    });
    return calls;
  }

  const geminiJson = (data) =>
    new Response(
      JSON.stringify({
        candidates: [
          { content: { parts: [{ text: JSON.stringify(data) }] }, finishReason: 'STOP' },
        ],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    );

  it('aborts the Gemini request when the client disconnects', async () => {
    let signal = null;
    const calls = stubGemini(
      (init) =>
        new Promise((resolve, reject) => {
          signal = init.signal;
          init.signal.addEventListener('abort', () => reject(init.signal.reason));
        })
    );
    const server = await qatool();

    await withLlm(GEMINI, async () => {
      const client = new AbortController();
      const pending = server
        .postJson('/api/generate', sampleCanonicalInput(), client.signal)
        .catch((e) => e);
      await waitFor(() => calls.length === 1, 'the Gemini call to start');

      client.abort();
      await pending;

      await waitFor(() => signal.aborted, 'Gemini’s request to be aborted');
      await waitFor(() => server.logged(/REQUEST_CANCELLED/), 'the cancellation to be logged');
    });
  });

  it('is unchanged for a client that stays: the call completes normally and is not aborted', async () => {
    const calls = stubGemini(() => geminiJson(realisticReplyForGemini()));
    const server = await qatool();

    await withLlm(GEMINI, async () => {
      const response = await server.postJson('/api/generate', sampleCanonicalInput());

      assert.equal(response.status, 200, await response.text());
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].signal.aborted, false);
    assert.ok(!server.logged(/REQUEST_CANCELLED/));
  });

  function realisticReplyForGemini() {
    // The generation reply for the fixture project, in the shape Gemini returns it.
    return {
      project: {
        project_description: 'Scripted description.',
        project_summary: 'Scripted summary.',
        qa_guidance: 'Scripted guidance.',
        sit_scope: ['A: a', 'B: b', 'C: c'],
        project_background: 'Scripted background.',
      },
      test_cases: [
        {
          requirement_ids: ['REQ-001'],
          section: 'Validation',
          test_case: 'Verify BIC Code is mandatory.',
          case_type: 'Negative',
          priority: 'High',
          type: 'Functional',
          expected_result: 'The transaction is rejected with error ADMI 002.',
          confidence: 'High',
          warnings: [],
        },
      ],
      warnings: [],
    };
  }
});
