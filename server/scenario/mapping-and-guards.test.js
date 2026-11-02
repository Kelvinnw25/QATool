import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { deriveCoverageObligations, matchObligations } from './obligations.js';

/**
 * Two shapes the obligation layer could not previously read, both measured as
 * gaps on a real PRD:
 *
 *   a mapping table   a response value and the meaning the system must give it
 *   a guard note      a restriction saying when an action is permitted at all
 *
 * Both detectors are held to the same standard as the rest of the module: an
 * explicit marker or nothing. The negative tests matter more than the positive
 * ones here, because a false obligation is a coverage figure that is wrong,
 * while a missed one is only silent.
 */

function requirement(description, overrides = {}) {
  return {
    requirement_id: 'REQ-001',
    title: 'Status verification',
    description,
    category: 'Business Rule',
    source_references: [{ document_id: 'DOC-001', page: 8, section: null, quote: null }],
    ambiguities: [],
    conflicts: [],
    ...overrides,
  };
}

function obligationsFor(description) {
  return deriveCoverageObligations([requirement(description)]);
}

describe('mapping table obligations', () => {
  const TABLE =
    'Core Banking Response Values\n' +
    'Y.ISO.RESPONSE:1:1="00" AND Y.MSG.RES:1:1="FT250430FK4S" -> Funds Transfer (FT) Success (Transaction successfully processed in core)\n' +
    'Y.ISO.RESPONSE:1:1="01" AND Y.MSG.RES:1:1="Transaction Failed!" -> Transaction Not Found / Failed (FT is not recorded)';

  it('derives one mapping obligation per stated row', () => {
    const mappings = obligationsFor(TABLE).filter((entry) => entry.type === 'mapping');

    assert.equal(mappings.length, 2, 'both rows, not one and not the header');

    const [success, failure] = mappings;
    assert.match(success.statement, /Y\.ISO\.RESPONSE:1:1=00/);
    assert.match(success.statement, /Funds Transfer \(FT\) Success/);
    assert.match(failure.statement, /Y\.ISO\.RESPONSE:1:1=01/);
    assert.match(failure.statement, /Not Found \/ Failed/);
  });

  it('keeps a quoted value that contains spaces intact', () => {
    const failure = obligationsFor(TABLE).find(
      (entry) => entry.type === 'mapping' && /01/.test(entry.statement)
    );

    assert.match(failure.statement, /Transaction Failed!/, 'not truncated at the first space');
  });

  it('keeps the source basis verbatim', () => {
    const [first] = obligationsFor(TABLE).filter((entry) => entry.type === 'mapping');

    assert.ok(TABLE.includes(first.source_basis), 'the basis is a slice of the requirement');
  });

  /**
   * The negatives. A two-column table of anything would otherwise become
   * obligations, and an approval table is the commonest two-column table in
   * these documents.
   */
  it('derives nothing without a stated value', () => {
    assert.deepEqual(
      obligationsFor('The reconciliation team -> receives the file each morning.').filter(
        (entry) => entry.type === 'mapping'
      ),
      []
    );
  });

  it('derives nothing without a meaning', () => {
    assert.deepEqual(
      obligationsFor('Set retryCount=3 before the scheduler starts.').filter(
        (entry) => entry.type === 'mapping' && /treated as/.test(entry.statement)
      ),
      []
    );
  });

  it('derives nothing from a heading that only trails a relation', () => {
    assert.deepEqual(
      obligationsFor('Core Banking Response Values ->').filter((entry) => entry.type === 'mapping'),
      []
    );
  });

  it('derives nothing from an approval table', () => {
    assert.deepEqual(
      obligationsFor(
        'Name Title Project Role Signature\nAldis Furqoni Tech Lead Tech Lead\nSelina Product Manager'
      ).filter((entry) => entry.type === 'mapping'),
      []
    );
  });

  it('reads the Indonesian relation too', () => {
    const mappings = obligationsFor(
      'responseCode=68 berarti transaksi timeout dan harus diproses ulang.'
    ).filter((entry) => entry.type === 'mapping');

    assert.equal(mappings.length, 1);
    assert.match(mappings[0].statement, /responseCode=68/);
  });

  const mappingCase = (action, expected) => ({
    case_id: 'TC-001',
    requirement_ids: ['REQ-001'],
    test_case: action,
    case_type: 'Positive',
    edge_polarity: null,
    expected_result: expected,
  });

  const successCoveredBy = (action, expected) =>
    matchObligations(
      obligationsFor(TABLE).filter(
        (entry) => entry.type === 'mapping' && /=00/.test(entry.statement)
      ),
      [mappingCase(action, expected)]
    ).every((entry) => entry.covered);

  it('can be covered by a test case that names the value and the meaning', () => {
    assert.ok(
      successCoveredBy(
        'Verify the core banking response is read as a successful funds transfer.',
        'Y.ISO.RESPONSE:1:1="00" AND Y.MSG.RES:1:1="FT250430FK4S" is treated as Funds Transfer (FT) Success, processed in core.'
      ),
      'a case naming the stated values and their meaning closes the obligation'
    );
  });

  /**
   * The regression this pair exists for. evidence() read metadata.code, which
   * this detector does not set, and squash(undefined) is '' - a string every
   * text contains. So every mapping row was reported covered by any case citing
   * the requirement, and the two response rules the feature turns on could not
   * be reported uncovered at all. Whether a run tested them was never checked.
   */
  it('is not covered by a case that cites the requirement and says nothing else', () => {
    assert.ok(
      !successCoveredBy('Verify the settlement report page loads.', 'The page opens.'),
      'an unrelated case must not close a mapping obligation'
    );
  });

  it('is not covered by a case that names the value but not its meaning', () => {
    assert.ok(
      !successCoveredBy(
        'Verify the response field is populated.',
        'Y.ISO.RESPONSE:1:1="00" AND Y.MSG.RES:1:1="FT250430FK4S" are present in the response.'
      ),
      'reading the field is not the same as reading what the value means'
    );
  });

  it('is not covered by a case that names the meaning but not the value', () => {
    assert.ok(
      !successCoveredBy(
        'Verify a successful transfer.',
        'The Funds Transfer (FT) Success is recorded in core.'
      ),
      'the stated value is half the mapping'
    );
  });

  /** A prose field name split by the sentence around it still counts. */
  it('reads a field and value the sentence separates', () => {
    const obligations = obligationsFor('Account status=ACTIVE -> the account may transact.').filter(
      (entry) => entry.type === 'mapping'
    );

    const covered = matchObligations(obligations, [
      mappingCase(
        'Verify an active account can transact.',
        'When the account status is ACTIVE, the account may transact.'
      ),
    ]);

    assert.ok(covered.every((entry) => entry.covered));
  });

  /** ...but the value is a word, not a substring: "00" is not "1000". */
  it('does not read a value out of a longer number', () => {
    const obligations = obligationsFor('responseCode=00 -> the transfer succeeded.').filter(
      (entry) => entry.type === 'mapping'
    );

    const covered = matchObligations(obligations, [
      mappingCase(
        'Verify a transfer of 1000 units.',
        'The responseCode field is read and the transfer succeeded.'
      ),
    ]);

    assert.ok(!covered.some((entry) => entry.covered));
  });
});

describe('guard condition obligations', () => {
  const NOTE =
    'Notes: Retry for Settlement Release is only performed when the status check response is FAILED and the retry attempt has not reached 3 times.';

  it('derives a condition from an explicit restriction', () => {
    const guards = obligationsFor(NOTE).filter(
      (entry) => entry.type === 'condition' && /Guard/.test(entry.statement)
    );

    assert.equal(guards.length, 1);
    assert.match(guards[0].statement, /only performed when/);
    assert.match(guards[0].statement, /FAILED/);
    assert.ok(NOTE.includes(guards[0].source_basis), 'verbatim basis');
  });

  it('recognises the other explicit restriction wordings', () => {
    for (const text of [
      'The export must only be triggered when data has finished rendering.',
      'A settlement can only be released if the participant is Active.',
      'Reprocessing is not allowed after the cut-off time.',
      'Retry hanya dilakukan jika response adalah FAILED.',
    ]) {
      const guards = obligationsFor(text).filter(
        (entry) => entry.type === 'condition' && /Guard/.test(entry.statement)
      );
      assert.equal(guards.length, 1, text);
    }
  });

  /**
   * Conservative by design. "when" appears in almost every requirement, and a
   * detector that read it as a restriction would turn every GIVEN/WHEN/THEN
   * line into a guard.
   */
  it('derives nothing from ordinary explanatory notes', () => {
    for (const text of [
      'Notes: Scope connectivity QR Manager only. Refer to the attached diagram.',
      'WHEN the user opens the Settlement Report menu the table is rendered.',
      'The scheduler runs when the system clock reaches 03.00 AM.',
      'Notes: this behaviour was agreed with the Reconciliation team.',
    ]) {
      assert.deepEqual(
        obligationsFor(text).filter(
          (entry) => entry.type === 'condition' && /Guard/.test(entry.statement)
        ),
        [],
        text
      );
    }
  });

  it('leaves the retry obligations it sits beside alone', () => {
    const types = obligationsFor(NOTE).map((entry) => entry.type);

    assert.ok(types.includes('condition'), 'the guard');
    assert.ok(types.includes('retry'), 'and the existing retry obligations are unaffected');
    assert.equal(types.filter((type) => type === 'retry').length, 2, 'behaviour and limit');
  });
});
