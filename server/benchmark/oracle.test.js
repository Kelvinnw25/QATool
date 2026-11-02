import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { compareToOracle, formatComparison } from './compare.js';

/**
 * The benchmark's own tests.
 *
 * Two jobs, and the first matters more. These check that the ORACLE is
 * internally sound - ids unique, every actionable item carrying the evidence a
 * comparison needs, every judgement call carrying its justification - and that
 * the COMPARATOR reports what it claims to.
 *
 * What they deliberately do NOT do is assert that QATOOL matches the oracle. A
 * benchmark whose tests fail when the tool regresses is a benchmark that will
 * be edited until it passes. The comparison is run and printed by the task that
 * evaluates a live run; here, only the instrument is tested.
 */

const oracle = JSON.parse(
  readFileSync(new URL('./prd-qr-manager-settlement-report.oracle.json', import.meta.url), 'utf8')
);

const groups = [
  ['actionable_obligations', oracle.actionable_obligations],
  ['not_measurable', oracle.not_measurable],
  ['implementation_instructions', oracle.implementation_instructions],
  ['examples', oracle.examples],
  ['background', oracle.background],
  ['document_metadata', oracle.document_metadata],
];

const every = groups.flatMap(([, items]) => items);

describe('the oracle itself', () => {
  it('is frozen and versioned', () => {
    assert.equal(oracle.frozen, true);
    assert.match(oracle.oracle_version, /^\d+\.\d+\.\d+$/);
    assert.equal(oracle.source_document.title, 'PRD QR Manager Settlement Report');
  });

  it('gives every item a unique id', () => {
    const ids = every.map((item) => item.id);
    assert.equal(new Set(ids).size, ids.length, 'duplicate oracle id');
  });

  it('numbers the ids contiguously, so nothing was deleted silently', () => {
    const numbers = every.map((item) => Number(item.id.replace('GO-', ''))).sort((a, b) => a - b);

    assert.equal(numbers[0], 1);
    for (let i = 1; i < numbers.length; i += 1) {
      assert.equal(numbers[i], numbers[i - 1] + 1, `gap in oracle ids before GO-${numbers[i]}`);
    }
  });

  it('cites a page and quotes the source for every item', () => {
    for (const item of every) {
      assert.ok(item.source_text?.length > 2, `${item.id} has no source text`);
      assert.ok(Number.isInteger(item.source_page), `${item.id} has no page`);
      assert.ok(item.source_page >= 1 && item.source_page <= 12, `${item.id} page out of range`);
    }
  });

  it('classifies every item as exactly one of the agreed kinds', () => {
    const allowed = new Set(Object.keys(oracle.classification_rules));
    for (const item of every) {
      assert.ok(allowed.has(item.classification), `${item.id}: ${item.classification}`);
    }
  });

  it('puts each item in the group its classification says', () => {
    const expected = {
      actionable_obligations: [
        'ACTIONABLE_BEHAVIOR',
        'QUALIFIER',
        'GUARD_CONDITION',
        'OUTPUT_CONTRACT',
      ],
      not_measurable: ['NOT_MEASURABLE'],
      implementation_instructions: ['IMPLEMENTATION_INSTRUCTION'],
      examples: ['EXAMPLE_SAMPLE'],
      background: ['BACKGROUND_OBJECTIVE'],
      document_metadata: ['DOCUMENT_METADATA'],
    };

    for (const [group, items] of groups) {
      for (const item of items) {
        assert.ok(expected[group].includes(item.classification), `${item.id} is in ${group}`);
      }
    }
  });
});

describe('every actionable obligation', () => {
  it('is marked independently testable', () => {
    for (const item of oracle.actionable_obligations) {
      assert.equal(item.independently_testable, true, item.id);
    }
  });

  it('carries evidence a comparison can look for', () => {
    for (const item of oracle.actionable_obligations) {
      const forms = [item.expected_evidence, ...(item.alternative_evidence ?? [])];
      assert.ok(Array.isArray(item.expected_evidence), `${item.id} has no evidence`);
      for (const evidence of forms) {
        assert.ok(Array.isArray(evidence) && evidence.length > 0, `${item.id} has empty evidence`);
        for (const group of evidence) {
          assert.ok(Array.isArray(group) && group.length > 0, `${item.id} has an empty group`);
          for (const term of group) assert.equal(typeof term, 'string', `${item.id}: ${term}`);
        }
      }
    }
  });

  /**
   * An alternative is a second way to state the SAME obligation, not a second
   * obligation and not a looser one - so only a guard has one, and its notes say
   * why.
   */
  it('gives an alternative form only to a guard, and explains it', () => {
    for (const item of oracle.actionable_obligations.filter((i) => i.alternative_evidence)) {
      assert.equal(item.classification, 'GUARD_CONDITION', item.id);
      assert.match(item.notes, /forbidden side/i, item.id);
    }
  });

  it('names its requirement and scenario', () => {
    for (const item of oracle.actionable_obligations) {
      assert.ok(item.requirement?.length > 3, item.id);
      assert.ok(item.scenario?.length > 3, item.id);
    }
  });

  it('points every qualifier and guard at what it narrows', () => {
    for (const item of oracle.actionable_obligations) {
      if (item.classification === 'QUALIFIER')
        assert.ok(item.qualifies, `${item.id} qualifies what?`);
      if (item.classification === 'GUARD_CONDITION')
        assert.ok(item.guards, `${item.id} guards what?`);
    }
  });

  it('records both conditions of a compound guard separately', () => {
    const retry = oracle.actionable_obligations.find((item) => item.id === 'GO-033');

    assert.equal(retry.required_conditions.length, 2, 'FAILED and attempts-below-three');
    assert.match(retry.required_conditions[0], /FAILED/);
    assert.match(retry.required_conditions[1], /has not reached 3/);
  });
});

describe('the judgement calls the audit had to make', () => {
  it('justifies every not-measurable item from the source', () => {
    for (const item of oracle.not_measurable) {
      assert.ok(item.reason?.length > 3, `${item.id} has no reason`);
      assert.ok(item.justification?.length > 40, `${item.id} has no justification`);
    }
  });

  it('justifies every implementation instruction from the PRD structure', () => {
    for (const item of oracle.implementation_instructions) {
      assert.ok(item.justification?.length > 40, `${item.id} has no justification`);
    }
  });

  /**
   * Asserted over the fields that DEFINE the item, never over its justification:
   * the prose there says "the only number nearby is '(cost 28 seconds)', which
   * describes today's production behaviour, not a target", and a test that
   * scanned it would forbid the oracle from explaining itself.
   */
  it('keeps "quickly" unmeasurable, with no threshold invented', () => {
    const quickly = oracle.not_measurable.find((item) => item.id === 'GO-041');
    const THRESHOLD = /\b\d+\s*(second|ms|millisecond|detik|menit|minute)/i;

    assert.match(quickly.source_text, /quickly/);
    assert.equal(quickly.reason, 'no_threshold_stated');
    assert.doesNotMatch(quickly.source_text, THRESHOLD, 'the source states no threshold');
    assert.equal(quickly.required_values, undefined, 'and the oracle attaches none');

    for (const item of oracle.actionable_obligations) {
      assert.ok(
        !/quickly|cepat/i.test(item.source_text),
        `${item.id} must not make an unquantified quality actionable`
      );
    }
  });

  /**
   * v1.0.0 asserted the opposite here - that the report format was declared and
   * unreadable - and the assertion passed while being wrong about the document.
   * The region is a raster image, so the text layer is empty; the content was
   * always there. See decisions.test.js for the resolved contract.
   */
  it('no longer treats the report format as unreadable', () => {
    assert.ok(
      !oracle.not_measurable.some((item) => item.id === 'GO-042'),
      'GO-042 was resolved from the page 6 image in v1.1.0'
    );
    assert.equal(oracle.not_measurable.length, 1, 'only "quickly" remains unmeasurable');
    assert.equal(oracle.not_measurable[0].id, 'GO-041');
  });

  /**
   * Again over the defining fields only. GO-004's notes explain that "(current
   * condition: Prev 100 and Next 100)" is excluded and why, which is exactly the
   * kind of sentence a blunt scan would punish.
   */
  it('keeps today’s numbers out of the actionable set', () => {
    const background = oracle.background.map((item) => item.source_text).join(' ');

    assert.match(background, /Prev 100 and Next 100/, 'recorded as current condition');
    assert.match(background, /28 seconds/, 'recorded as current condition');

    for (const item of oracle.actionable_obligations) {
      const defining = [
        item.source_text,
        ...(item.required_values ?? []),
        ...item.expected_evidence.flat(),
      ].join(' ');

      assert.doesNotMatch(
        defining,
        /Prev 100|Next 100/,
        `${item.id} must not require today's labels`
      );
      assert.doesNotMatch(defining, /28\s*second/i, `${item.id} must not require today's timing`);
    }
  });

  it('keeps sample values out of the actionable set, but keeps the literal message in it', () => {
    const examples = JSON.stringify(oracle.examples);
    assert.match(examples, /FT250430FK4S/, 'the specimen FT number is an example');
    assert.match(examples, /FT26188KDBJZ/, 'and so is the one in the payload');

    const failure = oracle.actionable_obligations.find((item) => item.id === 'GO-040');
    assert.ok(
      failure.required_values.includes('Transaction Failed!'),
      'but "Transaction Failed!" is a literal, not a specimen: it is the same for every failure'
    );
  });

  /**
   * v1.0.0 left two calls open and this asserted they were visible. v1.1.0
   * decided both from the source - GO-044 on who the verb addresses, GO-046 on
   * where the block sits - so the flags are gone. What survives is the rule: a
   * flag, if one is ever raised again, must carry its reasoning.
   */
  it('leaves no call undecided, and any future flag must be argued', () => {
    const flagged = every.filter((item) => item.review_required);

    assert.deepEqual(
      flagged.map((item) => item.id),
      [],
      'GO-044 and GO-046 were decided in v1.1.0'
    );
    for (const item of flagged) assert.ok(item.justification?.length > 40, item.id);
  });
});

describe('the explicit source decisions', () => {
  const byId = new Map(oracle.actionable_obligations.map((item) => [item.id, item]));

  it('preserves every qualifier and condition named in the brief', () => {
    const required = [
      ['GO-028', /Transaction Date/],
      ['GO-029', /mscore/],
      ['GO-030', /HOLD/],
      ['GO-033', /has not reached 3/],
      ['GO-034', /current active page/],
    ];

    for (const [id, pattern] of required) {
      const item = byId.get(id);
      assert.ok(item, `${id} is in the actionable set`);
      assert.match(item.source_text, pattern, id);
    }
  });

  it('represents both response mappings, each with its stated meaning', () => {
    const success = byId.get('GO-039');
    const failure = byId.get('GO-040');

    assert.match(success.source_text, /Y\.ISO\.RESPONSE:1:1="00"/);
    assert.match(success.source_text, /Funds Transfer \(FT\)\s*Success/);
    assert.match(failure.source_text, /Y\.ISO\.RESPONSE:1:1="01"/);
    assert.match(failure.source_text, /Transaction Failed!/);
    assert.match(failure.source_text, /Transaction Not Found \/ Failed/);
  });

  it('keeps the Select All scope whole: page, page size and other pages', () => {
    const guard = byId.get('GO-034');

    assert.match(guard.source_text, /current active page/);
    assert.match(guard.source_text, /up to 10 rows per page/);
    assert.match(guard.source_text, /will not select items on other pages/);
  });

  it('treats the daily report file name, format and destination as output contracts', () => {
    for (const id of ['GO-036', 'GO-037', 'GO-038']) {
      assert.equal(byId.get(id).classification, 'OUTPUT_CONTRACT', id);
    }
  });
});

describe('the comparator', () => {
  const run = (testCases, obligations = []) => ({ test_cases: testCases, obligations });

  const covering = (text) => [
    {
      case_id: 'TC-001',
      test_case: 'Verify.',
      expected_result: text,
      requirement_ids: ['REQ-001'],
    },
  ];

  it('reports an empty run as missing everything actionable', () => {
    const report = compareToOracle(oracle, run([]));

    assert.equal(report.totals.covered, 0);
    assert.equal(report.totals.missing, oracle.actionable_obligations.length);
    assert.equal(report.totals.oracle_actionable, oracle.actionable_obligations.length);
  });

  it('counts an item covered only when every evidence group is present', () => {
    const partial = compareToOracle(
      oracle,
      run(covering('The grid shows Unsettled transactions.'))
    );
    const whole = compareToOracle(
      oracle,
      run(covering('The grid shows Unsettled and Unreleased transactions.'))
    );

    const find = (report) => report.items.find((item) => item.id === 'GO-001');

    assert.equal(find(partial).covered, false, 'one of the two statuses is not evidence for both');
    assert.equal(find(whole).covered, true);
  });

  /**
   * Five runs wrote "a strict 1-hour delay from the original timeout timestamp"
   * - GO-014 exactly - and were scored missing because the hyphen was kept and
   * the evidence term is "1 hour". The compound form is punctuation, not a
   * different duration.
   */
  it('reads a hyphenated quantity as the same phrase as the spaced one', () => {
    const delay = (text) =>
      compareToOracle(oracle, run(covering(text))).items.find((item) => item.id === 'GO-014');

    assert.equal(delay('A strict 1-hour delay from the original timeout timestamp.').covered, true);
    assert.equal(delay('A strict 1 hour delay from the original timeout timestamp.').covered, true);
    assert.equal(
      delay('A strict one-hour delay from the original timeout timestamp.').covered,
      true
    );
  });

  it('does not let the folding stand in for the part of the evidence that is missing', () => {
    const delay = (text) =>
      compareToOracle(oracle, run(covering(text))).items.find((item) => item.id === 'GO-014');

    assert.equal(
      delay('A strict 1-hour delay before processing.').covered,
      false,
      'no reference point'
    );
    assert.equal(delay('A 2-hour delay from the original timeout timestamp.').covered, false);
  });

  /**
   * A date carries on past its letters, so it is not a quantity-and-unit
   * compound and must not be folded: the image contract's evidence names the
   * date form "03-feb-25", and "03 Feb 25" is a different spelling of it.
   */
  it('leaves a date whole', () => {
    const format = (text) =>
      compareToOracle(oracle, run(covering(text))).items.find((item) => item.id === 'GO-070');

    assert.deepEqual(format('TRX_DATE is written as 03-Feb-25.').missing_evidence, []);
    assert.equal(format('TRX_DATE is written as 03 Feb 25.').missing_evidence.length, 1);
  });

  it('accepts any spelling inside a group and none outside it', () => {
    const hold = (text) =>
      compareToOracle(oracle, run(covering(text))).items.find((item) => item.id === 'GO-030');

    assert.equal(hold('Settlement Type HOLD is used.').covered, true);
    assert.equal(hold('The settlement type is set.').covered, false);
  });

  /**
   * Thirteen saved runs wrote GO-019 as "the transaction still times out" and
   * were scored missing against the evidence term "timeout". The verb is two
   * words where the noun is one; it is the same event.
   */
  it('reads every spelling of the timeout compound as "timeout"', () => {
    const recheck = (text) =>
      compareToOracle(oracle, run(covering(text))).items.find((item) => item.id === 'GO-019');
    const sentence = (verb) =>
      `If the transaction ${verb} after the 1st and/or 2nd retry attempt, Check Status is performed again.`;

    for (const verb of [
      'still timeout',
      'still timeouts',
      'still times out',
      'timed out',
      'is timing out',
      'hits a time-out',
      'hits a time out',
    ]) {
      assert.equal(recheck(sentence(verb)).covered, true, verb);
    }
  });

  it('does not read a ratio as a timeout', () => {
    const recheck = (text) =>
      compareToOracle(oracle, run(covering(text))).items.find((item) => item.id === 'GO-019');

    assert.equal(
      recheck('The 1st retry succeeds 2 times out of 3, and Check Status is performed again.')
        .covered,
      false
    );
  });

  /**
   * "1 hour" is not in "11 hour". Plain substring matching said it was, and the
   * hyphen fold carried that to "11-hour".
   */
  it('does not find a number inside a longer number', () => {
    const delay = (text) =>
      compareToOracle(oracle, run(covering(text))).items.find((item) => item.id === 'GO-014');

    assert.equal(delay('An 11-hour delay from the original timeout timestamp.').covered, false);
    assert.equal(delay('A 21 hour delay from the original timeout timestamp.').covered, false);
    assert.equal(delay('A 1 hour delay from the original timeout timestamp.').covered, true);
    assert.equal(delay('(1 hour) from the original timeout timestamp.').covered, true);
  });

  /**
   * A case shows an item by showing every group of ONE of its forms. Groups are
   * never borrowed across forms: "failed" from the first, "reached 3" and "not
   * performed" from the second would describe a retry withheld at the limit
   * while the response is FAILED - half the guard.
   */
  it('takes an alternative form whole, never a mixture of two', () => {
    const guard = (text) =>
      compareToOracle(oracle, run(covering(text))).items.find((item) => item.id === 'GO-033');

    assert.equal(
      guard(
        'Retry is not performed when the response is not FAILED or the attempt has reached 3 times.'
      ).covered,
      true,
      'the forbidden side, both conditions negated'
    );
    assert.equal(
      guard(
        'The response is FAILED and the attempt has reached 3 times, so retry is not performed.'
      ).covered,
      false,
      'groups from two forms do not make one'
    );
  });

  it('separates a behaviour never derived from one derived and untested', () => {
    const derived = [
      {
        obligation_id: 'OB-001',
        requirement_id: 'REQ-001',
        type: 'qualifier',
        statement: 'Qualifier - must be exercised with: mscore*',
        source_basis:
          'Call Check Status to T24 via MW (mscore*) to verify the actual state of the transaction',
      },
    ];

    const report = compareToOracle(oracle, run([], derived));
    const mscore = report.items.find((item) => item.id === 'GO-029');

    assert.equal(mscore.discovered, true, 'the detector read this sentence');
    assert.deepEqual(mscore.discovered_as, ['OB-001']);
    assert.equal(mscore.covered, false, 'and no test case exercised it');
    assert.ok(report.undiscovered.length > 0, 'while the rest were never derived at all');
  });

  it('names an obligation no oracle item accounts for', () => {
    const invented = [
      {
        obligation_id: 'OB-099',
        requirement_id: 'REQ-001',
        type: 'bound',
        statement: 'Boundary 500 (maximum) is exercised',
        source_basis: 'Batch transfers are limited to 500 transactions per submission',
      },
    ];

    const report = compareToOracle(oracle, run([], invented));

    assert.equal(report.totals.extra, 1);
    assert.equal(report.extra[0].obligation_id, 'OB-099');
    assert.match(report.extra[0].why_not_in_oracle, /no oracle item quotes this wording/);
  });

  it('reports a run that excuses a behaviour the oracle holds testable', () => {
    const excused = [
      {
        obligation_id: 'OB-002',
        requirement_id: 'REQ-004',
        type: 'criterion',
        measurable: false,
        statement: 'Acceptance criterion - Extract all transaction data',
        source_basis:
          'Extract all transaction data from 00.00 to 23.59 on D-1 (previous day) including both H+1 and On Hold transactions',
      },
    ];

    const report = compareToOracle(oracle, run([], excused));
    const flagged = report.classification_errors.wrongly_excused.map((entry) => entry.oracle_id);

    // GO-032, the H+1 / On Hold qualifier, is a phrase inside the same sentence,
    // so one excused obligation correctly implicates both the behaviour and the
    // qualifier the oracle splits out of it.
    assert.ok(flagged.includes('GO-010'), `expected GO-010, got ${flagged.join(', ')}`);
    assert.ok(flagged.includes('GO-032'), 'and the qualifier carried in the same sentence');
  });

  it('reports a run that counts an unmeasurable item as actionable', () => {
    const counted = [
      {
        obligation_id: 'OB-003',
        requirement_id: 'REQ-005',
        type: 'criterion',
        measurable: true,
        statement: 'Acceptance criterion - Load and display the transaction data grid quickly',
        source_basis: 'Load and display the transaction data grid quickly',
      },
    ];

    const report = compareToOracle(oracle, run([], counted));

    assert.equal(report.classification_errors.wrongly_actionable.length, 1);
    assert.equal(report.classification_errors.wrongly_actionable[0].oracle_id, 'GO-041');
  });

  /**
   * These two are phrase-level and say so. A run that keeps a qualifier in its
   * own words is flagged here and is not a loss; the flag means "read this by
   * hand". Keeping it strict is deliberate - a similarity rule in the benchmark
   * would start forgiving real losses.
   */
  it('reports verbatim qualifier and condition checks separately from coverage', () => {
    const report = compareToOracle(
      oracle,
      run(covering('A retry Release Settlement to MW is triggered when the response is 01.'))
    );
    const retry = report.items.find((item) => item.id === 'GO-017');

    assert.equal(retry.covered, true, 'the behaviour is shown');
    assert.ok(
      report.totals.condition_not_verbatim > 0,
      'while conditions elsewhere are not quoted'
    );
  });

  it('flags a kept-but-reworded qualifier rather than calling it covered-and-clean', () => {
    const reworded = compareToOracle(
      oracle,
      run(
        covering(
          'Extracts data from 00.00 to 23.59 on D-1, including H+1 and On Hold transactions.'
        )
      )
    );
    const extract = reworded.items.find((item) => item.id === 'GO-010');

    assert.equal(extract.covered, true);
    assert.deepEqual(
      extract.qualifier_not_verbatim,
      ['including both H+1 and On Hold transactions'],
      'dropping the word "both" is not a lost qualifier, and the flag is phrase-level'
    );
  });

  it('renders a report a human can read', () => {
    const text = formatComparison(compareToOracle(oracle, run([])));

    assert.match(text, new RegExp(`oracle ${oracle.oracle_version.replace(/\./g, '\.')}`));
    assert.match(text, /RECONCILES: \d+ actionable = \d+ covered \+ \d+ missing \[OK\]/);
    assert.match(text, /MISSING:/);
    assert.match(text, /GO-001/);
  });
});
