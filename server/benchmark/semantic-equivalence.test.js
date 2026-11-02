import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { compareToOracle } from './compare.js';

/**
 * What the oracle accepts for GO-014, GO-019 and GO-033, and what it must not.
 *
 * Built from an audit of every saved benchmark run (40, three models, four
 * contracts) after three items were scored missing for wording rather than for
 * missing behaviour. Each row is one test case's text and the verdict the PRD
 * calls for. Rows marked with a run id quote that run's case verbatim; the rest
 * are deliberately weakened, inverted or boundary statements no run produced -
 * they exist so that accepting a paraphrase cannot quietly become accepting
 * anything with the right keywords in it.
 *
 * These test the INSTRUMENT, like the rest of this directory. Whether QATOOL
 * covers the items is measured by running it, never asserted here.
 */

const oracle = JSON.parse(
  readFileSync(new URL('./prd-qr-manager-settlement-report.oracle.json', import.meta.url), 'utf8')
);

const verdict = (id, text) =>
  compareToOracle(oracle, {
    test_cases: [{ case_id: 'TC-001', requirement_ids: ['REQ-001'], test_case: text }],
  }).items.find((item) => item.id === id).covered;

const check = (id, rows) => {
  for (const [text, expected, why] of rows) {
    it(why, () => assert.equal(verdict(id, text), expected, text));
  }
};

describe('GO-014: a strict 1 hour delay, measured from the original timeout timestamp', () => {
  check('GO-014', [
    [
      'enforcing a strict 1 hour delay from the original timeout timestamp before processing.',
      true,
      'covered: the duration and its reference point (AB-baseline-4 TC-007)',
    ],
    [
      'a strict 1-hour delay is enforced from the original timeout timestamp before processing.',
      true,
      'covered: the hyphenated duration (C-baseline-3 TC-007)',
    ],
    [
      'The scheduler is strictly prevented from processing the pending transaction before exactly 1 hour has elapsed from the original timeout timestamp.',
      true,
      'covered: the forbidden side of the delay (P5-flash3 TC-009)',
    ],
    [
      'A strict 1-hour delay is enforced before the scheduler processes the record.',
      false,
      'missing: the reference point dropped',
    ],
    [
      'A strict 1-hour delay is enforced from the time the record enters the queue.',
      false,
      'missing: a different reference point',
    ],
    [
      'A strict 2-hour delay is enforced from the original timeout timestamp.',
      false,
      'missing: a different duration',
    ],
    [
      'An 11-hour delay is enforced from the original timeout timestamp.',
      false,
      'missing: "1 hour" inside "11-hour"',
    ],
  ]);
});

describe('GO-019: after retry 1 and/or 2 the transaction still times out, so Check Status runs again', () => {
  check('GO-019', [
    [
      'After Release Settlement 1 and/or 2 retries attempt the transaction still timeouts, the system performs Check Status again.',
      true,
      'covered: the noun (G-plan-5 TC-010)',
    ],
    [
      'If after Release Settlement 1 and/or 2 retry attempts (where status check response is FAILED and retry count has not reached 3) the transaction still times out, the system performs Check Status again via MW (mscore*)',
      true,
      'covered: the verb, "still times out" (C-plan-1 TC-010)',
    ],
    [
      'if the transaction still times out after 1st and/or 2nd retries, Check Status runs again',
      true,
      'covered: "times out" and "runs again" (AB-baseline-3 TC-009)',
    ],
    [
      'The system calls Check Status to T24 via MW (mscore*); after Release Settlement 1 and/or 2 retries attempt the transaction still timing out, the system performs Check Status again.',
      true,
      'covered: "still timing out" (G-plan-3 TC-010, expected result)',
    ],
    [
      'After the 1st and/or 2nd retry attempt, Check Status is performed again.',
      false,
      'missing: the timeout condition dropped, so it re-checks after every retry',
    ],
    [
      'If the transaction still times out, Check Status is performed again.',
      false,
      'missing: which retries it applies to',
    ],
    [
      'When the first Release Settlement times out, the transaction is routed to the CHECK STATUS queue.',
      false,
      'missing: timeout catching (GO-012), not the re-check',
    ],
    [
      'When the status remains unresolved (FAILED) after the 3rd retry attempt via MW (mscore*), the system permanently marks the transaction status as FAILED and does not perform further retries.',
      false,
      'missing: the final failure (GO-020), not the re-check (G-plan-4 TC-011)',
    ],
  ]);
});

describe('GO-033: retry only when (A) the response is FAILED and (B) attempts have not reached 3', () => {
  check('GO-033', [
    [
      "When the check status response is FAILED (Y.ISO.RESPONSE:1:1='01') or NOT FOUND, and the retry attempt has not reached 3 times, the system triggers a retry Release Settlement to MW.",
      true,
      'covered: the permitted side, both conditions (C-baseline-2 TC-009)',
    ],
    [
      'A retry Release Settlement to MW is triggered when Check Status returns FAILED (Y.ISO.RESPONSE:1:1="01") or NOT FOUND, provided maximum retries of 3 is not reached.',
      true,
      'covered: the permitted side, "is not reached" (P5-flash2 TC-012)',
    ],
    [
      'Retry for Settlement Release is not performed when the status check response is anything other than FAILED or when the retry attempt has reached 3 times.',
      true,
      'covered: the forbidden side, both conditions negated (G-plan-6 TC-011)',
    ],
    [
      'Verify retry is not triggered if Check Status response is not FAILED or attempt count is 3. Retry for Settlement Release is not performed if status check response is SUCCESS or retry attempt count has reached 3 times.',
      true,
      'covered: the forbidden side, SUCCESS as the non-FAILED response (P5-flash2 TC-015)',
    ],
    [
      "Verify retry trigger when check status response is FAILED (Y.ISO.RESPONSE:1:1='01'). System triggers a retry Release Settlement to MW, up to a maximum of 3 retries.",
      false,
      'missing: "up to a maximum of 3" is the limit, not the guard (P4-chunk3b TC-018)',
    ],
    [
      'A retry Release Settlement to MW is triggered when the status check response is FAILED.',
      false,
      'missing: (B) not stated at all',
    ],
    [
      'Verify that retry for Settlement Release is not performed when retry attempt limit has reached 3 times. When calling Check Status to T24 via MW (mscore*) and the retry attempt has reached 3 times, no further settlement release retry is performed.',
      false,
      'missing: the forbidden side of (B) only (AB-plan-1 TC-010)',
    ],
    [
      'When the retry attempt reaches 3 times and the status check response remains FAILED (transaction not completed), no further retry is performed and the system permanently marks the transaction status as FAILED.',
      false,
      'missing: (B) withheld, (A) stated positively - half the guard (AB-plan-3 TC-010)',
    ],
    [
      'No settlement release retry is performed when the status check response is anything other than FAILED.',
      false,
      'missing: the forbidden side of (A) only',
    ],
    [
      'Retry for Settlement Release is performed when the status check response is FAILED (transaction not completed) and the retry attempt has reached 3 times.',
      false,
      'missing: inverted (B), a retry AT the limit',
    ],
    ['Maximum 3 retries. Status FAILED.', false, 'missing: the right keywords and no rule'],
  ]);
});

/**
 * Pinned as measured, not endorsed.
 *
 * Literal groups cannot see the polarity of a single word. The permitted form
 * asks for "failed", and "not FAILED" contains it - so a case retrying when the
 * response is NOT failed, and below the limit, shows every group. No saved run
 * produced this (every primary-form credit across 40 runs carries a positive
 * FAILED), and closing it needs more than a spelling list. If a later change
 * fixes it, this test should fail and be turned round.
 */
describe('known limit of literal evidence', () => {
  it('accepts an inverted (A) - a retry when the response is NOT failed', () => {
    assert.equal(
      verdict(
        'GO-033',
        'Retry for Settlement Release is performed when the status check response is not FAILED and the retry attempt has not reached 3 times.'
      ),
      true
    );
  });
});
