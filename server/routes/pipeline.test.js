import test from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../app.js';
import { inspectWorkbook } from '../export/inspect.js';
import { buildSampleCanonical } from '../export/fixtures/sample-canonical.js';
import { buildDocx, buildPdf } from '../extract/fixtures/build.js';
import { config } from '../config.js';
import { LlmError, LLM_ERRORS } from '../llm/provider.js';
import { sampleCanonicalInput, sampleLlmResponse } from '../generate/fixtures/sample-input.js';

/**
 * Renders a FormData into the raw bytes and matching headers inject() needs.
 *
 * Built from a single Response: each one generates its own multipart boundary,
 * so reading the body and the content-type from two Responses would hand the
 * server a boundary that does not appear in the payload.
 */
async function multipart(form) {
  const response = new Response(form);
  return {
    payload: Buffer.from(await response.arrayBuffer()),
    headers: { 'content-type': response.headers.get('content-type') },
  };
}

/**
 * No fixtures, no database, no reset between tests - the server holds nothing,
 * so an app instance is interchangeable with any other.
 */
function harness() {
  const app = buildApp();
  return { app, close: () => app.close() };
}

test('the app starts with no database handle', async (t) => {
  const h = harness();
  t.after(() => h.close());

  const response = await h.app.inject({ method: 'GET', url: '/api/health' });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().stateless, true);
});

test('extract requires multipart, not JSON', async (t) => {
  const h = harness();
  t.after(() => h.close());

  const response = await h.app.inject({ method: 'POST', url: '/api/extract', payload: {} });
  assert.equal(response.statusCode, 400);
  assert.equal(response.json().error.code, 'BAD_REQUEST');
  assert.match(response.json().error.message, /multipart/);
});

test('extract parses an uploaded document and returns requirements', async (t) => {
  const h = harness();
  t.after(() => h.close());

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
    'PRD Bulk Transfer.docx'
  );

  const response = await h.app.inject({
    method: 'POST',
    url: '/api/extract',
    ...(await multipart(form)),
  });

  assert.equal(response.statusCode, 200, response.body);
  const result = response.json();

  assert.equal(result.documents.length, 1);
  assert.equal(result.documents[0].document_id, 'DOC-001');
  assert.equal(result.documents[0].filename, 'PRD Bulk Transfer.docx');
  assert.equal(result.documents[0].status, 'Extracted');
  assert.ok(result.requirements.length >= 1);
  assert.equal(result.requirements[0].requirement_id, 'REQ-001');
  assert.equal(result.requirements[0].source_references[0].section, 'Business Rules');
  assert.ok(Array.isArray(result.warnings));
  assert.ok(result.metrics.total_extracted_chars > 0);
});

test('extract rejects an unsupported file with a controlled error', async (t) => {
  const h = harness();
  t.after(() => h.close());

  const form = new FormData();
  form.append('documents', new Blob([Buffer.from('just some notes')]), 'notes.txt');

  const response = await h.app.inject({
    method: 'POST',
    url: '/api/extract',
    ...(await multipart(form)),
  });

  assert.equal(response.statusCode, 422);
  assert.equal(response.json().error.code, 'EXTRACTION_FAILED');
  assert.match(response.json().error.message, /not a PDF, DOCX, XLSX/);
});

test('extract never returns an empty success', async (t) => {
  const h = harness();
  t.after(() => h.close());

  const form = new FormData();
  form.append('documents', new Blob([buildPdf([[]])]), 'Scanned.pdf');

  const response = await h.app.inject({
    method: 'POST',
    url: '/api/extract',
    ...(await multipart(form)),
  });

  assert.equal(response.statusCode, 422);
  assert.equal(response.json().error.code, 'NO_REQUIREMENTS_EXTRACTED');
  assert.equal(response.json().error.details[0].extracted_char_count, 0);
});

test('extracted output feeds straight into validate', async (t) => {
  const h = harness();
  t.after(() => h.close());

  const form = new FormData();
  form.append(
    'documents',
    new Blob([
      buildDocx([
        { heading: 'Business Rules', level: 1 },
        { text: 'A transfer missing a mandatory BIC code must be rejected with code ADMI 002.' },
      ]),
    ]),
    'PRD.docx'
  );

  const extracted = (
    await h.app.inject({
      method: 'POST',
      url: '/api/extract',
      ...(await multipart(form)),
    })
  ).json();

  // The pipeline is stateless, so the browser merges and posts the result back.
  const canonical = {
    project: { project_name: 'Bulk Credit Transfer', sit_scope: [] },
    documents: extracted.documents,
    requirements: extracted.requirements,
    test_cases: [],
  };

  const validation = (
    await h.app.inject({ method: 'POST', url: '/api/validate', payload: canonical })
  ).json();

  assert.equal(validation.valid, true, JSON.stringify(validation.schema_issues));
  assert.deepEqual(validation.coverage.uncovered, ['REQ-001'], 'nothing covers it yet');
});

/**
 * Runs the body with the mock provider configured, then puts the real settings
 * back. The registry is switched by config alone, so this is the same mechanism
 * an operator uses to run QATOOL offline with LLM_PROVIDER=mock - not a hook
 * that exists only for tests.
 */
async function withMockProvider(responses, body) {
  const original = { ...config.llm };
  Object.assign(config.llm, { provider: 'mock', responses });
  try {
    return await body();
  } finally {
    Object.assign(config.llm, original);
    delete config.llm.responses;
  }
}

test('generation turns requirements into test cases and project outputs', async (t) => {
  const h = harness();
  t.after(() => h.close());

  const response = await withMockProvider([sampleLlmResponse()], () =>
    h.app.inject({ method: 'POST', url: '/api/generate', payload: sampleCanonicalInput() })
  );

  assert.equal(response.statusCode, 200, response.body);
  const body = response.json();

  assert.equal(body.test_cases.length, 5);
  assert.equal(body.test_cases[0].case_id, 'TC-001');
  assert.ok(body.project.project_description);
  assert.equal(body.project.sit_scope.length, 3);
  assert.ok(Array.isArray(body.warnings));
  assert.equal(body.metadata.provider, 'Mock');
});

test('a generated project passes validation and exports', async (t) => {
  const h = harness();
  t.after(() => h.close());

  // The point of the milestone: what generation returns is a legal canonical
  // project, so the next two endpoints accept it without anything in between.
  const generated = await withMockProvider([sampleLlmResponse()], () =>
    h.app.inject({ method: 'POST', url: '/api/generate', payload: sampleCanonicalInput() })
  );

  const canonical = { ...sampleCanonicalInput(), ...generated.json() };
  delete canonical.warnings;
  delete canonical.metadata;

  const validation = await h.app.inject({
    method: 'POST',
    url: '/api/validate',
    payload: canonical,
  });
  assert.equal(validation.statusCode, 200, validation.body);
  assert.equal(validation.json().valid, true, JSON.stringify(validation.json().schema_issues));

  const exported = await h.app.inject({ method: 'POST', url: '/api/export', payload: canonical });
  assert.equal(exported.statusCode, 200, exported.body);
  assert.equal(exported.headers['x-qatool-row-count'], '5');
});

test('the two Edge cases reach the workbook as Positive and Negative', async (t) => {
  const h = harness();
  t.after(() => h.close());

  const generated = await withMockProvider([sampleLlmResponse()], () =>
    h.app.inject({ method: 'POST', url: '/api/generate', payload: sampleCanonicalInput() })
  );

  const canonical = { ...sampleCanonicalInput(), ...generated.json() };
  delete canonical.warnings;
  delete canonical.metadata;

  const exported = await h.app.inject({ method: 'POST', url: '/api/export', payload: canonical });
  const workbook = inspectWorkbook(exported.rawPayload);

  const edgeRows = workbook.dataRows.filter((row) => row.cells.G.startsWith('[Edge Case] '));
  assert.equal(edgeRows.length, 2, 'both Edge cases are marked in the export');
  assert.deepEqual(
    edgeRows.map((row) => row.cells.D),
    ['Positive', 'Negative'],
    'valid boundary exports Positive, invalid exports Negative'
  );

  // The canonical copy is untouched: the prefix is export decoration only.
  const canonicalEdges = canonical.test_cases.filter((testCase) => testCase.case_type === 'Edge');
  assert.equal(canonicalEdges.length, 2);
  for (const testCase of canonicalEdges) {
    assert.ok(!testCase.expected_result.startsWith('[Edge Case] '));
  }
});

test('generation refuses an empty project instead of calling the provider', async (t) => {
  const h = harness();
  t.after(() => h.close());

  const response = await h.app.inject({ method: 'POST', url: '/api/generate', payload: {} });

  assert.equal(response.statusCode, 422);
  assert.equal(response.json().error.code, 'NO_REQUIREMENTS');
});

test('generation reports a missing API key as a configuration fault', async (t) => {
  const h = harness();
  t.after(() => h.close());

  const original = { ...config.llm };
  Object.assign(config.llm, { provider: 'gemini', apiKey: '' });

  try {
    const response = await h.app.inject({
      method: 'POST',
      url: '/api/generate',
      payload: sampleCanonicalInput(),
    });

    assert.equal(response.statusCode, 500);
    assert.equal(response.json().error.code, 'LLM_NOT_CONFIGURED');
    assert.match(response.json().error.message, /GEMINI_API_KEY/);
  } finally {
    Object.assign(config.llm, original);
  }
});

test('a provider failure is a controlled error, and the request body is unchanged', async (t) => {
  const h = harness();
  t.after(() => h.close());

  const payload = sampleCanonicalInput();
  const before = JSON.stringify(payload);

  const response = await withMockProvider(
    [new LlmError(LLM_ERRORS.RATE_LIMITED, 'Too many requests.', 429)],
    () => h.app.inject({ method: 'POST', url: '/api/generate', payload })
  );

  assert.equal(response.statusCode, 429);
  assert.equal(response.json().error.code, 'LLM_RATE_LIMITED');

  // Nothing was consumed: the browser still holds everything it needs to retry
  // without re-uploading or re-extracting.
  assert.equal(JSON.stringify(payload), before);
});

test('malformed structured output is rejected, not repaired', async (t) => {
  const h = harness();
  t.after(() => h.close());

  const response = await withMockProvider([{ project: {}, test_cases: 'not an array' }], () =>
    h.app.inject({ method: 'POST', url: '/api/generate', payload: sampleCanonicalInput() })
  );

  assert.equal(response.statusCode, 502);
  assert.equal(response.json().error.code, 'LLM_MALFORMED_OUTPUT');
  assert.ok(response.json().error.details.length > 0);
});

/**
 * Replaces fetch for the duration of a test so nothing reaches a real provider.
 * The automated suite must never make a network call to an LLM, even with a
 * fake key - that is what gemini.live.test.js is for, and only on request.
 */
async function withStubbedFetch(reply, body) {
  const realFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return reply();
  };
  try {
    return { result: await body(), calls };
  } finally {
    globalThis.fetch = realFetch;
  }
}

const FAKE_KEY = 'AIzaSECRETVALUE0123456789';

test('no response from the generate endpoint carries the API key', async (t) => {
  const h = harness();
  t.after(() => h.close());

  const original = { ...config.llm };
  Object.assign(config.llm, { provider: 'gemini', apiKey: FAKE_KEY });

  try {
    // The worst case: a provider error that echoes the key back in its body.
    const { result: response, calls } = await withStubbedFetch(
      () =>
        new Response(JSON.stringify({ error: { message: `API key ${FAKE_KEY} not valid` } }), {
          status: 400,
          headers: { 'content-type': 'application/json' },
        }),
      () => h.app.inject({ method: 'POST', url: '/api/generate', payload: sampleCanonicalInput() })
    );

    assert.equal(calls.length, 1, 'the request went to the stub, not the network');
    assert.ok(!calls[0].url.includes(FAKE_KEY), 'the key is never in the URL');
    assert.ok(!response.body.includes(FAKE_KEY));
    assert.ok(!response.body.includes('SECRETVALUE'));
  } finally {
    Object.assign(config.llm, original);
  }
});

test('validate runs the semantic review only when asked', async (t) => {
  const h = harness();
  t.after(() => h.close());

  const generated = await withMockProvider([sampleLlmResponse()], () =>
    h.app.inject({ method: 'POST', url: '/api/generate', payload: sampleCanonicalInput() })
  );
  const canonical = {
    ...sampleCanonicalInput(),
    project: generated.json().project,
    test_cases: generated.json().test_cases,
  };

  const plain = await withMockProvider([{ issues: [] }], () =>
    h.app.inject({ method: 'POST', url: '/api/validate', payload: canonical })
  );
  assert.equal(plain.json().semantic.llm, 'not_requested');
  assert.equal(plain.json().semantic.heuristics, 'completed');

  const reviewed = await withMockProvider(
    [
      {
        issues: [
          {
            category: 'contradiction',
            severity: 'high',
            testcase_id: 'TC-003',
            requirement_id: 'REQ-002',
            explanation: 'Expects forwarding where REQ-002 requires rejection.',
          },
        ],
      },
    ],
    () => h.app.inject({ method: 'POST', url: '/api/validate?semantic=true', payload: canonical })
  );

  assert.equal(reviewed.statusCode, 200, reviewed.body);
  const body = reviewed.json();
  assert.equal(body.valid, true, 'deterministic validation is unaffected');
  assert.equal(body.semantic.llm, 'completed');
  assert.equal(body.semantic_warnings.length, 1);
  assert.equal(body.semantic_warnings[0].testcase_id, 'TC-003');
  assert.deepEqual(body.coverage.uncovered, ['REQ-004'], 'coverage is still reported');
});

test('a failed semantic review is reported, not thrown', async (t) => {
  const h = harness();
  t.after(() => h.close());

  const generated = await withMockProvider([sampleLlmResponse()], () =>
    h.app.inject({ method: 'POST', url: '/api/generate', payload: sampleCanonicalInput() })
  );
  const canonical = {
    ...sampleCanonicalInput(),
    project: generated.json().project,
    test_cases: generated.json().test_cases,
  };

  const response = await withMockProvider(
    [new LlmError(LLM_ERRORS.UNAVAILABLE, 'The model is experiencing high demand.', 502)],
    () => h.app.inject({ method: 'POST', url: '/api/validate?semantic=true', payload: canonical })
  );

  // 200, because deterministic validation succeeded and export is still
  // possible. The review can be retried without regenerating.
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().valid, true);
  assert.equal(response.json().semantic.llm, 'failed');
  assert.equal(response.json().semantic.error.code, 'LLM_UNAVAILABLE');
});

test('no response from the semantic review carries the API key', async (t) => {
  const h = harness();
  t.after(() => h.close());

  const generated = await withMockProvider([sampleLlmResponse()], () =>
    h.app.inject({ method: 'POST', url: '/api/generate', payload: sampleCanonicalInput() })
  );
  const canonical = {
    ...sampleCanonicalInput(),
    project: generated.json().project,
    test_cases: generated.json().test_cases,
  };

  const original = { ...config.llm };
  Object.assign(config.llm, { provider: 'gemini', apiKey: FAKE_KEY });

  try {
    const { result: response, calls } = await withStubbedFetch(
      () =>
        new Response(JSON.stringify({ error: { message: `bad key ${FAKE_KEY}` } }), {
          status: 403,
          headers: { 'content-type': 'application/json' },
        }),
      () => h.app.inject({ method: 'POST', url: '/api/validate?semantic=true', payload: canonical })
    );

    assert.equal(calls.length, 1);
    assert.equal(response.json().semantic.error.code, 'LLM_AUTH_FAILED');
    assert.ok(!response.body.includes(FAKE_KEY));
  } finally {
    Object.assign(config.llm, original);
  }
});

test('validate accepts a canonical object and reports coverage', async (t) => {
  const h = harness();
  t.after(() => h.close());

  const response = await h.app.inject({
    method: 'POST',
    url: '/api/validate',
    payload: buildSampleCanonical(),
  });

  assert.equal(response.statusCode, 200, response.body);
  const result = response.json();

  assert.equal(result.valid, true, JSON.stringify(result.schema_issues));

  // The sample predates semantic validation and carries details its cited
  // requirements never state - U000 appears in no requirement, and TC-005
  // asserts REQ-004's U253 while citing REQ-002. The deterministic checks find
  // all four; without ?semantic=true, no model is called.
  assert.deepEqual(
    result.semantic_warnings.map((issue) => `${issue.testcase_id}:${issue.category}`).sort(),
    [
      'TC-001:unsupported_implementation_detail',
      'TC-003:unsupported_implementation_detail',
      'TC-004:unsupported_implementation_detail',
      'TC-005:unsupported_implementation_detail',
    ]
  );
  assert.equal(result.semantic.heuristics, 'completed');
  assert.equal(result.semantic.llm, 'not_requested');

  // REQ-004 is intentionally uncovered in the sample.
  assert.deepEqual(result.coverage.uncovered, ['REQ-004']);
  assert.deepEqual(result.coverage.orphan_test_cases, []);
});

test('validate reports a test case citing an unknown requirement', async (t) => {
  const h = harness();
  t.after(() => h.close());

  const canonical = buildSampleCanonical();
  canonical.test_cases[0].requirement_ids = ['REQ-999'];

  const result = (
    await h.app.inject({ method: 'POST', url: '/api/validate', payload: canonical })
  ).json();

  assert.equal(result.valid, false);
  assert.equal(result.reference_issues[0].code, 'UNKNOWN_REQUIREMENT_REFERENCE');
});

/**
 * Clearing a polarity used to make the whole project structurally invalid,
 * which also blanked the coverage report and every other finding. It is a
 * classification a reviewer has not finished, not a corrupt document: the
 * project stays valid and usable, validation says so out loud, and export is
 * where it actually bites.
 */
test('validate reports an Edge case whose polarity was cleared, without failing the project', async (t) => {
  const h = harness();
  t.after(() => h.close());

  const canonical = buildSampleCanonical();
  const edge = canonical.test_cases.find((testCase) => testCase.case_type === 'Edge');
  edge.edge_polarity = null;

  const result = (
    await h.app.inject({ method: 'POST', url: '/api/validate', payload: canonical })
  ).json();

  assert.equal(result.valid, true, 'the document is still structurally sound');
  assert.deepEqual(result.schema_issues, []);

  const finding = result.semantic_warnings.find(
    (issue) => issue.testcase_id === edge.case_id && issue.category === 'suspicious_edge_polarity'
  );
  assert.ok(finding, JSON.stringify(result.semantic_warnings));
  assert.match(finding.explanation, /Edge polarity missing/);

  // Coverage still works, which it did not when this failed the whole schema.
  assert.ok(result.coverage.entries.length > 0);
  assert.equal(result.coverage.summary.testcases_unresolved_classification, 1);
});

test('export delivers the same case rather than guessing its polarity', async (t) => {
  const h = harness();
  t.after(() => h.close());

  const canonical = buildSampleCanonical();
  const edge = canonical.test_cases.find((testCase) => testCase.case_type === 'Edge');
  edge.edge_polarity = null;

  const response = await h.app.inject({ method: 'POST', url: '/api/export', payload: canonical });

  assert.equal(response.statusCode, 200, 'the workbook is still produced');
  assert.equal(
    response.headers['x-qatool-row-count'],
    String(canonical.test_cases.length),
    'including the unresolved case'
  );
  assert.equal(response.headers['x-qatool-export-warnings'], '1', 'and QA is told about it');
});

test('validate reports a project description of more than one sentence', async (t) => {
  const h = harness();
  t.after(() => h.close());

  const canonical = buildSampleCanonical();
  canonical.project.project_description = 'Enables transfers. It also updates the status table.';

  const result = (
    await h.app.inject({ method: 'POST', url: '/api/validate', payload: canonical })
  ).json();

  assert.equal(result.valid, false);
  assert.ok(
    result.schema_issues.some((issue) => issue.path === 'project.project_description'),
    JSON.stringify(result.schema_issues)
  );
});

test('a flawed project description does not block the workbook', async (t) => {
  const h = harness();
  t.after(() => h.close());

  // The workbook does not carry the description, so a problem with it must not
  // cost the user the artifact they came for.
  const canonical = buildSampleCanonical();
  canonical.project.project_description = 'One sentence. And then a second one.';

  const response = await h.app.inject({ method: 'POST', url: '/api/export', payload: canonical });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.headers['x-qatool-row-count'], '6');
});

test('the sample workflow carries all five generated outputs', async (t) => {
  const h = harness();
  t.after(() => h.close());

  const { project } = (
    await h.app.inject({ method: 'GET', url: '/api/meta/sample-canonical' })
  ).json();

  for (const field of [
    'project_description',
    'project_summary',
    'qa_guidance',
    'project_background',
  ]) {
    assert.ok(project[field], `${field} should be populated for the Results page`);
  }
  assert.ok(
    project.sit_scope.length >= 3 && project.sit_scope.length <= 5,
    'SIT scope is 3-5 points'
  );
});

test('validate rejects a non-object body with a controlled error', async (t) => {
  const h = harness();
  t.after(() => h.close());

  const response = await h.app.inject({ method: 'POST', url: '/api/validate', payload: [] });
  assert.equal(response.statusCode, 400);
  assert.equal(response.json().error.code, 'BAD_REQUEST');
});

test('export returns a real workbook with the right headers', async (t) => {
  const h = harness();
  t.after(() => h.close());

  const canonical = buildSampleCanonical();
  const response = await h.app.inject({
    method: 'POST',
    url: '/api/export',
    payload: canonical,
  });

  assert.equal(response.statusCode, 200, response.body);
  assert.equal(
    response.headers['content-type'],
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  );
  assert.equal(
    response.headers['content-disposition'],
    'attachment; filename="SIT Script - Bulk Credit Transfer Phase 2.xlsx"'
  );
  assert.equal(response.headers['x-qatool-row-count'], '6');

  // The bytes coming back are a workbook, not an error page.
  const workbook = inspectWorkbook(response.rawPayload);
  assert.equal(workbook.dataRows.length, 6);
  assert.equal(workbook.headerRow.G, 'Exected Result');
});

test('the exported workbook honours the Edge rules end to end', async (t) => {
  const h = harness();
  t.after(() => h.close());

  const response = await h.app.inject({
    method: 'POST',
    url: '/api/export',
    payload: buildSampleCanonical(),
  });

  const workbook = inspectWorkbook(response.rawPayload);
  const rows = Object.fromEntries(workbook.dataRows.map((row) => [row.cells.A, row.cells]));

  assert.equal(rows['TC-003'].D, 'Positive', 'Edge / valid downgrades to Positive');
  assert.ok(rows['TC-003'].G.startsWith('[Edge Case] '));

  assert.equal(rows['TC-004'].D, 'Negative', 'Edge / invalid downgrades to Negative');
  assert.ok(rows['TC-004'].G.startsWith('[Edge Case] '));

  for (const row of workbook.dataRows) {
    assert.ok(['Positive', 'Negative'].includes(row.cells.D));
    assert.equal(row.cells.H, '', 'Status stays blank');
    assert.equal(row.cells.I, '', 'Tested By stays blank');
  }
});

test('export refuses an empty test case list', async (t) => {
  const h = harness();
  t.after(() => h.close());

  const canonical = buildSampleCanonical();
  canonical.test_cases = [];

  const response = await h.app.inject({ method: 'POST', url: '/api/export', payload: canonical });
  assert.equal(response.statusCode, 422);
  assert.equal(response.json().error.code, 'EXPORT_EMPTY');
});

/**
 * A classification nobody has finished is a reason to warn, not to withhold
 * the file. A structurally empty case still blocks, because a row of blanks in
 * a SIT script is worse than an absent one.
 */
test('export still blocks a case with no expected result', async (t) => {
  const h = harness();
  t.after(() => h.close());

  const canonical = buildSampleCanonical();
  canonical.test_cases[0].expected_result = '   ';

  const response = await h.app.inject({ method: 'POST', url: '/api/export', payload: canonical });
  assert.equal(response.statusCode, 422);
  assert.equal(response.json().error.code, 'EXPORT_BLOCKED');
  assert.equal(response.json().error.details[0].code, 'EXPECTED_RESULT_EMPTY');
});

test('export preserves an unrecognised case type and counts it as a warning', async (t) => {
  const h = harness();
  t.after(() => h.close());

  const canonical = buildSampleCanonical();
  canonical.test_cases[0].case_type = 'Positiv';
  canonical.test_cases[0].edge_polarity = null;

  const response = await h.app.inject({ method: 'POST', url: '/api/export', payload: canonical });

  assert.equal(response.statusCode, 200);
  assert.equal(response.headers['x-qatool-export-warnings'], '1');
});

test('export rejects a project with no name', async (t) => {
  const h = harness();
  t.after(() => h.close());

  const canonical = buildSampleCanonical();
  canonical.project.project_name = '  ';

  const response = await h.app.inject({ method: 'POST', url: '/api/export', payload: canonical });
  assert.equal(response.statusCode, 400);
  assert.equal(response.json().error.code, 'VALIDATION_FAILED');
});

test('the sample workflow endpoint returns a valid canonical project', async (t) => {
  const h = harness();
  t.after(() => h.close());

  const sample = (await h.app.inject({ method: 'GET', url: '/api/meta/sample-canonical' })).json();

  assert.equal(sample.documents.length, 2);
  assert.equal(sample.requirements.length, 4);
  assert.equal(sample.test_cases.length, 6);

  const validation = (
    await h.app.inject({ method: 'POST', url: '/api/validate', payload: sample })
  ).json();
  assert.equal(validation.valid, true, JSON.stringify(validation));
});

test('two requests share nothing', async (t) => {
  const h = harness();
  t.after(() => h.close());

  const first = buildSampleCanonical();
  first.project.project_name = 'Project One';
  first.test_cases = first.test_cases.slice(0, 2);

  const second = buildSampleCanonical();
  second.project.project_name = 'Project Two';

  const a = await h.app.inject({ method: 'POST', url: '/api/export', payload: first });
  const b = await h.app.inject({ method: 'POST', url: '/api/export', payload: second });

  assert.equal(a.headers['x-qatool-row-count'], '2');
  assert.equal(b.headers['x-qatool-row-count'], '6');
  assert.match(a.headers['content-disposition'], /Project One/);
  assert.match(b.headers['content-disposition'], /Project Two/);
});

test('no CRUD resource routes remain', async (t) => {
  const h = harness();
  t.after(() => h.close());

  for (const url of [
    '/api/projects',
    '/api/projects/abc',
    '/api/projects/abc/documents',
    '/api/projects/abc/requirements',
    '/api/projects/abc/test-cases',
    '/api/projects/abc/canonical',
  ]) {
    const response = await h.app.inject({ method: 'GET', url });
    assert.equal(response.statusCode, 404, `${url} should no longer exist`);
  }
});

/**
 * Request-level tracing, through the real Fastify lifecycle.
 *
 * What these pin is the wiring rather than the formatting: that a run exists
 * for an API request, that its id reaches a diagnostic error body, and that a
 * request which never reaches the backend cannot have one.
 */
test('an API error response carries the run id that produced it', async (t) => {
  const { app, close } = harness();
  t.after(close);

  const response = await app.inject({
    method: 'POST',
    url: '/api/generate',
    payload: { ...sampleCanonicalInput(), requirements: [] },
  });

  const body = response.json();

  assert.equal(response.statusCode, 422);
  assert.equal(body.error.code, 'NO_REQUIREMENTS', 'the existing contract is unchanged');
  assert.ok(body.error.message, 'the message is unchanged');
  assert.match(body.error.run_id, /^QATOOL-\d{8}-[0-9A-F]{6}$/, 'and a run id was added');
});

test('two requests get two different run ids', async (t) => {
  const { app, close } = harness();
  t.after(close);

  const ids = [];
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await app.inject({
      method: 'POST',
      url: '/api/generate',
      payload: { ...sampleCanonicalInput(), requirements: [] },
    });
    ids.push(response.json().error.run_id);
  }

  assert.notEqual(ids[0], ids[1], 'a run id identifies one request, not the process');
});

test('a successful request returns exactly the body it did before', async (t) => {
  const { app, close } = harness();
  t.after(close);

  const response = await app.inject({ method: 'GET', url: '/api/health' });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(Object.keys(response.json()).sort(), ['stateless', 'status', 'time']);
  assert.ok(!('run_id' in response.json()), 'success bodies are untouched');
});

test('a 404 outside /api starts no run', async (t) => {
  const { app, close } = harness();
  t.after(close);

  // The distinction the whole design rests on: no run means the request never
  // became pipeline work. A proxy failure during a dev-server restart never
  // reaches the backend at all, so it can have no run id - and nothing here
  // invents one to make the logs look complete.
  const response = await app.inject({ method: 'GET', url: '/not-an-api-path' });

  assert.ok(response.statusCode >= 200);
  const body = response.headers['content-type']?.includes('application/json')
    ? response.json()
    : null;
  if (body?.error) assert.ok(!('run_id' in body.error));
});

test('validation carries test case diagnostics beside the existing results, not inside them', async (t) => {
  const { app, close } = harness();
  t.after(close);

  const plain = buildSampleCanonical();
  const vague = structuredClone(plain);
  vague.test_cases[0].expected_result = `${vague.test_cases[0].expected_result} The page loads quickly.`;

  const before = (
    await app.inject({ method: 'POST', url: '/api/validate', payload: plain })
  ).json();
  const after = (await app.inject({ method: 'POST', url: '/api/validate', payload: vague })).json();

  assert.deepEqual(Object.keys(after), [
    'valid',
    'schema_issues',
    'reference_issues',
    'semantic_warnings',
    'semantic',
    'coverage',
    'testcase_diagnostics',
  ]);
  assert.equal(after.testcase_diagnostics.status, 'completed');
  assert.ok(
    after.testcase_diagnostics.findings.some(
      (finding) =>
        finding.rule_id === 'TCD-VAGUE-01' && finding.testcase_id === vague.test_cases[0].case_id
    ),
    JSON.stringify(after.testcase_diagnostics.findings)
  );

  // A diagnostic is not a semantic warning, and it moves no coverage figure.
  assert.ok(!JSON.stringify(after.semantic_warnings).includes('TCD-'));
  assert.deepEqual(after.coverage.summary, before.coverage.summary);
  assert.equal(after.valid, before.valid);
});

test('a structurally invalid project gets no diagnostics, and the response says why', async (t) => {
  const { app, close } = harness();
  t.after(close);

  const canonical = buildSampleCanonical();
  canonical.test_cases[0].case_id = 'NOT-A-CASE-ID';

  const body = (
    await app.inject({ method: 'POST', url: '/api/validate', payload: canonical })
  ).json();

  assert.equal(body.valid, false);
  assert.equal(body.testcase_diagnostics.status, 'skipped');
  assert.match(body.testcase_diagnostics.reason, /structurally valid/);
  assert.deepEqual(body.testcase_diagnostics.findings, []);
});
