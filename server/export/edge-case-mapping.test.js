import test from 'node:test';
import assert from 'node:assert/strict';
import {
  checkExportable,
  exportWarnings,
  EDGE_CASE_PREFIX,
  ExportMappingError,
  mapTestCaseToRow,
  toTemplateCaseType,
  toTemplateExpectedResult,
} from './edge-case-mapping.js';
import {
  preMarkedEdgeCase,
  sampleTestCases,
  unresolvedEdgeCase,
} from './fixtures/sample-test-cases.js';
import { TEMPLATE_CASE_TYPES } from '../schema/enums.js';

const base = {
  case_id: 'TC-001',
  section: 'Transfer Limits',
  test_case: 'Verify something.',
  priority: 'High',
  type: 'Functional',
  expected_result: 'Transaction is accepted at the maximum allowed amount.',
};

test('non-Edge case types pass through unchanged', () => {
  assert.equal(
    toTemplateCaseType({ ...base, case_type: 'Positive', edge_polarity: null }),
    'Positive'
  );
  assert.equal(
    toTemplateCaseType({ ...base, case_type: 'Negative', edge_polarity: null }),
    'Negative'
  );
});

test('Edge with a valid boundary exports as Positive', () => {
  assert.equal(
    toTemplateCaseType({ ...base, case_type: 'Edge', edge_polarity: 'valid' }),
    'Positive'
  );
});

test('Edge with an invalid boundary exports as Negative', () => {
  assert.equal(
    toTemplateCaseType({ ...base, case_type: 'Edge', edge_polarity: 'invalid' }),
    'Negative'
  );
});

/**
 * The direction is never guessed - but the row is no longer lost either. An
 * Edge case whose polarity is still open exports as 'Edge': the value the draft
 * actually holds, in the cell it belongs in, for a reviewer to resolve.
 * Choosing Positive or Negative here would invent the judgement the field
 * exists to record, and could turn a boundary-rejection test into a success
 * path.
 */
test('Edge with no polarity exports as Edge rather than guessing a direction', () => {
  assert.equal(toTemplateCaseType({ ...base, case_type: 'Edge', edge_polarity: null }), 'Edge');
});

test('Edge with an unrecognised polarity is never mapped to a template value', () => {
  const mapped = toTemplateCaseType({ ...base, case_type: 'Edge', edge_polarity: 'borderline' });

  assert.equal(mapped, 'Edge');
  assert.ok(!TEMPLATE_CASE_TYPES.includes(mapped), 'it was not coerced into the dropdown');
});

test('a case with no case type at all is still a structural failure', () => {
  assert.throws(
    () => toTemplateCaseType({ ...base, case_id: 'TC-009', case_type: '   ' }),
    (error) => error instanceof ExportMappingError && error.caseId === 'TC-009'
  );
});

test('Edge rows are prefixed, others are not', () => {
  assert.equal(
    toTemplateExpectedResult({ ...base, case_type: 'Edge', edge_polarity: 'valid' }),
    `${EDGE_CASE_PREFIX}Transaction is accepted at the maximum allowed amount.`
  );
  assert.equal(
    toTemplateExpectedResult({ ...base, case_type: 'Positive', edge_polarity: null }),
    'Transaction is accepted at the maximum allowed amount.'
  );
});

test('the prefix is idempotent, including hand-typed variants', () => {
  const variants = [
    '[Edge Case] Already marked.',
    '[edge case] Already marked.',
    '  [Edge Case]  Already marked.',
  ];

  for (const expected_result of variants) {
    const result = toTemplateExpectedResult({
      ...base,
      case_type: 'Edge',
      edge_polarity: 'valid',
      expected_result,
    });
    assert.equal(result, expected_result, `'${expected_result}' must not be prefixed again`);
    assert.equal(
      (result.match(/\[edge case\]/gi) ?? []).length,
      1,
      'exactly one marker should remain'
    );
  }
});

test('mapping never mutates the canonical test case', () => {
  const testCase = { ...base, case_type: 'Edge', edge_polarity: 'valid' };
  const snapshot = JSON.stringify(testCase);
  mapTestCaseToRow(testCase);
  assert.equal(JSON.stringify(testCase), snapshot, 'the prefix must not leak back into the model');
});

test('execution fields map to blank', () => {
  const row = mapTestCaseToRow({
    ...base,
    case_type: 'Positive',
    edge_polarity: null,
    status: 'PASSED',
    tested_by: 'Kelvin',
  });
  assert.equal(row.status, '', 'Status is reserved for SIT execution');
  assert.equal(row.tested_by, '', 'Tested By is reserved for SIT execution');
});

test('checkExportable does not block an unresolved Edge case', () => {
  assert.deepEqual(checkExportable(unresolvedEdgeCase), [], 'a classification never blocks');
});

test('an unresolved Edge case is reported as a warning instead', () => {
  const [warning] = exportWarnings(unresolvedEdgeCase);

  assert.equal(warning.code, 'EDGE_POLARITY_UNRESOLVED_EXPORTED');
  assert.equal(warning.case_id, 'TC-007');
  assert.equal(warning.field, 'edge_polarity');
  assert.equal(warning.observed_value, null);
  assert.match(warning.message, /no polarity was inferred/);
  assert.match(warning.message, /QA review required/);
});

test('checkExportable reports an empty expected result', () => {
  const issues = checkExportable({ ...base, case_type: 'Positive', expected_result: '   ' });
  assert.deepEqual(
    issues.map((issue) => issue.code),
    ['EXPECTED_RESULT_EMPTY']
  );
});

test('every fixture passes its export pre-flight', () => {
  for (const testCase of [...sampleTestCases, preMarkedEdgeCase]) {
    assert.deepEqual(checkExportable(testCase), [], `${testCase.case_id} should be exportable`);
  }
});

/**
 * The export policy for classification.
 *
 * Generation keeps a draft whose case type or priority is outside the
 * recommended vocabulary, because it still tells a reviewer what to test.
 * Export now keeps it too. Blocking the workbook meant one imperfect label cost
 * QA every other row in the file, and coercing it would settle a classification
 * nobody looked at. So the drafted value is written to the cell and the case is
 * named in a warning - a visible odd value beats a corrected one or no file.
 */
test('an unrecognised case type does not block the export', () => {
  assert.deepEqual(checkExportable({ ...base, case_type: 'Positiv', edge_polarity: null }), []);
});

test('an unrecognised case type is reported as a warning and preserved', () => {
  const [warning] = exportWarnings({ ...base, case_type: 'Positiv', edge_polarity: null });

  assert.equal(warning.code, 'UNRECOGNIZED_CASE_TYPE_EXPORTED');
  assert.equal(warning.field, 'case_type');
  assert.equal(warning.observed_value, 'Positiv');
  assert.match(warning.message, /preserved unchanged/);
  assert.match(warning.message, /QA review required/);
});

test('an unrecognised priority does not block the export', () => {
  assert.deepEqual(checkExportable({ ...base, case_type: 'Positive', priority: 'Urgent' }), []);
});

test('an unrecognised priority is reported as a warning and preserved', () => {
  const [warning] = exportWarnings({ ...base, case_type: 'Positive', priority: 'Urgent' });

  assert.equal(warning.code, 'UNRECOGNIZED_PRIORITY_EXPORTED');
  assert.equal(warning.observed_value, 'Urgent');
  assert.match(warning.message, /preserved unchanged/);
});

test('checkExportable still blocks a case with nothing to test', () => {
  assert.deepEqual(
    checkExportable({ ...base, case_type: 'Positive', test_case: '  ' }).map((i) => i.code),
    ['TEST_CASE_EMPTY']
  );
});

test('checkExportable accepts Edge, which the mapping downgrades legitimately', () => {
  const issues = checkExportable({ ...base, case_type: 'Edge', edge_polarity: 'invalid' });
  assert.deepEqual(issues, []);
});

test('every questionable field on a case is warned about at once', () => {
  const warnings = exportWarnings({ ...base, case_type: 'Positiv', priority: 'Urgent' });

  assert.deepEqual(warnings.map((w) => w.code).sort(), [
    'UNRECOGNIZED_CASE_TYPE_EXPORTED',
    'UNRECOGNIZED_PRIORITY_EXPORTED',
  ]);
});

test('a clean case produces no export warnings at all', () => {
  for (const testCase of [...sampleTestCases, preMarkedEdgeCase]) {
    assert.deepEqual(exportWarnings(testCase), [], `${testCase.case_id} is clean`);
  }
});

test('toTemplateCaseType preserves an unknown case type rather than coercing it', () => {
  assert.equal(toTemplateCaseType({ ...base, case_id: 'TC-009', case_type: 'Positiv' }), 'Positiv');
});

test('a preserved value is never one of the dropdown values by accident', () => {
  const row = mapTestCaseToRow({ ...base, case_type: 'Positiv', priority: 'Urgent' });

  assert.equal(row.case_type, 'Positiv', 'written exactly as drafted');
  assert.equal(row.priority, 'Urgent');
});
