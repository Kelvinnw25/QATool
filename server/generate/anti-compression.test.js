import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { deriveCoverageObligations, matchObligations } from '../scenario/obligations.js';
import { buildPrompt } from './prompt.js';

/**
 * Combining obligations is allowed; losing them in the combination is not.
 *
 * The generator composes at requirement granularity and then writes one summary
 * expected_result. Summarising keeps the headline behaviour and drops two kinds
 * of detail first, every time:
 *
 *   modifiers     a qualifier narrows an action without changing it, so "using
 *                 Transaction Date" reads as decoration beside "generates
 *                 SETTLEMENT_QRMANAGER_DDMMYYYY.txt"
 *   prohibitions  "without normal intervention", "without .tmp files",
 *                 "preventing resource blocking", "only performed when ..."
 *                 say what must NOT happen, and a sentence about what DOES
 *                 happen omits them silently
 *
 * One real case proved it: a single test for the whole daily-report requirement
 * named the schedule, the date range, the .tmp exclusion, the format, the
 * delimiter and the directory - and dropped exactly the modifier and the
 * prohibition.
 *
 * These tests fix the DISCRIMINATION in place. Each pair is the same behaviour
 * written twice: once as the compressed summary that was actually generated,
 * once with the evidence present. The compressed one must not count. A false
 * pass here is invisible and ships to SIT; a false gap is merely annoying.
 *
 * Nothing here asserts how many test cases exist, and nothing compares counts
 * between runs - one case carrying all the evidence and four cases carrying it
 * between them are both correct.
 */

function requirement(description, id = 'REQ-001') {
  return {
    requirement_id: id,
    title: 'Requirement',
    description,
    category: 'Business Rule',
    source_references: [{ document_id: 'DOC-001', page: 4, section: null, quote: null }],
    ambiguities: [],
    conflicts: [],
  };
}

function testCase(action, expected, caseId = 'TC-001') {
  return {
    case_id: caseId,
    requirement_ids: ['REQ-001'],
    test_case: action,
    expected_result: expected,
    case_type: 'Positive',
    edge_polarity: null,
  };
}

/** Every obligation of `description`, matched against `cases`. */
function matched(description, cases) {
  return matchObligations(deriveCoverageObligations([requirement(description)]), cases);
}

/** The obligations whose statement mentions `pattern`, and whether each is covered. */
function about(description, cases, pattern) {
  const entries = matched(description, cases).filter(
    (entry) => pattern.test(entry.statement) || pattern.test(entry.source_basis)
  );

  assert.ok(entries.length > 0, `no obligation about ${pattern} in: ${description}`);
  return entries;
}

const allCovered = (entries) => entries.every((entry) => entry.covered);

// --- the daily report ---------------------------------------------------------

/**
 * The GIVEN/WHEN/THEN wrapper is part of the fixture, not decoration: the
 * acceptance criteria only derive as obligations when they sit under a THEN
 * lead-in, which is how the real document writes them.
 */
const DAILY =
  'GIVEN the daily settlement report is due\n' +
  'WHEN the system clock reaches 03.00 AM\n' +
  'THEN the system must fulfill:\n' +
  'Create and implement new automated scheduler to trigger the daily report generation\n' +
  'Ensure the process runs automatically without normal intervention and without creating temporary files (.tmp) during extraction\n' +
  'Use SETTLEMENT_QRMANAGER_DDMMYYYY.txt as file name format (Date using Transaction Date)';

describe('a combined daily-report case', () => {
  /** A. Combining is fine when the evidence for each part is actually there. */
  it('covers both the automatic run and the .tmp exclusion when it states both', () => {
    const cases = [
      testCase(
        'Verify the automated daily settlement report generation.',
        'The scheduler runs the extraction automatically without normal intervention, and no temporary .tmp files are created during extraction.'
      ),
    ];

    assert.ok(
      allCovered(about(DAILY, cases, /normal intervention/)),
      'one case can carry two obligations when it states both'
    );
  });

  /** B. The case that was actually generated: format right, date missing. */
  it('does NOT cover the Transaction Date when it states the format alone', () => {
    const cases = [
      testCase(
        'Verify automated daily settlement report generation by the scheduler.',
        'The automated scheduler triggers report generation at 03.00 AM, extracts all transaction data from 00.00 to 23.59 on D-1 without .tmp files, uses SETTLEMENT_QRMANAGER_DDMMYYYY.txt format with tilde ~ delimiter, and saves the file to the designated directory.'
      ),
    ];

    assert.ok(
      !allCovered(about(DAILY, cases, /Transaction Date/)),
      'a long, accurate summary that omits the qualifier does not discharge it'
    );
  });

  it('does cover the Transaction Date once the case names it', () => {
    const cases = [
      testCase(
        'Verify the daily report file name.',
        'The report is saved as SETTLEMENT_QRMANAGER_DDMMYYYY.txt, where the date is taken from the Transaction Date.'
      ),
    ];

    assert.ok(allCovered(about(DAILY, cases, /Transaction Date/)));
  });

  /**
   * The summary the task called out. It asserts nothing a tester can fail, so
   * it must discharge nothing.
   */
  it('covers nothing at all when it only claims the report is generated correctly', () => {
    const cases = [
      testCase('Verify the daily report.', 'The system generates the daily report correctly.'),
    ];

    assert.deepEqual(
      matched(DAILY, cases).filter((entry) => entry.covered),
      []
    );
  });
});

// --- the retry guard ----------------------------------------------------------

const RETRY =
  'IF FAILED or NOT FOUND, then trigger retry Release Settlement to MW. The maximum number of settlement release retries is 3.\n' +
  'Notes: Retry for Settlement Release is only performed when the status check response is\n' +
  'FAILED (transaction not completed) and the retry attempt has not reached 3 times';

describe('a combined retry case', () => {
  /** C. The generated case: the retry happens, stops at 3, and is never forbidden. */
  it('does NOT cover the guard when it only proves the retry happens', () => {
    const cases = [
      testCase(
        'Verify status verification retry behaviour when T24 returns Failure or Not Found.',
        'When the check status response is FAILED or NOT FOUND, retry Release Settlement to MW is triggered up to a maximum of 3 retries.'
      ),
    ];

    assert.ok(
      !allCovered(about(RETRY, cases, /Guard/)),
      'FAILED plus max 3 is not the same statement as "only when FAILED and attempts < 3"'
    );
  });

  /** D. And does cover it once the restriction is stated. */
  it('covers the guard when it states both halves of the restriction', () => {
    const cases = [
      testCase(
        'Verify no retry is triggered outside the permitted condition.',
        'Retry for Settlement Release is only performed when the status check response is FAILED and the retry attempt has not reached 3 times; no retry occurs for any other response or once 3 attempts have been made.'
      ),
    ];

    assert.ok(allCovered(about(RETRY, cases, /Guard/)));
  });

  /** The base behaviour is still covered by the base case - nothing regressed. */
  it('still covers the retry behaviour and the limit from the base case', () => {
    const cases = [
      testCase(
        'Verify retry on a failed status check.',
        'A retry of Release Settlement to MW is triggered, up to a maximum of 3 retries.'
      ),
    ];

    assert.ok(allCovered(about(RETRY, cases, /Retry behaviour/)));
    assert.ok(allCovered(about(RETRY, cases, /Retry limit of 3/)));
  });
});

// --- the queue ----------------------------------------------------------------

const QUEUE =
  'GIVEN a settlement release times out\n' +
  'WHEN the timeout is caught\n' +
  'THEN the system must fulfill:\n' +
  'Route the pending transaction into a dedicated CHECK STATUS queue\n' +
  'Trigger a scheduler to manage this queue, preventing any resource blocking on the main transaction flow.';

describe('a combined queue case', () => {
  /** E. Routing is not scheduler ownership, and neither is non-blocking. */
  it('does NOT cover scheduler management when it only states the routing', () => {
    const cases = [
      testCase(
        'Verify timed-out transactions are queued.',
        'The pending transaction is routed into the dedicated CHECK STATUS queue.'
      ),
    ];

    assert.ok(
      !allCovered(about(QUEUE, cases, /scheduler to manage/)),
      'routing does not imply who manages the queue or what stays unblocked'
    );
  });

  /** F. Both further behaviours stated, both covered. */
  it('covers scheduler management and non-blocking when it states them', () => {
    const cases = [
      testCase(
        'Verify the CHECK STATUS queue is managed without blocking the main flow.',
        'A scheduler is triggered to manage the CHECK STATUS queue, preventing any resource blocking on the main transaction flow.'
      ),
    ];

    assert.ok(allCovered(about(QUEUE, cases, /scheduler to manage/)));
  });
});

// --- G: nothing regressed -----------------------------------------------------

describe('the qualifier that was already covered', () => {
  const MSCORE = 'Call Check Status to T24 via MW (mscore*) to verify the actual state.';

  it('is still covered by a case naming the component', () => {
    const cases = [
      testCase(
        'Verify status verification handling when T24 returns a Success response.',
        'When check status response from T24 via mscore is Success, the DB status is updated to SUCCESS.'
      ),
    ];

    assert.ok(allCovered(about(MSCORE, cases, /mscore/)));
  });

  it('is still NOT covered by a case that drops it', () => {
    const cases = [
      testCase(
        'Verify status verification handling.',
        'When the check status response from T24 via MW is Success, the DB status is updated to SUCCESS.'
      ),
    ];

    assert.ok(!allCovered(about(MSCORE, cases, /mscore/)));
  });
});

// --- H and I: composition stays free ------------------------------------------

describe('how the obligations are distributed between cases', () => {
  /** H. A genuine multi-obligation case remains valid when the evidence is there. */
  it('accepts one case covering several obligations, each with its own evidence', () => {
    const cases = [
      testCase(
        'Verify the automated daily settlement report end to end.',
        'The automated scheduler triggers generation, the process runs automatically without normal intervention and creates no temporary .tmp files, and the output is named SETTLEMENT_QRMANAGER_DDMMYYYY.txt using the Transaction Date.'
      ),
    ];

    assert.deepEqual(
      matched(DAILY, cases).filter((entry) => !entry.covered),
      [],
      'one case can discharge the whole requirement when it says everything'
    );
  });

  /**
   * I. The same obligations split across three cases are equally covered. The
   * rule is about evidence inside whatever case is written, never about how
   * many cases exist, so neither shape is preferred and counts stay free to
   * vary between runs.
   */
  it('accepts the same obligations split across several cases', () => {
    const cases = [
      testCase(
        'Verify the scheduler triggers generation.',
        'The automated scheduler triggers the daily report generation.',
        'TC-001'
      ),
      testCase(
        'Verify unattended extraction.',
        'The process runs automatically without normal intervention and creates no temporary .tmp files during extraction.',
        'TC-002'
      ),
      testCase(
        'Verify the report file name.',
        'The file is named SETTLEMENT_QRMANAGER_DDMMYYYY.txt using the Transaction Date.',
        'TC-003'
      ),
    ];

    assert.deepEqual(
      matched(DAILY, cases).filter((entry) => !entry.covered),
      [],
      'three cases discharge exactly what one case did'
    );
  });
});

// --- the instruction itself ---------------------------------------------------

describe('the anti-compression rule reaches the generator', () => {
  const canonical = {
    project: { project_name: 'Settlement' },
    documents: [{ document_id: 'DOC-001', filename: 'PRD.pdf', document_type: 'PRD' }],
    requirements: [requirement(DAILY)],
  };

  const prompt = () =>
    buildPrompt(canonical, [], deriveCoverageObligations(canonical.requirements), []);

  it('states the evidence invariant', () => {
    assert.match(prompt(), /ITS OWN TEXT MUST SHOW EVIDENCE FOR ALL N/);
  });

  it('rejects "already covered elsewhere" as evidence', () => {
    assert.match(prompt(), /is not evidence/);
    assert.match(prompt(), /never discharged by implication/);
  });

  it('offers splitting as the remedy rather than compressing', () => {
    assert.match(prompt(), /Splitting is always available/);
  });

  it('shows the summary that covers nothing', () => {
    assert.match(prompt(), /generates the daily report correctly/);
    assert.match(prompt(), /Covers nothing at all/);
  });
});
