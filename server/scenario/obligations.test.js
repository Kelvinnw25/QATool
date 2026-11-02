import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  deriveCoverageObligations,
  matchObligations,
  obligationSchema,
  obligationsForPrompt,
  reviewableGaps,
} from './obligations.js';
import { buildCoverage } from '../schema/canonical.js';

/**
 * Coverage obligations.
 *
 * The rule these tests hold the module to is the same one the checklist tests
 * hold it to, and it points the same way: a missed obligation is a silence, an
 * invented one is a lie in a coverage percentage. So where a detector declines
 * to read something, that is asserted as the right answer rather than filed as
 * a gap - and several tests below exist only to prove nothing is derived.
 */

function requirement(overrides = {}) {
  return {
    requirement_id: 'REQ-001',
    // Neutral: the title is part of the text obligations are read from, so
    // anything with a keyword in it would seed every test with an obligation.
    title: 'Transfer rule',
    description: 'A single fund transfer is submitted for processing.',
    category: 'Functional Behavior',
    source_references: [],
    ambiguities: [],
    conflicts: [],
    ...overrides,
  };
}

function testCase(overrides = {}) {
  return {
    case_id: 'TC-001',
    requirement_ids: ['REQ-001'],
    section: 'Transfers',
    test_case: 'Verify a fund transfer is submitted.',
    case_type: 'Positive',
    edge_polarity: null,
    priority: 'High',
    type: 'Functional',
    expected_result: 'The transfer is submitted successfully.',
    source_references: [],
    confidence: 'High',
    warnings: [],
    status: null,
    tested_by: null,
    order_index: 0,
    ...overrides,
  };
}

const derive = (description, overrides = {}) =>
  deriveCoverageObligations([requirement({ description, ...overrides })]);

const typed = (obligations, type) => obligations.filter((entry) => entry.type === type);
const statements = (obligations) => obligations.map((entry) => entry.statement);

// --- A, B: acceptance criteria ------------------------------------------------

describe('GIVEN / WHEN / THEN', () => {
  it('reads an inline WHEN ... THEN as a branch', () => {
    const branches = typed(
      derive(
        'WHEN a transfer is submitted by a Suspended participant THEN the transfer is rejected.'
      ),
      'branch'
    );

    assert.equal(branches.length, 1);
    assert.match(branches[0].statement, /transfer is rejected/);
    assert.match(branches[0].metadata.condition, /Suspended participant/);
  });

  it('decomposes a block where GIVEN, WHEN and THEN are separate lines', () => {
    const branches = typed(
      derive(
        [
          'GIVEN the participant status is Suspended',
          'WHEN a settlement instruction is submitted',
          'THEN the instruction is rejected',
        ].join('\n')
      ),
      'branch'
    );

    assert.equal(branches.length, 1);
    assert.match(branches[0].statement, /instruction is rejected/);
  });

  /**
   * The whole point of the layer. Four outcomes under one WHEN are four things
   * a tester has to see happen, and the old requirement-level report called all
   * four covered as soon as one test case cited the requirement.
   */
  it('makes every THEN bullet its own obligation', () => {
    const branches = typed(
      derive(
        [
          'WHEN a settlement instruction is submitted',
          'THEN the instruction is rejected',
          'AND the rejection is recorded in the audit log',
          'AND a notification is sent to the originating bank',
        ].join('\n')
      ),
      'branch'
    );

    assert.equal(branches.length, 3, 'one THEN and two ANDs');
    assert.match(statements(branches).join(' '), /audit log/);
    assert.match(statements(branches).join(' '), /originating bank/);
  });

  it('does not attach a stray "and" sentence to an earlier WHEN', () => {
    const branches = typed(
      derive(
        [
          'WHEN a settlement instruction is submitted',
          'The instruction is queued for processing.',
          'And the daily report is produced at end of day.',
        ].join('\n')
      ),
      'branch'
    );

    assert.deepEqual(branches, [], 'no THEN was ever reached, so nothing continues it');
  });
});

// --- C: IF / ELSE --------------------------------------------------------------

describe('IF / ELSE branches', () => {
  it('derives both halves of an if/else', () => {
    const branches = typed(
      derive(
        'IF Check Status succeeds, THEN the record is updated. ELSE the system retries Release Settlement.'
      ),
      'branch'
    );

    assert.equal(branches.length, 2);
    assert.match(branches[0].metadata.condition, /Check Status succeeds/);
    assert.equal(branches[1].metadata.condition, 'otherwise');
    assert.match(branches[1].metadata.outcome, /retries Release Settlement/);
  });

  it('reads an arrow as a then', () => {
    const branches = typed(
      derive('IF the balance is insufficient -> the debit is reversed.'),
      'branch'
    );

    assert.equal(branches.length, 1);
    assert.match(branches[0].metadata.outcome, /debit is reversed/);
  });

  /**
   * "If" opens half the sentences in a specification. Without a marker saying a
   * distinct outcome follows, there is no second branch to be missing, and
   * reading one produces a coverage gap nobody can close.
   */
  it('refuses a bare "if" with no outcome marker', () => {
    assert.deepEqual(
      typed(derive('The fee is waived if the customer holds a priority account.'), 'branch'),
      []
    );
  });
});

// --- D: status transitions ------------------------------------------------------

describe('status transitions', () => {
  it('reads a status change to a shouted state', () => {
    const transitions = typed(
      derive('On timeout the transaction status becomes PENDING.'),
      'transition'
    );

    assert.equal(transitions.length, 1);
    assert.equal(transitions[0].metadata.state, 'PENDING');
  });

  it('reads the Indonesian form', () => {
    const transitions = typed(
      derive('Status transaksi berubah menjadi GAGAL setelah batas waktu terlampaui.'),
      'transition'
    );

    assert.equal(transitions.length, 1);
    assert.equal(transitions[0].metadata.state, 'GAGAL');
  });

  it('reads "marked as" without a status lead-in', () => {
    const transitions = typed(
      derive('After the third unresolved retry the transaction is marked as FAILED.'),
      'transition'
    );

    assert.equal(transitions.length, 1);
    assert.equal(transitions[0].metadata.state, 'FAILED');
  });

  it('does not read prose after "becomes" as a state', () => {
    assert.deepEqual(
      typed(derive('The status becomes the responsibility of the operator.'), 'transition'),
      []
    );
  });
});

// --- E: response mappings --------------------------------------------------------

describe('response mappings', () => {
  it('derives one obligation per stated code, with what triggers it', () => {
    const mappings = typed(
      derive(
        'Jika peserta berstatus Suspended, instruksi ditolak dengan kode KLR-01. Jika peserta berstatus Ditutup, instruksi ditolak dengan kode KLR-02.'
      ),
      'mapping'
    );

    assert.deepEqual(
      mappings.map((entry) => entry.metadata.code),
      ['KLR-01', 'KLR-02']
    );
    assert.match(mappings[0].statement, /Suspended/);
  });

  it('does not mistake a currency amount for a code', () => {
    const mappings = typed(
      derive('A transfer is rejected with an error when the amount exceeds IDR 50,000,000.'),
      'mapping'
    );

    assert.deepEqual(mappings, [], 'IDR 50 is money, not a response code');
  });

  it('never reads a requirement id as a response code', () => {
    const mappings = typed(
      derive('Rejection behaviour is defined by REQ-014 and returns an error.'),
      'mapping'
    );

    assert.deepEqual(
      mappings.map((entry) => entry.metadata.code),
      []
    );
  });
});

// --- F: retry ---------------------------------------------------------------------

describe('retry', () => {
  /**
   * Two obligations, because they fail differently in production: a system that
   * never retries and a system that retries for ever are both wrong, and one
   * test case proves neither about the other.
   */
  it('separates retrying at all from the limit on retrying', () => {
    const retries = typed(derive('The system retries Release Settlement up to 3 times.'), 'retry');

    assert.equal(retries.length, 2);
    assert.equal(retries[0].metadata.limit, null);
    assert.equal(retries[1].metadata.limit, '3');
  });

  it('reads "maximum 3 retries" and the Indonesian form', () => {
    assert.equal(
      typed(derive('A maximum of 3 retries is permitted.'), 'retry')[1].metadata.limit,
      '3'
    );
    assert.equal(
      typed(derive('Pengiriman ulang dilakukan paling banyak 5 kali.'), 'retry')[1].metadata.limit,
      '5'
    );
  });

  it('derives nothing from a requirement that never mentions retrying', () => {
    assert.deepEqual(
      typed(derive('The request is sent once to the core banking system.'), 'retry'),
      []
    );
  });
});

// --- side effects -----------------------------------------------------------------

describe('side effects', () => {
  it('reads a named artifact as something a tester can look at', () => {
    const effects = typed(
      derive('On success the system must save FT Number against the transaction.'),
      'side_effect'
    );

    assert.equal(effects.length, 1);
    assert.equal(effects[0].metadata.object, 'FT Number');
  });

  /**
   * Every one of these came out of the synthetic fixtures before the rule
   * existed: a protocol, a format, a currency and the front half of a response
   * code that was already a mapping obligation. A lone acronym names a
   * technology, not an artifact, and four obligations nobody can test is four
   * points off a coverage percentage for no reason.
   */
  it('does not read a lone acronym as an artifact', () => {
    for (const description of [
      'The API must send the response to the client.',
      'The rejection is recorded with code KLR-01 in the log.',
      'A record is saved showing IDR 50,000 was transferred.',
    ]) {
      assert.deepEqual(
        typed(derive(description), 'side_effect').map((entry) => entry.metadata.object),
        [],
        description
      );
    }
  });

  it('needs an object, not just a verb', () => {
    assert.deepEqual(typed(derive('The result is recorded for later review.'), 'side_effect'), []);
  });
});

// --- G: scheduler / timing ----------------------------------------------------------

describe('scheduler and timing', () => {
  it('reads a delay as an obligation with its unit', () => {
    const scheduled = typed(
      derive('The scheduler must wait 1 hour before executing Check Status.'),
      'schedule'
    );

    assert.equal(scheduled.length, 1);
    assert.deepEqual(
      { amount: scheduled[0].metadata.amount, unit: scheduled[0].metadata.unit },
      { amount: '1', unit: 'hour' }
    );
  });

  it('normalises Indonesian units to the same family', () => {
    const scheduled = typed(derive('Proses berkala dijalankan setiap 15 menit.'), 'schedule');

    assert.equal(scheduled[0].metadata.unit, 'minute');
  });

  /**
   * A duration needs a word that schedules it. "A 30 minute meeting" is a fact
   * about the world, not a behaviour the system owes anyone.
   */
  it('needs a scheduling word, not just a duration', () => {
    assert.deepEqual(
      typed(derive('The reconciliation window is a 30 minute period.'), 'schedule'),
      []
    );
  });
});

// --- H: UI behaviour -------------------------------------------------------------------

describe('UI behaviour', () => {
  it('reads select and unselect as separate obligations', () => {
    const ui = typed(
      derive(
        [
          'The user selects the Include Fee checkbox and the fee is added to the total.',
          'The user unselects the Include Fee checkbox and the fee is removed from the total.',
        ].join('\n')
      ),
      'ui_action'
    );

    assert.equal(ui.length, 2);
    assert.match(ui[0].statement, /selects/);
    assert.match(ui[1].statement, /unselects/);
  });

  /**
   * Both halves required. "Select" is how a specification talks about database
   * reads, and "field" appears in every other line of a data mapping; only the
   * pair makes it something somebody has to click.
   */
  it('needs both an action and something to act on', () => {
    assert.deepEqual(
      typed(derive('The service selects the active records for settlement.'), 'ui_action'),
      []
    );
    assert.deepEqual(
      typed(derive('The screen is available to authorised users.'), 'ui_action'),
      []
    );
  });
});

// --- I: bounds still behave -------------------------------------------------------------

describe('numeric bounds', () => {
  it('derives one obligation per stated bound, keeping the checklist kinds', () => {
    const bounds = typed(
      derive('A single fund transfer must be at least IDR 10,000 and at most IDR 50,000,000.'),
      'bound'
    );

    assert.deepEqual(
      bounds.map((entry) => [
        entry.metadata.normalized ?? entry.metadata.value,
        entry.metadata.kind,
      ]),
      [
        ['10000', 'minimum'],
        ['50000000', 'maximum'],
      ]
    );
  });

  /**
   * The same number arriving twice under two names would count twice in the
   * denominator, and a padded denominator misleads exactly like the coarse
   * figure this layer replaced.
   */
  it('does not also count a scheduled duration or a retry limit as a bare bound', () => {
    const derived = derive('The scheduler waits 1 hour, and the system retries up to 3 times.');
    const values = typed(derived, 'bound').map((entry) => entry.metadata.value);

    assert.ok(!values.includes('1'), 'the hour is a schedule obligation');
    assert.ok(!values.includes('3'), 'the three is a retry limit obligation');
  });
});

// --- J, K, P: nothing is invented ----------------------------------------------------------

describe('nothing is invented', () => {
  /**
   * The invariant the whole module rests on: every obligation can be traced to
   * the words that produced it. A derived obligation with no sentence behind it
   * is a fabricated requirement, which is the failure QATOOL exists to prevent.
   */
  it('grounds every obligation in a verbatim slice of the requirement', () => {
    const source = requirement({
      title: 'Settlement routing',
      description:
        'IF the participant is Suspended, THEN the instruction is rejected with code KLR-01 and the status becomes REJECTED. The system retries up to 3 times after waiting 15 minutes.',
      category: 'Error Handling',
    });

    const obligations = deriveCoverageObligations([source]);
    assert.ok(obligations.length > 0);

    for (const obligation of obligations) {
      const inSource =
        source.title.includes(obligation.source_basis) ||
        source.description.includes(obligation.source_basis);

      assert.ok(inSource, `source_basis not verbatim: "${obligation.source_basis}"`);
    }
  });

  it('derives nothing from vague prose', () => {
    assert.deepEqual(
      derive('The system should be user friendly, performant and maintainable over time.'),
      []
    );
  });

  it('derives nothing from a plain descriptive statement', () => {
    assert.deepEqual(
      derive('This module handles settlement instructions for participant banks.'),
      []
    );
  });

  it('leaves a requirement it cannot read as measuring nothing, not as fully covered', () => {
    const canonical = {
      project: {},
      documents: [],
      requirements: [
        requirement({ description: 'The module is part of the settlement platform.' }),
      ],
      test_cases: [testCase()],
    };

    const entry = buildCoverage(canonical).entries[0];

    assert.equal(entry.covered, true, 'a test case cites it');
    assert.equal(entry.obligations.total, 0);
    assert.equal(entry.obligations.state, 'not_measurable');
    assert.equal(entry.obligations.percent, null, 'no percentage is claimed');
  });

  it('satisfies its own shape, always', () => {
    const obligations = deriveCoverageObligations([
      requirement({
        description:
          'WHEN a transfer is submitted THEN it is queued. IF it fails -> it is rejected with ADMI 002 and the status becomes FAILED, retried up to 3 times after 15 minutes.',
      }),
    ]);

    assert.ok(obligations.length > 0);
    for (const obligation of obligations) {
      assert.doesNotThrow(() => obligationSchema.parse(obligation));
    }
  });

  it('numbers obligations densely, with no gap', () => {
    const obligations = deriveCoverageObligations([
      requirement({ description: 'The status becomes PENDING and is later marked as SETTLED.' }),
      requirement({
        requirement_id: 'REQ-002',
        description: 'The system retries up to 3 times.',
      }),
    ]);

    assert.deepEqual(
      obligations.map((entry) => entry.obligation_id),
      obligations.map((_, index) => `OB-${String(index + 1).padStart(3, '0')}`)
    );
  });
});

// --- L, M, N, O: matching --------------------------------------------------------------------

describe('matching obligations to test cases', () => {
  const rich = requirement({
    description:
      'Jika peserta berstatus Suspended, instruksi ditolak dengan kode KLR-01 dan status menjadi REJECTED.',
    category: 'Error Handling',
  });

  /**
   * One good test case is allowed to do several jobs. The instruction the
   * generator is given says the same thing, and a matcher that demanded one
   * case per obligation would quietly turn a coverage tool into a row-count
   * tool.
   */
  it('lets one test case cover several obligations', () => {
    const matched = matchObligations(deriveCoverageObligations([rich]), [
      testCase({
        case_type: 'Negative',
        test_case: 'Verifikasi instruksi ditolak untuk peserta berstatus Suspended.',
        expected_result: 'Instruksi ditolak dengan kode KLR-01 dan status menjadi REJECTED.',
      }),
    ]);

    const covered = matched.filter((entry) => entry.covered);
    assert.ok(covered.length >= 3, `one case covered ${covered.length} obligations`);
    assert.deepEqual([...new Set(covered.flatMap((entry) => entry.case_ids))], ['TC-001']);
  });

  it('reports a requirement as partially covered when only some obligations are reached', () => {
    const canonical = {
      project: {},
      documents: [],
      requirements: [rich],
      test_cases: [
        testCase({
          case_type: 'Negative',
          test_case: 'Verifikasi instruksi ditolak untuk peserta Suspended.',
          expected_result: 'Instruksi ditolak.',
        }),
      ],
    };

    const entry = buildCoverage(canonical).entries[0];

    assert.equal(entry.covered, true, 'requirement-level coverage is unchanged');
    assert.equal(entry.obligations.state, 'partial');
    assert.ok(entry.obligations.covered < entry.obligations.total);
    assert.ok(entry.obligations.uncovered.length > 0);
  });

  it('reports full coverage only when every obligation has evidence', () => {
    const canonical = {
      project: {},
      documents: [],
      requirements: [rich],
      test_cases: [
        testCase({
          case_type: 'Negative',
          test_case: 'Verifikasi instruksi ditolak untuk peserta berstatus Suspended.',
          expected_result: 'Instruksi ditolak dengan kode KLR-01 dan status menjadi REJECTED.',
        }),
      ],
    };

    const { entries, summary } = buildCoverage(canonical);

    assert.equal(entries[0].obligations.state, 'full');
    assert.equal(entries[0].obligations.percent, 100);
    assert.equal(summary.requirement_fully_covered, 1);
    assert.equal(summary.obligations_uncovered, 0);
  });

  it('reports a requirement no test case cites as uncovered, not partial', () => {
    const canonical = {
      project: {},
      documents: [],
      requirements: [rich],
      test_cases: [],
    };

    const entry = buildCoverage(canonical).entries[0];

    assert.equal(entry.covered, false);
    assert.equal(entry.obligations.state, 'uncovered');
    assert.deepEqual(buildCoverage(canonical).uncovered, ['REQ-001']);
  });

  /**
   * Cases exist, none of them reaches the behaviour. Calling this 'full'
   * because zero of zero matched, or 'uncovered' because nothing matched, would
   * both be wrong: the honest reading is that it is cited and incomplete.
   */
  it('calls nothing-matched partial rather than uncovered when cases cite it', () => {
    const canonical = {
      project: {},
      documents: [],
      requirements: [rich],
      test_cases: [
        testCase({
          test_case: 'Verify the dashboard loads.',
          expected_result: 'The dashboard loads.',
        }),
      ],
    };

    const entry = buildCoverage(canonical).entries[0];

    assert.equal(entry.obligations.covered, 0);
    assert.equal(entry.obligations.state, 'partial');
    assert.equal(entry.obligations.percent, 0);
  });

  it('does not count a test case that cites a different requirement', () => {
    const matched = matchObligations(deriveCoverageObligations([rich]), [
      testCase({
        requirement_ids: ['REQ-002'],
        expected_result: 'Instruksi ditolak dengan kode KLR-01 dan status menjadi REJECTED.',
      }),
    ]);

    assert.deepEqual(
      matched.filter((entry) => entry.covered),
      []
    );
  });

  it('needs the retry count itself before calling the limit exercised', () => {
    const obligations = deriveCoverageObligations([
      requirement({ description: 'The system retries the call up to 3 times.' }),
    ]);

    const [behaviour, limit] = matchObligations(obligations, [
      testCase({
        test_case: 'Verify the call is retried after a failure.',
        expected_result: 'The call is retried.',
      }),
    ]);

    assert.equal(behaviour.covered, true, 'retrying at all is demonstrated');
    assert.equal(limit.covered, false, 'stopping at three is not');
  });
});

// --- Summary and rendering ------------------------------------------------------------------

describe('the coverage summary', () => {
  it('counts requirements and obligations separately', () => {
    const canonical = {
      project: {},
      documents: [],
      requirements: [
        requirement({ description: 'The status becomes PENDING.' }),
        requirement({
          requirement_id: 'REQ-002',
          description: 'The system retries up to 3 times.',
        }),
        requirement({
          requirement_id: 'REQ-003',
          description: 'This module is part of the platform.',
        }),
      ],
      test_cases: [
        testCase({
          requirement_ids: ['REQ-001'],
          test_case: 'Verify the status becomes PENDING on timeout.',
          expected_result: 'The status becomes PENDING.',
        }),
      ],
    };

    const { summary } = buildCoverage(canonical);

    assert.equal(summary.requirement_total, 3);
    assert.equal(summary.requirement_covered, 1, 'only REQ-001 is cited');
    assert.equal(summary.requirement_fully_covered, 1);
    assert.equal(
      summary.obligations_total,
      summary.obligations_covered + summary.obligations_uncovered
    );
    assert.ok(summary.obligations_total > 1);
  });
});

describe('what reaches the model', () => {
  it('renders obligations grouped by requirement', () => {
    const rendered = obligationsForPrompt(
      deriveCoverageObligations([
        requirement({
          description: 'The status becomes PENDING and the system retries up to 3 times.',
        }),
      ])
    );

    assert.match(rendered, /^REQ-001:/m);
    assert.match(rendered, /^ {2}- \[OB-001\]/m);
  });

  it('says nothing when there is nothing to say', () => {
    assert.equal(obligationsForPrompt([]), '');
    assert.equal(obligationsForPrompt(deriveCoverageObligations([requirement()])), '');
  });

  /**
   * checkUntestedBounds already names every stated limit no case mentions, and
   * the reviewer is told not to repeat it. Sending the bounds anyway would
   * spend its one call re-deriving a finding it is forbidden to report.
   */
  it('keeps numeric bounds out of what the reviewer is asked about', () => {
    const matched = matchObligations(
      deriveCoverageObligations([
        requirement({
          description:
            'A transfer must be at most IDR 50,000,000, and the status becomes REJECTED above it.',
        }),
      ]),
      []
    );

    const gaps = reviewableGaps(matched);

    assert.ok(gaps.length > 0, 'the behavioural gap is offered');
    assert.ok(
      gaps.every((gap) => !/^Boundary /.test(gap.obligation)),
      'no bound gaps are offered'
    );
  });

  it('offers nothing when every obligation is covered', () => {
    const matched = matchObligations(
      deriveCoverageObligations([requirement({ description: 'The status becomes PENDING.' })]),
      [
        testCase({
          test_case: 'Verify the status becomes PENDING.',
          expected_result: 'The status becomes PENDING.',
        }),
      ]
    );

    assert.deepEqual(reviewableGaps(matched), []);
  });
});
