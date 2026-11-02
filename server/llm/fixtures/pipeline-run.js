import { Writable } from 'node:stream';

import { buildApp } from '../../app.js';
import { config } from '../../config.js';
import { inspectWorkbook } from '../../export/inspect.js';
import { buildDocx } from '../../extract/fixtures/build.js';
import { sampleCanonicalInput } from '../../generate/fixtures/sample-input.js';

/**
 * Drives QATOOL's real routes end to end, for tests that swap the model.
 *
 * Shared by the fake-gateway tests and the opt-in smoke test against the real
 * Apayee, so both exercise exactly the same pipeline.
 */

/**
 * Renders a FormData into the raw bytes and headers inject() needs, from one
 * Response so the multipart boundary matches the payload.
 */
export async function multipart(form) {
  const response = new Response(form);
  return {
    payload: Buffer.from(await response.arrayBuffer()),
    headers: { 'content-type': response.headers.get('content-type') },
  };
}

/** A synthetic document. Nothing here is, or resembles, a real PRD. */
export function syntheticUpload() {
  const form = new FormData();
  form.append(
    'documents',
    new Blob([
      buildDocx([
        { heading: 'Business Rules', level: 1 },
        {
          text: 'Transactions from a Suspended participant must be rejected with reason code U253.',
        },
        { text: 'A transfer missing a mandatory BIC code must be rejected with code ADMI 002.' },
      ]),
    ]),
    'PRD Synthetic.docx'
  );
  return form;
}

/**
 * Runs the body with these LLM settings, then restores the real ones. The
 * registry is switched by config alone, which is how an operator switches it.
 */
export async function withLlm(settings, body) {
  const original = { ...config.llm };
  Object.assign(config.llm, settings);
  try {
    return await body();
  } finally {
    for (const key of Object.keys(config.llm)) delete config.llm[key];
    Object.assign(config.llm, original);
  }
}

/** The canonical project the browser would hold after extraction. */
export function canonicalFrom(extracted, projectName = 'Gateway Test') {
  return {
    project: { project_name: projectName, sit_scope: [] },
    documents: extracted.documents,
    requirements: extracted.requirements,
    test_cases: [],
    test_points: extracted.test_points,
  };
}

/**
 * extract (which holds the structuring call) -> generate -> validate with the
 * semantic review -> export. Stops after generate when generate does not succeed.
 */
export async function runPipeline({ upload = syntheticUpload, projectName } = {}) {
  const app = buildApp();
  try {
    const extract = await app.inject({
      method: 'POST',
      url: '/api/extract',
      ...(await multipart(upload())),
    });
    if (extract.statusCode !== 200) throw new Error(`extract failed: ${extract.body}`);
    const extracted = extract.json();

    const input = canonicalFrom(extracted, projectName);
    const generate = await app.inject({ method: 'POST', url: '/api/generate', payload: input });
    const generated = generate.json();

    const result = { extract, extracted, generate, generated };
    if (generate.statusCode !== 200) return result;

    const canonical = { ...input, ...generated };
    delete canonical.warnings;
    delete canonical.metadata;

    const validate = await app.inject({
      method: 'POST',
      url: '/api/validate?semantic=true',
      payload: canonical,
    });
    const exported = await app.inject({ method: 'POST', url: '/api/export', payload: canonical });

    return {
      ...result,
      canonical,
      validate,
      validated: validate.json(),
      exported,
      workbook: exported.statusCode === 200 ? inspectWorkbook(exported.rawPayload) : null,
    };
  } finally {
    await app.close();
  }
}

/** LLM settings that select Apayee at this address, with short test timeouts. */
export function llmSettingsFor(baseUrl, overrides = {}) {
  return {
    provider: 'apayee',
    apayeeBaseUrl: baseUrl,
    apayeeToken: '',
    apayeeQueueWaitMs: 2000,
    timeoutMs: 20_000,
    ...overrides,
  };
}

/** Polls, rather than sleeping for a guessed time. */
export async function waitFor(condition, label, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

/**
 * QATOOL's real server on a real loopback port, with its log captured.
 *
 * inject() cannot show a client leaving: there is no socket to close. A listening
 * server and a client that really disconnects is the only faithful test of
 * cancellation.
 */
export async function startQatool() {
  let logs = '';
  const stream = new Writable({
    write(chunk, _encoding, done) {
      logs += chunk;
      done();
    },
  });

  const app = buildApp({ logger: { level: 'info', stream } });
  const baseUrl = await app.listen({ host: '127.0.0.1', port: 0 });

  return {
    app,
    baseUrl,
    logs: () => logs,
    logged: (pattern) => pattern.test(logs),
    // After a client aborts, the test's fetch client parks a pre-opened idle
    // connection until its own keep-alive timeout (about 4 s), and a graceful close
    // waits for it. Nothing is in flight by now, so end them all.
    close: async () => {
      app.server.closeAllConnections();
      await app.close();
    },

    extract: (signal) =>
      fetch(`${baseUrl}/api/extract`, { method: 'POST', body: syntheticUpload(), signal }),
    postJson: (route, payload, signal) =>
      fetch(`${baseUrl}${route}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal,
      }),
  };
}

/**
 * The three requests that each hold one LLM call, sent to a live QATOOL server.
 * `canonical` is a project that has already been generated, for the review.
 */
export const STAGE_REQUESTS = [
  { name: 'requirement structuring', send: (server, signal) => server.extract(signal) },
  {
    name: 'test case generation',
    send: (server, signal) => server.postJson('/api/generate', sampleCanonicalInput(), signal),
  },
  {
    name: 'semantic review',
    send: (server, signal, canonical) =>
      server.postJson('/api/validate?semantic=true', canonical, signal),
  },
];
