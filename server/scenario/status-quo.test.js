import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { boundsFor, statedValues } from './checklist.js';
import { deriveCoverageObligations } from './obligations.js';

/**
 * Numbers that describe what the system does TODAY.
 *
 * Measured on a real PRD: "Display the navigation control buttons as Prev 10
 * and Next 10 (current condition: Prev 100 and Next 100)". Both numbers were
 * read as stated values, so 100 - the value being removed - became a coverage
 * obligation and a reviewer finding asking why nobody tested it. A tester
 * acting on that would have written a test asserting the behaviour the change
 * exists to delete.
 *
 * The rule has to stay narrow in the other direction too. Guessing which
 * numbers are aspirational from prose would silently drop real bounds, and a
 * missed bound is the failure this module exists to prevent - so anything
 * without an explicit status-quo marker is still a value.
 */
describe('status-quo values', () => {
  const PRD_LINE =
    'Display a maximum of 10 rows of transaction per page. ' +
    'Display the navigation control buttons as Prev 10 and Next 10 (current condition: Prev 100 and Next 100)';

  it('ignores the value a parenthesised current condition names', () => {
    assert.deepEqual([...statedValues(PRD_LINE).keys()], ['10']);
  });

  it('keeps the target bound from the same sentence', () => {
    assert.deepEqual(
      boundsFor(PRD_LINE).map((bound) => `${bound.normalized}:${bound.kind}`),
      ['10:maximum'],
      'the maximum survives; only the superseded value goes'
    );
  });

  it('derives no obligation for the superseded value', () => {
    const [obligations] = [
      deriveCoverageObligations([
        {
          requirement_id: 'REQ-001',
          title: 'Row display and pagination limit',
          description: PRD_LINE,
          category: 'Constraint',
          source_references: [{ document_id: 'DOC-001', page: 3, section: null, quote: null }],
          ambiguities: [],
          conflicts: [],
        },
      ]),
    ];

    const bounds = obligations.filter((obligation) => obligation.type === 'bound');

    assert.ok(
      bounds.some((obligation) => /\b10\b/.test(obligation.statement)),
      'the real limit is still an obligation'
    );
    assert.ok(
      !bounds.some((obligation) => /\b100\b/.test(obligation.statement)),
      'the superseded limit is not'
    );
  });

  it('recognises the other ways a document names its current behaviour', () => {
    const cases = [
      ['The limit is a maximum of 25 items. Currently: 99 items are allowed.', ['25']],
      ['Maksimal 3 kali percobaan (kondisi saat ini: 5 kali).', ['3']],
      ['Maximum 50 records per batch (previously: 500 records).', ['50']],
      ['Timeout is at most 30 seconds (existing behaviour: 90 seconds).', ['30']],
    ];

    for (const [text, expected] of cases) {
      assert.deepEqual([...statedValues(text).keys()], expected, text);
    }
  });

  /**
   * The conservative half. None of these carries a status-quo marker, so every
   * number stays - including the ones a looser rule would be tempted to drop.
   */
  it('keeps every value when no status-quo marker is present', () => {
    const cases = [
      ['Maksimal 500 transaksi per batch.', ['500']],
      ['Transfer minimum IDR 10,000 and at most IDR 50,000,000.', ['10000', '50000000']],
      ['The maximum is 500 and the minimum is 100.', ['500', '100']],
      // "current" as an ordinary adjective, not a status-quo lead-in.
      ['Select all rows on the current active page, up to 10 rows per page.', ['10']],
    ];

    for (const [text, expected] of cases) {
      assert.deepEqual([...statedValues(text).keys()], expected, text);
    }
  });

  it('leaves a parenthetical that is not about the current state alone', () => {
    assert.deepEqual(
      [...statedValues('Retry a maximum of 3 times (as agreed with Operations).').keys()],
      ['3']
    );
  });
});
