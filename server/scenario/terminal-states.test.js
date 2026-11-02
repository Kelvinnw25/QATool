import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { deriveCoverageObligations, matchObligations } from './obligations.js';

/**
 * Three behaviours the Settlement PRD states outright that derived no
 * obligation, so no coverage figure could say whether a run tested them: the
 * move into PENDING on a timeout, the final FAILED after the third retry, and
 * what response 01 means in the core banking table ("FT is not recorded").
 *
 * The lines below are the PRD's own, as the structuring step hands them over.
 * The negatives guard the other direction, which matters more: an obligation
 * the document does not state makes a coverage figure wrong, not incomplete.
 *
 * A second thing was true of the final FAILED and went unfixed the first
 * time: the PRD does not merely say the status becomes FAILED, it says so
 * ONLY after the third retry is exhausted - "IF the status remains unresolved
 * (FAILED) after 3rd retry attempt, permanently mark ...". A detector reading
 * only the imperative clause drops that condition, and a matcher asking only
 * whether a case mentions "FAILED" is then satisfied by the mid-retry branch
 * that sets FAILED on the FIRST attempt - a case that never reaches the third
 * retry at all. Both halves are covered below: the condition is kept in
 * `source_basis` and `metadata.condition`, and coverage now requires a case
 * to state it, not merely the state name.
 */

function derive(description) {
  return deriveCoverageObligations([
    {
      requirement_id: 'REQ-001',
      title: 'Settlement status handling',
      description,
      category: 'Error Handling',
      source_references: [{ document_id: 'DOC-001', page: 7, section: null, quote: null }],
      ambiguities: [],
      conflicts: [],
    },
  ]);
}

function testCase(overrides = {}) {
  return {
    case_id: 'TC-001',
    requirement_ids: ['REQ-001'],
    section: 'Settlement',
    test_case: '',
    case_type: 'Positive',
    edge_polarity: null,
    priority: 'High',
    type: 'Functional',
    expected_result: '',
    source_references: [],
    confidence: 'High',
    warnings: [],
    status: null,
    tested_by: null,
    order_index: 0,
    ...overrides,
  };
}

const typed = (obligations, type) => obligations.filter((entry) => entry.type === type);
const states = (description) =>
  typed(derive(description), 'transition').map((entry) => entry.metadata.state);

const TIMEOUT_CRITERIA = [
  'THEN the system must fulfill:',
  '- Mark the transaction as PENDING and route the record into a dedicated CHECK',
  'STATUS queue.',
  '- Enforce a strict 1 hour delay from the original timeout timestamp before allowing the scheduler to process the record.',
].join('\n');

const RETRY_CRITERIA = [
  'THEN the system must fulfill:',
  '- IF FAILED (Y.ISO.RESPONSE:1:1="01") or NOT FOUND, then trigger retry',
  'Release Settlement to Middleware. The maximum number of settlement release retries is 3.',
  '- IF the status remains unresolved (FAILED) after 3rd retry attempt, permanently mark the transaction status as FAILED.',
  'Notes: Retry for Settlement Release is only performed when the status check response is FAILED (transaction not completed) and the retry attempt has not reached 3 times.',
].join('\n');

const RESPONSE_TABLE = [
  'Response Mapping',
  'Y.ISO.RESPONSE:1:1="00" AND',
  'Y.MSG.RES:1:1="FTDEMO014922"',
  'Funds Transfer (FT)',
  'Success (Transaction successfully processed in core)',
  'Y.ISO.RESPONSE:1:1="01" AND',
  'Y.MSG.RES:1:1="Transaction Failed!"',
  'Transaction Not Found / Failed',
  '(FT is not recorded)',
  'Core Banking Response Values Transaction Meaning / Mapping',
  'Y.ISO.RESPONSE:1:1="00" AND Y.MSG.RES:1:1="FTDEMO014922" Funds Transfer (FT) Success (Transaction successfully processed in core) Y.ISO.RESPONSE:1:1="01" AND Y.MSG.RES:1:1="Transaction Failed!" Transaction Not Found / Failed (FT is not recorded)',
].join('\n');

describe('a state written as an instruction is a transition', () => {
  it('reads the move into PENDING on a timeout', () => {
    const [transition] = typed(derive(TIMEOUT_CRITERIA), 'transition');
    assert.equal(transition.metadata.state, 'PENDING');
    assert.equal(transition.source_basis, 'Mark the transaction as PENDING');
    assert.equal(transition.statement, 'State transition to PENDING is exercised');
    assert.deepEqual(states(TIMEOUT_CRITERIA), ['PENDING']);
  });

  it('reads the final FAILED after the third retry, once, beside what was there', () => {
    const obligations = derive(RETRY_CRITERIA);
    const [transition, ...more] = typed(obligations, 'transition');
    assert.deepEqual(more, []);
    assert.equal(transition.metadata.state, 'FAILED');

    // The statement stays the short form a prompt line can carry; the
    // condition that gates it - "after 3rd retry attempt" - is kept in full,
    // verbatim, in the basis and in metadata, rather than lost with only the
    // imperative clause kept.
    assert.equal(transition.statement, 'State transition to FAILED is exercised');
    assert.equal(
      transition.source_basis,
      'IF the status remains unresolved (FAILED) after 3rd retry attempt, permanently mark the transaction status as FAILED.'
    );
    assert.equal(
      transition.metadata.condition,
      'the status remains unresolved (FAILED) after 3rd retry attempt'
    );

    // The obligations the retry path already had are all still there.
    assert.ok(obligations.some((entry) => entry.type === 'retry' && entry.metadata.limit === '3'));
    assert.ok(typed(obligations, 'condition').some((entry) => entry.metadata.guard));
    assert.ok(
      typed(obligations, 'mapping').some(
        (entry) => entry.statement === 'Response Y.ISO.RESPONSE:1:1=01 is treated as: FAILED'
      )
    );
  });

  it('is not gated when the source states no condition, and an ungated transition still needs only the state', () => {
    const [transition] = typed(derive(TIMEOUT_CRITERIA), 'transition');
    assert.equal(transition.metadata.condition, undefined);

    const [matched] = matchObligations(
      [transition],
      [
        testCase({
          test_case: 'Trigger the timeout path once.',
          expected_result: 'Status is PENDING.',
        }),
      ]
    );
    assert.equal(matched.covered, true);
  });

  it('reports the terminal FAILED covered only when a case states the third-retry condition, not the state alone', () => {
    const [transition] = typed(derive(RETRY_CRITERIA), 'transition');
    assert.ok(transition.metadata.condition);

    // The branch that sets FAILED on the FIRST failed attempt and retries - it
    // names the state, never the third retry being exhausted - is alone not
    // evidence of the terminal transition.
    const midRetryOnly = testCase({
      case_id: 'TC-MID',
      test_case: 'Check status returns FAILED on the first attempt.',
      expected_result: 'A retry is triggered; the transaction is not yet final.',
    });
    const [onlyMidRetry] = matchObligations([transition], [midRetryOnly]);
    assert.equal(onlyMidRetry.covered, false);

    // The case that actually reaches the end of the retry path states both.
    const exhausted = testCase({
      case_id: 'TC-END',
      test_case: 'After the status remains unresolved through the 3rd retry attempt.',
      expected_result: 'The transaction status is permanently marked as FAILED.',
    });
    const [matched] = matchObligations([transition], [midRetryOnly, exhausted]);
    assert.equal(matched.covered, true);
    assert.deepEqual(matched.case_ids, ['TC-END']);
  });

  it('says nothing about NOT FOUND beyond what the branch already states', () => {
    // Whether NOT FOUND is retried is for the SME; no new obligation decides it.
    const obligations = derive(RETRY_CRITERIA);
    assert.deepEqual(
      obligations
        .filter((entry) => /NOT\s+FOUND/i.test(entry.statement))
        .map((entry) => entry.type),
      ['branch']
    );
  });

  it('is one obligation however many times the state is stated', () => {
    assert.deepEqual(
      states('The transaction is marked as FAILED.\nPermanently mark the transaction as FAILED.'),
      ['FAILED']
    );
  });

  it('is not read from a lowercase result or a long stretch of prose', () => {
    assert.deepEqual(states('Mark the checkbox as checked when the row is selected.'), []);
    assert.deepEqual(states('Mark the record and notify the operator as soon as possible.'), []);
    assert.deepEqual(
      states('Mark every single one of the pending records in the batch as DONE.'),
      []
    );
  });

  it('is deterministic', () => {
    assert.deepEqual(derive(RETRY_CRITERIA), derive(RETRY_CRITERIA));
  });
});

describe('a mapping table is read row by row under its meaning header', () => {
  const mappings = (description) =>
    typed(derive(description), 'mapping').map((entry) => [
      entry.metadata.stated,
      entry.metadata.meaning,
    ]);

  it('reads what response 01 means: the FT is not recorded', () => {
    assert.deepEqual(mappings(RESPONSE_TABLE), [
      [
        'Y.ISO.RESPONSE:1:1=00 AND Y.MSG.RES:1:1=FTDEMO014922',
        'Funds Transfer (FT) Success (Transaction successfully processed in core)',
      ],
      [
        'Y.ISO.RESPONSE:1:1=01 AND Y.MSG.RES:1:1=Transaction Failed!',
        'Transaction Not Found / Failed (FT is not recorded)',
      ],
    ]);
    const [, notRecorded] = typed(derive(RESPONSE_TABLE), 'mapping');
    assert.equal(
      notRecorded.source_basis,
      'Y.ISO.RESPONSE:1:1="01" AND Y.MSG.RES:1:1="Transaction Failed!" Transaction Not Found / Failed (FT is not recorded)'
    );
  });

  it('reads no row without a header naming a meaning or mapping column', () => {
    assert.deepEqual(
      mappings(
        'Y.ISO.RESPONSE:1:1="01" AND Y.MSG.RES:1:1="Transaction Failed!" Transaction Not Found / Failed (FT is not recorded)'
      ),
      []
    );
    assert.deepEqual(mappings('Set timeout=30 seconds before the next retry.'), []);
  });

  it('reads no half key, sentence tail or placeholder as a row', () => {
    assert.deepEqual(
      mappings(
        [
          'Response Mapping',
          'Y.ISO.RESPONSE:1:1="00" AND',
          // The tail of a sentence: what follows the bracket is not a cell.
          '(Y.ISO.RESPONSE:1:1="00" and Y.MSG.RES:1:1="FTDEMO014922"), update the DB status to SUCCESS',
          '(Y.ISO.RESPONSE:1:1="00" and Y.MSG.RES:1:1="{{FT Number returned}}"), update the DB status to SUCCESS',
        ].join('\n')
      ),
      []
    );
  });

  it('leaves a row with its own relation to the detector that reads it, once', () => {
    assert.deepEqual(mappings('Response Mapping\nRC="05" means Do not honour'), [
      ['RC=05', 'Do not honour'],
    ]);
  });
});
