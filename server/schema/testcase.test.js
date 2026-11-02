import test from 'node:test';
import assert from 'node:assert/strict';
import { testCaseSchema } from './testcase.js';
import { CLASSIFICATION_WARNINGS, classificationFindings } from './classification.js';
import { CASE_TYPES, CLASSIFICATION_MAX_LENGTH, TEMPLATE_CASE_TYPES } from './enums.js';

function validTestCase(overrides = {}) {
  return {
    case_id: 'TC-001',
    requirement_ids: ['REQ-001'],
    section: 'Participant Status Routing',
    test_case: 'Verify transaction rejection for a Suspended participant.',
    case_type: 'Negative',
    edge_polarity: null,
    priority: 'High',
    type: 'Functional',
    expected_result: 'Transaction is rejected with reason code U253.',
    source_references: [],
    confidence: 'High',
    warnings: [],
    status: null,
    tested_by: null,
    order_index: 0,
    ...overrides,
  };
}

function issuePaths(result) {
  return result.error.issues.map((issue) => issue.path.join('.'));
}

test('Edge is an internal case type and is absent from the template vocabulary', () => {
  assert.ok(CASE_TYPES.includes('Edge'));
  assert.ok(!TEMPLATE_CASE_TYPES.includes('Edge'));
  assert.deepEqual(TEMPLATE_CASE_TYPES, ['Positive', 'Negative']);
});

test('accepts an Edge case carrying a valid-boundary polarity', () => {
  const result = testCaseSchema.safeParse(
    validTestCase({ case_type: 'Edge', edge_polarity: 'valid' })
  );
  assert.ok(result.success, JSON.stringify(result.error?.issues));
  assert.equal(result.data.edge_polarity, 'valid');
});

test('accepts an Edge case carrying an invalid-boundary polarity', () => {
  const result = testCaseSchema.safeParse(
    validTestCase({ case_type: 'Edge', edge_polarity: 'invalid' })
  );
  assert.ok(result.success, JSON.stringify(result.error?.issues));
});

/**
 * The canonical model carries drafts; it does not grade them.
 *
 * These three used to be fatal here, and the case was deleted. That cost a
 * reviewer a usable draft over a label they would have fixed with a dropdown,
 * and told them nothing about what had gone. The rule that produced them is not
 * gone - it moved to classification.js, where it produces a warning - and the
 * consequence it protects against is enforced at the point where it actually
 * bites, in export. See the tests below each case.
 */
test('keeps an Edge case with no polarity, rather than defaulting or deleting one', () => {
  const result = testCaseSchema.safeParse(
    validTestCase({ case_type: 'Edge', edge_polarity: null })
  );

  assert.ok(result.success, 'the draft survives');
  assert.equal(result.data.edge_polarity, null, 'and no polarity was invented for it');

  const finding = classificationFindings(result.data);
  assert.deepEqual(
    finding.map((entry) => entry.code),
    [CLASSIFICATION_WARNINGS.EDGE_POLARITY_MISSING],
    'QA is told instead'
  );
});

test('keeps a polarity on a non-Edge case without clearing it', () => {
  const result = testCaseSchema.safeParse(
    validTestCase({ case_type: 'Positive', edge_polarity: 'valid' })
  );

  assert.ok(result.success);
  assert.equal(result.data.edge_polarity, 'valid', 'not nulled to make it fit');
  assert.equal(result.data.case_type, 'Positive', 'and not promoted to Edge either');

  assert.deepEqual(
    classificationFindings(result.data).map((entry) => entry.code),
    [CLASSIFICATION_WARNINGS.EDGE_POLARITY_ON_NON_EDGE]
  );
});

test('keeps an unrecognised polarity value and quotes it back', () => {
  const result = testCaseSchema.safeParse(
    validTestCase({ case_type: 'Edge', edge_polarity: 'boundary' })
  );

  assert.ok(result.success);
  assert.equal(result.data.edge_polarity, 'boundary');

  const [finding] = classificationFindings(result.data);
  assert.equal(finding.code, CLASSIFICATION_WARNINGS.UNRECOGNIZED_EDGE_POLARITY);
  assert.equal(finding.observed_value, 'boundary', 'the reviewer sees what the model wrote');
});

test('keeps an unrecognised case type and names the recommended vocabulary', () => {
  const result = testCaseSchema.safeParse(validTestCase({ case_type: 'Positiv' }));

  assert.ok(result.success);
  assert.equal(result.data.case_type, 'Positiv', 'not corrected to Positive');

  const [finding] = classificationFindings(result.data);
  assert.equal(finding.code, CLASSIFICATION_WARNINGS.UNRECOGNIZED_CASE_TYPE);
  assert.equal(finding.field, 'case_type');
  assert.match(finding.message, /Positive \/ Negative \/ Edge/);
});

test('keeps an unrecognised priority', () => {
  const result = testCaseSchema.safeParse(validTestCase({ priority: 'Urgent' }));

  assert.ok(result.success);
  assert.equal(result.data.priority, 'Urgent', 'not mapped onto High');

  const [finding] = classificationFindings(result.data);
  assert.equal(finding.code, CLASSIFICATION_WARNINGS.UNRECOGNIZED_PRIORITY);
});

/**
 * The line between a questionable label and an unusable one. A word nobody
 * recognises is still a label; a paragraph is a field that has been filled in
 * with the wrong thing entirely, and nothing downstream can render it.
 */
test('still rejects a classification value that is not a label at all', () => {
  const result = testCaseSchema.safeParse(
    validTestCase({ case_type: 'x'.repeat(CLASSIFICATION_MAX_LENGTH + 1) })
  );

  assert.equal(result.success, false);
  assert.deepEqual(issuePaths(result), ['case_type']);
});

test('still rejects an empty classification value', () => {
  assert.equal(testCaseSchema.safeParse(validTestCase({ case_type: '   ' })).success, false);
  assert.equal(testCaseSchema.safeParse(validTestCase({ priority: '' })).success, false);
});

test('a clean case produces no classification findings at all', () => {
  const result = testCaseSchema.safeParse(
    validTestCase({ case_type: 'Edge', edge_polarity: 'invalid' })
  );

  assert.ok(result.success);
  assert.deepEqual(classificationFindings(result.data), []);
});

test('storage fields are gone from the model', () => {
  // Nothing is persisted, so there is no primary key and no row lifecycle.
  for (const field of ['id', 'project_id', 'created_at', 'updated_at']) {
    const result = testCaseSchema.safeParse(validTestCase({ [field]: 'anything' }));
    assert.equal(result.success, false, `'${field}' should no longer be accepted`);
  }
});

test('rejects unknown fields instead of silently dropping them', () => {
  const result = testCaseSchema.safeParse(validTestCase({ automation_ready: true }));
  assert.equal(result.success, false);
});

test('requires a non-empty expected result', () => {
  const result = testCaseSchema.safeParse(validTestCase({ expected_result: '   ' }));
  assert.equal(result.success, false);
  assert.deepEqual(issuePaths(result), ['expected_result']);
});

test('requires requirement ids to be well formed', () => {
  const result = testCaseSchema.safeParse(validTestCase({ requirement_ids: ['REQ-1'] }));
  assert.equal(result.success, false);
});

test('Type is a controlled string, not an enum', () => {
  // The template defines no vocabulary for this column, so the schema accepts
  // whatever the business actually uses rather than a taxonomy invented here.
  for (const value of ['Functional', 'Integration', 'Reconciliation', 'Non-Functional']) {
    const result = testCaseSchema.safeParse(validTestCase({ type: value }));
    assert.ok(result.success, `expected '${value}' to be accepted`);
  }
});

test('Type still rejects empty and over-long values', () => {
  assert.equal(testCaseSchema.safeParse(validTestCase({ type: '   ' })).success, false);
  assert.equal(testCaseSchema.safeParse(validTestCase({ type: 'x'.repeat(101) })).success, false);
});

test('Type defaults to the value the template demonstrates', () => {
  const { type, ...withoutType } = validTestCase();
  const result = testCaseSchema.safeParse(withoutType);
  assert.ok(result.success, JSON.stringify(result.error?.issues));
  assert.equal(result.data.type, 'Functional');
});

test('optional fields fall back to safe defaults', () => {
  const { confidence, status, tested_by, ...sparse } = validTestCase();
  const result = testCaseSchema.safeParse(sparse);
  assert.ok(result.success, JSON.stringify(result.error?.issues));
  assert.equal(result.data.confidence, 'Medium');
  assert.equal(result.data.status, null, 'execution status is never pre-filled');
  assert.equal(result.data.tested_by, null);
});

test('the approval model is gone from the test case', () => {
  // QATOOL V1 is a batch generator, not a review system: final human review
  // happens in Excel after export.
  const result = testCaseSchema.safeParse(validTestCase({ review_status: 'Approved' }));
  assert.equal(result.success, false, 'review_status should no longer be accepted');
});
