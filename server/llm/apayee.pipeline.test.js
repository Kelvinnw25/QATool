import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { buildApp } from '../app.js';
import { config } from '../config.js';
import { startFakeApayee } from './fixtures/fake-apayee.js';
import { multipart, runPipeline, syntheticUpload, withLlm } from './fixtures/pipeline-run.js';
import { scriptedReply } from './fixtures/scripted-replies.js';

/**
 * QATOOL's real routes, with LLM_PROVIDER=apayee, against a fake gateway.
 *
 * This is the whole existing pipeline - extract (which holds the structuring
 * call), generate, validate with the semantic review, export - not a stand-in
 * for it. Only the model is replaced, and it is replaced the same way twice: by
 * QATOOL's own mock provider and by the Apayee adapter talking to a gateway
 * that answers identically. If the adapter changed a prompt, a schema, a reply
 * or anything downstream of them, the two runs would differ.
 */

const open = [];
afterEach(async () => {
  while (open.length > 0) await open.pop().close();
});

async function gateway(reply) {
  const fake = await startFakeApayee({
    reply:
      reply ??
      ((record, response, { send, success }) =>
        send(response, 200, success(record, scriptedReply(record.body)))),
  });
  open.push(fake);
  return fake;
}

const apayeeSettings = (fake, overrides = {}) => ({
  provider: 'apayee',
  apayeeBaseUrl: fake.baseUrl,
  apayeeToken: '',
  apayeeQueueWaitMs: 1000,
  timeoutMs: 10_000,
  ...overrides,
});

/** The same pipeline through QATOOL's own mock, recording what it was asked. */
async function runThroughMock() {
  const seen = [];
  const run = await withLlm(
    {
      provider: 'mock',
      responses: [
        (request) => {
          seen.push(request);
          return scriptedReply(request);
        },
      ],
    },
    runPipeline
  );
  return { seen, run };
}

describe('the full pipeline through the Apayee provider', () => {
  it('routes all three LLM stages through the gateway, in pipeline order', async () => {
    const fake = await gateway();

    const run = await withLlm(apayeeSettings(fake), runPipeline);

    assert.equal(run.generate.statusCode, 200, run.generate.body);
    assert.equal(fake.requests.length, 3, 'structure, generate and semantic review');

    const schemas = fake.requests.map((request) => Object.keys(request.body.schema.properties));
    assert.ok(schemas[0].includes('requirements'), 'call 1 is requirement structuring');
    assert.ok(schemas[1].includes('test_cases'), 'call 2 is test case generation');
    assert.deepEqual(schemas[2], ['issues'], 'call 3 is the semantic review');

    for (const request of fake.requests) {
      assert.equal(request.body.task, 'generic');
      assert.equal(request.url, '/v1/generate');
    }
  });

  it('reports Apayee as the provider at every stage, and not as a fallback', async () => {
    const fake = await gateway();

    const run = await withLlm(apayeeSettings(fake), runPipeline);

    assert.equal(
      run.extracted.structuring.mode,
      'ai',
      'structuring was not the deterministic fallback'
    );
    assert.equal(run.extracted.structuring.provider, 'Apayee');
    assert.equal(run.generated.metadata.provider, 'Apayee');
    assert.equal(run.validated.semantic.llm, 'completed');
  });

  it('sends the same prompts and schemas that QATOOL’s own mock is asked', async () => {
    const { seen } = await runThroughMock();
    const fake = await gateway();

    await withLlm(apayeeSettings(fake), runPipeline);

    assert.equal(seen.length, 3);
    assert.equal(fake.requests.length, 3);
    for (const [index, asked] of seen.entries()) {
      const sent = fake.requests[index].body;
      assert.equal(sent.system, asked.system, `system text of call ${index + 1}`);
      assert.equal(sent.prompt, asked.prompt, `prompt of call ${index + 1}`);
      assert.deepEqual(sent.schema, asked.schema, `schema of call ${index + 1}`);
    }
  });

  it('produces the same requirements, test cases and workbook as the mock', async () => {
    const { run: viaMock } = await runThroughMock();
    const fake = await gateway();

    const viaApayee = await withLlm(apayeeSettings(fake), runPipeline);

    assert.equal(viaApayee.exported.statusCode, 200, viaApayee.exported.body);
    assert.deepEqual(viaApayee.extracted.requirements, viaMock.extracted.requirements);
    assert.deepEqual(viaApayee.generated.test_cases, viaMock.generated.test_cases);
    assert.deepEqual(viaApayee.generated.project, viaMock.generated.project);
    assert.deepEqual(viaApayee.workbook.dataRows, viaMock.workbook.dataRows);
    assert.equal(
      viaApayee.exported.headers['x-qatool-row-count'],
      viaMock.exported.headers['x-qatool-row-count']
    );
  });

  it('keeps requirement references intact from extraction to the workbook', async () => {
    const fake = await gateway();

    const run = await withLlm(apayeeSettings(fake), runPipeline);

    const requirementIds = run.extracted.requirements.map((r) => r.requirement_id);
    assert.ok(requirementIds.length >= 2);
    for (const testCase of run.generated.test_cases) {
      assert.ok(testCase.requirement_ids.length > 0);
      for (const id of testCase.requirement_ids) assert.ok(requirementIds.includes(id), id);
      assert.ok(testCase.source_references.length > 0, 'traceability is derived, and present');
    }
    assert.equal(run.validated.valid, true, JSON.stringify(run.validated.schema_issues));
    assert.equal(run.workbook.dataRows.length, run.generated.test_cases.length);
  });

  it('does not send the token anywhere but the Authorization header', async () => {
    const token = 'pipeline-test-token-Hx47Pq92Lm58Ve13Dc60';
    const fake = await startFakeApayee({
      token,
      reply: (record, response, { send, success }) =>
        send(response, 200, success(record, scriptedReply(record.body))),
    });
    open.push(fake);

    const run = await withLlm(apayeeSettings(fake, { apayeeToken: token }), runPipeline);

    assert.equal(run.generate.statusCode, 200, run.generate.body);
    for (const request of fake.requests) {
      assert.equal(request.headers.authorization, `Bearer ${token}`);
      assert.ok(!request.raw.includes(token));
    }
    for (const response of [run.extract, run.generate, run.validate, run.exported]) {
      assert.ok(!response.body?.includes?.(token), 'no response carries the token');
    }
  });
});

describe('failures through the gateway behave like any other provider’s', () => {
  const unreachable = async () => {
    const stopped = await startFakeApayee({ reply() {} });
    const settings = apayeeSettings(stopped);
    await stopped.close();
    return settings;
  };

  it('structuring fails soft: extraction still succeeds on the deterministic fallback', async () => {
    const settings = await unreachable();
    const app = buildApp();
    open.push({ close: () => app.close() });

    const response = await withLlm(settings, async () =>
      app.inject({
        method: 'POST',
        url: '/api/extract',
        ...(await multipart(syntheticUpload())),
      })
    );

    assert.equal(response.statusCode, 200, response.body);
    const body = response.json();
    assert.equal(body.structuring.mode, 'fallback');
    assert.ok(body.requirements.length > 0);
    assert.ok(
      body.warnings.some((warning) => warning.code === 'AI_REQUIREMENT_STRUCTURING_FAILED')
    );
  });

  it('generation fails with a controlled error and leaves the request alone', async () => {
    const settings = await unreachable();
    const app = buildApp();
    open.push({ close: () => app.close() });
    const { sampleCanonicalInput } = await import('../generate/fixtures/sample-input.js');

    const response = await withLlm(settings, () =>
      app.inject({ method: 'POST', url: '/api/generate', payload: sampleCanonicalInput() })
    );

    assert.equal(response.statusCode, 502);
    assert.equal(response.json().error.code, 'LLM_UNAVAILABLE');
    assert.match(response.json().error.message, /Apayee/);
  });

  it('the semantic review is reported, not thrown, when the gateway is busy', async () => {
    const fake = await gateway();
    const first = await withLlm(apayeeSettings(fake), runPipeline);
    const { canonical } = first;
    const busy = await gateway((record, response, { send, failure }) =>
      send(response, 503, failure('PROVIDER_UNAVAILABLE'))
    );
    const app = buildApp();
    open.push({ close: () => app.close() });

    const response = await withLlm(apayeeSettings(busy), () =>
      app.inject({ method: 'POST', url: '/api/validate?semantic=true', payload: canonical })
    );

    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().semantic.llm, 'failed');
    assert.equal(response.json().semantic.error.code, 'LLM_UNAVAILABLE');
  });

  it('an authentication failure is reported as such and never echoes the token', async () => {
    const token = 'pipeline-test-token-Hx47Pq92Lm58Ve13Dc60';
    const fake = await startFakeApayee({
      token: 'a-different-token-Zz99Yy88Xx77Ww66Vv55',
      reply() {},
    });
    open.push(fake);
    const app = buildApp();
    open.push({ close: () => app.close() });
    const { sampleCanonicalInput } = await import('../generate/fixtures/sample-input.js');

    const response = await withLlm(apayeeSettings(fake, { apayeeToken: token }), () =>
      app.inject({ method: 'POST', url: '/api/generate', payload: sampleCanonicalInput() })
    );

    assert.equal(response.statusCode, 502);
    assert.equal(response.json().error.code, 'LLM_AUTH_FAILED');
    assert.ok(!response.body.includes(token));
  });

  it('a reply with no usable test cases is the existing GENERATION_EMPTY, not a new failure', async () => {
    // What a gateway that can only satisfy the schema minimally would return.
    const fake = await gateway((record, response, { send, success }) => {
      const reply = scriptedReply(record.body);
      if (reply.test_cases) reply.test_cases = [];
      send(response, 200, success(record, reply));
    });
    const app = buildApp();
    open.push({ close: () => app.close() });
    const { sampleCanonicalInput } = await import('../generate/fixtures/sample-input.js');

    const response = await withLlm(apayeeSettings(fake), () =>
      app.inject({ method: 'POST', url: '/api/generate', payload: sampleCanonicalInput() })
    );

    assert.equal(response.statusCode, 422);
    assert.equal(response.json().error.code, 'GENERATION_EMPTY');
  });
});

describe('selecting the provider', () => {
  it('leaves the other providers working in the same process', async () => {
    const { run } = await runThroughMock();

    assert.equal(run.generate.statusCode, 200, run.generate.body);
    assert.equal(run.generated.metadata.provider, 'Mock');
  });

  it('restores the settings it changed, so the default is still Gemini’s key check', async () => {
    const before = { ...config.llm };
    const fake = await gateway();

    await withLlm(apayeeSettings(fake), async () => {});

    assert.deepEqual({ ...config.llm }, before);
  });
});
