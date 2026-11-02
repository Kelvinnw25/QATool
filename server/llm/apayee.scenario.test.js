import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { startFakeApayee } from './fixtures/fake-apayee.js';
import { llmSettingsFor, runPipeline, withLlm } from './fixtures/pipeline-run.js';
import { realisticReply, refundUpload } from './fixtures/realistic-scenario.js';
import { assertRefundScenario, assertSatisfiesSchema } from './fixtures/refund-scenario-checks.js';

/**
 * A realistic, deterministic run of the whole pipeline through the Apayee
 * provider: upload, structuring, generation, semantic review, deterministic
 * validation and the XLSX export.
 *
 * The gateway here is a fake that records what it receives. The same scenario
 * runs against the real Apayee in apayee.smoke.test.js, where Apayee also
 * validates every reply against the schema QATOOL sent.
 */

const open = [];
afterEach(async () => {
  while (open.length > 0) await open.pop().close();
});

const runRefund = () => runPipeline({ upload: refundUpload, projectName: 'Refund Service' });

async function gateway() {
  const fake = await startFakeApayee({
    reply: (record, response, { send, success }) =>
      send(response, 200, success(record, realisticReply(record.body))),
  });
  open.push(fake);
  return fake;
}

/** The same scenario through QATOOL's own mock, recording what the model is asked. */
async function viaMock() {
  const asked = [];
  const run = await withLlm(
    {
      provider: 'mock',
      responses: [
        (request) => {
          asked.push(request);
          return realisticReply(request);
        },
      ],
    },
    runRefund
  );
  return { asked, run };
}

describe('the refund scenario through the Apayee provider', () => {
  it('scripts replies that satisfy the schemas QATOOL really sends', async () => {
    // A validating gateway rejects a reply with a missing required field. QATOOL's
    // own parsing defaults some, so only this - or the opt-in smoke test - notices.
    const asked = [];
    await withLlm(
      {
        provider: 'mock',
        responses: [
          (request) => {
            asked.push(request);
            return realisticReply(request);
          },
        ],
      },
      runRefund
    );

    assert.equal(asked.length, 3);
    for (const request of asked) {
      assertSatisfiesSchema(request.schema, realisticReply(request));
    }
  });

  it('completes the whole pipeline, to a workbook with the generated test cases', async () => {
    const fake = await gateway();

    const run = await withLlm(llmSettingsFor(fake.baseUrl), runRefund);

    assertRefundScenario(run, { provider: 'Apayee' });
    assert.equal(fake.requests.length, 3);
  });

  it('is the same scenario, with the same results, through QATOOL’s own mock', async () => {
    // The scenario's expectations hold for any provider, so a failure in the test
    // above points at the gateway path and a failure here at the scenario itself.
    const { run } = await viaMock();

    assertRefundScenario(run, { provider: 'Mock' });
  });

  it('changes nothing between QATOOL and the model: prompts, schemas and results', async () => {
    const { asked, run: viaMockRun } = await viaMock();
    const fake = await gateway();

    const viaApayee = await withLlm(llmSettingsFor(fake.baseUrl), runRefund);

    assert.equal(asked.length, 3);
    for (const [index, expected] of asked.entries()) {
      const sent = fake.requests[index].body;
      assert.equal(sent.system, expected.system, `system text of call ${index + 1}`);
      assert.equal(sent.prompt, expected.prompt, `prompt of call ${index + 1}`);
      assert.deepEqual(sent.schema, expected.schema, `schema of call ${index + 1}`);
    }

    assert.deepEqual(viaApayee.extracted.requirements, viaMockRun.extracted.requirements);
    assert.deepEqual(viaApayee.extracted.test_points, viaMockRun.extracted.test_points);
    assert.deepEqual(viaApayee.generated.test_cases, viaMockRun.generated.test_cases);
    assert.deepEqual(viaApayee.validated.semantic_warnings, viaMockRun.validated.semantic_warnings);
    assert.deepEqual(viaApayee.workbook.dataRows, viaMockRun.workbook.dataRows);
  });

  it('produces the same workbook every time', async () => {
    const fake = await gateway();

    const first = await withLlm(llmSettingsFor(fake.baseUrl), runRefund);
    const second = await withLlm(llmSettingsFor(fake.baseUrl), runRefund);

    assert.deepEqual(first.workbook.dataRows, second.workbook.dataRows);
  });
});
