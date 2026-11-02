import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { checklistForPrompt, deriveChecklist, statedValues } from './checklist.js';

/**
 * The scenario checklist.
 *
 * Every rule here is deliberately literal, and the tests are written to hold it
 * that way: the checklist feeds a language model, so a confident wrong entry is
 * worse than a missing one. Where a rule declines to guess, that is asserted as
 * the correct answer rather than treated as a gap.
 */

function requirement(overrides = {}) {
  return {
    requirement_id: 'REQ-001',
    // Neutral on purpose: the title is part of the text bounds are read from,
    // so a default like "Limit" would trip the limit keyword in every test.
    title: 'Transfer rule',
    description: 'A single fund transfer must be at least IDR 10,000.',
    category: 'Constraint',
    source_references: [],
    ambiguities: [],
    conflicts: [],
    ...overrides,
  };
}

const first = (requirements) => deriveChecklist(requirements)[0];

describe('bounds', () => {
  it('reads both ends of a two-sided limit', () => {
    const entry = first([
      requirement({
        description:
          'A single fund transfer must be at least IDR 10,000 and at most IDR 50,000,000. Both limits are inclusive.',
      }),
    ]);

    assert.deepEqual(
      entry.bounds.map((bound) => [bound.raw, bound.normalized, bound.kind]),
      [
        ['10,000', '10000', 'minimum'],
        ['50,000,000', '50000000', 'maximum'],
      ]
    );
  });

  it('normalises thousands separators to one comparable value', () => {
    assert.equal(statedValues('IDR 10,000').get('10000'), '10,000');
    assert.equal(statedValues('IDR 10.000').get('10000'), '10.000');
    assert.equal(statedValues('10000').get('10000'), '10000');
  });

  /**
   * The separator regression. An earlier identifier filter matched the currency
   * prefix, stripped "IDR 10" out of "IDR 10,000" and reported a limit of 000.
   */
  it('never mistakes a currency prefix for an identifier', () => {
    const values = statedValues('at most IDR 10,000 per transfer');

    assert.ok(values.has('10000'), 'the amount survives intact');
    assert.ok(!values.has('000'), 'and no phantom bound is produced');
  });

  it('does not treat identifiers as bounds', () => {
    const entry = first([
      requirement({
        description:
          'A transfer above the maximum of 500 is rejected with ADMI 002, HTTP 400 and reason U253, per REQ-001.',
      }),
    ]);

    assert.deepEqual(
      entry.bounds.map((bound) => bound.normalized),
      ['500'],
      'only the real limit is a bound'
    );
  });

  it('recognises Indonesian limit wording', () => {
    const entry = first([
      requirement({
        title: 'Batas batch',
        description: 'Maksimal 500 transaksi per batch.',
        category: 'Constraint',
      }),
    ]);

    assert.deepEqual(entry.bounds, [{ raw: '500', normalized: '500', kind: 'maximum' }]);
  });

  it('recognises paling sedikit as a minimum', () => {
    const entry = first([
      requirement({ description: 'Batch harus berisi paling sedikit 10 transaksi.' }),
    ]);

    assert.equal(entry.bounds[0].kind, 'minimum');
  });

  it('marks an exact boundary', () => {
    const entry = first([
      requirement({ description: 'The batch limit applies at exactly 500 transactions.' }),
    ]);

    assert.equal(entry.bounds[0].kind, 'exact');
  });

  it('leaves a value with no qualifying keyword unclassified rather than guessing', () => {
    const entry = first([
      requirement({
        description: 'The maximum batch is 500 transactions, processed in 30 seconds.',
      }),
    ]);

    const thirty = entry.bounds.find((bound) => bound.normalized === '30');
    assert.equal(thirty.kind, 'unclassified');
  });

  it('ignores numbers when no limit wording is present at all', () => {
    const entries = deriveChecklist([
      requirement({
        description: 'The system sends a 6 digit OTP to the registered mobile number.',
        category: 'Functional Behavior',
      }),
    ]);

    assert.deepEqual(entries, [], 'a number is not a limit on its own');
  });
});

describe('rejection paths', () => {
  it('is set from the requirement category', () => {
    const entry = first([
      requirement({ description: 'The transfer is not completed.', category: 'Error Handling' }),
    ]);

    assert.equal(entry.rejection_path, true);
  });

  it('is set from rejection wording in either language', () => {
    for (const description of [
      'A transfer outside the permitted range must be rejected.',
      'Instruksi dengan field wajib yang kosong harus ditolak.',
    ]) {
      const entry = first([requirement({ description, category: 'Business Rule' })]);
      assert.equal(entry.rejection_path, true, description);
    }
  });

  it('is not set by the word required alone', () => {
    const entries = deriveChecklist([
      requirement({
        description: 'Approval is required before the instruction is posted to the ledger.',
        category: 'Business Rule',
      }),
    ]);

    assert.deepEqual(entries, [], 'no rejection is described, so there is nothing to list');
  });
});

describe('conditions', () => {
  const eligibility =
    'A fund transfer may only be submitted when all of the following conditions are met: ' +
    'the source account status is Active, the available balance is greater than or equal to the transfer amount, ' +
    'the cumulative transfer amount for the calendar day does not exceed IDR 100,000,000, ' +
    'and the destination account is not on the blacklist.';

  it('splits an explicitly enumerated list', () => {
    const entry = first([requirement({ description: eligibility })]);

    assert.equal(entry.conditions.length, 4);
    assert.equal(entry.conditions[0], 'the source account status is Active');
    assert.equal(entry.conditions[3], 'the destination account is not on the blacklist');
  });

  it('does not split a thousands separator into a condition', () => {
    const entry = first([requirement({ description: eligibility })]);

    assert.match(
      entry.conditions[2],
      /IDR 100,000,000$/,
      'the amount stays whole inside its clause'
    );
  });

  it('recognises an Indonesian lead-in', () => {
    const entry = first([
      requirement({
        description:
          'Transaksi diproses apabila semua kondisi berikut terpenuhi: status peserta Aktif, saldo mencukupi, rekening tujuan tidak diblokir.',
      }),
    ]);

    assert.equal(entry.conditions.length, 3);
  });

  it('extracts nothing when there is no enumeration lead-in', () => {
    const entry = first([
      requirement({
        description:
          'A transfer is submitted when the account is Active and the balance is sufficient, and at most IDR 50,000 applies.',
      }),
    ]);

    assert.deepEqual(entry.conditions, [], 'prose is not silently chopped into conditions');
  });

  it('caps a long enumeration', () => {
    const items = Array.from({ length: 14 }, (unused, index) => `condition number ${index + 1}`);
    const entry = first([
      requirement({
        description: `Allowed only if: ${items.join(', ')}.`,
        category: 'Business Rule',
      }),
    ]);

    assert.equal(entry.conditions.length, 8);
  });
});

describe('review flags', () => {
  it('carries ambiguity, conflict and fragment forward', () => {
    const entry = first([
      requirement({
        description: 'Maksimal 500 transaksi per batch.',
        ambiguities: [
          'Uses an unquantified term, so the threshold to test against is not defined.',
          'Unusually short for a requirement, so part of the source sentence may be missing. Check it against the document.',
        ],
        conflicts: [{ message: 'CONFLICT DETECTED', source_references: [], resolved: false }],
      }),
    ]);

    assert.deepEqual([...entry.review_flags].sort(), ['ambiguous', 'conflicted', 'fragment']);
  });

  it('ignores a conflict a reviewer has already resolved', () => {
    const entry = first([
      requirement({
        description: 'Maksimal 500 transaksi per batch.',
        conflicts: [{ message: 'CONFLICT DETECTED', source_references: [], resolved: true }],
      }),
    ]);

    assert.deepEqual(entry.review_flags, []);
  });
});

describe('what is left out', () => {
  it('omits a requirement with nothing testable in it', () => {
    assert.deepEqual(
      deriveChecklist([
        requirement({
          description:
            'The portal should be responsive and user-friendly on all supported devices.',
          category: 'Functional Behavior',
        }),
      ]),
      []
    );
  });

  it('handles an empty or missing requirement list', () => {
    assert.deepEqual(deriveChecklist([]), []);
    assert.deepEqual(deriveChecklist(undefined), []);
  });
});

describe('rendering for the prompt', () => {
  it('renders nothing for an empty checklist', () => {
    assert.equal(checklistForPrompt([]), '');
    assert.equal(checklistForPrompt(undefined), '');
  });

  it('names each requirement and the values to test', () => {
    const rendered = checklistForPrompt(
      deriveChecklist([
        requirement({
          description: 'A transfer must be at least IDR 10,000 and at most IDR 50,000,000.',
        }),
      ])
    );

    assert.match(rendered, /REQ-001/);
    assert.match(rendered, /10,000 \(minimum\)/);
    assert.match(rendered, /50,000,000 \(maximum\)/);
  });

  it('is one line per requirement, so the prompt stays affordable', () => {
    const rendered = checklistForPrompt(
      deriveChecklist([
        requirement({ requirement_id: 'REQ-001', description: 'Maksimal 500 transaksi.' }),
        requirement({
          requirement_id: 'REQ-002',
          description: 'Transaksi ditolak.',
          category: 'Error Handling',
        }),
      ])
    );

    assert.equal(rendered.split('\n').length, 2);
  });
});
