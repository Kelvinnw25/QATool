import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { deriveCoverageObligations, matchObligations } from './obligations.js';
import { withMeasurability } from './measurability.js';
import { GENERATION_WARNINGS, reportObligationGaps } from '../generate/assemble.js';

/**
 * Three identical live runs over one PRD produced three different suites, and
 * four behaviours came and went between them:
 *
 *   response mapping   00 -> Funds Transfer Success, 01 -> Transaction Failed
 *   mscore*            the component a status check travels through
 *   the retry guard    retry only when FAILED AND attempts have not reached 3
 *   Select All + HOLD  the release action, its settlement type, its page scope
 *
 * Tracing each one backwards separated two quite different problems, and only
 * the second was about the generator:
 *
 *   the mapping and the guard were reported COVERED IN RUNS WHERE THE TEST
 *   CASES DID NOT STATE THEM. Nothing was measuring them, so nothing could
 *   report them missing, and whether a run happened to test them was invisible.
 *
 *   mscore* and HOLD were measured correctly all along. When the generator
 *   dropped one, coverage said so.
 *
 * These tests fix the first kind in place. Every one of them simulates a real
 * observed output - the omitted form and the present form of each behaviour -
 * and asserts that the deterministic layer tells them apart, and that the
 * omitted form reaches the warning QA reads. They are about what the report
 * SAYS, not about what the model writes: no prompt can be tested from here, and
 * a suite that could only pass when the model cooperated would prove nothing.
 */

function requirement(description, id = 'REQ-001') {
  return {
    requirement_id: id,
    title: 'Status verification and conditional retry',
    description,
    category: 'Business Rule',
    source_references: [{ document_id: 'DOC-001', page: 8, section: null, quote: null }],
    ambiguities: [],
    conflicts: [],
  };
}

function testCase(action, expected, overrides = {}) {
  return {
    case_id: 'TC-001',
    requirement_ids: ['REQ-001'],
    test_case: action,
    expected_result: expected,
    case_type: 'Negative',
    edge_polarity: null,
    ...overrides,
  };
}

/** The obligations of `description`, matched against one generated case. */
function coverage(description, cases) {
  return withMeasurability(
    matchObligations(deriveCoverageObligations([requirement(description)]), cases)
  );
}

const covered = (matched, type, probe) =>
  matched
    .filter((entry) => entry.type === type && probe.test(entry.statement))
    .every((e) => e.covered);

const found = (matched, type, probe) =>
  matched.filter((entry) => entry.type === type && probe.test(entry.statement)).length;

// --- The source, as the PRD states it ----------------------------------------

/** The status-verification block, wrapped exactly where the PDF wraps it. */
const VERIFICATION =
  'GIVEN the interval time has passed and the isolated scheduler picks up the PENDING transaction\n' +
  'WHEN the system executes the status verification\n' +
  'THEN the system must fulfill:\n' +
  'Call Check Status to T24 via MW (mscore*) to verify the actual state of the transaction\n' +
  'IF check status response from T24 is Success (Y.ISO.RESPONSE:1:1="00" and\n' +
  'Y.MSG.RES:1:1="FT26188KDBJZ" ), update the DB status to SUCCESS and save the FT NUMBER\n' +
  'IF FAILED (Y.ISO.RESPONSE:1:1="01") or NOT\n' +
  'FOUND, then trigger retry Release Settlement to MW. The maximum number of settlement release retries is 3.\n' +
  'Notes: Retry for Settlement Release is only performed when the status check response is\n' +
  'FAILED (transaction not completed) and the retry attempt has not reached 3 times';

/** The Select All block, with its release action and its page scope. */
const SELECT_ALL =
  'GIVEN the user is on the Settlement Report page\n' +
  'WHEN the user clicks the Release action button (Settlement Type: HOLD)\n' +
  'THEN the system must fulfill the following:\n' +
  'Display a Select All checkbox on the page near the transaction list table\n' +
  'Notes: Select All only applies to transactions on the current active page (up to 10 rows per page) and will not select items on other pages';

// --- Response mapping ---------------------------------------------------------

describe('response mapping', () => {
  const MAPPING = /is treated as/;

  it('derives both rules from the requirement', () => {
    const matched = coverage(VERIFICATION, []);

    assert.equal(found(matched, 'mapping', /=00.*treated as/), 1, 'the success rule');
    assert.equal(found(matched, 'mapping', /=01.*treated as/), 1, 'the failure rule');
  });

  /**
   * Run 3's shape: both codes and both meanings stated. This is what the
   * obligation asks for and it must keep reading as covered.
   */
  it('is covered when the case states the code and what it means', () => {
    const matched = coverage(VERIFICATION, [
      testCase(
        'Verify status verification when Check Status returns Success.',
        'When Y.ISO.RESPONSE:1:1="00", the response is treated as Success: the DB status is updated to SUCCESS and the FT NUMBER is saved.',
        { case_type: 'Positive' }
      ),
      testCase(
        'Verify status verification when Check Status returns a failure.',
        'When Y.ISO.RESPONSE:1:1="01" the response is treated as FAILED, and a retry Release Settlement to MW is triggered.'
      ),
    ]);

    assert.ok(covered(matched, 'mapping', MAPPING), 'both rules are stated and both are covered');
  });

  /**
   * Runs 1 and 2's shape: the flow is described, the codes are not. Before the
   * fix this read as covered - evidence() compared the case against
   * squash(undefined), which is '', and every string contains ''.
   */
  it('is NOT covered when the case describes the flow without the codes', () => {
    const matched = coverage(VERIFICATION, [
      testCase(
        'Verify the status verification flow.',
        'The system checks the transaction status and updates the database accordingly, retrying where necessary.',
        { case_type: 'Positive' }
      ),
    ]);

    assert.ok(!covered(matched, 'mapping', MAPPING), 'an unstated mapping is not covered');
  });

  it('is NOT covered when the case states the code but not its meaning', () => {
    const matched = coverage(VERIFICATION, [
      testCase(
        'Verify the response field is read.',
        'The field Y.ISO.RESPONSE:1:1="00" is present in the response payload.',
        { case_type: 'Positive' }
      ),
    ]);

    assert.ok(!covered(matched, 'mapping', /=00/), 'reading a field is not interpreting it');
  });
});

// --- The retry guard ----------------------------------------------------------

describe('the retry guard', () => {
  const GUARD = /^Guard/;

  it('derives one obligation naming both conditions', () => {
    const [guard] = coverage(VERIFICATION, []).filter((entry) => entry.type === 'condition');

    assert.ok(guard, 'the Notes line is a guard, not commentary');
    assert.match(guard.statement, /FAILED/, 'the first condition');
    assert.match(guard.statement, /has not reached 3 times/, 'the second condition');
  });

  /**
   * The statement spells the conditions out because the compound guard was the
   * obligation most often half-covered: six runs of seven kept FAILED and
   * dropped the attempt count.
   */
  it('numbers the conditions rather than running them together', () => {
    const [guard] = coverage(VERIFICATION, []).filter((entry) => entry.type === 'condition');

    assert.match(guard.statement, /\(1\) .*; \(2\) /, `not spelled out: ${guard.statement}`);
    assert.doesNotMatch(guard.statement, /^Guard - Notes:/, 'the note framing is not behaviour');
  });

  /** The one run in seven that stated the restriction. */
  it('is covered when the case states the restriction', () => {
    const matched = coverage(VERIFICATION, [
      testCase(
        'Verify retry release settlement when the status check response is FAILED.',
        'When Check Status response is FAILED (transaction not completed) or NOT FOUND and the retry attempt has not reached 3 times, a retry Release Settlement to MW is triggered.'
      ),
    ]);

    assert.ok(covered(matched, 'condition', GUARD));
  });

  /**
   * The other six. This case is real output: it describes the retry happening,
   * never that it is conditional. It supplies "status", "response", "failed",
   * "retry", "attempt", "not", "times" and "performed" on its own - eight of
   * the guard's thirteen words, exactly the eight the ratio needed, every one
   * of them generic retry vocabulary. The words that made it a guard were the
   * missing ones.
   */
  it('is NOT covered by a case that only describes the retry happening', () => {
    const matched = coverage(VERIFICATION, [
      testCase(
        'Verify retry release settlement and check status workflow for failed or not found status check responses.',
        'When check status response returns FAILED (Y.ISO.RESPONSE:1:1="01") or NOT FOUND, retry Release Settlement to MW is triggered up to 3 times, with Check Status performed again after 1st and/or 2nd timeout retries, and marked permanently as FAILED if unresolved after the 3rd retry attempt.'
      ),
    ]);

    assert.ok(!covered(matched, 'condition', GUARD), 'the restriction was never stated');
  });

  /** Half the guard is not the guard: keeping FAILED and dropping the count. */
  it('is NOT covered when only the first condition is stated', () => {
    const matched = coverage(VERIFICATION, [
      testCase(
        'Verify a retry is triggered on a failed status check.',
        'A retry Release Settlement to MW is only performed when the status check response is FAILED (transaction not completed).'
      ),
    ]);

    assert.ok(!covered(matched, 'condition', GUARD), 'both conditions or neither');
  });
});

// --- mscore* ------------------------------------------------------------------

describe('the mscore* qualifier', () => {
  const MSCORE = /mscore/;

  it('is covered when the case keeps the term', () => {
    const matched = coverage(VERIFICATION, [
      testCase(
        'Verify Check Status is called to T24 via MW (mscore*).',
        'The actual state of the transaction is verified through mscore*.',
        { case_type: 'Positive' }
      ),
    ]);

    assert.ok(covered(matched, 'qualifier', MSCORE));
  });

  /** Two runs in seven. The behaviour is tested; the component is generalised away. */
  it('is NOT covered when the case generalises the component away', () => {
    const matched = coverage(VERIFICATION, [
      testCase(
        'Verify Check Status is called to the core banking system.',
        'The actual state of the transaction is verified against T24.',
        { case_type: 'Positive' }
      ),
    ]);

    assert.ok(!covered(matched, 'qualifier', MSCORE), 'the stated term is the obligation');
  });
});

// --- Select All, its release action and its page scope ------------------------

describe('Select All with the release action', () => {
  it('is covered when the case keeps HOLD and the page scope', () => {
    const matched = coverage(SELECT_ALL, [
      testCase(
        'Verify Select All on the Settlement Report page when Settlement Type: HOLD.',
        'A Select All checkbox is displayed near the transaction list table, and checking it selects every transaction on the current active page (up to 10 rows per page) and no items on other pages.',
        { case_type: 'Positive' }
      ),
    ]);

    assert.ok(
      matched.filter((entry) => entry.measurable).every((entry) => entry.covered),
      matched
        .filter((entry) => entry.measurable && !entry.covered)
        .map((entry) => entry.statement)
        .join(' | ')
    );
  });

  /** Run 1's shape: the checkbox is tested, the release context is dropped. */
  it('is NOT covered when the case drops the settlement type', () => {
    const matched = coverage(SELECT_ALL, [
      testCase(
        'Verify the Select All checkbox.',
        'A Select All checkbox is displayed near the transaction list table and selects the rows on the current active page, up to 10 rows per page.',
        { case_type: 'Positive' }
      ),
    ]);

    assert.ok(
      !covered(matched, 'qualifier', /HOLD/),
      'the release context is part of the scenario'
    );
  });
});

// --- What QA is told ----------------------------------------------------------

describe('the report QA reads', () => {
  /**
   * The point of the whole exercise. A behaviour the generator dropped has to
   * arrive as a named warning, not as a coverage figure that quietly holds.
   */
  it('names every dropped behaviour in a warning', () => {
    const matched = coverage(VERIFICATION, [
      testCase(
        'Verify the status verification flow.',
        'The system checks the transaction status through the core banking system and updates the database, retrying where necessary.',
        { case_type: 'Positive' }
      ),
    ]);

    const warnings = reportObligationGaps(matched);
    const gaps = warnings.filter((w) => w.code === GENERATION_WARNINGS.OBLIGATION_NOT_COVERED);
    const said = gaps.map((w) => w.message).join(' ');

    assert.ok(gaps.length > 0, 'the run is reported as incomplete');
    assert.match(said, /mscore/, 'the dropped qualifier is named');
    assert.match(said, /has not reached 3 times/, 'the dropped guard is named');
    assert.match(said, /treated as/, 'the dropped mapping is named');
    assert.match(said, /REQ-001/, 'and the requirement they came from');
  });

  it('says nothing when every behaviour is stated', () => {
    const matched = coverage(VERIFICATION, [
      testCase(
        'Verify Check Status to T24 via MW (mscore*) returns Success.',
        'When Y.ISO.RESPONSE:1:1="00" the response is treated as Success, the DB status is updated to SUCCESS and the FT NUMBER is saved.',
        { case_id: 'TC-001', case_type: 'Positive' }
      ),
      testCase(
        'Verify retry release settlement via MW (mscore*) on a failed Check Status.',
        'When Y.ISO.RESPONSE:1:1="01" the response is treated as FAILED, and because the status check response is FAILED (transaction not completed) and the retry attempt has not reached 3 times, a retry Release Settlement to MW is triggered, up to a maximum of 3 retries.',
        { case_id: 'TC-002' }
      ),
    ]);

    const uncovered = matched.filter((entry) => entry.measurable && !entry.covered);

    assert.deepEqual(
      uncovered.map((entry) => entry.statement),
      [],
      'a complete suite reports no gaps'
    );
  });

  /**
   * The quietest loss of all, and a real one. In the live run the structuring
   * call gave the core banking response table its own requirement - "Core
   * Banking Response Mapping", holding both response rules - and the PDF had
   * wrapped every row across three lines, splitting each value from its closing
   * quote and putting the column headers below the data. No detector could read
   * it, so no obligation existed, so coverage over that requirement was neither
   * met nor missed: it was empty, and the figures looked perfect.
   */
  it('says so when a requirement yields no obligation at all', () => {
    const table = requirement(
      [
        'Y.ISO.RESPONSE:1:1="00',
        '" AND',
        'Y.MSG.RES:1:1="FT25043 0FK4S"',
        'Funds Transfer (FT)',
        'Core Banking Response',
        'Values',
      ].join('\n'),
      'REQ-009'
    );
    table.title = 'Core Banking Response Mapping';

    const derived = deriveCoverageObligations([table]);
    assert.deepEqual(derived, [], 'the wrapped table is unreadable, which is the premise');

    const warnings = reportObligationGaps(withMeasurability(matchObligations(derived, [])), [
      table,
    ]);
    const unread = warnings.filter(
      (entry) => entry.code === GENERATION_WARNINGS.OBLIGATION_NOT_DERIVED
    );

    assert.equal(unread.length, 1, 'the empty requirement is named');
    assert.match(unread[0].message, /Core Banking Response Mapping/);
    assert.equal(unread[0].requirement_id, 'REQ-009');
  });

  it('says nothing of the sort about a requirement it can read', () => {
    const matched = coverage(VERIFICATION, []);
    const warnings = reportObligationGaps(matched, [requirement(VERIFICATION)]);

    assert.deepEqual(
      warnings.filter((entry) => entry.code === GENERATION_WARNINGS.OBLIGATION_NOT_DERIVED),
      []
    );
  });
});
