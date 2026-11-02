import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  DEFAULT_DISABLED_RULES,
  DIAGNOSTIC_RULES,
  DIAGNOSTIC_SEVERITIES,
  TESTCASE_DIAGNOSTICS_VERSION,
  diagnoseTestCase,
  diagnoseTestCases,
  skippedDiagnostics,
} from './testcase-diagnostics.js';

/**
 * Diagnostics on drafted test cases.
 *
 * The positive examples are verbatim test cases from a ten-run audit over the
 * two sanitized PRDs in this repository (PRD_Transaction_Routing_Sanitized.pdf,
 * PRD_QR_Manager_Settlement_Report_SANITIZED.pdf), each one a case the audit
 * judged non-atomic, vague or intermediate-only. The negative controls come
 * from the same runs - cases the audit judged atomic and executable - plus
 * hand-written traps for the wordings most likely to be over-read.
 */

const UNAVAILABLE = { kind: 'unavailable', requirements: [] };

function testCase(expected, scenario = 'Verify the behaviour.', extra = {}) {
  return {
    case_id: 'TC-001',
    section: 'Section',
    test_case: scenario,
    expected_result: expected,
    requirement_ids: [],
    ...extra,
  };
}

const ruleIds = (subject, context = UNAVAILABLE, options = {}) =>
  diagnoseTestCase(subject, context, options).map((finding) => finding.rule_id);
const findingFor = (subject, ruleId, context = UNAVAILABLE, options = {}) =>
  diagnoseTestCase(subject, context, options).find((finding) => finding.rule_id === ruleId);

/**
 * Rules that are off by default are tested with the rule switched on, so that
 * their negative controls keep meaning something: with the rule off, every
 * "does not flag" assertion would pass without the rule having run at all.
 */
const ENABLE_ATOM_04 = { enableRules: ['TCD-ATOM-04'] };
const ENABLE_VAGUE_02 = { enableRules: ['TCD-VAGUE-02'] };

const cited = (description) => ({
  kind: 'cited',
  requirements: [
    { requirement_id: 'REQ-001', title: 'Requirement', description, source_references: [] },
  ],
});

// --- Verbatim cases from the audited runs -----------------------------------------

const RETRY_TWO_BRANCHES =
  'When check status response is FAILED (Y.ISO.RESPONSE:1:1="01" and Y.MSG.RES:1:1="Transaction Failed!") or NOT FOUND, a retry Release Settlement to Middleware is triggered; if after Release Settlement 1 and/or 2 retry attempts the transaction still Timeout, Check Status is performed again.';
const RETRY_RECHECK_AND_TERMINAL =
  'If after Release Settlement 1 and/or 2 retry attempts the transaction still Timeout (and retry attempt has not reached 3 times), the system performs Check Status again; if the status remains unresolved (FAILED) after 3rd retry attempt, the transaction status is permanently marked as FAILED.';
const RETRY_FIVE_TRANSITIONS =
  'The system calls Check Status, and when the response is FAILED (Y.ISO.RESPONSE:1:1="01") or NOT FOUND, triggers a retry Release Settlement to Middleware up to a maximum of 3 retries, performing Check Status again if after 1st and/or 2nd retry attempt the transaction still timeouts, ensuring retry is only performed when status check response is FAILED and retry attempt has not reached 3 times.';
const TERMINAL_FAILED =
  'If the status remains unresolved (FAILED) after 3rd retry attempt (maximum number of settlement release retries is 3), the transaction status is permanently marked as FAILED.';
const RECHECK_ONLY =
  'After Release Settlement 1 and/or 2 retry attempts resulting in Timeout, the system performs Check Status again.';
const SUCCESS_SEQUENCE =
  'The system calls Check Status to Core Banking via Middleware, receives Success, updates the DB status to SUCCESS, and saves the FT NUMBER.';
const SUCCESS_MAPPING =
  'When check status response is Y.ISO.RESPONSE:1:1="00" and Y.MSG.RES:1:1="{{FT Number returned}}" (or Y.MSG.RES:1:1="FTDEMO014922"), the DB status is updated to SUCCESS and the FT NUMBER is saved.';
const TIMEOUT_SCENARIO =
  'Verify system behavior when Release Settlement experiences Timeout (TTTP 408 or 504 or responseCode 68 - Timeout) via Middleware.';
const TIMEOUT_EXPECTED =
  'The transaction experiencing Timeout (TTTP 408 or 504 or responseCode 68 - Timeout) is marked as PENDING and routed into a dedicated CHECK STATUS queue managed by a scheduler preventing resource blocking on the main transaction flow, enforcing a strict 1 hour delay from the original timeout timestamp before allowing the scheduler to process the record.';
const NOT_FOUND_SCENARIO =
  "Verify retry behavior when the check status response from Core Banking is FAILED (Y.ISO.RESPONSE:1:1='01' and Y.MSG.RES:1:1='Transaction Failed!') or NOT FOUND and the retry attempt has not reached 3 times.";
const NOT_FOUND_EXPECTED_OUTSIDE_CONDITION =
  'The system calls Check Status, identifies FAILED or NOT FOUND, and triggers a retry Release Settlement to Middleware since retry attempt has not reached 3 times.';
const QUOTED_OR_NOT_FOUND =
  'The system calls Check Status to Core Banking via Middleware, receives Y.ISO.RESPONSE:1:1="01" (treated as FAILED) or NOT FOUND, and triggers a retry Release Settlement to Middleware.';
const GUARD_TWO_CONDITIONS =
  'Retry for Settlement Release is not performed when the status check response is anything other than FAILED or when the retry attempt has reached 3 times.';
const DAILY_REPORT =
  'The automated scheduler triggers daily report generation without normal intervention and without creating temporary files (.tmp) during extraction, extracting transaction data from 00.00 to 23.59 on D-1 including both H+1 and On Hold transactions, generating the final report file in .txt format named SETTLEMENT_QRMANAGER_DDMMYYYY.txt (Date using Transaction Date) using a tilde ~ as the data delimiter, and saving the final .txt file into a designated directory path on QR Manager server ready to be fetched by Reconciliation team.';
const QUICKLY =
  'The system performs Table Tuning to optimize the data retrieval process and loads and displays the transaction data grid quickly.';
const EXPORT_ALWAYS_ACTIVE =
  'The Export to TXT button status remains active and enabled under all data states, and clicking it triggers the file generation or download process immediately without any validation lockouts.';
const IMMEDIATELY_REJECTED =
  'The transaction is immediately rejected and response code 92 (Invalid Routing) is sent when routing is not found.';
const PROCEEDS_AND_SENDS =
  'The system proceeds to specific route validation and sends the transaction to the designated switching using messaging according to its technical specifications.';
const PROCEEDS_ONLY =
  'The system proceeds to specific route validation when DEFAULT_SWITCHING is ACTIVE.';
const PROCEEDS_NEXT_ONLY = 'The system proceeds next validation when DEFAULT_SWITCHING is ACTIVE.';
const MERGED_FEATURES =
  'Verify transaction fallback routing for QRIS TUNTAS (Transfer, Setor, Tarik) as Issuer when status is INACTIVE.';

/** PRD_Transaction_Routing_Sanitized.pdf p3, as the production parser reads it. */
const ROUTING_SOURCE = [
  'IF ACTIVE, then proceed to specific route validation',
  'Check the Switching of QRIS MPM :',
  'IF ACTIVE, then send the transaction to the designated switching and use messaging according to its technical specifications.',
].join('\n');

// --- TCD-ATOM-01 -----------------------------------------------------------------------

describe('TCD-ATOM-01: several conditional branches in one Expected Result', () => {
  // tcd-1 reported the three audited retry cases as definite. The review of the
  // frozen runs found that two of them are stages of one retry walk (FAILED ->
  // retry -> retry times out -> Check Status again), which one execution can
  // pass through, so "only one of them can be satisfied" was not true of them.
  // Sequential and uncertain cases are warnings now; definite needs conditions
  // that cannot hold in the same execution.
  it('flags two sequential branches as a warning, not definite (audited run 1 TC-010)', () => {
    const finding = findingFor(testCase(RETRY_TWO_BRANCHES), 'TCD-ATOM-01');
    assert.ok(finding, 'audited case: retry and re-check merged into one case');
    assert.equal(finding.severity, 'warning');
    assert.match(finding.reason, /stages of one sequence/);
    assert.match(finding.evidence, /When check status response is FAILED/);
    assert.match(finding.evidence, /if after Release Settlement 1 and\/or 2 retry attempts/);
  });

  it('flags a re-check branch merged with the terminal FAILED branch as a warning (run 3 TC-010)', () => {
    const finding = findingFor(testCase(RETRY_RECHECK_AND_TERMINAL), 'TCD-ATOM-01');
    assert.ok(finding);
    assert.equal(finding.severity, 'warning');
  });

  it('counts branches inside one long sentence when each condition has its own outcome', () => {
    const finding = findingFor(testCase(RETRY_FIVE_TRANSITIONS), 'TCD-ATOM-01');
    assert.ok(finding);
    assert.match(finding.reason, /states 3 separate conditions/);
    // Its exclusivity depends on whether NOT FOUND is a response of its own,
    // which is an open SME question - so it is not called definite.
    assert.equal(finding.severity, 'warning');
  });

  it('is definite only for branches that cannot hold in the same execution', () => {
    for (const expected of [
      'If the amount is above 10000000, OTP is required; if the amount is 10000000 or below, no OTP is required.',
      'Jika saldo cukup, transaksi berhasil diproses; jika saldo tidak cukup, transaksi ditolak.',
      'If the switching is ACTIVE, the transaction is sent to it; if the switching is INACTIVE, the transaction is sent to DEFAULT_SWITCHING.',
    ]) {
      const finding = findingFor(testCase(expected), 'TCD-ATOM-01');
      assert.ok(finding, expected);
      assert.equal(finding.severity, 'definite', expected);
      assert.match(finding.reason, /cannot hold in the same execution/);
    }
  });

  it('does not treat two status names as exclusive, and does not read NOT FOUND as a negation', () => {
    const finding = findingFor(
      testCase(
        'When the response is FAILED, a retry is triggered; when the response is NOT FOUND, the transaction is marked FAILED.'
      ),
      'TCD-ATOM-01'
    );
    assert.equal(finding.severity, 'warning');
  });

  it('keeps a later stage a warning even when it negates the earlier condition', () => {
    const finding = findingFor(
      testCase(
        'When the first attempt times out, the system retries; if the retry still does not succeed, the transaction is marked PENDING.'
      ),
      'TCD-ATOM-01'
    );
    assert.equal(finding.severity, 'warning');
  });

  it('reads Indonesian conditions', () => {
    const expected =
      'Jika status FAILED, sistem melakukan retry Release Settlement; jika setelah retry ke-3 status masih FAILED, status transaksi ditandai FAILED permanen.';
    assert.ok(ruleIds(testCase(expected)).includes('TCD-ATOM-01'));
  });

  it('leaves a single condition alone (negative control from the audit)', () => {
    assert.ok(!ruleIds(testCase(TERMINAL_FAILED)).includes('TCD-ATOM-01'));
    assert.ok(!ruleIds(testCase(IMMEDIATELY_REJECTED)).includes('TCD-ATOM-01'));
  });

  it('does not count alternative conditions of one outcome as separate branches', () => {
    assert.ok(!ruleIds(testCase(GUARD_TWO_CONDITIONS)).includes('TCD-ATOM-01'));
  });

  it('does not count a restated condition as a second branch', () => {
    const expected =
      'The request is rejected when the amount exceeds the daily limit. An error message is displayed when the amount exceeds the daily limit.';
    assert.ok(!ruleIds(testCase(expected)).includes('TCD-ATOM-01'));
  });

  it('does not read idioms like "if any" as conditions', () => {
    const expected = 'Errors, if any, are listed in the import summary when the import finishes.';
    assert.ok(!ruleIds(testCase(expected)).includes('TCD-ATOM-01'));
  });
});

// --- TCD-ATOM-02 -----------------------------------------------------------------------

describe('TCD-ATOM-02: alternatives joined by "or"', () => {
  it('flags alternative timeout codes as a warning and names them', () => {
    const finding = findingFor(
      testCase('The transaction is marked as PENDING.', TIMEOUT_SCENARIO),
      'TCD-ATOM-02'
    );
    assert.ok(finding);
    assert.equal(finding.severity, 'warning');
    assert.equal(finding.field, 'test_case');
    assert.match(finding.reason, /408 \/ 504 \/ 68/);
  });

  it('flags codes joined by "or" wherever they appear, not only after "when"', () => {
    assert.ok(ruleIds(testCase(TIMEOUT_EXPECTED)).includes('TCD-ATOM-02'));
  });

  it('flags FAILED or NOT FOUND inside a condition', () => {
    const finding = findingFor(
      testCase(NOT_FOUND_EXPECTED_OUTSIDE_CONDITION, NOT_FOUND_SCENARIO),
      'TCD-ATOM-02'
    );
    assert.ok(finding);
    assert.equal(finding.field, 'test_case');
    assert.match(finding.reason, /FAILED \/ NOT FOUND/);
  });

  it('flags a quoted code joined by "or" to a status', () => {
    assert.ok(ruleIds(testCase(QUOTED_OR_NOT_FOUND)).includes('TCD-ATOM-02'));
  });

  it('flags alternative conditions ("… or when …")', () => {
    assert.ok(ruleIds(testCase(GUARD_TWO_CONDITIONS)).includes('TCD-ATOM-02'));
  });

  it('reads Indonesian "atau"', () => {
    assert.ok(
      ruleIds(
        testCase('Retry dijalankan.', 'Verifikasi retry ketika status FAILED atau NOT FOUND.')
      ).includes('TCD-ATOM-02')
    );
  });

  it('ignores "1 and/or 2" retry counts', () => {
    assert.ok(
      !ruleIds(testCase(RECHECK_ONLY, 'Verify behavior after 1 and/or 2 retry attempts.')).includes(
        'TCD-ATOM-02'
      )
    );
  });

  it('ignores status words listed in an outcome rather than a condition', () => {
    assert.ok(!ruleIds(testCase(NOT_FOUND_EXPECTED_OUTSIDE_CONDITION)).includes('TCD-ATOM-02'));
    assert.ok(
      !ruleIds(
        testCase('The system shows transactions with the status Unsettled or Unreleased.')
      ).includes('TCD-ATOM-02')
    );
  });

  it('does not read capitalised names of protocols as alternatives', () => {
    assert.ok(
      !ruleIds(
        testCase('The file is delivered over SFTP or HTTPS when the batch completes.')
      ).includes('TCD-ATOM-02')
    );
  });

  it('reads codes that end a sentence (tcd-1 missed "408 or 504.")', () => {
    for (const scenario of [
      'Verify handling when the middleware returns either 408 or 504.',
      'Verify retry when Core Banking returns HTTP 500 or 503.',
      'Verify retry when Core Banking returns HTTP 500 or 503!',
    ]) {
      const finding = findingFor(
        testCase('The record is marked PENDING.', scenario),
        'TCD-ATOM-02'
      );
      assert.ok(finding, scenario);
      assert.equal(finding.severity, 'warning');
    }
  });

  it('reads a comma list that ends in "or" as one list of alternatives', () => {
    const finding = findingFor(
      testCase(
        'The record is marked PENDING.',
        'Verify handling when Release Settlement experiences a timeout (HTTP 408, 504, or responseCode 68).'
      ),
      'TCD-ATOM-02'
    );
    assert.ok(finding);
    assert.match(finding.reason, /408 \/ 504 \/ 68/);
  });

  it('reads slash lists of codes and statuses inside a condition', () => {
    const codes = findingFor(
      testCase(
        'The record is marked PENDING.',
        'Verify handling when Release Settlement experiences a timeout (HTTP 408/504/68).'
      ),
      'TCD-ATOM-02'
    );
    assert.match(codes.reason, /408 \/ 504 \/ 68/);
    assert.match(codes.reason, /joined by "\/"/);
    const statuses = findingFor(
      testCase('When the response is FAILED/NOT FOUND, the system triggers a retry.'),
      'TCD-ATOM-02'
    );
    assert.match(statuses.reason, /FAILED \/ NOT FOUND/);
  });

  it('does not read times, dates, decimals, legends or plain comma lists as alternatives', () => {
    for (const [expected, scenario] of [
      ['The batch runs.', 'Verify the batch when it starts at 10.30 or 11.00.'],
      ['The report is dated 14/10/26.', 'Verify the report header.'],
      ['The page shows 10/12 records.', 'Verify the counter.'],
      ['The legend shows PENDING / SUCCESS / FAILED.', 'Verify the legend.'],
      ['Codes 408, 504 and 68 are written to the log.', 'Verify logging.'],
      ['The total is 1.5 or 2.5 percent of the amount.', 'Verify the fee.'],
    ]) {
      assert.ok(
        !ruleIds(testCase(expected, scenario)).includes('TCD-ATOM-02'),
        `${scenario} / ${expected}`
      );
    }
  });

  it('does not assume that two status names are two responses', () => {
    // FAILED and NOT FOUND share the code "01" in the audited PRD (p8), and
    // whether NOT FOUND is a separate response is an open SME question. The
    // finding asks it; it does not tell the reader to split the case.
    const status = findingFor(
      testCase(NOT_FOUND_EXPECTED_OUTSIDE_CONDITION, NOT_FOUND_SCENARIO),
      'TCD-ATOM-02'
    );
    assert.match(status.reason, /one response under two names/);
    assert.match(status.action, /Confirm with the source or the SME/);
    assert.match(status.action, /Do not decide it by assumption/);
    // Codes are distinct values, so their finding keeps the plain wording.
    const codes = findingFor(
      testCase('The transaction is marked as PENDING.', TIMEOUT_SCENARIO),
      'TCD-ATOM-02'
    );
    assert.doesNotMatch(codes.reason, /one response under two names/);
  });

  it('leaves Title-case alternatives alone, which may be synonyms', () => {
    const scenario =
      'Verify release date and time display when a transaction status achieves Settled or Released.';
    assert.ok(!ruleIds(testCase('The column is displayed.', scenario)).includes('TCD-ATOM-02'));
  });
});

// --- TCD-ATOM-03 -----------------------------------------------------------------------

describe('TCD-ATOM-03: a checklist of independent outcomes', () => {
  it('flags a daily-report case that checks timing, window, files, format and location at once', () => {
    const finding = findingFor(testCase(DAILY_REPORT), 'TCD-ATOM-03');
    assert.ok(finding);
    assert.equal(finding.severity, 'warning');
    assert.match(finding.evidence, /\.tmp/);
    assert.match(finding.evidence, /settlement_qrmanager_ddmmyyyy\.txt/);
  });

  it('leaves a short sequence of steps on one outcome alone', () => {
    assert.ok(!ruleIds(testCase(SUCCESS_SEQUENCE)).includes('TCD-ATOM-03'));
  });

  it('leaves a single outcome that quotes many values alone', () => {
    assert.ok(!ruleIds(testCase(SUCCESS_MAPPING)).includes('TCD-ATOM-03'));
  });
});

// --- TCD-ATOM-04 -----------------------------------------------------------------------

describe('TCD-ATOM-04: enumerated variants in one case (disabled by default)', () => {
  it('reports nothing by default, even on the audited case', () => {
    assert.ok(
      !ruleIds(testCase('The transaction is sent to DEFAULT_SWITCHING.', MERGED_FEATURES)).includes(
        'TCD-ATOM-04'
      )
    );
  });

  it('when enabled, flags three feature variants named in one case', () => {
    const finding = findingFor(
      testCase('The transaction is sent to DEFAULT_SWITCHING.', MERGED_FEATURES),
      'TCD-ATOM-04',
      UNAVAILABLE,
      ENABLE_ATOM_04
    );
    assert.ok(finding);
    assert.match(finding.reason, /3 variants \(Transfer, Setor, Tarik\)/);
  });

  it('when enabled, leaves qualifiers, counts and examples alone', () => {
    for (const scenario of [
      'Verify Select All when the user clicks the Release action button (Settlement Type: HOLD).',
      'Verify Select All selects the current page (up to 10 rows per page).',
      'Verify the filter (e.g. Settled, Unsettled, Settled & Unsettled) is shown.',
    ]) {
      assert.ok(
        !ruleIds(testCase('Rows are selected.', scenario), UNAVAILABLE, ENABLE_ATOM_04).includes(
          'TCD-ATOM-04'
        ),
        scenario
      );
    }
  });

  it('known false positives that keep it disabled: columns and dropdown options read as variants', () => {
    // Regression evidence from the review's probes (A4-04, A4-05). These are
    // lists of attributes of ONE check, not variants. While this assertion
    // holds, the rule still over-fires and must stay off by default; when a
    // revision makes it fail, update it to assert the fix.
    for (const scenario of [
      'Verify the daily report contains the columns (TRX_DATE, PAN, AMOUNT).',
      'Verify the Settlement Status dropdown offers the options (Settled, Unsettled, Settled & Unsettled).',
    ]) {
      assert.ok(
        ruleIds(testCase('It is shown.', scenario), UNAVAILABLE, ENABLE_ATOM_04).includes(
          'TCD-ATOM-04'
        ),
        scenario
      );
      assert.ok(!ruleIds(testCase('It is shown.', scenario)).includes('TCD-ATOM-04'), scenario);
    }
  });
});

// --- TCD-VAGUE-01/02/03 -------------------------------------------------------------------

describe('TCD-VAGUE-01: speed without a threshold', () => {
  it('flags "quickly" as definite and says the source is unknown when it is', () => {
    const finding = findingFor(testCase(QUICKLY), 'TCD-VAGUE-01');
    assert.ok(finding);
    assert.equal(finding.severity, 'definite');
    assert.equal(finding.source_context, 'unavailable');
    assert.match(finding.reason, /Source context is not available/);
  });

  it('points at a threshold the cited requirement states', () => {
    const finding = findingFor(
      testCase(QUICKLY),
      'TCD-VAGUE-01',
      cited('Load and display the transaction data grid within 3 seconds for 10,000 rows.')
    );
    assert.equal(finding.source_context, 'cited');
    assert.match(finding.source_evidence, /within 3 seconds/);
  });

  it('calls a requirement without a threshold a source gap', () => {
    const finding = findingFor(
      testCase(QUICKLY),
      'TCD-VAGUE-01',
      cited(
        'Load and display the transaction data grid quickly. Current condition: cost 28 seconds.'
      )
    );
    // "28 seconds" is a baseline, and it is measurable, so it is offered as the
    // nearest stated value - the rule does not decide whether it is the target,
    // and must not present it as one.
    assert.match(finding.source_evidence, /28 seconds/);
    assert.match(finding.reason, /target or only a baseline/);
    assert.doesNotMatch(finding.reason, /intended threshold/);
    const none = findingFor(
      testCase(QUICKLY),
      'TCD-VAGUE-01',
      cited('Load and display the grid quickly.')
    );
    assert.match(none.reason, /source gap for the SME/);
  });

  it('reads Indonesian', () => {
    assert.ok(
      ruleIds(testCase('Data transaksi ditampilkan dengan cepat.')).includes('TCD-VAGUE-01')
    );
  });

  it('leaves a stated threshold and a feature name alone', () => {
    assert.ok(
      !ruleIds(testCase('The grid loads quickly, within 3 seconds.')).includes('TCD-VAGUE-01')
    );
    assert.ok(!ruleIds(testCase('The Quick Pay menu is displayed.')).includes('TCD-VAGUE-01'));
  });

  it('leaves lower-case names of things alone (tcd-1 called these definite)', () => {
    for (const expected of [
      'The quick search box is displayed above the transaction table.',
      'The request is routed to the fast-track approval queue.',
      'A quick filter panel is shown next to the grid.',
      'Menu akses cepat ditampilkan di dashboard.',
    ]) {
      assert.ok(!ruleIds(testCase(expected)).includes('TCD-VAGUE-01'), expected);
    }
  });

  it('still flags a speed adjective used as a claim', () => {
    for (const expected of [
      'The transaction page is fast.',
      'The transaction grid loads fast.',
      'The system provides a fast response to every search.',
      'The grid loads faster than before.',
      'Halaman transaksi harus cepat.',
      'The grid is displayed without delay.',
    ]) {
      const finding = findingFor(testCase(expected), 'TCD-VAGUE-01');
      assert.ok(finding, expected);
      assert.equal(finding.severity, 'definite', expected);
    }
  });
});

describe('TCD-VAGUE-02: "immediately" as an unmeasured timing claim (disabled by default)', () => {
  it('reports nothing by default, even on the audited case', () => {
    assert.ok(!ruleIds(testCase(EXPORT_ALWAYS_ACTIVE)).includes('TCD-VAGUE-02'));
  });

  it('when enabled, flags it as a warning when it qualifies a process', () => {
    const finding = findingFor(
      testCase(EXPORT_ALWAYS_ACTIVE),
      'TCD-VAGUE-02',
      UNAVAILABLE,
      ENABLE_VAGUE_02
    );
    assert.ok(finding);
    assert.equal(finding.severity, 'warning');
  });

  it('when enabled, leaves "immediately rejected" alone: that is an ordering, not a response time', () => {
    assert.ok(
      !ruleIds(testCase(IMMEDIATELY_REJECTED), UNAVAILABLE, ENABLE_VAGUE_02).includes(
        'TCD-VAGUE-02'
      )
    );
    assert.ok(
      !ruleIds(
        testCase('Transaksi segera ditolak dengan kode 92.'),
        UNAVAILABLE,
        ENABLE_VAGUE_02
      ).includes('TCD-VAGUE-02')
    );
  });

  it('known false positive that keeps it disabled: "immediately forwarded" is an ordering too', () => {
    // Regression evidence (review probe V2-02). Update when a revision fixes it.
    const expected = 'The transaction is immediately forwarded to the designated switching.';
    assert.ok(ruleIds(testCase(expected), UNAVAILABLE, ENABLE_VAGUE_02).includes('TCD-VAGUE-02'));
    assert.ok(!ruleIds(testCase(expected)).includes('TCD-VAGUE-02'));
  });

  it('leaves the same case to TCD-VAGUE-03, which asks the remaining question', () => {
    assert.ok(ruleIds(testCase(EXPORT_ALWAYS_ACTIVE)).includes('TCD-VAGUE-03'));
  });
});

describe('TCD-VAGUE-03: a scope nobody enumerated', () => {
  it('flags "all data states"', () => {
    const finding = findingFor(testCase(EXPORT_ALWAYS_ACTIVE), 'TCD-VAGUE-03');
    assert.ok(finding);
    assert.match(finding.evidence, /all data states/);
  });

  it('is not silenced by a time limit elsewhere in the Expected Result', () => {
    const ids = ruleIds(
      testCase('The button stays enabled under all data states and responds within 2 seconds.')
    );
    assert.ok(ids.includes('TCD-VAGUE-03'));
    assert.ok(!ids.includes('TCD-VAGUE-01'));
  });

  it('leaves concrete "all" phrases alone', () => {
    assert.ok(
      !ruleIds(testCase('The system selects all transaction rows in the table.')).includes(
        'TCD-VAGUE-03'
      )
    );
    assert.ok(
      !ruleIds(testCase('The system loads all available data from all dates.')).includes(
        'TCD-VAGUE-03'
      )
    );
  });
});

// --- TCD-INTER-01 ----------------------------------------------------------------------------

describe('TCD-INTER-01: an intermediate step with no end result', () => {
  it('flags it as a warning when no source context is available', () => {
    const finding = findingFor(testCase(PROCEEDS_ONLY), 'TCD-INTER-01');
    assert.ok(finding);
    assert.equal(finding.severity, 'warning');
    assert.equal(finding.source_context, 'unavailable');
    assert.ok(ruleIds(testCase(PROCEEDS_NEXT_ONLY)).includes('TCD-INTER-01'));
  });

  it('is definite when the cited source states what happens after the step', () => {
    const finding = findingFor(testCase(PROCEEDS_ONLY), 'TCD-INTER-01', cited(ROUTING_SOURCE));
    assert.equal(finding.severity, 'definite');
    assert.equal(finding.source_context, 'cited');
    assert.match(finding.source_evidence, /then send the transaction/);
  });

  it('says nothing when the source itself ends at the step', () => {
    assert.equal(
      findingFor(
        testCase(PROCEEDS_ONLY),
        'TCD-INTER-01',
        cited('IF ACTIVE, then proceed to specific route validation.')
      ),
      undefined
    );
  });

  it('stays a warning when the source does not mention the step', () => {
    const finding = findingFor(
      testCase(PROCEEDS_ONLY),
      'TCD-INTER-01',
      cited('Display the Select All checkbox near the table.')
    );
    assert.equal(finding.severity, 'warning');
    assert.equal(finding.source_context, 'cited');
  });

  it('is never definite on project-level text, and quotes none of it', () => {
    // tcd-1 judged a case citing no requirement against the whole project and
    // quoted the first "proceed … then send" it found - for five of the six
    // audited cases, a different section (RT-1 p3) from the case's own.
    const finding = findingFor(testCase(PROCEEDS_ONLY), 'TCD-INTER-01', {
      kind: 'project',
      requirements: cited(ROUTING_SOURCE).requirements,
    });
    assert.equal(finding.severity, 'warning');
    assert.equal(finding.source_context, 'project');
    assert.equal(finding.source_evidence, null);
    assert.match(finding.reason, /cannot be linked/);
  });

  it('judges a case only by the requirement it cites, never by another section', () => {
    const requirements = [
      {
        requirement_id: 'REQ-1',
        title: 'Domestic routing',
        description:
          'IF ACTIVE, then proceed to the next validation. Check the Switching: IF ACTIVE, then send the transaction to the designated switching.',
        source_references: [],
      },
      {
        requirement_id: 'REQ-2',
        title: 'Inquiry gate',
        description: 'IF ACTIVE, then proceed to the next validation.',
        source_references: [],
      },
    ];
    const gate = (ids) =>
      testCase(
        'The system proceeds to the next validation when DEFAULT_SWITCHING is ACTIVE.',
        'Verify.',
        { requirement_ids: ids }
      );
    const run = (ids) =>
      diagnoseTestCases({ requirements, test_cases: [gate(ids)] }).findings.filter(
        (finding) => finding.rule_id === 'TCD-INTER-01'
      );

    assert.deepEqual(run(['REQ-2']), [], 'its own source ends at the step');
    const [linked] = run(['REQ-1']);
    assert.equal(linked.severity, 'definite');
    assert.match(linked.source_evidence, /Domestic routing|then send the transaction/);
    assert.doesNotMatch(linked.source_evidence, /Inquiry gate/);
    const [unlinked] = run([]);
    assert.equal(unlinked.severity, 'warning');
    assert.equal(unlinked.source_evidence, null);
  });

  it('leaves a step followed by its outcome alone (negative control from the audit)', () => {
    assert.ok(!ruleIds(testCase(PROCEEDS_AND_SENDS)).includes('TCD-INTER-01'));
    assert.ok(
      !ruleIds(testCase(PROCEEDS_AND_SENDS), cited(ROUTING_SOURCE)).includes('TCD-INTER-01')
    );
  });

  it('reads Indonesian', () => {
    assert.ok(
      ruleIds(
        testCase('Sistem lanjut ke validasi berikutnya ketika DEFAULT_SWITCHING ACTIVE.')
      ).includes('TCD-INTER-01')
    );
  });
});

// --- The contract -------------------------------------------------------------------------------

function deepFreeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

function auditedProject() {
  return {
    requirements: [],
    test_cases: [
      testCase(
        RETRY_TWO_BRANCHES,
        'Verify retry and re-check behavior when check status response is FAILED or NOT FOUND.',
        { case_id: 'TC-010' }
      ),
      testCase(TERMINAL_FAILED, 'Verify permanent failure marking.', { case_id: 'TC-011' }),
      testCase(QUICKLY, 'Verify grid loading performance.', { case_id: 'TC-005' }),
      testCase(DAILY_REPORT, 'Verify automated daily report generation.', { case_id: 'TC-006' }),
      testCase(PROCEEDS_AND_SENDS, 'Verify routing.', { case_id: 'TC-002' }),
    ],
  };
}

describe('diagnoseTestCases: contract', () => {
  it('returns findings with every field a reviewer needs', () => {
    const result = diagnoseTestCases(auditedProject());
    assert.equal(result.rules_version, TESTCASE_DIAGNOSTICS_VERSION);
    assert.equal(result.status, 'completed');
    assert.ok(result.findings.length > 0);
    for (const finding of result.findings) {
      assert.ok(Object.hasOwn(DIAGNOSTIC_RULES, finding.rule_id), finding.rule_id);
      assert.equal(finding.rule, DIAGNOSTIC_RULES[finding.rule_id]);
      assert.ok(DIAGNOSTIC_SEVERITIES.includes(finding.severity));
      assert.match(finding.testcase_id, /^TC-\d{3}$/);
      assert.ok(['test_case', 'expected_result'].includes(finding.field));
      for (const key of ['evidence', 'reason', 'action']) {
        assert.equal(typeof finding[key], 'string');
        assert.ok(finding[key].length > 10, `${finding.rule_id} ${key}`);
      }
      assert.ok(['cited', 'project', 'unavailable', 'not_needed'].includes(finding.source_context));
    }
  });

  it('reports at most one finding per rule per case, definite first', () => {
    const { findings } = diagnoseTestCases(auditedProject());
    const keys = findings.map((finding) => `${finding.testcase_id}|${finding.rule_id}`);
    assert.equal(new Set(keys).size, keys.length);
    const firstWarning = findings.findIndex((finding) => finding.severity === 'warning');
    assert.ok(findings.slice(firstWarning).every((finding) => finding.severity === 'warning'));
  });

  it('summarises what it found', () => {
    const { findings, summary } = diagnoseTestCases(auditedProject());
    assert.equal(summary.total, findings.length);
    assert.equal(summary.definite + summary.warning, findings.length);
    assert.equal(
      Object.values(summary.by_rule).reduce((sum, count) => sum + count, 0),
      findings.length
    );
    assert.equal(
      summary.testcases_flagged,
      new Set(findings.map((finding) => finding.testcase_id)).size
    );
  });

  it('is pure: the project is never written, and the same project gives the same findings', () => {
    const project = auditedProject();
    const before = structuredClone(project);
    const first = diagnoseTestCases(deepFreeze(project));
    assert.deepEqual(project, before);
    assert.deepEqual(diagnoseTestCases(structuredClone(before)), first);
  });

  it('does not invent context: a case citing a missing requirement falls back to the project', () => {
    const project = {
      requirements: [
        {
          requirement_id: 'REQ-001',
          title: 'R',
          description: ROUTING_SOURCE,
          source_references: [],
        },
      ],
      test_cases: [testCase(PROCEEDS_ONLY, 'Verify.', { requirement_ids: ['REQ-404'] })],
    };
    const [finding] = diagnoseTestCases(project).findings;
    assert.equal(finding.source_context, 'project');
    // The project text is not linked to this case, so it cannot make the finding
    // definite and is not quoted (tcd-1 said definite here).
    assert.equal(finding.severity, 'warning');
    assert.equal(finding.source_evidence, null);
  });

  it('runs no default-disabled rule unless asked, and says which rules were off', () => {
    const project = {
      requirements: [],
      test_cases: [
        testCase('The transaction is sent to DEFAULT_SWITCHING.', MERGED_FEATURES, {
          case_id: 'TC-001',
        }),
        testCase(EXPORT_ALWAYS_ACTIVE, 'Verify Export.', { case_id: 'TC-002' }),
      ],
    };
    const off = diagnoseTestCases(project);
    assert.deepEqual(off.disabled_rules, [...DEFAULT_DISABLED_RULES]);
    assert.deepEqual([...DEFAULT_DISABLED_RULES].sort(), ['TCD-ATOM-04', 'TCD-VAGUE-02']);
    for (const ruleId of DEFAULT_DISABLED_RULES) {
      assert.ok(!off.findings.some((finding) => finding.rule_id === ruleId), ruleId);
      assert.equal(off.summary.by_rule[ruleId], 0, ruleId);
    }

    const on = diagnoseTestCases(project, { enableRules: [...DEFAULT_DISABLED_RULES] });
    assert.deepEqual(on.disabled_rules, []);
    for (const ruleId of DEFAULT_DISABLED_RULES) {
      assert.ok(
        on.findings.some((finding) => finding.rule_id === ruleId),
        ruleId
      );
    }

    // Opting in adds findings; it changes none of the others.
    const others = (result) =>
      result.findings.filter((finding) => !DEFAULT_DISABLED_RULES.includes(finding.rule_id));
    assert.deepEqual(others(on), off.findings);
  });

  it('ignores unknown rule ids in enableRules', () => {
    const result = diagnoseTestCases(auditedProject(), { enableRules: ['TCD-NOPE-99'] });
    assert.deepEqual(result.disabled_rules, [...DEFAULT_DISABLED_RULES]);
    assert.deepEqual(result, diagnoseTestCases(auditedProject()));
  });

  it('copes with an empty project and with fields that are not text', () => {
    assert.equal(diagnoseTestCases({ requirements: [], test_cases: [] }).summary.total, 0);
    assert.equal(diagnoseTestCases({}).status, 'completed');
    const odd = diagnoseTestCases({
      test_cases: [{ case_id: 'TC-001', test_case: null, expected_result: 42 }],
    });
    assert.equal(odd.summary.total, 0);
  });

  it('has the same shape when skipped', () => {
    const skipped = skippedDiagnostics('Not structurally valid.');
    assert.equal(skipped.status, 'skipped');
    assert.deepEqual(skipped.findings, []);
    assert.deepEqual(Object.keys(skipped.summary.by_rule), Object.keys(DIAGNOSTIC_RULES));
    assert.deepEqual(
      Object.keys(skipped),
      Object.keys(diagnoseTestCases({ requirements: [], test_cases: [] }))
    );
  });
});
