import assert from 'node:assert/strict';

import { EXPECTED, REFUND_PRD } from './realistic-scenario.js';

/**
 * What a correct run of the refund scenario looks like, from the upload to the
 * workbook. One set of assertions for every way the scenario is run - through a
 * fake gateway, and through the real Apayee - so they cannot drift apart.
 *
 * Each check is about a property QATOOL owns and must keep when the model is
 * reached through a gateway: the requirement text is the document's, not the
 * model's; traceability is derived; the workbook carries what was generated.
 */

const RULE_SENTENCES = REFUND_PRD.filter((block) => block.text?.includes('must')).map(
  (block) => block.text
);

/**
 * The office template's header row, exactly as the pinned template spells it -
 * including "Exected Result". The exporter reproduces the template, so a test
 * that expected the corrected spelling would be asking it to change the template.
 */
export const WORKBOOK_HEADERS = [
  'Case ID',
  'Section',
  'Test Case',
  'Case Type',
  'Priority',
  'Type',
  'Exected Result',
  'Status',
  'Tested By',
];

/** @param {Awaited<ReturnType<import('./pipeline-run.js').runPipeline>>} run */
export function assertRefundScenario(run, { provider }) {
  assertStructuring(run, provider);
  assertGeneration(run, provider);
  assertReview(run);
  assertWorkbook(run);
}

function assertStructuring({ extract, extracted }, provider) {
  assert.equal(extract.statusCode, 200, extract.body);

  const { structuring, requirements } = extracted;
  assert.equal(structuring.mode, 'ai', 'structuring did not fall back to deterministic extraction');
  assert.equal(structuring.provider, provider);
  assert.equal(structuring.supporting_blocks.total, EXPECTED.supportingBlockCount);

  assert.deepEqual(
    requirements.map((requirement) => requirement.title),
    EXPECTED.titles,
    'the model’s handles, one per rule'
  );
  assert.deepEqual(
    requirements.map((requirement) => requirement.requirement_id),
    ['REQ-001', 'REQ-002', 'REQ-003', 'REQ-004']
  );

  // The model names a requirement; it never writes one. The wording is the document's.
  assert.deepEqual(
    requirements.map((requirement) => requirement.description),
    RULE_SENTENCES
  );
  for (const requirement of requirements) {
    assert.equal(requirement.source_references.length, 1);
    assert.equal(requirement.source_references[0].document_id, 'DOC-001');
    assert.equal(requirement.source_references[0].quote, requirement.description);
    assert.equal(
      requirement.source_references[0].section,
      'Refund Request Service > Business Rules'
    );
  }

  assert.equal(extracted.test_points.length, 6, 'the model’s test points were kept');
  assert.equal(requirements[3].ambiguities.length, 1, 'REQ-004 was marked ambiguous');
  assert.deepEqual(
    requirements.slice(0, 3).map((requirement) => requirement.ambiguities),
    [[], [], []]
  );
}

function assertGeneration({ extracted, generate, generated }, provider) {
  assert.equal(generate.statusCode, 200, generate.body);

  const cases = generated.test_cases;
  assert.equal(cases.length, EXPECTED.testCaseCount);
  assert.deepEqual(
    cases.map((testCase) => testCase.case_id),
    ['TC-001', 'TC-002', 'TC-003', 'TC-004', 'TC-005', 'TC-006', 'TC-007'],
    'ids are assigned by QATOOL, in order, with no gaps'
  );
  assert.equal(generated.metadata.provider, provider);

  const byId = new Map(extracted.requirements.map((r) => [r.requirement_id, r]));
  for (const testCase of cases) {
    assert.equal(testCase.requirement_ids.length, 1);
    const requirement = byId.get(testCase.requirement_ids[0]);
    assert.ok(requirement, `${testCase.case_id} cites a real requirement`);
    assert.deepEqual(
      testCase.source_references,
      requirement.source_references,
      `${testCase.case_id} traceability is derived from its requirement, not written by the model`
    );
    assert.ok(testCase.test_case.length > 20);
    assert.ok(testCase.expected_result.length > 20);
  }

  assert.deepEqual(
    cases.map((testCase) => testCase.requirement_ids[0]),
    ['REQ-001', 'REQ-002', 'REQ-002', 'REQ-003', 'REQ-003', 'REQ-004', 'REQ-004']
  );
  assert.equal(
    cases.filter((testCase) => testCase.case_type === 'Edge').length,
    EXPECTED.edgeCaseCount
  );

  for (const code of EXPECTED.errorCodes) {
    assert.ok(
      cases.some((testCase) => testCase.expected_result.includes(code)),
      `a case states ${code}`
    );
  }

  const { metadata } = generated;
  assert.equal(metadata.requirements_covered, EXPECTED.requirementCount);
  assert.equal(metadata.obligations_total, 5);
  assert.equal(metadata.obligations_covered, 5);
  assert.equal(metadata.obligations_uncovered, 0);
  assert.equal(metadata.discarded_invalid, 0);
  assert.deepEqual(
    generated.warnings.map((warning) => warning.code),
    ['OBLIGATION_NOT_DERIVED'],
    'the one honest warning: REQ-001 states no separate obligation'
  );
}

function assertReview({ validated }) {
  assert.equal(validated.valid, true, JSON.stringify(validated.schema_issues));
  assert.deepEqual(validated.reference_issues, []);
  assert.equal(validated.semantic.llm, 'completed');

  // Exactly the reviewer's one finding: the heuristics find nothing to add, and
  // it points at a real test case, so it was kept and not discarded as unanchored.
  assert.equal(validated.semantic.discarded_issues, 0);
  assert.equal(validated.semantic_warnings.length, 1);
  const [finding] = validated.semantic_warnings;
  assert.equal(finding.category, 'unsupported_behavior');
  assert.equal(finding.testcase_id, 'TC-003');
  assert.equal(finding.requirement_id, 'REQ-002');
  assert.deepEqual(finding.detected_by, ['llm']);

  assert.equal(validated.coverage.summary.requirement_covered, EXPECTED.requirementCount);
  assert.deepEqual(validated.coverage.uncovered, []);
}

function assertWorkbook({ generated, exported, workbook }) {
  assert.equal(exported.statusCode, 200, exported.body);
  assert.equal(
    exported.headers['content-type'],
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  );
  assert.match(exported.headers['content-disposition'], /^attachment; filename="[^"]+\.xlsx"$/);
  assert.equal(exported.headers['x-qatool-row-count'], String(EXPECTED.testCaseCount));

  assert.deepEqual(Object.values(workbook.headerRow), WORKBOOK_HEADERS);
  assert.equal(workbook.dataRows.length, EXPECTED.testCaseCount);
  assert.equal(workbook.tableRef, `C2:C${EXPECTED.testCaseCount + 1}`, 'the table spans every row');
  assert.ok(workbook.validations.length > 0, 'the template’s dropdowns survived');
  assert.ok(workbook.hasDrawing, 'the template’s drawing reference survived');

  const cases = generated.test_cases;
  workbook.dataRows.forEach((row, index) => {
    const testCase = cases[index];
    const { A, B, C, D, E, F, G, H, I } = row.cells;

    assert.equal(A, testCase.case_id);
    assert.equal(B, testCase.section);
    assert.equal(C, testCase.test_case);
    assert.equal(E, testCase.priority);
    assert.equal(F, testCase.type);
    assert.equal(H, '', `row ${row.row}: Status is left for the tester`);
    assert.equal(I, '', `row ${row.row}: Tested By is left for the tester`);

    // The workbook has no Edge column value: a valid boundary is a Positive row, an
    // invalid one a Negative, and both are marked in the expected-result text.
    if (testCase.case_type === 'Edge') {
      assert.equal(D, testCase.edge_polarity === 'valid' ? 'Positive' : 'Negative');
      assert.equal(G, `[Edge Case] ${testCase.expected_result}`);
    } else {
      assert.equal(D, testCase.case_type);
      assert.equal(G, testCase.expected_result);
    }
  });

  const rowFor = (id) => workbook.dataRows.find((row) => row.cells.A === id).cells;
  assert.equal(rowFor('TC-002').D, 'Negative');
  assert.match(rowFor('TC-002').G, /RFD-101/);
  assert.match(rowFor('TC-004').G, /RFD-204/);
  assert.match(rowFor('TC-003').G, /^\[Edge Case\] /);
  assert.match(rowFor('TC-006').G, /5 minutes/);
}

/**
 * Checks a scripted reply against the `required` and `enum` rules of the schema it
 * answers, so a reply that a validating gateway would reject fails in `npm test`
 * too. It is deliberately not a JSON Schema validator - QATOOL has none, and the
 * real one runs in the opt-in smoke test - only the two rules a reply most easily
 * breaks: a missing required field and a value outside its enum.
 */
export function assertSatisfiesSchema(schema, value, at = '$') {
  if (schema?.enum && !schema.enum.includes(value)) {
    assert.fail(`${at}: ${JSON.stringify(value)} is not one of ${JSON.stringify(schema.enum)}`);
  }

  if (Array.isArray(value)) {
    if (schema.minItems !== undefined)
      assert.ok(value.length >= schema.minItems, `${at}: too few items`);
    if (schema.maxItems !== undefined)
      assert.ok(value.length <= schema.maxItems, `${at}: too many items`);
    value.forEach((item, index) =>
      assertSatisfiesSchema(schema.items ?? {}, item, `${at}[${index}]`)
    );
    return;
  }

  if (value !== null && typeof value === 'object') {
    for (const key of schema.required ?? []) {
      assert.ok(key in value, `${at}: missing required field "${key}"`);
    }
    for (const [key, child] of Object.entries(value)) {
      if (schema.properties?.[key])
        assertSatisfiesSchema(schema.properties[key], child, `${at}.${key}`);
    }
  }
}
