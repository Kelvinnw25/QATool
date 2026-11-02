import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { createConnection } from 'node:net';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { config } from '../config.js';
import { sampleCanonicalInput } from '../generate/fixtures/sample-input.js';
import { buildApp } from '../app.js';
import { ApayeeProvider } from './apayee.js';
import {
  STAGE_REQUESTS,
  multipart,
  runPipeline,
  startQatool,
  syntheticUpload,
  waitFor,
  withLlm,
} from './fixtures/pipeline-run.js';
import { realisticReply, refundUpload } from './fixtures/realistic-scenario.js';
import { assertRefundScenario } from './fixtures/refund-scenario-checks.js';
import { scriptedReply } from './fixtures/scripted-replies.js';
import { LLM_ERRORS } from './provider.js';

/**
 * QATOOL's real pipeline against the real Apayee, started in this process.
 *
 * Opt-in, like the live Gemini test, because it needs the Apayee project on
 * disk with its dependencies installed:
 *
 *   QATOOL_APAYEE_SMOKE=1 npm run test:apayee
 *   QATOOL_APAYEE_SMOKE=1 APAYEE_DIR=D:\other\Apayee npm run test:apayee
 *
 * Apayee is imported and run, never modified, and it listens on a loopback port
 * the operating system picks, so nothing needs starting by hand and nothing
 * collides with an Apayee that is already running. Its mock provider is the only
 * provider there is: no model, no network beyond this machine.
 *
 * Why scripted replies. Apayee's stock mock answers any schema with the smallest
 * value that satisfies it, which for QATOOL means no requirements and no test
 * cases - a faithful result for a gateway with no model, and not enough to reach
 * the XLSX. So these tests give Apayee's own MockProvider the scripted `output`
 * option it offers for tests, and one test records what the stock mock does.
 * Apayee validates every scripted reply against the schema QATOOL sent, so a
 * reply that does not fit QATOOL's real schema fails here as it would in use.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const apayeeDir = path.resolve(process.env.APAYEE_DIR ?? path.join(here, '../../../Apayee'));

const skip =
  process.env.QATOOL_APAYEE_SMOKE !== '1'
    ? 'Set QATOOL_APAYEE_SMOKE=1 to run against a real Apayee started in this process.'
    : !existsSync(path.join(apayeeDir, 'src/server.js'))
      ? `QATOOL_APAYEE_SMOKE=1 is set but Apayee was not found at ${apayeeDir}. Set APAYEE_DIR.`
      : !existsSync(path.join(apayeeDir, 'node_modules/fastify'))
        ? `Apayee at ${apayeeDir} has no node_modules. Run npm install there first.`
        : false;

const TOKEN = 'smoke-test-token-Bn30Qw71Ke94Rt58Ys22';

const started = [];
afterEach(async () => {
  while (started.length > 0) await started.pop()();
});

async function loadApayee() {
  const fromApayee = (file) => import(pathToFileURL(path.join(apayeeDir, file)).href);
  const [{ startServer }, { MockProvider }] = await Promise.all([
    fromApayee('src/server.js'),
    fromApayee('src/providers/mock/mock.provider.js'),
  ]);
  return { startServer, MockProvider };
}

/** Starts Apayee on a free loopback port; `provider` omitted means its stock mock. */
async function startApayee({ provider, env = {} } = {}) {
  const { startServer, MockProvider } = await loadApayee();
  const server = await startServer({
    env: { APAYEE_PORT: '0', APAYEE_LOG_LEVEL: 'silent', ...env },
    signals: new EventEmitter(),
    provider: provider?.(MockProvider),
  });
  started.push(server.shutdown);
  return server;
}

const settingsFor = (server, overrides = {}) => ({
  provider: 'apayee',
  apayeeBaseUrl: server.address,
  apayeeToken: '',
  apayeeQueueWaitMs: 2000,
  timeoutMs: 20_000,
  ...overrides,
});

const generic = { system: 's', prompt: 'p', schema: { type: 'object' } };

function portIsClosed(address) {
  const { port } = new URL(address);
  return new Promise((resolve) => {
    const socket = createConnection({ port: Number(port), host: '127.0.0.1' });
    socket.once('connect', () => (socket.destroy(), resolve(false)));
    socket.once('error', () => resolve(true));
  });
}

describe('QATOOL pipeline against a real Apayee', { skip, timeout: 120_000 }, () => {
  it('completes the refund scenario: upload, structuring, generation, review, validation, workbook', async () => {
    const apayee = await startApayee({
      provider: (MockProvider) =>
        new MockProvider({ output: (request) => realisticReply(request) }),
    });

    const run = await withLlm(settingsFor(apayee), () =>
      runPipeline({ upload: refundUpload, projectName: 'Refund Service' })
    );

    assertRefundScenario(run, { provider: 'Apayee' });

    const stats = apayee.app.queue.stats();
    assert.equal(stats.succeeded, 3, 'structuring, generation and review all went through Apayee');
    assert.equal(stats.failed + stats.timedOut + stats.cancelled + stats.rejected, 0);
  });

  it('gives the workbook the same rows as the mock does for the same replies', async () => {
    const reference = await withLlm(
      { provider: 'mock', responses: [(request) => realisticReply(request)] },
      () => runPipeline({ upload: refundUpload, projectName: 'Refund Service' })
    );
    const apayee = await startApayee({
      provider: (MockProvider) =>
        new MockProvider({ output: (request) => realisticReply(request) }),
    });

    const run = await withLlm(settingsFor(apayee), () =>
      runPipeline({ upload: refundUpload, projectName: 'Refund Service' })
    );

    assert.deepEqual(run.generated.test_cases, reference.generated.test_cases);
    assert.deepEqual(run.workbook.dataRows, reference.workbook.dataRows);
    assert.deepEqual(run.validated.semantic_warnings, reference.validated.semantic_warnings);
  });

  it('records what Apayee’s stock mock does with QATOOL’s real schemas', async () => {
    // The finding the scripted tests above work around, kept as a test so it is
    // stated, checked and noticed if Apayee's mock ever changes.
    const apayee = await startApayee();
    const app = buildApp();
    try {
      const run = await withLlm(settingsFor(apayee), async () => {
        const extract = await app.inject({
          method: 'POST',
          url: '/api/extract',
          ...(await multipart(syntheticUpload())),
        });
        const generate = await app.inject({
          method: 'POST',
          url: '/api/generate',
          payload: sampleCanonicalInput(),
        });
        return { extract, generate };
      });

      // Every real schema was accepted and answered, so the transport and the
      // schema handling are sound. The answers are empty, and QATOOL says so.
      assert.equal(run.extract.statusCode, 200, run.extract.body);
      assert.equal(run.extract.json().structuring.mode, 'fallback');
      assert.equal(run.generate.statusCode, 422);
      assert.equal(run.generate.json().error.code, 'GENERATION_EMPTY');
    } finally {
      await app.close();
    }
  });

  it('maps a real Apayee timeout and a real queue cancellation', async () => {
    const apayee = await startApayee({
      provider: (MockProvider) => new MockProvider({ latencyMs: 30_000 }),
    });
    const provider = new ApayeeProvider(settingsFor(apayee, { timeoutMs: 150 }));

    const timedOut = await provider.generateJson(generic).catch((e) => e);
    assert.equal(timedOut.code, LLM_ERRORS.TIMEOUT);
    assert.equal(timedOut.statusCode, 504);
    assert.equal(apayee.app.queue.stats().active, 0, 'the queue is free again');

    const controller = new AbortController();
    const slow = new ApayeeProvider(settingsFor(apayee, { timeoutMs: 30_000 }));
    const pending = slow.generateJson({ ...generic, signal: controller.signal }).catch((e) => e);
    while (apayee.app.queue.stats().active === 0) await new Promise((r) => setTimeout(r, 10));
    controller.abort();
    await pending;
    while (apayee.app.queue.stats().active > 0) await new Promise((r) => setTimeout(r, 10));

    assert.equal(apayee.app.queue.stats().cancelled, 1, 'Apayee saw the disconnect and cancelled');
  });

  it('authenticates with the token, and rejects a wrong one', async () => {
    const apayee = await startApayee({ env: { APAYEE_AUTH_TOKEN: TOKEN } });

    const good = await new ApayeeProvider(settingsFor(apayee, { apayeeToken: TOKEN })).generateJson(
      generic
    );
    const missing = await new ApayeeProvider(settingsFor(apayee))
      .generateJson(generic)
      .catch((e) => e);
    const wrong = await new ApayeeProvider(settingsFor(apayee, { apayeeToken: `${TOKEN}x` }))
      .generateJson(generic)
      .catch((e) => e);

    assert.ok(good.data);
    assert.equal(missing.code, LLM_ERRORS.AUTH_FAILED);
    assert.equal(wrong.code, LLM_ERRORS.AUTH_FAILED);
    assert.ok(!wrong.message.includes(TOKEN));
  });

  it('reports a timeout above Apayee’s maximum as a configuration problem', async () => {
    const apayee = await startApayee();

    const error = await new ApayeeProvider(settingsFor(apayee, { timeoutMs: 700_000 }))
      .generateJson(generic)
      .catch((e) => e);

    assert.equal(error.code, LLM_ERRORS.NOT_CONFIGURED);
    assert.match(error.message, /APAYEE_MAX_TIMEOUT_MS/);
  });

  it('shuts Apayee down cleanly, leaving nothing listening', async () => {
    const apayee = await startApayee();
    assert.equal(await portIsClosed(apayee.address), false, 'listening before shutdown');

    await apayee.shutdown();
    started.pop();

    assert.equal(await portIsClosed(apayee.address), true, 'closed after shutdown');
    assert.equal(config.llm.provider === 'apayee', false, 'the real settings were never changed');
  });
});

describe('cancellation reaches the real Apayee queue', { skip, timeout: 120_000 }, () => {
  /** A scripted Apayee whose calls last as long as `hold.latencyMs` says when each starts. */
  async function slowApayee() {
    const hold = { latencyMs: 0 };
    const apayee = await startApayee({
      provider: (MockProvider) =>
        new MockProvider({
          latencyMs: () => hold.latencyMs,
          output: (request) => scriptedReply(request),
        }),
    });
    return { apayee, hold, queue: apayee.app.queue };
  }

  async function qatool() {
    const server = await startQatool();
    started.push(() => server.close());
    return server;
  }

  const idle = (queue) => queue.stats().active === 0 && queue.stats().pending === 0;

  for (const stage of STAGE_REQUESTS) {
    it(`a disconnect during ${stage.name} cancels the active Apayee request and frees the queue`, async () => {
      const { apayee, hold, queue } = await slowApayee();
      const server = await qatool();

      await withLlm(settingsFor(apayee), async () => {
        const { canonical } = await runPipeline();
        const before = queue.stats();

        hold.latencyMs = 30_000;
        const client = new AbortController();
        const abandoned = stage.send(server, client.signal, canonical).catch((e) => e);
        await waitFor(() => queue.stats().active === 1, 'the call to become active in Apayee');

        client.abort();
        await abandoned;
        await waitFor(() => idle(queue), 'Apayee to free its slot');

        const after = queue.stats();
        assert.equal(after.cancelled, before.cancelled + 1, 'counted as a cancellation');
        assert.equal(after.succeeded, before.succeeded, 'nothing completed');
        assert.equal(after.failed + after.timedOut, before.failed + before.timedOut);
        assert.equal(after.abandoned, 0, 'the provider stopped; nothing was left running');

        hold.latencyMs = 0;
        const retry = await stage.send(server, undefined, canonical);
        assert.equal(retry.status, 200, await retry.text());
        assert.equal(
          queue.stats().succeeded,
          before.succeeded + 1,
          'the queue serves the next request'
        );
      });
    });
  }

  it('cancelling a queued request removes it, and the active one finishes untouched', async () => {
    const { apayee, hold, queue } = await slowApayee();
    const server = await qatool();

    await withLlm(settingsFor(apayee), async () => {
      hold.latencyMs = 600;
      const generate = STAGE_REQUESTS[1];

      const active = generate.send(server);
      await waitFor(() => queue.stats().active === 1, 'the first call to become active');
      const leaving = new AbortController();
      const queued = generate.send(server, leaving.signal).catch((e) => e);
      await waitFor(() => queue.stats().pending === 1, 'the second call to queue behind it');

      leaving.abort();
      await queued;
      await waitFor(() => queue.stats().pending === 0, 'Apayee to drop the queued request');
      assert.equal(queue.stats().active, 1, 'the first request is still running');

      const finished = await active;
      assert.equal(finished.status, 200, await finished.text());
      await waitFor(() => idle(queue), 'the queue to empty');

      const stats = queue.stats();
      assert.equal(stats.cancelled, 1);
      assert.equal(stats.succeeded, 1);
      assert.equal(stats.abandoned, 0);

      hold.latencyMs = 0;
      assert.equal((await generate.send(server)).status, 200, 'the queue still serves new work');
    });
  });

  it('cancelling the active request lets the one queued behind it run', async () => {
    const { apayee, hold, queue } = await slowApayee();
    const server = await qatool();

    await withLlm(settingsFor(apayee), async () => {
      const generate = STAGE_REQUESTS[1];

      hold.latencyMs = 30_000;
      const leaving = new AbortController();
      const abandoned = generate.send(server, leaving.signal).catch((e) => e);
      await waitFor(() => queue.stats().active === 1, 'the first call to become active');
      const waiting = generate.send(server);
      await waitFor(() => queue.stats().pending === 1, 'the second call to queue');

      hold.latencyMs = 0; // the second call is fast once it gets its turn
      leaving.abort();
      await abandoned;

      const response = await waiting;
      assert.equal(response.status, 200, await response.text());
      await waitFor(() => idle(queue), 'the queue to empty');

      const stats = queue.stats();
      assert.equal(stats.cancelled, 1);
      assert.equal(stats.succeeded, 1);
      assert.equal(stats.abandoned, 0);
    });
  });

  it('never cancels requests whose clients stay connected', async () => {
    const { apayee, hold, queue } = await slowApayee();
    const server = await qatool();

    await withLlm(settingsFor(apayee), async () => {
      hold.latencyMs = 150;
      const responses = await Promise.all([1, 2, 3].map(() => STAGE_REQUESTS[1].send(server)));

      for (const response of responses) assert.equal(response.status, 200, await response.text());
      const stats = queue.stats();
      assert.equal(stats.succeeded, 3, 'queued and served one after another');
      assert.equal(stats.cancelled, 0);
    });
  });
});
