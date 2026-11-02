/**
 * Export fixtures.
 *
 * Deliberately hand-written rather than LLM-generated: this component has to be
 * provable on its own, before any extraction or generation exists. The wording
 * follows PRD 11/12 (action-oriented test cases, observable expected results)
 * and the subject matter mirrors the BI-FAST material in the supplied template.
 *
 * Covers every branch of the export mapping:
 *
 *   Positive        -> Positive, unprefixed
 *   Negative        -> Negative, unprefixed
 *   Edge / valid    -> Positive, '[Edge Case] ' prefixed
 *   Edge / invalid  -> Negative, '[Edge Case] ' prefixed
 */
function testCase(index, overrides) {
  return {
    case_id: `TC-${String(index).padStart(3, '0')}`,
    requirement_ids: ['REQ-001'],
    section: 'Real Time Bulk Credit Transfer',
    case_type: 'Positive',
    edge_polarity: null,
    priority: 'High',
    type: 'Functional',
    source_references: [
      { document_id: 'DOC-001', page: 4, section: 'Business Rules', quote: null },
    ],
    confidence: 'High',
    warnings: [],
    status: null,
    tested_by: null,
    order_index: index - 1,
    ...overrides,
  };
}

export const sampleTestCases = [
  testCase(1, {
    test_case: 'Verify a Bulk Credit Transfer to a different bank completes successfully.',
    case_type: 'Positive',
    expected_result:
      '1. BCT message: status SUCCESS, reason code U000\n' +
      '2. BCT status: SUCCESS, and recorded in BI-FAST Portal\n' +
      '3. Recorded in transaction history BI-FAST Portal and related Report',
  }),

  testCase(2, {
    test_case:
      'Verify rejection of a Bulk Credit Transfer missing a mandatory field such as BIC code.',
    case_type: 'Negative',
    expected_result:
      '1. BCT message: status RJCT, reason code ADMI 002, error code 0001\n' +
      '2. BCT status: RJCT, and recorded in BI-FAST Portal',
  }),

  testCase(3, {
    section: 'Transfer Limits',
    test_case: 'Verify a Bulk Credit Transfer of exactly 50 transactions is accepted.',
    case_type: 'Edge',
    edge_polarity: 'valid',
    expected_result:
      'Transfer completes at the maximum permitted batch size, with BCT status SUCCESS and reason code U000 recorded in the BI-FAST Portal.',
  }),

  testCase(4, {
    section: 'Transfer Limits',
    test_case: 'Verify rejection of a Bulk Credit Transfer exceeding 1000 transactions.',
    case_type: 'Edge',
    edge_polarity: 'invalid',
    priority: 'Medium',
    expected_result:
      'Transfer is rejected with "File LoadApplication: End of file script code returned false" and no transactions are posted.',
  }),

  testCase(5, {
    section: 'Participant Status Routing',
    test_case: 'Verify transaction rejection for a Suspended participant.',
    case_type: 'Negative',
    priority: 'Critical',
    // Exercises the XML escaping path: ampersands, angle brackets and quotes
    // all reach a cell intact.
    expected_result:
      'Transaction is rejected with reason code U253 & the "Suspended" status is retained; amount < limit is not evaluated.',
  }),
];

/** An Edge case a reviewer already marked by hand - the prefix must not double. */
export const preMarkedEdgeCase = testCase(6, {
  section: 'Transfer Limits',
  test_case: 'Verify acceptance at the maximum permitted transfer amount.',
  case_type: 'Edge',
  edge_polarity: 'valid',
  expected_result: '[Edge Case] Transaction is accepted at the maximum allowed amount.',
});

/** An Edge case with no polarity - must be refused, never guessed. */
export const unresolvedEdgeCase = testCase(7, {
  section: 'Transfer Limits',
  test_case: 'Verify behaviour at the transfer boundary.',
  case_type: 'Edge',
  edge_polarity: null,
  expected_result: 'Something happens at the boundary.',
});
