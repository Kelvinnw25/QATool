import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { deriveCoverageObligations } from './obligations.js';

/**
 * Two obligations the real PRD produced that no test could ever cover, both
 * sitting in the coverage denominator and both pointing QA at something the
 * document does not require.
 *
 * The negatives matter more than the positives: an obligation that is silent
 * makes coverage incomplete, while one that is wrong makes it misleading.
 */

function derive(description) {
  return deriveCoverageObligations([
    {
      requirement_id: 'REQ-001',
      title: 'Status verification',
      description,
      category: 'Business Rule',
      source_references: [{ document_id: 'DOC-001', page: 8, section: null, quote: null }],
      ambiguities: [],
      conflicts: [],
    },
  ]);
}

const limitsIn = (description) =>
  derive(description)
    .filter((entry) => entry.type === 'retry' && entry.metadata.limit)
    .map((entry) => entry.metadata.limit);

const objectsIn = (description) =>
  derive(description)
    .filter((entry) => entry.type === 'side_effect')
    .map((entry) => entry.metadata.object);

/**
 * An ordinal says WHICH attempt; a cap says HOW MANY are allowed.
 *
 * The count was read with the cap word optional, so "after Release Settlement
 * 1 and/or 2 retries attempt" became "retry limit of 2" - beside the genuine
 * limit of 3. Two contradictory limits from one requirement, and the wrong one
 * tells QA to prove the system stops after two attempts.
 */
describe('retry ordinals are not retry limits', () => {
  const PRD_LINE =
    'IF after Release Settlement 1 and/or 2 retries attempt the transaction still Timeout, perform Check Status again.';

  it('reads no limit from the PRD line that produced the false one', () => {
    assert.deepEqual(limitsIn(PRD_LINE), []);
  });

  it('reads no limit from any other ordinal wording', () => {
    for (const text of [
      'After 1 retry the record is re-queued.',
      'Attempt 2 of the retry is logged.',
      'The retry #1 result is recorded.',
      'Setelah percobaan ke-2 transaksi tetap gagal.',
    ]) {
      assert.deepEqual(limitsIn(text), [], text);
    }
  });

  it('still reads an explicit cap', () => {
    const capped = [
      ['The system retries Release Settlement up to 3 times.', '3'],
      ['A maximum of 3 retries is permitted.', '3'],
      ['Pengiriman ulang dilakukan paling banyak 5 kali.', '5'],
      ['Retry is not more than 3.', '3'],
      ['The retry attempt has not reached 3 times.', '3'],
      // Was missed before: the cap word and its number sit either side of the noun.
      ['The maximum number of settlement release retries is 3.', '3'],
    ];

    for (const [text, expected] of capped) {
      assert.deepEqual(limitsIn(text), [expected], text);
    }
  });

  it('takes only the cap when a sentence carries both', () => {
    assert.deepEqual(
      limitsIn(`${PRD_LINE} The maximum number of retries is 3.`),
      ['3'],
      'the ordinal is ignored and the cap survives'
    );
  });

  it('still records that retrying happens at all', () => {
    const retries = derive(PRD_LINE).filter((entry) => entry.type === 'retry');

    assert.equal(retries.length, 1, 'the behaviour obligation remains');
    assert.equal(retries[0].metadata.limit, null);
    assert.match(retries[0].statement, /Retry behaviour is exercised/);
  });

  /**
   * What this sentence does and does not yield, pinned as measured.
   *
   * It states a real behaviour - a retry that times out is checked again. This
   * test used to pin that the behaviour produced NO branch obligation, because
   * the branch detector read only the THEN form and this sentence writes "IF
   * ... , perform ..." - recorded then rather than fixed, on the ground that a
   * wrong branch is worse than a missing one. Measured since: with no
   * obligation the generation plan never had to account for the re-check, and
   * it was dropped in four runs of ten (GO-019).
   *
   * Now read, narrowly: a sentence-initial IF, a top-level comma, and a
   * consequent that opens with an action verb. Both halves come from the
   * sentence verbatim, the limit is still not invented, and nothing else is.
   */
  it('yields the retry behaviour and the re-check, and nothing false beside them', () => {
    const derived = derive(PRD_LINE);

    assert.deepEqual(
      derived.map((entry) => entry.type),
      ['branch', 'retry'],
      'the re-check as a branch, the retry behaviour with no limit, nothing invented'
    );

    const [branch] = derived;
    assert.equal(
      branch.metadata.condition,
      'after Release Settlement 1 and/or 2 retries attempt the transaction still Timeout'
    );
    assert.equal(branch.metadata.outcome, 'perform Check Status again');
    assert.ok(PRD_LINE.includes(branch.source_basis), 'the basis is the sentence itself');
  });
});

/**
 * A placeholder shows where a value goes. It is not a value, and nothing the
 * system writes is called "{{ada isi FT Number nya}}".
 */
describe('template placeholders are not side effects', () => {
  const PRD_LINE =
    'Y.MSG.RES:1:1="{{ada isi FT Number nya}}" ), update the DB status to SUCCESS and save the FT NUMBER';

  it('does not name the placeholder as an artifact', () => {
    assert.ok(
      !objectsIn(PRD_LINE).some((object) => object.includes('{{')),
      'the placeholder produced no obligation'
    );
  });

  it('keeps the real side effect stated in the same sentence', () => {
    assert.deepEqual(
      objectsIn(PRD_LINE),
      ['FT NUMBER'],
      'saving the FT NUMBER is still an obligation'
    );
  });

  it('masks the other placeholder forms too', () => {
    assert.deepEqual(
      objectsIn('Save ${FT_PLACEHOLDER} and <FT NUMBER HERE> into the CORE LEDGER.'),
      ['CORE LEDGER']
    );
  });

  it('still derives ordinary side effects', () => {
    assert.deepEqual(
      objectsIn(
        'The system saves the FT NUMBER and writes the settlement record to the AUDIT LOG.'
      ),
      ['FT NUMBER', 'AUDIT LOG']
    );
  });

  it('keeps the source basis verbatim, placeholder included', () => {
    const [effect] = derive(PRD_LINE).filter((entry) => entry.type === 'side_effect');

    assert.match(
      effect.source_basis,
      /\{\{ada isi FT Number nya\}\}/,
      'masking is for matching only; the evidence still quotes the document'
    );
  });
});
