import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { deriveCoverageObligations, matchObligations } from '../scenario/obligations.js';
import { buildPrompt } from './prompt.js';

/**
 * The three details a real PRD kept losing between obligation and test case.
 *
 * All three are things the source states explicitly and a generated case drops
 * as incidental: which date a file name is built from, which component a call
 * travels through, and the two-part condition a retry is allowed under. Each
 * survived the obligation layer and then vanished in generation, run after run.
 *
 * What these tests hold in place is the DISCRIMINATION rather than the
 * generator: a case covering the base behaviour must NOT count as covering the
 * qualifier. That is the direction that matters - a false pass here is
 * invisible and ships, while a false gap is merely annoying.
 *
 * One of the three was unreachable rather than uncovered. Guard obligations
 * store their clause under `metadata.guard`, the matcher read `metadata.clause`,
 * and mentions() answers false for undefined - so NO test case could cover a
 * guard, including one quoting it word for word. Every "the retry guard is
 * uncovered" line in this project's reports was that, not the model.
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

/** The obligations of `description` of one type, matched against `cases`. */
function coverage(description, cases, type) {
  const matched = matchObligations(deriveCoverageObligations([requirement(description)]), cases);
  const relevant = matched.filter((entry) => entry.type === type);

  assert.ok(relevant.length > 0, `no ${type} obligation derived from: ${description}`);
  return relevant;
}

const allCovered = (entries) => entries.every((entry) => entry.covered);

describe('the date a file name is built from', () => {
  const SOURCE =
    'Use SETTLEMENT_QRMANAGER_DDMMYYYY.txt as file name format (Date using Transaction Date)';

  it('is covered when the case keeps the stated term', () => {
    const entries = coverage(
      SOURCE,
      [
        testCase(
          'Verify the daily report file name format.',
          'The file is named SETTLEMENT_QRMANAGER_DDMMYYYY.txt, built using the Transaction Date.'
        ),
      ],
      'qualifier'
    );

    assert.ok(allCovered(entries));
  });

  /**
   * The case that was actually generated: correct about the format, silent
   * about which date. Counting it covered is what let the detail disappear.
   */
  it('is NOT covered by a case that verifies the format alone', () => {
    const entries = coverage(
      SOURCE,
      [
        testCase(
          'Verify the daily report file name format.',
          'The report file is generated with the SETTLEMENT_QRMANAGER_DDMMYYYY.txt naming format.'
        ),
      ],
      'qualifier'
    );

    assert.ok(!allCovered(entries), 'the base behaviour does not discharge the qualifier');
  });

  it('is NOT covered by a case naming some other date', () => {
    const entries = coverage(
      SOURCE,
      [
        testCase(
          'Verify the daily report file name format.',
          'The file is named SETTLEMENT_QRMANAGER_DDMMYYYY.txt using the system date.'
        ),
      ],
      'qualifier'
    );

    assert.ok(!allCovered(entries));
  });
});

describe('the component a call travels through', () => {
  const SOURCE = 'Call Check Status to T24 via MW (mscore*) to verify the actual state.';

  it('is covered when the case keeps the component', () => {
    const entries = coverage(
      SOURCE,
      [
        testCase(
          'Verify the status check call path.',
          'Check Status is called to T24 via MW (mscore) and the actual state is returned.'
        ),
      ],
      'qualifier'
    );

    assert.ok(allCovered(entries));
  });

  /** The generated case, every run: the call is there, the component is not. */
  it('is NOT covered by a case that only checks the status call', () => {
    const entries = coverage(
      SOURCE,
      [
        testCase(
          'Verify successful status verification response from T24 via MW.',
          'Check Status is called to T24 via MW and the transaction state is returned.'
        ),
      ],
      'qualifier'
    );

    assert.ok(
      !allCovered(entries),
      'covering the call does not discharge the component it must travel through'
    );
  });

  it('is NOT covered by a case generalising it to the core system', () => {
    const entries = coverage(
      SOURCE,
      [
        testCase(
          'Verify the status is checked against the core banking system.',
          'The core banking system returns the actual state of the transaction.'
        ),
      ],
      'qualifier'
    );

    assert.ok(!allCovered(entries));
  });
});

describe('the condition a retry is allowed under', () => {
  const SOURCE =
    'Notes: Retry for Settlement Release is only performed when the status check response is\n' +
    'FAILED (transaction not completed) and the retry attempt has not reached 3 times';

  /**
   * This asserted false before the matcher was repaired - for every possible
   * test case, including this one, which quotes the restriction.
   */
  it('is covered when the case states the restriction', () => {
    const entries = coverage(
      SOURCE,
      [
        testCase(
          'Verify no retry is triggered when the status check response is not FAILED, and none once the retry attempt has reached 3 times.',
          'Retry for Settlement Release is only performed when the status check response is FAILED and the retry attempt has not reached 3 times; no retry occurs otherwise.'
        ),
      ],
      'condition'
    );

    assert.ok(allCovered(entries), 'a case quoting the restriction covers the guard');
  });

  /** The generated case: the retry happens and stops at 3, but nothing forbids it. */
  it('is NOT covered by a case that only proves the retry happens', () => {
    const entries = coverage(
      SOURCE,
      [
        testCase(
          'Verify retry release settlement upon a failed status check.',
          'A retry of Release Settlement is triggered and is attempted up to a maximum of 3 times.'
        ),
      ],
      'condition'
    );

    assert.ok(!allCovered(entries), 'proving the action happens is not proving when it must not');
  });
});

describe('the instruction the generator receives', () => {
  const canonical = {
    project: { project_name: 'Settlement' },
    documents: [{ document_id: 'DOC-001', filename: 'PRD.pdf', document_type: 'PRD' }],
    requirements: [
      requirement(
        'Call Check Status to T24 via MW (mscore*) to verify the actual state.\n' +
          'Notes: Retry is only performed when the response is FAILED and the attempt has not reached 3 times'
      ),
    ],
  };

  const prompt = () =>
    buildPrompt(canonical, [], deriveCoverageObligations(canonical.requirements), []);

  it('carries the qualifier and the guard as obligations', () => {
    const text = prompt();

    assert.match(text, /Qualifier - .*mscore/);
    assert.match(text, /Guard - .*only performed when/);
  });

  /**
   * The rule the model kept breaking, asserted because a prompt change is
   * otherwise silent - nothing else fails if it is edited away.
   */
  it('says a qualifier is not discharged by covering the action around it', () => {
    const text = prompt();

    assert.match(text, /Covering the action WITHOUT the term does not discharge it/);
    assert.match(
      text,
      /Never drop one on the grounds that the behaviour around it is already covered/
    );
  });

  it('says a guard states when the action is forbidden', () => {
    const text = prompt();

    assert.match(text, /states when the action is FORBIDDEN/);
    assert.match(text, /both belong in the case/);
  });

  it('still forbids inventing the missing half', () => {
    assert.match(prompt(), /Neither instruction is permission to invent/);
  });
});
