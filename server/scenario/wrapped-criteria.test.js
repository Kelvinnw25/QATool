import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { deriveCoverageObligations, matchObligations } from './obligations.js';

/**
 * Acceptance criteria that a page break cut in half.
 *
 * A PDF gives no indication that a line continues: segments split on newlines,
 * so a criterion whose text wrapped derived an obligation demanding only the
 * words above the break. Measured on the real PRD, on a criterion whose test
 * case covered every word of it:
 *
 *   source     Add a new dropdown field named Settlement
 *              Status: placed directly below the existing
 *              Settlement Type: dropdown: Settled ,
 *              Unsettled , and Settled & Unsettled
 *
 *   obligation Add a new dropdown field named Settlement
 *
 *   test case  The Settlement Status dropdown is placed directly below
 *              Settlement Type with options Settled, Unsettled, and
 *              Settled & Unsettled
 *
 * The obligation asked for seven words, three of which - "add", "field",
 * "named" - are its own framing verb, and scored one short of the bar. Reported
 * as a behaviour nobody tested.
 *
 * The rule rebuilds the criterion instead of loosening the comparison, and the
 * gate is on the criterion, never on the lines below it. Whether a following
 * line LOOKS like a continuation separates nothing: "Current condition in
 * production when opening" is as wrapped as "Status: placed directly below the
 * existing", and belongs to a different sentence. What separates them is
 * whether the criterion itself stopped mid-phrase.
 *
 * The negatives below are the point. Both were absorbed when this was first
 * tried without that gate.
 */

function requirement(description) {
  return {
    requirement_id: 'REQ-001',
    title: 'Advanced search filter',
    description,
    category: 'Business Rule',
    source_references: [{ document_id: 'DOC-001', page: 9, section: null, quote: null }],
    ambiguities: [],
    conflicts: [],
  };
}

function testCase(action, expected) {
  return {
    case_id: 'TC-001',
    requirement_ids: ['REQ-001'],
    test_case: action,
    expected_result: expected,
    case_type: 'Positive',
    edge_polarity: null,
  };
}

const LEAD =
  'GIVEN QR Manager User open Settlement Report menu\n' +
  'WHEN User click Advance Search filter dropdown\n' +
  'THEN the system must fulfill the following:\n';

const criteria = (body) =>
  deriveCoverageObligations([requirement(LEAD + body)]).filter(
    (entry) => entry.type === 'criterion'
  );

// --- Positive -----------------------------------------------------------------

describe('a criterion the page layout cut', () => {
  /** The real block, wrapped exactly where the PDF wraps it. */
  const WRAPPED =
    'Add a new dropdown field named Settlement\n' +
    'Status: placed directly below the existing\n' +
    'Settlement Type: dropdown: Settled ,\n' +
    'Unsettled , and Settled & Unsettled';

  it('is rebuilt from the lines below it', () => {
    const [entry] = criteria(WRAPPED);

    assert.match(entry.statement, /named Settlement Status/, 'the field name is whole again');
    assert.match(entry.statement, /placed directly below/, 'and its stated position');
    assert.match(entry.statement, /Settled , Unsettled/, 'and its options');
  });

  it('keeps the source basis a verbatim contiguous slice', () => {
    const [entry] = criteria(WRAPPED);

    assert.ok(
      (LEAD + WRAPPED).includes(entry.source_basis),
      'rebuilt by index, never by joining segments'
    );
    assert.equal(entry.source_basis, WRAPPED, 'all four lines, exactly as written');
  });

  it('is one obligation, not one per line', () => {
    assert.equal(criteria(WRAPPED).length, 1);
  });

  /** The live test case, word for word. It was reported as covering nothing. */
  it('is covered by the case that states the whole behaviour', () => {
    const [entry] = matchObligations(criteria(WRAPPED), [
      testCase(
        'Verify the presence and filtering functionality of the new Settlement Status dropdown in Advanced Search.',
        'The Settlement Status dropdown is placed directly below Settlement Type with options Settled, Unsettled, and Settled & Unsettled, and filtering displays the respective transactions accordingly.'
      ),
    ]);

    assert.ok(entry.covered, 'the case says every word of the criterion');
  });

  /**
   * The limit of the rule, asserted so it is not mistaken for an oversight. A
   * shouted column name is also cut here - "for RELEASE" / "DATE AND TIME to
   * the table" - and is NOT rejoined, because a shouted name cut in half and a
   * shouted name finishing a sentence ("save the FT NUMBER") cannot be told
   * apart from the line above. The narrower reading leaves both alone.
   */
  it('leaves a shouted name cut across a line break alone', () => {
    const [entry] = criteria(
      ['Add and display new data column for RELEASE', 'DATE AND TIME to the table'].join('\n')
    );

    assert.equal(entry.metadata.criterion, 'Add and display new data column for RELEASE');
  });
});

// --- Negative -----------------------------------------------------------------

describe('a criterion that is already complete', () => {
  /**
   * The first thing absorbed when the gate was missing. "Current condition in
   * production when opening" is a note about today's behaviour, not the tail of
   * the bullet above it - and it is wrapped too, so nothing about the line
   * itself says so.
   */
  it('does not absorb the sentence below it', () => {
    const [entry] = criteria(
      'Load and display the transaction data grid quickly\n' +
        'Current condition in production when opening\n' +
        'Settlement Report menu (cost 28 seconds):'
    );

    assert.equal(entry.metadata.criterion, 'Load and display the transaction data grid quickly');
    assert.doesNotMatch(entry.statement, /Current condition/);
  });

  /**
   * The second. A Notes line is read by the guard, qualifier and bound
   * detectors, and carries no criterion verb of its own - so without the gate
   * it looked exactly like a wrapped tail and was merged into the bullet above.
   *
   * Asserted over every obligation rather than over the criteria, because the
   * Display line is read more specifically as a UI action and the criterion
   * reading of it is deduplicated away.
   */
  it('does not absorb a Notes line', () => {
    const body =
      'Display a Select All checkbox on the page near the transaction list table\n' +
      'Notes: Select All only applies to transactions on the current active page (up to 10 rows per page) and will not select items on other pages';
    const derived = deriveCoverageObligations([requirement(LEAD + body)]);

    assert.ok(
      derived.every((entry) => !/checkbox[\s\S]*only applies/.test(entry.source_basis)),
      'the two lines are never one obligation'
    );
    assert.ok(
      derived.some((entry) => entry.type === 'qualifier' && /rows per page/.test(entry.statement)),
      'and the Notes line still yields its own'
    );
  });

  it('does not absorb a list lead-in or the branches under it', () => {
    const [entry] = criteria(
      'Add a new dropdown field named Settlement\n' +
        'Status: placed directly below the existing\n' +
        'Process and render the data according to the selected filter within the chosen time period:\n' +
        'IF the User pick Settled filter, then display all of the settled transaction'
    );

    assert.doesNotMatch(entry.statement, /Process and render/, 'the lead-in closes the run');
    assert.doesNotMatch(entry.statement, /IF the User/);
  });

  it('does not absorb tracker rows', () => {
    const [entry] = criteria(
      'Add a new dropdown field named Settlement\n' + 'SDE4-19347:\n' + 'R] [Settlement'
    );

    assert.equal(entry.metadata.criterion, 'Add a new dropdown field named Settlement');
  });

  it('stops after three wrapped lines', () => {
    const [entry] = criteria(
      'Add a new dropdown field named Settlement\n' +
        'Status: one\n' +
        'two\n' +
        'three\n' +
        'four must not be taken'
    );

    assert.doesNotMatch(entry.statement, /four/);
  });

  /**
   * Matching is untouched. The rule rebuilds what the obligation SAYS; it does
   * not make the comparison more forgiving, and a case that does not state the
   * behaviour is still reported uncovered.
   */
  it('is still not covered by a case that does not state it', () => {
    const [entry] = matchObligations(
      criteria(
        'Add a new dropdown field named Settlement\nStatus: placed directly below the existing'
      ),
      [
        testCase(
          'Verify the settlement report page loads.',
          'The page opens with the default view.'
        ),
      ]
    );

    assert.ok(!entry.covered);
  });
});
