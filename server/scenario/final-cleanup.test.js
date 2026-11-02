import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { deriveCoverageObligations, matchObligations } from './obligations.js';
import { classifyMeasurability, MEASURABILITY_REASONS } from './measurability.js';
import { quotes } from '../lib/text.js';

/**
 * The last three obligations a real PRD reported as gaps, and what each turned
 * out to be. None was a missing test.
 *
 *   a quotation the matcher could not see   the case contained the obligation's
 *                                           operative phrase word for word and
 *                                           still scored one word under the bar
 *   a third reading of one sentence         a bound, a qualifier and a UI action
 *                                           from the same line; the first two
 *                                           covered, the third reported as work
 *                                           still to do
 *   an instruction to a developer           "Create and implement new automated
 *                                           scheduler", whose observable effect
 *                                           the same requirement states four
 *                                           more times
 *
 * The negatives below matter more than the positives. Each fix widens or narrows
 * something, and the risk in every case is the same: a coverage figure that goes
 * green without a behaviour being tested.
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

const derive = (description) => deriveCoverageObligations([requirement(description)]);
const typed = (description, type) => derive(description).filter((entry) => entry.type === type);
const matchedOn = (description, cases) => matchObligations(derive(description), cases);

// --- OB-012: evidence the ratio test could not see ----------------------------

describe('a phrase quoted from the source', () => {
  const BLOCK =
    'GIVEN the daily report is due\n' +
    'WHEN the system clock reaches 03.00 AM\n' +
    'THEN the system must fulfill:\n' +
    'Ensure the process runs automatically without normal intervention and without creating temporary files (.tmp) during extraction';

  /**
   * Measured before the fix: 13 obligation words, 8 needed, 7 found. The six
   * missing were the obligation's own framing - "Ensure the process runs ...
   * during extraction" - which no test case repeats. The operative phrase was
   * present verbatim and the answer was still "uncovered".
   */
  it('covers the obligation it is lifted from', () => {
    const [entry] = matchedOn(BLOCK, [
      testCase(
        'Verify automated daily report generation.',
        'The automated scheduler extracts all transaction data from D-1 without normal intervention and without creating temporary files (.tmp), then saves the report.'
      ),
    ]).filter((e) => e.type === 'criterion');

    assert.ok(entry.covered, 'a verbatim quotation is evidence');
  });

  /** The threshold itself is untouched: a paraphrase is judged exactly as before. */
  it('does not cover it when the case only paraphrases', () => {
    const [entry] = matchedOn(BLOCK, [
      testCase(
        'Verify automated daily report generation.',
        'The scheduler produces the report on its own and cleans up after itself.'
      ),
    ]).filter((e) => e.type === 'criterion');

    assert.ok(!entry.covered, 'saying the same thing in other words is not quoting it');
  });

  it('does not cover it from a short overlap', () => {
    const [entry] = matchedOn(BLOCK, [
      testCase('Verify the extraction.', 'Temporary files are removed during extraction.'),
    ]).filter((e) => e.type === 'criterion');

    assert.ok(!entry.covered, 'three or four shared words are a coincidence, not a quotation');
  });

  describe('the rule on its own', () => {
    it('needs five consecutive content words in the same order', () => {
      const phrase = 'the process runs automatically without normal intervention during extraction';

      assert.ok(
        quotes(
          `It confirms that the process runs automatically without normal intervention today.`,
          phrase
        )
      );
      assert.ok(
        !quotes('The process runs on a schedule; intervention is not normally required.', phrase)
      );
    });

    it('ignores word order that does not match', () => {
      assert.ok(
        !quotes(
          'intervention normal without automatically runs process the',
          'the process runs automatically without normal intervention'
        )
      );
    });

    it('declines a phrase too short to quote', () => {
      assert.ok(!quotes('the button remains enabled', 'button remains enabled'));
    });
  });
});

// --- OB-033: a third reading of one sentence ----------------------------------

describe('one line read by more than one detector', () => {
  const NOTE =
    'GIVEN the user is on the Settlement Report page\n' +
    'WHEN the user clicks the Release action button\n' +
    'THEN the system must fulfill the following:\n' +
    'Notes: Select All only applies to transactions on the current active page (up to 10 rows per page) and will not select items on other pages';

  it('keeps the named readings and drops the restatement', () => {
    const types = derive(NOTE)
      .filter((entry) => entry.source_basis.startsWith('Notes: Select All'))
      .map((entry) => entry.type);

    assert.ok(types.includes('bound'), 'the page size is still an obligation');
    assert.ok(types.includes('qualifier'), 'and so is the stated qualifier');
    assert.ok(
      !types.includes('ui_action'),
      `the whole-sentence restatement is not a third obligation: ${types.join(', ')}`
    );
  });

  /**
   * The standalone case, which must survive. A UI line that no other detector
   * reads is the only reading there is, and dropping it would lose behaviour.
   */
  it('keeps a UI behaviour that nothing else reads', () => {
    const line =
      'GIVEN the user is on the page\n' +
      'WHEN the user opens it\n' +
      'THEN the system must fulfill:\n' +
      'Display a Select All checkbox on the page near the transaction list table';

    assert.equal(
      typed(line, 'ui_action').length,
      1,
      'no competing reading, so the UI action stands'
    );
  });

  /** Same rule, retry flavour: a generic restatement yields to the specific ones. */
  it('keeps the specific retry readings of a line and drops the coarse one', () => {
    const line =
      'GIVEN a settlement fails\n' +
      'WHEN the status check returns FAILED\n' +
      'THEN the system must fulfill:\n' +
      'Trigger a retry of Release Settlement, up to a maximum of 3 retries.';

    const entries = derive(line).filter((entry) =>
      /retry of Release Settlement/.test(entry.source_basis)
    );
    const types = entries.map((entry) => entry.type);

    assert.ok(types.includes('retry'), 'the retry behaviour is kept');
    assert.ok(!types.includes('criterion'), `and not restated as a criterion: ${types.join(', ')}`);
  });

  it('still derives standalone retry behaviour when nothing more specific exists', () => {
    const retries = typed('The system retries the release up to 3 times.', 'retry');

    assert.equal(retries.length, 2, 'the behaviour and the cap');
    assert.ok(retries.some((entry) => entry.metadata.limit === '3'));
  });
});

// --- OB-011: an instruction to whoever builds the system ----------------------

describe('a bullet that tells a developer what to build', () => {
  const BUILD =
    'GIVEN the daily report is due\n' +
    'WHEN the system clock reaches 03.00 AM\n' +
    'THEN the system must fulfill:\n' +
    'Create and implement new automated scheduler to trigger the daily report generation';

  /**
   * Decided from this document's own wording. Under one THEN it lists five
   * bullets; four say what the software does at run time - extract, ensure, use,
   * save - and this one instructs someone to build a component. Its observable
   * consequence is already stated by the WHEN and by the four siblings.
   */
  it('is derived, but not as an actionable behaviour', () => {
    const [entry] = typed(BUILD, 'criterion');

    assert.ok(entry, 'still derived, because the document said it');
    assert.deepEqual(classifyMeasurability(entry), {
      measurable: false,
      reason: MEASURABILITY_REASONS.IMPLEMENTATION_INSTRUCTION,
    });
  });

  /**
   * The negatives. "Create" alone is not a build verb - software creates files,
   * records and columns at run time - and a stated value settles the question
   * before any verb is read.
   */
  it('leaves runtime behaviour alone', () => {
    for (const line of [
      'Create a new settlement record for each released transaction',
      'Add and display new data column for RELEASE DATE AND TIME to the table',
      'Generate the final report file in .txt format using a tilde delimiter',
      'Save the final .txt file into a designated directory path',
    ]) {
      const [entry] = typed(
        `GIVEN x happens\nWHEN y occurs\nTHEN the system must fulfill:\n${line}`,
        'criterion'
      );

      assert.ok(entry, line);
      assert.equal(classifyMeasurability(entry).measurable, true, line);
    }
  });

  it('keeps a build instruction measurable when it states a value', () => {
    const [entry] = typed(
      'GIVEN x\nWHEN y\nTHEN the system must fulfill:\nImplement a retry loop of at most 3 attempts',
      'criterion'
    );

    assert.equal(
      classifyMeasurability(entry).measurable,
      true,
      'a stated value is checkable whatever the verb'
    );
  });
});
