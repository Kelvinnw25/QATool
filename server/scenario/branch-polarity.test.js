import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { deriveCoverageObligations, matchObligations } from './obligations.js';

/**
 * A branch's outcome in the polarity the source states it, and the branch's
 * own state - never its sibling's.
 *
 * Measured over 40 saved runs of the real PRD: the outcome was matched as a
 * bag of the case's words, so "no settlement release retry is performed"
 * proved "trigger retry Release Settlement to MW", and the ratio let the state
 * be the word dropped - every Unsettled and every Settled & Unsettled case
 * proved the Settled branch, and the reverse. Rows naming a run quote its case
 * verbatim; the rest are constructed weakenings and inversions.
 */

const requirement = (description) => ({
  requirement_id: 'REQ-001',
  title: 'Branching',
  description,
  category: 'Business Rule',
  source_references: [],
  ambiguities: [],
  conflicts: [],
});

/** The real PRD's branch lines, as the parser emits them. */
const FILTERS = [
  'IF the User pick Settled filter, then display all of the settled transaction',
  'IF the User pick Unsettled filter, then display all of the unsettled transaction',
  'IF the User pick Settled & Unsettled , then display all of the settled and unsettled transaction',
].join('\n');
const RESPONSES = [
  'IF check status response from T24 is Success (Y.ISO.RESPONSE:1:1="00" and',
  'Y.MSG.RES:1:1="{{ada isi FT Number nya}}" ), update the DB status to SUCCESS and save the FT NUMBER',
  'IF FAILED (Y.ISO.RESPONSE:1:1="01") or NOT',
  'FOUND, then trigger retry Release Settlement to MW.',
].join('\n');

const branchesOf = (text) => {
  const all = deriveCoverageObligations([requirement(text)]);
  return { all, branches: all.filter((o) => o.type === 'branch') };
};

/** Matched with the whole requirement's obligations, the way production calls it. */
function verdict(text, pick, cases) {
  const { all, branches } = branchesOf(text);
  const target = branches.find(pick);
  const testCases = cases.map(([testCase, expectedResult], at) => ({
    case_id: `TC-${at + 1}`,
    requirement_ids: ['REQ-001'],
    case_type: 'Positive',
    test_case: testCase,
    expected_result: expectedResult,
  }));
  return matchObligations(all, testCases).find((o) => o.obligation_id === target.obligation_id);
}

const check = (text, pick, rows) => {
  for (const [expected, why, testCase, expectedResult] of rows) {
    it(why, () =>
      assert.equal(
        verdict(text, pick, [[testCase, expectedResult]]).covered,
        expected,
        expectedResult
      )
    );
  }
};

const SETTLED = (o) => o.metadata.condition === 'the User pick Settled filter';
const UNSETTLED = (o) => o.metadata.condition === 'the User pick Unsettled filter';
const BOTH = (o) => /Settled & Unsettled/.test(o.metadata.condition);
const RETRY = (o) => /trigger retry/.test(o.metadata.outcome);
const SUCCESS = (o) => /SUCCESS/.test(o.metadata.outcome);

describe('the branches these rows are read against', () => {
  it('are the PRD sentences, unchanged by this matcher', () => {
    assert.equal(branchesOf(FILTERS).branches.length, 3);
    const { branches } = branchesOf(RESPONSES);
    assert.equal(
      branches.find(RETRY).metadata.condition,
      'FAILED (Y.ISO.RESPONSE:1:1="01") or NOT FOUND'
    );
    assert.equal(
      branches.find(SUCCESS).metadata.outcome,
      'update the DB status to SUCCESS and save the FT NUMBER'
    );
  });
});

describe('the retry branch: FAILED or NOT FOUND -> trigger retry (GO-017)', () => {
  check(RESPONSES, RETRY, [
    [
      true,
      'covered: the retry triggered on FAILED or NOT FOUND (C-plan-1 TC-009)',
      'Verify conditional retry triggering when Check Status returns FAILED or NOT FOUND before reaching 3 attempts.',
      "When check status response from T24 via MW (mscore*) is FAILED (Y.ISO.RESPONSE:1:1='01') or NOT FOUND, and the retry attempt has not reached 3 times, the system triggers a retry Release Settlement to MW.",
    ],
    [
      true,
      'covered: the condition in the title (P4-chunk3 TC-018)',
      'Verify settlement release retry triggering when check status response from T24 returns FAILED.',
      'A retry Release Settlement to MW is triggered when Y.ISO.RESPONSE:1:1="01", up to a maximum of 3 retries.',
    ],
    [
      true,
      'covered: an unrelated "not" in another clause does not negate the retry',
      '',
      'When the status check response is NOT FOUND, a retry Release Settlement to MW is triggered and the transaction is not yet marked FAILED.',
    ],
    [
      false,
      'not covered: the retry NOT performed (G-plan-6 TC-011)',
      'Verify guard condition preventing settlement release retry when status check response is not FAILED or attempt count has reached 3.',
      'Retry for Settlement Release is not performed when the status check response is anything other than FAILED or when the retry attempt has reached 3 times.',
    ],
    [
      false,
      'not covered: "no further settlement release retry" (C-plan-5 TC-010)',
      'Verify that settlement release retry is not performed when retry attempt reaches 3 times.',
      'No further settlement release retry is performed when the retry attempt has reached 3 times.',
    ],
    [
      false,
      'not covered: the retry on the opposite state, Success',
      '',
      'When the check status response is Success, a retry Release Settlement to MW is triggered.',
    ],
  ]);
});

describe('the Success branch: update the DB status and save the FT NUMBER (GO-016)', () => {
  check(RESPONSES, SUCCESS, [
    [
      true,
      'covered: the outcome split between title and result (P5-flash2 TC-011)',
      'Verify DB status update when Check Status via MW (mscore*) returns Success from T24.',
      'The database status is updated to SUCCESS and the FT NUMBER is saved when Check Status response returns Success with Y.ISO.RESPONSE:1:1="00" and Y.MSG.RES:1:1 contains the FT Number.',
    ],
    [
      false,
      'not covered: the outcome negated',
      '',
      'When the check status response from T24 is Success, the DB status is not updated to SUCCESS and the FT NUMBER is not saved.',
    ],
  ]);
});

describe('the Settled branch (GO-022)', () => {
  check(FILTERS, SETTLED, [
    [
      true,
      'covered: Settled (C-plan-1 TC-012)',
      'Verify data rendering when selecting the Settled filter in Advanced Search.',
      'When the user picks the Settled filter, the system displays all of the settled transactions within the chosen time period.',
    ],
    [
      true,
      'covered: "only settled transactions are displayed" (P5-flash2 TC-017)',
      'Verify search output when Settlement Status filter is set to Settled.',
      'Only settled transactions are displayed within the chosen time period.',
    ],
    [
      true,
      'covered: one case giving each option its own outcome (AB-plan-1 TC-011)',
      'Verify Advanced Search filter dropdown options and data rendering for Settlement Status.',
      'The Settlement Status dropdown field is placed directly below the existing Settlement Type dropdown with options Settled, Unsettled, and Settled & Unsettled, displaying all settled transactions when Settled is picked, all unsettled transactions when Unsettled is picked, and all settled and unsettled transactions when Settled & Unsettled is picked.',
    ],
    [
      true,
      'covered: Settled, with the unsettled ones stated as not displayed',
      'Verify data rendering when selecting the Settled filter.',
      'When the user picks the Settled filter, the system displays all of the settled transactions, and unsettled transactions are not displayed.',
    ],
    [
      false,
      'not covered: Unsettled (C-plan-1 TC-013)',
      'Verify data rendering when selecting the Unsettled filter in Advanced Search.',
      'When the user picks the Unsettled filter, the system displays all of the unsettled transactions within the chosen time period.',
    ],
    [
      false,
      'not covered: Settled & Unsettled (C-plan-1 TC-014)',
      'Verify data rendering when selecting the Settled & Unsettled filter in Advanced Search.',
      'When the user picks the Settled & Unsettled filter, the system displays all of the settled and unsettled transactions within the chosen time period.',
    ],
    [
      false,
      'not covered: the dropdown options listed (C-plan-1 TC-011)',
      'Verify the presence and placement of the new Settlement Status dropdown field in the Advanced Search filter.',
      'A new dropdown field named Settlement Status is added and placed directly below the existing Settlement Type dropdown with options Settled, Unsettled, and Settled & Unsettled.',
    ],
    [
      false,
      'not covered: "settled" borrowed from another sentence',
      'Verify data rendering for the Unsettled filter.',
      'When the user picks the Unsettled filter, the system displays all of the transactions. Settled transactions are listed in the report.',
    ],
    [
      false,
      'not covered: settled transactions NOT displayed',
      '',
      'When the user picks the Settled filter, the settled transactions are not displayed.',
    ],
  ]);
});

describe('the Unsettled and Settled & Unsettled branches (GO-023, GO-024)', () => {
  check(FILTERS, UNSETTLED, [
    [
      true,
      'Unsettled covered: Unsettled (G-plan-3 TC-014)',
      'Verify data rendering in Advanced Search when selecting the Unsettled filter option.',
      'When the user picks the Unsettled filter, the system processes and renders data within the chosen time period displaying all of the unsettled transactions.',
    ],
    [
      false,
      'Unsettled not covered: Settled (C-plan-1 TC-012)',
      'Verify data rendering when selecting the Settled filter in Advanced Search.',
      'When the user picks the Settled filter, the system displays all of the settled transactions within the chosen time period.',
    ],
  ]);
  check(FILTERS, BOTH, [
    [
      true,
      'Settled & Unsettled covered: both (C-plan-1 TC-014)',
      'Verify data rendering when selecting the Settled & Unsettled filter in Advanced Search.',
      'When the user picks the Settled & Unsettled filter, the system displays all of the settled and unsettled transactions within the chosen time period.',
    ],
    [
      false,
      'Settled & Unsettled not covered: Settled only (C-plan-1 TC-012)',
      'Verify data rendering when selecting the Settled filter in Advanced Search.',
      'When the user picks the Settled filter, the system displays all of the settled transactions within the chosen time period.',
    ],
    [
      false,
      'Settled & Unsettled not covered: Unsettled only (P5-flash TC-017)',
      "Verify that picking the 'Unsettled' filter in the Settlement Status dropdown displays only unsettled transactions within the chosen time period.",
      'The table displays only transactions that are unsettled.',
    ],
  ]);
});

describe('the same reading for branches from other documents', () => {
  const REJECTED =
    'WHEN a transfer is submitted by a Suspended participant THEN the transfer is rejected.';
  const DORMANT = 'IF the account is dormant, THEN the transfer is not processed.';
  const UPDATED =
    'IF Check Status succeeds, THEN the record is updated. ELSE the system retries Release Settlement.';
  const first = () => true;
  const otherwise = (o) => o.metadata.condition === 'otherwise';

  check(REJECTED, first, [
    [
      true,
      'rejected when Suspended',
      '',
      'A transfer submitted by a Suspended participant is rejected.',
    ],
    [
      false,
      'NOT rejected when Suspended',
      '',
      'A transfer submitted by a Suspended participant is not rejected.',
    ],
  ]);
  check(DORMANT, first, [
    [
      true,
      'a negated outcome, stated negated',
      '',
      'When the account is dormant, the transfer is not processed.',
    ],
    [
      false,
      'a negated outcome, stated positively',
      '',
      'When the account is dormant, the transfer is processed.',
    ],
    [
      false,
      'a negated outcome is not satisfied by an unrelated "not"',
      '',
      'When the account is dormant, the transfer is processed and the fee is not charged.',
    ],
  ]);
  check(UPDATED, first, [
    [true, 'record updated', '', 'If Check Status succeeds, the record is updated.'],
    [false, 'record NOT updated', '', 'If Check Status succeeds, the record is not updated.'],
  ]);
  check(UPDATED, otherwise, [
    [true, 'otherwise: retries', '', 'Otherwise the system retries Release Settlement.'],
    [
      false,
      'otherwise: does not retry',
      '',
      'Otherwise the system does not retry Release Settlement.',
    ],
  ]);
});

describe('opposite cases cannot restore coverage the genuine case gave', () => {
  const GENUINE = [
    'Verify data rendering when selecting the Settled filter in Advanced Search.',
    'When the user picks the Settled filter, the system displays all of the settled transactions within the chosen time period.',
  ];
  const OPPOSITES = [
    [
      'Verify data rendering when selecting the Unsettled filter in Advanced Search.',
      'When the user picks the Unsettled filter, the system displays all of the unsettled transactions within the chosen time period.',
    ],
    [
      'Verify data rendering when selecting the Settled & Unsettled filter in Advanced Search.',
      'When the user picks the Settled & Unsettled filter, the system displays all of the settled and unsettled transactions within the chosen time period.',
    ],
  ];

  it('credits only the genuine case when it is there', () => {
    assert.deepEqual(verdict(FILTERS, SETTLED, [GENUINE, ...OPPOSITES]).case_ids, ['TC-1']);
  });

  it('is uncovered once the genuine case is removed', () => {
    assert.equal(verdict(FILTERS, SETTLED, OPPOSITES).covered, false);
  });

  it('keeps a NOT-retry case from standing in for the retry', () => {
    assert.equal(
      verdict(RESPONSES, RETRY, [
        [
          'Verify that settlement release retry is not performed when retry attempt reaches 3 times.',
          'No further settlement release retry is performed when the retry attempt has reached 3 times.',
        ],
      ]).covered,
      false
    );
  });
});
