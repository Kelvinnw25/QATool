/**
 * End-to-end verification against a running QATOOL server.
 *
 *   npm run dev                 # or npm start, in another terminal
 *   npm run e2e:live
 *
 * Uploads two synthetic documents and walks the whole pipeline - extract,
 * generate, validate with the semantic review, export - then reads the
 * exported workbook back and checks it. Every assertion is printed as PASS or
 * FAIL and the script exits non-zero if any fail.
 *
 * The documents are invented BI-FAST fixtures built in memory, deliberately
 * contradicting each other on the batch limit so the conflict path is
 * exercised. No real bank document belongs here: with a real provider
 * configured, whatever this sends goes to that provider.
 *
 *   E2E_BASE   server to test (default http://127.0.0.1:3001)
 *   E2E_OUT    path to save the exported .xlsx for independent inspection
 */
import { writeFileSync } from 'node:fs';
import { buildDocx, buildPdf } from '../server/extract/fixtures/build.js';
import { inspectWorkbook } from '../server/export/inspect.js';

const BASE = process.env.E2E_BASE ?? 'http://127.0.0.1:3001';
const OUT = process.env.E2E_OUT;

const checks = [];
const check = (label, ok, detail = '') => checks.push({ label, ok: Boolean(ok), detail });
const line = (text = '') => process.stdout.write(`${text}\n`);

function post(path, body) {
  return fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** Indonesian PRD with a table, plus an RFC that disagrees about the batch limit. */
function syntheticUpload() {
  const form = new FormData();
  form.append(
    'documents',
    new Blob([
      buildDocx([
        { heading: 'Ketentuan Validasi', level: 1 },
        {
          text: 'Field BIC Code wajib diisi dan harus terdiri dari 8 atau 11 karakter. Jika kosong, transaksi ditolak dengan error ADMI 002.',
        },
        {
          table: [
            ['Field', 'Rule', 'Error'],
            ['Account Number', 'Mandatory, numeric only', 'ADMI 002'],
          ],
        },
        { heading: 'Business Rules', level: 2 },
        {
          text: 'Transaksi ke bank peserta dengan status Suspended harus ditolak dan tidak diteruskan ke BI-FAST.',
        },
        {
          text: 'Maksimal 300 transaksi per batch. Batch yang melebihi batas akan ditolak seluruhnya.',
        },
      ]),
    ]),
    'PRD BI-FAST Overdraft (synthetic).docx'
  );
  form.append(
    'documents',
    new Blob([
      buildPdf([
        [
          'Batch Size Limits',
          'The system must accept a maximum of 500 transactions per batch.',
          'A batch exceeding the maximum must be rejected and no transaction posted.',
        ],
      ]),
    ]),
    'RFC Limits (synthetic).pdf'
  );
  return form;
}

async function run() {
  // --- Extract --------------------------------------------------------------
  let started = Date.now();
  const extractResponse = await fetch(`${BASE}/api/extract`, {
    method: 'POST',
    body: syntheticUpload(),
  });
  const extracted = await extractResponse.json();
  line(`extract   ${Date.now() - started}ms  HTTP ${extractResponse.status}`);

  check('extract: HTTP 200', extractResponse.status === 200, String(extractResponse.status));
  check('extract: both documents parsed', extracted.documents?.length === 2);
  check(
    'extract: requirements found',
    extracted.requirements?.length > 0,
    `${extracted.requirements?.length} reqs`
  );
  check(
    'extract: cross-document conflict detected',
    extracted.warnings?.some((warning) => warning.code === 'CONFLICTING_SOURCES')
  );
  if (extractResponse.status !== 200) return;

  const documentIds = new Set(extracted.documents.map((document) => document.document_id));
  const requirementIds = new Set(
    extracted.requirements.map((requirement) => requirement.requirement_id)
  );

  const canonical = {
    project: { project_name: 'BI-FAST Overdraft (synthetic)', sit_scope: [] },
    documents: extracted.documents,
    requirements: extracted.requirements,
    test_cases: [],
  };

  // --- Generate -------------------------------------------------------------
  started = Date.now();
  const generateResponse = await post('/api/generate', canonical);
  const generated = await generateResponse.json();
  line(`generate  ${Date.now() - started}ms  HTTP ${generateResponse.status}`);

  if (generateResponse.status !== 200) {
    check('generate: HTTP 200', false, `${generated.error?.code}: ${generated.error?.message}`);
    return;
  }

  const { project, test_cases: testCases, warnings, metadata } = generated;
  canonical.project = project;
  canonical.test_cases = testCases;

  line(
    `          ${metadata.provider}/${metadata.model}, ${testCases.length} cases, ` +
      `${warnings.length} warnings, tokens ${metadata.usage?.input_tokens}in/${metadata.usage?.output_tokens}out`
  );

  check('generate: test cases produced', testCases.length > 0, `${testCases.length}`);
  for (const field of [
    'project_description',
    'project_summary',
    'qa_guidance',
    'project_background',
  ]) {
    check(
      `generate: ${field} present`,
      typeof project[field] === 'string' && project[field].length > 0
    );
  }
  check(
    'generate: SIT scope has 3-5 points',
    project.sit_scope.length >= 3 && project.sit_scope.length <= 5,
    `${project.sit_scope.length}`
  );
  check(
    'generate: dense TC ids',
    testCases.every(
      (testCase, index) => testCase.case_id === `TC-${String(index + 1).padStart(3, '0')}`
    )
  );
  check(
    'generate: every Edge case has a polarity',
    testCases
      .filter((testCase) => testCase.case_type === 'Edge')
      .every((testCase) => ['valid', 'invalid'].includes(testCase.edge_polarity))
  );
  check(
    'generate: no polarity on non-Edge cases',
    testCases
      .filter((testCase) => testCase.case_type !== 'Edge')
      .every((testCase) => testCase.edge_polarity === null)
  );
  check(
    'generate: every cited requirement exists',
    testCases.every((testCase) => testCase.requirement_ids.every((id) => requirementIds.has(id)))
  );
  check(
    'generate: every source reference names a real document',
    testCases.every((testCase) =>
      testCase.source_references.every((reference) => documentIds.has(reference.document_id))
    )
  );
  check(
    'generate: traceable cases carry source references',
    testCases
      .filter((testCase) => testCase.requirement_ids.length > 0)
      .every((testCase) => testCase.source_references.length > 0)
  );

  line('\n  Project Description: ' + project.project_description);
  line('  SIT Scope:\n' + project.sit_scope.map((point) => `    - ${point}`).join('\n'));
  line('\n  Test cases:');
  for (const testCase of testCases) {
    const polarity = testCase.edge_polarity ? `/${testCase.edge_polarity}` : '';
    const trace = testCase.source_references
      .map((reference) => reference.document_id + (reference.page ? ` p${reference.page}` : ''))
      .join(', ');
    line(
      `    ${testCase.case_id} [${testCase.case_type}${polarity}] ${testCase.priority} ` +
        `confidence=${testCase.confidence} <- ${testCase.requirement_ids.join(', ') || '(none)'} src=${trace}`
    );
    line(`      ${testCase.test_case}`);
    line(`      => ${testCase.expected_result}`);
  }
  for (const warning of warnings) {
    line(
      `  ! ${warning.code}${warning.requirement_id ? ` (${warning.requirement_id})` : ''}: ${warning.message}`
    );
  }

  // --- Validate, including the semantic review ------------------------------
  started = Date.now();
  const validateResponse = await post('/api/validate?semantic=true', canonical);
  const validation = await validateResponse.json();
  line(
    `\nvalidate  ${Date.now() - started}ms  HTTP ${validateResponse.status}  ` +
      `valid=${validation.valid} rules=${validation.semantic?.heuristics} ai=${validation.semantic?.llm}`
  );

  check('validate: HTTP 200', validateResponse.status === 200);
  check(
    'validate: structurally valid',
    validation.valid === true,
    JSON.stringify(validation.schema_issues).slice(0, 200)
  );
  check(
    'validate: semantic review ran',
    validation.semantic?.llm === 'completed',
    validation.semantic?.error ? JSON.stringify(validation.semantic.error) : ''
  );
  check('validate: coverage reported', Array.isArray(validation.coverage?.uncovered));

  const caseIds = new Set(canonical.test_cases.map((testCase) => testCase.case_id));
  check(
    'validate: every semantic finding cites a real id',
    (validation.semantic_warnings ?? []).every(
      (issue) =>
        (!issue.testcase_id || caseIds.has(issue.testcase_id)) &&
        (!issue.requirement_id || requirementIds.has(issue.requirement_id))
    )
  );

  for (const issue of validation.semantic_warnings ?? []) {
    line(
      `    [${issue.severity}] ${issue.category} ${issue.testcase_id ?? ''} ${issue.requirement_id ?? ''} ` +
        `(${issue.detected_by.join('+')}): ${issue.explanation}`
    );
  }

  // --- Export ---------------------------------------------------------------
  const beforeExport = JSON.stringify(canonical.test_cases);
  const exportResponse = await post('/api/export', canonical);
  const buffer = Buffer.from(await exportResponse.arrayBuffer());
  line(
    `\nexport    HTTP ${exportResponse.status}  rows=${exportResponse.headers.get('x-qatool-row-count')}  bytes=${buffer.length}`
  );

  check('export: HTTP 200', exportResponse.status === 200, String(exportResponse.status));
  check(
    'export: xlsx content type',
    /spreadsheetml/.test(exportResponse.headers.get('content-type') ?? '')
  );
  check('export: canonical left untouched', JSON.stringify(canonical.test_cases) === beforeExport);
  if (exportResponse.status !== 200) return;

  const workbook = inspectWorkbook(buffer);
  const lastRow = canonical.test_cases.length + 1;

  check('xlsx: one row per test case', workbook.dataRows.length === canonical.test_cases.length);
  check(
    'xlsx: template header preserved, typo and all',
    Object.values(workbook.headerRow).includes('Exected Result')
  );
  check(
    'xlsx: Table_1 retargeted to the data',
    workbook.tableRef === `C2:C${lastRow}`,
    workbook.tableRef
  );
  check(
    'xlsx: dropdowns retargeted to the data rows',
    workbook.validations.every((validation) => validation.sqref?.endsWith(String(lastRow))),
    workbook.validations.map((validation) => validation.sqref).join(' ')
  );
  check(
    'xlsx: Case Type only ever Positive or Negative',
    workbook.dataRows.every((row) => ['Positive', 'Negative'].includes(row.cells.D))
  );
  check(
    'xlsx: Status and Tested By left blank',
    workbook.dataRows.every((row) => !row.cells.H && !row.cells.I)
  );

  const rowsById = new Map(workbook.dataRows.map((row) => [row.cells.A, row.cells]));
  let edgeMapped = true;
  let plainVerbatim = true;
  for (const testCase of canonical.test_cases) {
    const cells = rowsById.get(testCase.case_id);
    if (!cells) {
      edgeMapped = false;
      plainVerbatim = false;
      continue;
    }
    if (testCase.case_type === 'Edge') {
      const expected = testCase.edge_polarity === 'valid' ? 'Positive' : 'Negative';
      if (cells.D !== expected || cells.G !== `[Edge Case] ${testCase.expected_result}`) {
        edgeMapped = false;
      }
    } else if (cells.D !== testCase.case_type || cells.G !== testCase.expected_result) {
      plainVerbatim = false;
    }
  }

  check('xlsx: Edge mapped by polarity, prefixed with [Edge Case]', edgeMapped);
  check('xlsx: non-Edge rows exported verbatim', plainVerbatim);
  check(
    'canonical: Expected Results never carry the export prefix',
    canonical.test_cases.every((testCase) => !testCase.expected_result.startsWith('[Edge Case]'))
  );

  if (OUT) {
    writeFileSync(OUT, buffer);
    line(`saved     ${OUT}`);
  }
}

await run();

line('\n=== CHECKS ===');
for (const { ok, label, detail } of checks) {
  line(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`);
}
const failed = checks.filter((entry) => !entry.ok).length;
line(`\n${checks.length - failed}/${checks.length} checks passed`);
if (failed) process.exitCode = 1;
