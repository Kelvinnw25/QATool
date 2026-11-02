import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { deriveCoverageObligations, matchObligations } from './obligations.js';

/**
 * Coverage evidence for the three conditional obligation types - a branch, a
 * guard, a schedule - read statement by statement.
 *
 * Each was measured crediting cases that never stated its condition, over 40
 * saved runs of the real PRD: the re-check after a timed-out retry credited to
 * a case about the final FAILED marking, the retry guard credited to cases that
 * withheld the retry at the limit alone, and the 1 hour delay satisfied by any
 * "1" and any "hour". Rows naming a run quote that run's case verbatim; the
 * others are weakenings and inversions no run produced, kept so that a
 * legitimate paraphrase can never quietly widen into keyword matching.
 */

const requirement = (description) => ({
  requirement_id: 'REQ-001',
  title: 'Status Verification and Conditional Retry',
  description,
  category: 'Business Rule',
  source_references: [],
  ambiguities: [],
  conflicts: [],
});

/** The real PRD's lines, as the parser emits them (page 7 and page 8). */
const PAGE_7 =
  'Enforce a strict 1 hour delay from the original timeout timestamp before allowing the scheduler to process the record (giving the Core Banking system a cool-down period).';
const PAGE_8 = [
  'Call Check Status to T24 via MW (mscore*) to verify the actual state of the transaction',
  'IF FAILED (Y.ISO.RESPONSE:1:1="01") or NOT',
  'FOUND, then trigger retry Release Settlement to MW. The maximum number of settlement release retries is 3.',
  'IF after Release Settlement 1 and/or 2 retries attempt the transaction still Timeout, perform',
  'Check Status again.',
  'IF the status remains unresolved (FAILED) after 3rd retry attempt, permanently mark the transaction status as FAILED',
  'Notes: Retry for Settlement Release is only performed when the status check response is',
  'FAILED (transaction not completed) and the retry attempt has not reached 3 times.',
].join('\n');

const derived = (text) => deriveCoverageObligations([requirement(text)]);
const RECHECK = derived(PAGE_8).find(
  (o) => o.type === 'branch' && /Check Status again/.test(o.metadata.outcome)
);
const GUARD = derived(PAGE_8).find((o) => o.type === 'condition' && o.metadata.guard);
const DELAY = derived(PAGE_7).find((o) => o.type === 'schedule');

const covers = (obligation, testCase, expectedResult) =>
  matchObligations(
    [obligation],
    [
      {
        case_id: 'TC-001',
        requirement_ids: ['REQ-001'],
        case_type: 'Positive',
        test_case: testCase,
        expected_result: expectedResult,
      },
    ]
  )[0].covered;

const check = (obligation, rows) => {
  for (const [expected, why, testCase, expectedResult] of rows) {
    it(why, () =>
      assert.equal(covers(obligation, testCase, expectedResult), expected, expectedResult)
    );
  }
};

describe('the obligations these rows are read against', () => {
  it('are the PRD sentences, unchanged by this matcher', () => {
    assert.equal(RECHECK.metadata.outcome, 'perform Check Status again');
    assert.equal(GUARD.metadata.conditions.length, 2);
    assert.deepEqual(DELAY.metadata, { amount: '1', unit: 'hour' });
  });
});

describe('a branch: the re-check after a timed-out retry (GO-019)', () => {
  check(RECHECK, [
    [
      true,
      'covered: "still timeouts" (G-plan-5 TC-010)',
      '',
      'After Release Settlement 1 and/or 2 retries attempt the transaction still timeouts, the system performs Check Status again.',
    ],
    [
      true,
      'covered: "still times out", guard in a bracket (C-plan-1 TC-010)',
      'Verify maximum retry handling, intermediate Check Status calls, and permanent failure marking after the 3rd retry attempt.',
      'If after Release Settlement 1 and/or 2 retry attempts (where status check response is FAILED and retry count has not reached 3) the transaction still times out, the system performs Check Status again via MW (mscore*); if the status remains unresolved (FAILED) after the 3rd retry attempt, the system permanently marks the transaction status as FAILED.',
    ],
    [
      true,
      'covered: "runs again" (AB-baseline-3 TC-009)',
      'Verify conditional retry behavior and final failure marking when T24 returns FAILED or NOT FOUND during status verification.',
      "Upon receiving FAILED (Y.ISO.RESPONSE:1:1='01') or NOT FOUND, the system triggers a retry Release Settlement to MW up to a maximum of 3 retries; if the transaction still times out after 1st and/or 2nd retries, Check Status runs again, and if unresolved after the 3rd retry, the transaction status is permanently marked as FAILED.",
    ],
    [
      true,
      'covered: one retry per case, "1 and/or 2" asks for either (P4-chunk3 TC-020)',
      '',
      'Check Status is performed again after the 1st release retry attempt still results in a Timeout.',
    ],
    [
      true,
      'covered: ordinal words and the noun',
      '',
      'The scheduler calls Check Status to T24 via MW (mscore*) again following a timeout on the first or second retry attempt.',
    ],
    [
      false,
      'not covered: a re-check with no timeout',
      'Verify Check Status is performed again.',
      'After the 1st and/or 2nd retry attempt, Check Status is performed again.',
    ],
    [
      false,
      'not covered: a timeout re-check with no retry it follows',
      '',
      'If the transaction still times out, Check Status is performed again.',
    ],
    [
      false,
      'not covered: the final FAILED marking (G-plan-4 TC-011)',
      'Verify permanent failure status marking when status remains unresolved (FAILED) after the 3rd retry attempt via MW (mscore*) where retry attempt has reached 3 times.',
      'When the status remains unresolved (FAILED) after the 3rd retry attempt via MW (mscore*), the system permanently marks the transaction status as FAILED and does not perform further retries.',
    ],
    [
      false,
      'not covered: "times out of" is a ratio',
      '',
      'The 1st retry succeeds 2 times out of 3, and Check Status is performed again.',
    ],
    [
      false,
      'not covered: "again" about the release, not Check Status',
      '',
      'If the 1st retry times out, the transaction status is updated and the system performs the release again.',
    ],
  ]);
});

describe('a guard: retry only when FAILED and below 3 attempts (GO-033)', () => {
  check(GUARD, [
    [
      true,
      'covered: the permitted side, both conditions (C-baseline-2 TC-009)',
      'Verify retry release settlement handling on failed or not found status check responses',
      "When the check status response is FAILED (Y.ISO.RESPONSE:1:1='01') or NOT FOUND, and the retry attempt has not reached 3 times, the system triggers a retry Release Settlement to MW.",
    ],
    [
      true,
      'covered: conditions in the title, the retry in the result (AB-baseline-5 TC-009)',
      'Verify retry behavior when the check status response returns FAILED (Y.ISO.RESPONSE:1:1="01") or NOT FOUND, and the retry attempt has not reached 3 times.',
      'Trigger retry Release Settlement to MW, performing Check Status again if the 1st and/or 2nd retry attempt still experiences a timeout, up to a maximum of 3 retries.',
    ],
    [
      true,
      'covered: the forbidden side, both conditions failing (G-plan-6 TC-011)',
      'Verify guard condition preventing settlement release retry when status check response is not FAILED or attempt count has reached 3.',
      'Retry for Settlement Release is not performed when the status check response is anything other than FAILED or when the retry attempt has reached 3 times.',
    ],
    [
      true,
      'covered: the forbidden side split across title and result (P5-flash2 TC-015)',
      'Verify retry is not triggered if Check Status response is not FAILED or attempt count is 3.',
      'Retry for Settlement Release is not performed if status check response is SUCCESS or retry attempt count has reached 3 times.',
    ],
    [
      false,
      'not covered: retry AT the limit, "not" borrowed from the bracket',
      '',
      'Retry for Settlement Release is performed when the status check response is FAILED (transaction not completed) and the retry attempt has reached 3 times.',
    ],
    [
      false,
      'not covered: retry AT the limit, "not" borrowed from NOT FOUND',
      '',
      'When the status check response is FAILED or NOT FOUND and the retry attempt has reached 3 times, a retry Release Settlement to MW is triggered.',
    ],
    [
      false,
      'not covered: retry when the response is NOT FAILED',
      '',
      'Retry for Settlement Release is performed when the status check response is not FAILED and the retry attempt has not reached 3 times.',
    ],
    [
      false,
      'not covered: withheld at the limit only (AB-plan-3 TC-010)',
      'Verify permanent failure marking when the transaction status remains unresolved after the 3rd retry attempt.',
      'When the retry attempt reaches 3 times and the status check response remains FAILED (transaction not completed), no further retry is performed and the system permanently marks the transaction status as FAILED.',
    ],
    [
      false,
      'not covered: withheld for a non-FAILED response only',
      '',
      'No settlement release retry is performed when the status check response is anything other than FAILED.',
    ],
    [
      false,
      'not covered: "up to a maximum of 3" (P4-chunk3b TC-018)',
      "Verify retry trigger when check status response is FAILED (Y.ISO.RESPONSE:1:1='01').",
      'System triggers a retry Release Settlement to MW, up to a maximum of 3 retries.',
    ],
    [
      false,
      'not covered: FAILED and 3 stated, the retry never mentioned',
      '',
      'When the status check response is FAILED and the retry attempt has not reached 3 times, the transaction remains PENDING.',
    ],
    [
      false,
      'not covered: one condition from each side',
      '',
      'A retry for Settlement Release is triggered when the status check response is FAILED. Settlement Release retry is not performed when the retry attempt has reached 3 times.',
    ],
  ]);
});

describe('a schedule: 1 hour, measured from the original timeout timestamp (GO-014)', () => {
  check(DELAY, [
    [
      true,
      'covered: the duration and its reference point (AB-baseline-4 TC-007)',
      '',
      'When releasing settlement to T24 via MW experiences Timeout, the transaction is marked as PENDING, enforcing a strict 1 hour delay from the original timeout timestamp before processing.',
    ],
    [
      true,
      'covered: hyphenated (C-baseline-3 TC-007)',
      '',
      'a strict 1-hour delay is enforced from the original timeout timestamp before processing.',
    ],
    [
      true,
      'covered: the forbidden side of the delay (P5-flash3 TC-009)',
      'Verify 1 hour delay enforcement on CHECK STATUS queue scheduler processing',
      'The scheduler is strictly prevented from processing the pending transaction before exactly 1 hour has elapsed from the original timeout timestamp.',
    ],
    [
      false,
      'not covered: 1 hour with no reference point',
      '',
      'The scheduler waits 1 hour before processing the record.',
    ],
    [
      false,
      'not covered: a different reference point',
      '',
      'A strict 1-hour delay is enforced from the time the record enters the queue.',
    ],
    [
      false,
      'not covered: the reference point and an unrelated hour, in two sentences',
      '',
      'Processing is measured from the original timeout timestamp. The export link expires after 1 hour.',
    ],
    [
      false,
      'not covered: "1" from a field code, "hours" from another number',
      '',
      'Y.ISO.RESPONSE:1:1 is checked within 24 hours from the original timeout timestamp.',
    ],
  ]);
});

describe('what the stricter reading leaves alone', () => {
  it('matches a schedule with no stated reference point on its duration alone', () => {
    const [wait] = derived('The scheduler must wait 1 hour before executing Check Status.').filter(
      (o) => o.type === 'schedule'
    );

    assert.equal(
      covers(wait, '', 'The scheduler waits 1 hour before executing Check Status.'),
      true
    );
    assert.equal(covers(wait, '', 'The scheduler waits 2 hours, then 1 more check.'), false);
  });

  it('matches a branch whose condition states no value as before', () => {
    const [settled] = derived(
      'IF the User pick Settled filter, then display all of the settled transaction'
    ).filter((o) => o.type === 'branch');

    assert.equal(
      covers(
        settled,
        'Verify data rendering when selecting Settled filter in Advanced Search.',
        'The system displays all settled transactions within the chosen period.'
      ),
      true
    );
  });
});
