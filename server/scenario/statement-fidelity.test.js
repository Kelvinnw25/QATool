import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { deriveCoverageObligations } from './obligations.js';

/**
 * What an obligation SAYS, as opposed to what it matches on.
 *
 * Two oracle items went uncovered on the frozen benchmark and both were blamed
 * on Gemini #2. Tracing them showed something else: the obligations existed,
 * were handed to the generator, and said almost nothing.
 *
 *   GO-014  source: "Enforce a strict 1 hour delay from the original timeout
 *                    timestamp before allowing the scheduler to process the
 *                    record"
 *           told to the generator: "Timing condition of 1 hour is exercised"
 *
 *   GO-038  source: "Save the final .txt file into a designated directory path
 *                    on QR Manager server so its ready to be fetched by
 *                    Reconciliation team."
 *           told to the generator: "Side effect on QR Manager is observable"
 *
 * Every word deciding whether a test passes for the right reason was dropped
 * before generation saw it. A model cannot preserve a reference point it was
 * never given, and blaming it for that is blaming the wrong layer.
 *
 * metadata is untouched in both, so coverage arithmetic is exactly as before:
 * this changes what is asked for, not what counts as an answer.
 */

function requirement(description) {
  return {
    requirement_id: 'REQ-001',
    title: 'Requirement',
    description,
    category: 'Business Rule',
    source_references: [{ document_id: 'DOC-001', page: 7, section: null, quote: null }],
    ambiguities: [],
    conflicts: [],
  };
}

const typed = (description, type) =>
  deriveCoverageObligations([requirement(description)]).filter((entry) => entry.type === type);

describe('a schedule obligation', () => {
  const DELAY =
    'Enforce a strict 1 hour delay from the original timeout timestamp before allowing the scheduler to process the record (giving the Core Banking system a cool-down period).';

  it('carries the reference point, not just the duration', () => {
    const [entry] = typed(DELAY, 'schedule');

    assert.match(entry.statement, /1 hour/, 'the duration survives');
    assert.match(
      entry.statement,
      /from the original timeout timestamp/,
      'and so does the reference'
    );
    assert.match(entry.statement, /strict/);
  });

  it('drops the rationale, which is why rather than what', () => {
    const [entry] = typed(DELAY, 'schedule');

    assert.doesNotMatch(entry.statement, /cool-down/, 'the bracketed reason is not an obligation');
  });

  it('leaves the matching metadata alone', () => {
    const [entry] = typed(DELAY, 'schedule');

    assert.deepEqual(entry.metadata, { amount: '1', unit: 'hour' });
  });

  it('keeps the short form when there is no clause worth carrying', () => {
    const [entry] = typed('Retry after 5 minutes.', 'schedule');

    assert.match(entry.statement, /Timing condition of 5 minutes is exercised/);
  });

  it('keeps the source basis verbatim', () => {
    const [entry] = typed(DELAY, 'schedule');

    assert.ok(DELAY.includes(entry.source_basis.trim()));
  });
});

describe('a side-effect obligation', () => {
  const SAVE =
    'Save the final .txt file into a designated directory path on QR Manager server so its ready to be fetched by Reconciliation team.';

  it('carries the sentence beside the object it names', () => {
    const [entry] = typed(SAVE, 'side_effect');

    assert.match(entry.statement, /Side effect on QR Manager is observable/, 'the object survives');
    assert.match(entry.statement, /designated directory path/, 'and so does the destination');
    assert.match(entry.statement, /QR Manager server/, 'and the server');
    assert.match(entry.statement, /Reconciliation team/, 'and who collects it');
  });

  it('leaves the matching metadata alone', () => {
    const [entry] = typed(SAVE, 'side_effect');

    assert.deepEqual(entry.metadata, { object: 'QR Manager' });
  });

  it('keeps the source basis verbatim', () => {
    const [entry] = typed(SAVE, 'side_effect');

    assert.equal(entry.source_basis, SAVE);
  });

  /**
   * The negative. Carrying the sentence must not turn one sentence naming two
   * artifacts into two obligations that each restate the whole thing as if it
   * were about one of them - the statements differ by their object, which is
   * the point, but neither may claim to be the only reading.
   */
  it('still derives one obligation per named artifact, not one per sentence', () => {
    const entries = typed(
      'Save the FT NUMBER and update the DB STATUS when the response is Success.',
      'side_effect'
    );
    const objects = entries.map((entry) => entry.metadata.object);

    assert.ok(objects.length >= 1);
    assert.equal(new Set(objects).size, objects.length, 'no artifact is claimed twice');
  });
});
