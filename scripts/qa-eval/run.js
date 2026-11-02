/**
 * Quality evaluation harness: synthetic documents through the real pipeline.
 *
 *   npm run dev            # in another terminal
 *   npm run qa:eval        # all sets
 *   npm run qa:eval -- --only=A,B --no-semantic
 *
 * Runs each fixture set from scripts/qa-eval/fixtures.js through the live
 * server - extract, generate, validate, export - and records everything needed
 * to judge output quality: requirements, case counts, the Positive/Negative/Edge
 * split, edge polarity, all five project outputs, warnings and traceability.
 *
 * This is an evaluation tool, not a test. It asserts only the mechanical things
 * a machine can decide (schema validity, id density, export integrity) and
 * leaves every judgement about meaning to the report written from its output.
 * A run that produces poor test cases still exits 0 - that is a finding, not a
 * harness failure.
 *
 * Each set costs one generation call, plus one semantic-review call unless
 * --no-semantic is passed. On the Gemini free tier the daily allowance is 20
 * requests per model AND FAILED ATTEMPTS COUNT - a run that meets an overload
 * can spend the day's budget without producing a single test case. Hence
 * --only, to re-run just the sets that failed rather than all of them.
 *
 *   QA_EVAL_BASE   server to drive (default http://127.0.0.1:3001)
 *   QA_EVAL_OUT    directory for the captured JSON and the exported workbooks
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FIXTURE_SETS, uploadFor } from './fixtures.js';
import { inspectWorkbook } from '../../server/export/inspect.js';

const BASE = process.env.QA_EVAL_BASE ?? 'http://127.0.0.1:3001';
const OUT = process.env.QA_EVAL_OUT ?? join(process.cwd(), '.qa-eval-output');

const args = process.argv.slice(2);
const only = args
  .find((argument) => argument.startsWith('--only='))
  ?.slice('--only='.length)
  .split(',')
  .map((id) => id.trim().toUpperCase());
const useSemantic = !args.includes('--no-semantic');

const line = (text = '') => process.stdout.write(`${text}\n`);

function post(path, body) {
  return fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/**
 * Generation, retried sparingly when the provider sheds load.
 *
 * A retry is NOT free. Measured on 2026-09-23: three successful generations
 * plus roughly twenty HTTP 503 "temporarily overloaded" replies exhausted the
 * whole free-tier allowance for the day, and the 429 that followed named
 * GenerateRequestsPerDayPerProjectPerModel-FreeTier with quotaValue 20. A 503
 * is refused capacity, not a request that never happened, and Google counts it.
 *
 * So the default is a couple of patient attempts rather than a retry storm: an
 * overload that has already lasted minutes is unlikely to clear on the next
 * second, and burning the day's budget discovering that costs an evaluation.
 * Raise QA_EVAL_RETRIES deliberately, knowing each attempt spends quota.
 *
 * 429 itself is never retried - the allowance is gone until it resets - and
 * neither is a malformed or invalid generation, which is a real finding this
 * evaluation exists to observe rather than paper over by rerolling.
 */
async function generateWithRetry(canonical) {
  const attempts = Number(process.env.QA_EVAL_RETRIES ?? 2);
  const delayMs = Number(process.env.QA_EVAL_RETRY_DELAY_MS ?? 120_000);

  for (let attempt = 1; ; attempt += 1) {
    const started = Date.now();
    const response = await post('/api/generate', canonical);
    const body = await response.json();
    line(`\ngenerate  ${Date.now() - started}ms  HTTP ${response.status}  (attempt ${attempt})`);

    const unreached = body.error?.code === 'LLM_UNAVAILABLE';
    if (!unreached || attempt >= attempts) return { response, body };

    line(
      `          provider overloaded (this attempt still cost quota), waiting ${delayMs / 1000}s before retry`
    );
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
}

/** Mechanical checks only - anything a machine can decide without judgement. */
function mechanicalChecks(canonical, requirementIds, documentIds, validation, workbook) {
  const cases = canonical.test_cases;
  const checks = {};

  checks.dense_case_ids = cases.every(
    (testCase, index) => testCase.case_id === `TC-${String(index + 1).padStart(3, '0')}`
  );
  checks.edge_cases_have_polarity = cases
    .filter((testCase) => testCase.case_type === 'Edge')
    .every((testCase) => ['valid', 'invalid'].includes(testCase.edge_polarity));
  checks.non_edge_cases_have_no_polarity = cases
    .filter((testCase) => testCase.case_type !== 'Edge')
    .every((testCase) => testCase.edge_polarity === null);
  checks.cited_requirements_exist = cases.every((testCase) =>
    testCase.requirement_ids.every((id) => requirementIds.has(id))
  );
  checks.source_references_name_real_documents = cases.every((testCase) =>
    testCase.source_references.every((reference) => documentIds.has(reference.document_id))
  );
  checks.expected_results_have_no_export_prefix = cases.every(
    (testCase) => !testCase.expected_result.startsWith('[Edge Case]')
  );
  checks.structurally_valid = validation?.valid === true;

  if (workbook) {
    const lastRow = cases.length + 1;
    checks.xlsx_row_per_case = workbook.dataRows.length === cases.length;
    checks.xlsx_header_preserved = Object.values(workbook.headerRow).includes('Exected Result');
    checks.xlsx_table_retargeted = workbook.tableRef === `C2:C${lastRow}`;
    checks.xlsx_dropdowns_retargeted = workbook.validations.every((entry) =>
      entry.sqref?.endsWith(String(lastRow))
    );
    checks.xlsx_case_type_in_template_vocabulary = workbook.dataRows.every((row) =>
      ['Positive', 'Negative'].includes(row.cells.D)
    );
    checks.xlsx_execution_columns_blank = workbook.dataRows.every(
      (row) => !row.cells.H && !row.cells.I
    );

    const rowsById = new Map(workbook.dataRows.map((row) => [row.cells.A, row.cells]));
    checks.xlsx_edge_mapped_by_polarity = cases
      .filter((testCase) => testCase.case_type === 'Edge')
      .every((testCase) => {
        const cells = rowsById.get(testCase.case_id);
        const expected = testCase.edge_polarity === 'valid' ? 'Positive' : 'Negative';
        return (
          cells && cells.D === expected && cells.G === `[Edge Case] ${testCase.expected_result}`
        );
      });
    checks.xlsx_plain_rows_verbatim = cases
      .filter((testCase) => testCase.case_type !== 'Edge')
      .every((testCase) => {
        const cells = rowsById.get(testCase.case_id);
        return cells && cells.D === testCase.case_type && cells.G === testCase.expected_result;
      });
  }

  return checks;
}

function distribution(cases) {
  const counts = { Positive: 0, Negative: 0, Edge: 0 };
  const polarity = { valid: 0, invalid: 0 };
  for (const testCase of cases) {
    counts[testCase.case_type] = (counts[testCase.case_type] ?? 0) + 1;
    if (testCase.edge_polarity) polarity[testCase.edge_polarity] += 1;
  }
  return { counts, polarity };
}

async function runSet(set) {
  line(`\n${'='.repeat(78)}\nSET ${set.id}  ${set.name}`);
  line(`scenarios: ${set.scenarios.join('; ')}\n`);

  const record = {
    set: set.id,
    name: set.name,
    scenarios: set.scenarios,
    expectations: set.expectations,
  };

  /* --- extract ----------------------------------------------------------- */
  let started = Date.now();
  const extractResponse = await fetch(`${BASE}/api/extract`, {
    method: 'POST',
    body: uploadFor(set),
  });
  const extracted = await extractResponse.json();
  line(`extract   ${Date.now() - started}ms  HTTP ${extractResponse.status}`);

  if (extractResponse.status !== 200) {
    record.failed_at = 'extract';
    record.error = extracted.error;
    line(`  FAILED: ${JSON.stringify(extracted.error)}`);
    return record;
  }

  record.documents = extracted.documents;
  record.requirements = extracted.requirements;
  record.extraction_warnings = extracted.warnings;

  line(
    `          ${extracted.documents.length} documents, ${extracted.requirements.length} requirements`
  );
  for (const requirement of extracted.requirements) {
    line(`  ${requirement.requirement_id} [${requirement.category}] ${requirement.title}`);
    line(`      ${requirement.description}`);
    for (const note of requirement.ambiguities) line(`      ~ ambiguity: ${note}`);
    for (const conflict of requirement.conflicts) line(`      ! conflict: ${conflict.message}`);
  }
  for (const warning of extracted.warnings ?? []) {
    line(`  ! ${warning.code}: ${warning.message}`);
  }

  const documentIds = new Set(extracted.documents.map((document) => document.document_id));
  const requirementIds = new Set(extracted.requirements.map((r) => r.requirement_id));

  const canonical = {
    project: { project_name: set.name, sit_scope: [] },
    documents: extracted.documents,
    requirements: extracted.requirements,
    test_cases: [],
  };

  /* --- generate ---------------------------------------------------------- */
  const { response: generateResponse, body: generated } = await generateWithRetry(canonical);

  if (generateResponse.status !== 200) {
    record.failed_at = 'generate';
    record.error = generated.error;
    line(`  FAILED: ${generated.error?.code}: ${generated.error?.message}`);
    return record;
  }

  canonical.project = generated.project;
  canonical.test_cases = generated.test_cases;
  record.project = generated.project;
  record.test_cases = generated.test_cases;
  record.generation_warnings = generated.warnings;
  record.metadata = generated.metadata;
  record.distribution = distribution(generated.test_cases);

  const { counts, polarity } = record.distribution;
  line(
    `          ${generated.metadata.provider}/${generated.metadata.model}  ` +
      `${generated.test_cases.length} cases  ` +
      `P${counts.Positive}/N${counts.Negative}/E${counts.Edge} ` +
      `(edge valid ${polarity.valid}, invalid ${polarity.invalid})  ` +
      `tokens ${generated.metadata.usage?.input_tokens}in/${generated.metadata.usage?.output_tokens}out`
  );

  line(`\n  PROJECT DESCRIPTION: ${generated.project.project_description}`);
  line(`\n  PROJECT SUMMARY: ${generated.project.project_summary}`);
  line(`\n  QA GUIDANCE: ${generated.project.qa_guidance}`);
  line(`\n  PROJECT BACKGROUND: ${generated.project.project_background}`);
  line(`\n  SIT SCOPE:`);
  for (const point of generated.project.sit_scope) line(`    - ${point}`);

  line(`\n  TEST CASES:`);
  for (const testCase of generated.test_cases) {
    const edge = testCase.edge_polarity ? `/${testCase.edge_polarity}` : '';
    const trace = testCase.source_references
      .map((reference) => reference.document_id + (reference.page ? ` p${reference.page}` : ''))
      .join(', ');
    line(
      `    ${testCase.case_id} [${testCase.case_type}${edge}] ${testCase.priority} ${testCase.type} ` +
        `confidence=${testCase.confidence}  <- ${testCase.requirement_ids.join(', ') || '(none)'}  src=${trace || '(none)'}`
    );
    line(`      TC: ${testCase.test_case}`);
    line(`      ER: ${testCase.expected_result}`);
  }
  for (const warning of generated.warnings ?? []) {
    line(
      `  ! ${warning.code}${warning.requirement_id ? ` (${warning.requirement_id})` : ''}: ${warning.message}`
    );
  }

  /* --- traceability ------------------------------------------------------ */
  record.traceability = extracted.requirements.map((requirement) => ({
    requirement_id: requirement.requirement_id,
    title: requirement.title,
    test_cases: generated.test_cases
      .filter((testCase) => testCase.requirement_ids.includes(requirement.requirement_id))
      .map((testCase) => testCase.case_id),
  }));

  line(`\n  TRACEABILITY:`);
  for (const entry of record.traceability) {
    line(`    ${entry.requirement_id} -> ${entry.test_cases.join(', ') || '(none)'}`);
  }

  /* --- validate ---------------------------------------------------------- */
  started = Date.now();
  const validateResponse = await post(
    useSemantic ? '/api/validate?semantic=true' : '/api/validate',
    canonical
  );
  const validation = await validateResponse.json();
  record.validation = validation;
  line(
    `\nvalidate  ${Date.now() - started}ms  HTTP ${validateResponse.status}  valid=${validation.valid}  ` +
      `rules=${validation.semantic?.heuristics} ai=${validation.semantic?.llm}`
  );
  if (validation.semantic?.error)
    line(`  review error: ${JSON.stringify(validation.semantic.error)}`);
  for (const issue of validation.schema_issues ?? [])
    line(`  SCHEMA ${issue.path}: ${issue.message}`);
  for (const issue of validation.reference_issues ?? []) line(`  REF ${JSON.stringify(issue)}`);
  for (const issue of validation.semantic_warnings ?? []) {
    line(
      `  [${issue.severity}] ${issue.category} ${issue.testcase_id ?? ''} ${issue.requirement_id ?? ''} ` +
        `(${issue.detected_by.join('+')}): ${issue.explanation}`
    );
  }
  line(`  uncovered: ${(validation.coverage?.uncovered ?? []).join(', ') || '(none)'}`);

  /* --- export ------------------------------------------------------------ */
  const beforeExport = JSON.stringify(canonical.test_cases);
  const exportResponse = await post('/api/export', canonical);
  let workbook = null;

  if (exportResponse.status === 200) {
    const buffer = Buffer.from(await exportResponse.arrayBuffer());
    workbook = inspectWorkbook(buffer);
    const file = join(OUT, `set-${set.id}.xlsx`);
    writeFileSync(file, buffer);
    record.export = {
      status: 200,
      bytes: buffer.length,
      rows: Number(exportResponse.headers.get('x-qatool-row-count')),
      file,
      canonical_untouched: JSON.stringify(canonical.test_cases) === beforeExport,
    };
    line(`\nexport    HTTP 200  ${record.export.rows} rows  ${buffer.length} bytes  -> ${file}`);
  } else {
    const body = await exportResponse.json().catch(() => ({}));
    record.export = { status: exportResponse.status, error: body.error };
    line(`\nexport    HTTP ${exportResponse.status}  ${JSON.stringify(body.error)}`);
  }

  record.checks = mechanicalChecks(canonical, requirementIds, documentIds, validation, workbook);
  const failed = Object.entries(record.checks).filter(([, ok]) => !ok);
  line(
    `\nchecks    ${Object.keys(record.checks).length - failed.length}/${Object.keys(record.checks).length} passed` +
      (failed.length ? `  FAILED: ${failed.map(([name]) => name).join(', ')}` : '')
  );

  return record;
}

/* ------------------------------------------------------------------------ */

mkdirSync(OUT, { recursive: true });

const selected = FIXTURE_SETS.filter((set) => !only || only.includes(set.id));
line(
  `QATOOL quality evaluation - ${selected.length} set(s), semantic review ${useSemantic ? 'on' : 'off'}`
);
line(`server ${BASE}, output ${OUT}`);

const records = [];
for (const set of selected) {
  try {
    records.push(await runSet(set));
  } catch (error) {
    line(`\nSET ${set.id} threw: ${error.message}`);
    records.push({
      set: set.id,
      name: set.name,
      failed_at: 'harness',
      error: String(error.message),
    });
  }
  writeFileSync(join(OUT, 'evaluation.json'), JSON.stringify(records, null, 2));
}

line(`\n${'='.repeat(78)}\nSUMMARY`);
for (const record of records) {
  if (record.failed_at) {
    line(`  ${record.set}  FAILED at ${record.failed_at}: ${record.error?.code ?? record.error}`);
    continue;
  }
  const { counts } = record.distribution;
  const failed = Object.entries(record.checks).filter(([, ok]) => !ok).length;
  line(
    `  ${record.set}  ${record.requirements.length} reqs -> ${record.test_cases.length} cases ` +
      `(P${counts.Positive}/N${counts.Negative}/E${counts.Edge}), ` +
      `${record.validation?.semantic_warnings?.length ?? 0} semantic findings, ` +
      `${failed ? `${failed} mechanical checks FAILED` : 'mechanical checks passed'}`
  );
}
line(`\nwritten to ${join(OUT, 'evaluation.json')}`);
