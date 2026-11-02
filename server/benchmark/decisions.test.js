import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { compareToOracle } from './compare.js';

/**
 * The v1.1.0 audit decisions, locked.
 *
 * Each settles a question the first audit left open or got wrong, and each is
 * justified from the PDF rather than from what QATOOL produces. These tests
 * exist so that a later edit quietly reversing one fails loudly.
 *
 * The largest is GO-042. v1.0.0 recorded the daily report format as
 * unrecoverable because pdftotext returned nothing for that region. The region
 * is a raster image: the content was always there. "Extraction returned
 * nothing" and "the document says nothing" are different claims, and conflating
 * them cost this oracle seven actionable items.
 */

const oracle = JSON.parse(
  readFileSync(new URL('./prd-qr-manager-settlement-report.oracle.json', import.meta.url), 'utf8')
);

const every = [
  ...oracle.actionable_obligations,
  ...oracle.not_measurable,
  ...oracle.implementation_instructions,
  ...oracle.examples,
  ...oracle.background,
  ...oracle.document_metadata,
];
const byId = (id) => every.find((item) => item.id === id);

const runWith = (action, expected) => ({
  test_cases: [
    {
      case_id: 'TC-001',
      requirement_ids: ['REQ-001'],
      test_case: action,
      expected_result: expected,
    },
  ],
});

describe('the frozen oracle', () => {
  it('is frozen and versioned', () => {
    assert.equal(oracle.oracle_version, '1.2.0');
    assert.equal(oracle.frozen, true);
  });

  /**
   * 1.1.1 is a patch: evidence only. The classification set is identical to
   * 1.1.0 - still 47 actionable, still the same four kinds in the same counts -
   * and the change makes coverage harder to claim, not easier.
   *
   * 1.2.0 is evidence plus one optional field, alternative_evidence, which the
   * comparator has to read - hence the minor version. Still no classification
   * changed and still 47 actionable.
   */
  it('records why it changed, every time', () => {
    assert.equal(oracle.revision_history.length, 4);
    assert.match(oracle.revision_history[1].note, /report format on page 6 IS readable/);
    assert.match(oracle.revision_history[2].note, /no classification changed/);
    assert.match(oracle.revision_history[3].note, /no classification changed/);
    assert.match(oracle.revision_history[3].note, /page 8/);
  });

  it('tightened GO-014 to require the reference point, not just the hour', () => {
    const delay = oracle.actionable_obligations.find((item) => item.id === 'GO-014');

    assert.ok(
      delay.expected_evidence.some((group) => group.some((term) => /original/.test(term))),
      'the hour must be measured from the original timeout timestamp'
    );
    assert.equal(delay.expected_evidence.length, 2, 'the duration AND where it is measured from');
  });

  it('does not cover GO-014 from a generic hour', () => {
    const generic = compareToOracle(
      oracle,
      runWith('Verify the delay.', 'The scheduler waits 1 hour before processing the record.')
    );
    const exact = compareToOracle(
      oracle,
      runWith(
        'Verify the delay.',
        'The scheduler waits a strict 1 hour from the original timeout timestamp before processing the record.'
      )
    );

    assert.equal(generic.items.find((item) => item.id === 'GO-014').covered, false);
    assert.equal(exact.items.find((item) => item.id === 'GO-014').covered, true);
  });

  it('holds 47 actionable and 29 non-actionable items', () => {
    assert.equal(oracle.actionable_obligations.length, 47);
    assert.equal(
      oracle.not_measurable.length +
        oracle.implementation_instructions.length +
        oracle.examples.length +
        oracle.background.length +
        oracle.document_metadata.length,
      29
    );
    assert.equal(every.length, 76);
  });

  it('gives every item exactly one classification and one place', () => {
    const seen = new Set();
    for (const item of every) {
      assert.ok(item.classification, `${item.id} has no classification`);
      assert.ok(!seen.has(item.id), `${item.id} appears twice`);
      seen.add(item.id);
    }
  });
});

// --- A. GO-038 ----------------------------------------------------------------

describe('GO-038, the destination', () => {
  /**
   * The contradiction v1.0.0 left behind: this item read as covered while a
   * separate metric reported "on QR Manager server" absent. Two metrics, one
   * sentence, two answers. The server is part of the contract - a file in the
   * right directory on the wrong host is not fetchable by Reconciliation - so
   * it is required evidence, and the metrics can no longer disagree.
   */
  it('requires the server as evidence, not merely as a qualifier', () => {
    const item = byId('GO-038');

    assert.equal(item.classification, 'OUTPUT_CONTRACT');
    assert.ok(
      item.expected_evidence.some((group) => group.some((term) => /qr manager/i.test(term))),
      'the server belongs in expected_evidence'
    );
  });

  it('is not covered by a case that names only the directory', () => {
    const report = compareToOracle(
      oracle,
      runWith(
        'Verify the report is saved.',
        'The .txt file is written into the designated directory path.'
      )
    );

    assert.equal(report.items.find((item) => item.id === 'GO-038').covered, false);
  });

  it('is covered when the case names the directory and the server', () => {
    const report = compareToOracle(
      oracle,
      runWith(
        'Verify the report is saved.',
        'The .txt file is written into the designated directory path on the QR Manager server, ready for the Reconciliation team.'
      )
    );

    assert.equal(report.items.find((item) => item.id === 'GO-038').covered, true);
  });
});

// --- B. GO-044 ----------------------------------------------------------------

describe('GO-044, Table Tuning', () => {
  it('is an implementation instruction, decided and no longer flagged', () => {
    const item = byId('GO-044');

    assert.equal(item.classification, 'IMPLEMENTATION_INSTRUCTION');
    assert.equal(item.review_required, undefined, 'the call is made, not deferred');
    assert.match(item.justification, /DECIDED from the source/);
  });

  it('states what QA could observe, and invents no threshold', () => {
    const item = byId('GO-044');

    assert.match(item.qa_can_observe, /Nothing specific/);
    assert.match(item.qa_can_observe, /No performance threshold may be invented/);
    assert.doesNotMatch(item.qa_can_observe, /within \d+|under \d+|less than \d+/i);
  });

  it('keeps the counter-argument on the record', () => {
    assert.match(byId('GO-044').counter_argument, /THEN the system must fulfill/);
  });
});

// --- C. GO-046 ----------------------------------------------------------------

describe('GO-046, the OFS request constants', () => {
  it('stays an example, decided on placement', () => {
    const item = byId('GO-046');

    assert.equal(item.classification, 'EXAMPLE_SAMPLE');
    assert.equal(item.review_required, undefined);
    assert.match(item.justification, /DECIDED on placement/);
    assert.match(item.justification, /outside the .THEN the system must fulfill/);
    assert.match(item.justification, /Tambah Queue name/, 'the unresolved authoring note matters');
  });

  it('keeps ENQUIRY.SELECT and E.CHN.VERIFY.FT out of the actionable set', () => {
    for (const item of oracle.actionable_obligations) {
      const defining = [item.source_text, ...(item.required_values ?? [])].join(' ');
      assert.doesNotMatch(defining, /ENQUIRY\.SELECT|E\.CHN\.VERIFY\.FT/, item.id);
    }
  });

  it('says what would have to happen for the decision to change', () => {
    assert.match(byId('GO-046').if_wrong, /source change followed by an oracle revision/);
  });
});

// --- D. GO-021 ----------------------------------------------------------------

describe('GO-021, split into its three assertions', () => {
  const parts = ['GO-021', 'GO-074', 'GO-075'];

  it('is three items, each independently testable', () => {
    for (const id of parts) {
      const item = byId(id);
      assert.equal(item.classification, 'ACTIONABLE_BEHAVIOR', id);
      assert.equal(item.independently_testable, true, id);
      assert.ok(item.assertion?.length > 10, `${id} states its own assertion`);
    }
  });

  it('keeps all three traceable to the one source bullet on page 10', () => {
    const source = byId('GO-021').source_text;

    for (const id of parts) {
      assert.equal(byId(id).source_text, source, `${id} quotes the original wording`);
      assert.equal(byId(id).source_page, 10, id);
    }
  });

  it('records which items were split out', () => {
    assert.equal(byId('GO-074').split_from, 'GO-021');
    assert.equal(byId('GO-075').split_from, 'GO-021');
  });

  it('lets placement and the option set fail on their own', () => {
    const report = compareToOracle(
      oracle,
      runWith(
        'Verify the filter.',
        'A Settlement Status dropdown field is displayed in Advanced Search.'
      )
    );
    const covered = (id) => report.items.find((item) => item.id === id).covered;

    assert.equal(covered('GO-021'), true, 'existence is shown');
    assert.equal(covered('GO-074'), false, 'placement is not');
    assert.equal(covered('GO-075'), false, 'nor is the option set');
  });
});

// --- E. GO-042 ----------------------------------------------------------------

describe('GO-042, the report format read from the image', () => {
  it('is an output contract, not an unmeasurable gap', () => {
    const item = byId('GO-042');

    assert.equal(item.classification, 'OUTPUT_CONTRACT');
    assert.equal(item.source_medium, 'image');
    assert.ok(
      !oracle.not_measurable.some((entry) => entry.id === 'GO-042'),
      'and no longer sits in not_measurable'
    );
  });

  it('carries all 17 columns with their source table, column and format', () => {
    const columns = byId('GO-042').report_columns;

    assert.equal(columns.length, 17);
    assert.equal(columns[0].column_name_report, 'TRX_DATE');
    assert.equal(columns[0].source_table_name, 'v_qr_release_settlement');
    assert.equal(columns[0].format, 'DD-MMM-YY');
    assert.equal(columns.at(-1).column_name_report, 'SETTLEMENT_GROUP_ID');

    // SETTLEMENT_DATE is the one row whose report name differs from its source
    // column, which is exactly what a schema check exists to catch.
    const settlement = columns.find((column) => column.column_name_report === 'SETTLEMENT_DATE');
    assert.equal(settlement.source_table_name, 'qr_settlement_group');
    assert.equal(settlement.source_column_name, 'SETTLEMENT_TIME');
  });

  it('marks only the illegible portion unresolved, and it is sample data', () => {
    const item = byId('GO-042');

    assert.match(item.unresolved, /SETTLEMENT_GROUP_ID sample value/);
    assert.match(item.unresolved, /nothing required is unresolved/);
  });

  it('records the correction rather than quietly fixing it', () => {
    assert.match(byId('GO-042').notes, /CORRECTED IN v1\.1\.0/);
    assert.match(byId('GO-042').notes, /different claims/);
  });

  it('keeps the two stated formats as separate contracts', () => {
    assert.ok(byId('GO-070').required_values.includes('DD-MMM-YY'));
    assert.ok(byId('GO-071').required_values.includes('Decimal 2 digits'));

    for (const id of ['GO-070', 'GO-071']) {
      assert.equal(byId(id).classification, 'OUTPUT_CONTRACT', id);
    }
  });

  it('keeps the join key and the FT_NUMBER validation as their own items', () => {
    assert.equal(byId('GO-072').classification, 'OUTPUT_CONTRACT');
    assert.ok(byId('GO-072').required_values.includes('FT_NUMBER_SETTLEMENT'));

    const guard = byId('GO-073');
    assert.equal(guard.classification, 'GUARD_CONDITION');
    assert.equal(guard.guards, 'GO-042');
    assert.equal(
      guard.required_conditions.length,
      2,
      'what is included, and what happens otherwise'
    );
  });

  it('keeps the Sample Data column out of the actionable set', () => {
    const sample = byId('GO-076');

    assert.equal(sample.classification, 'EXAMPLE_SAMPLE');
    assert.match(sample.source_text, /Toko Daisho Merchant/);

    for (const item of oracle.actionable_obligations) {
      const defining = [item.source_text, ...(item.required_values ?? [])].join(' ');
      assert.doesNotMatch(defining, /Toko Daisho|FT04FDFKNR90|9360015302018539983/, item.id);
    }
  });

  it('does not duplicate contracts the prose already states', () => {
    // The image's note repeats the tilde, the .txt, the 03.00 schedule, the
    // .tmp prohibition and the D-1 window. Those are GO-037, GO-009, GO-011 and
    // GO-010 already; re-recording them would inflate the denominator with the
    // same requirement counted twice.
    const fromImage = oracle.actionable_obligations.filter(
      (item) => item.source_medium === 'image'
    );

    assert.equal(fromImage.length, 5, 'schema, two formats, the join, the validation');
    for (const item of fromImage) {
      assert.doesNotMatch(item.source_text, /tilde|03\.00 am/i, `${item.id} duplicates prose`);
    }
  });
});

// --- E2. v1.2.0: GO-033 and GO-019 ---------------------------------------------

describe('GO-033, the retry guard, in either of its two statements', () => {
  const guard = oracle.actionable_obligations.find((item) => item.id === 'GO-033');

  /**
   * "Only performed when A and B" and "not performed when not-A or not-B" are
   * one rule. v1.1.1 could credit only the first, although its own note says
   * the guard is about when the retry is FORBIDDEN - and three saved runs
   * stated exactly that, with both conditions, and were scored missing.
   */
  it('accepts the forbidden side as a complete form of its own', () => {
    assert.equal(guard.alternative_evidence.length, 1);
    const [forbidden] = guard.alternative_evidence;
    assert.equal(forbidden.length, 3, 'retry withheld, response not FAILED, limit reached');
  });

  it('never mixes the two forms: no group accepts "has reached" beside "has not reached"', () => {
    for (const group of guard.expected_evidence) {
      assert.ok(!group.some((term) => /^(?:has )?reached/.test(term)), group.join('|'));
    }
  });

  it('keeps the classification, the conditions and the source unchanged', () => {
    assert.equal(guard.classification, 'GUARD_CONDITION');
    assert.equal(guard.required_conditions.length, 2);
    assert.match(guard.source_text, /only performed when the status check response is/);
  });
});

describe('GO-019, the re-check', () => {
  it('requires "again", the page 8 word that separates it from the first Check Status call', () => {
    const recheck = oracle.actionable_obligations.find((item) => item.id === 'GO-019');

    assert.match(recheck.source_text, /perform Check Status again/);
    assert.ok(recheck.expected_evidence.some((group) => group.includes('again')));
  });

  it('is not covered by the first release timing out and being queued for CHECK STATUS', () => {
    const report = compareToOracle(
      oracle,
      runWith(
        'Verify timeout catching.',
        'When the first Release Settlement returns a timeout, the transaction is routed to the CHECK STATUS queue.'
      )
    );

    assert.equal(report.items.find((item) => item.id === 'GO-019').covered, false);
  });
});

// --- F. Arithmetic ------------------------------------------------------------

describe('the arithmetic', () => {
  const emptyRun = compareToOracle(oracle, { test_cases: [] });

  it('reconciles on an empty run', () => {
    assert.equal(emptyRun.reconciliation.holds, true);
    assert.equal(emptyRun.reconciliation.covered, 0);
    assert.equal(emptyRun.reconciliation.missing, 47);
  });

  it('reconciles on a partial run', () => {
    const report = compareToOracle(
      oracle,
      runWith(
        'Verify the default view shows Unsettled and Unreleased transactions.',
        'All available data from all dates is loaded, 10 rows per page.'
      )
    );

    assert.equal(report.reconciliation.holds, true);
    assert.equal(
      report.reconciliation.covered + report.reconciliation.missing,
      oracle.actionable_obligations.length
    );
  });

  it('counts every actionable item exactly once, on one side', () => {
    const ids = emptyRun.items.map((item) => item.id);

    assert.equal(new Set(ids).size, ids.length);
    assert.equal(ids.length, 47);
    for (const item of emptyRun.items) {
      assert.equal(
        typeof item.covered,
        'boolean',
        `${item.id} is covered or missing, never neither`
      );
    }
  });

  it('keeps the diagnostics out of the identity', () => {
    assert.match(emptyRun.reconciliation.note, /DIAGNOSTICS/);
    assert.match(emptyRun.reconciliation.note, /never both and never neither/);
  });
});
