import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { generateFromRequirements } from './index.js';
import { GENERATION_WARNINGS } from './assemble.js';
import { MockProvider } from '../llm/mock.js';
import { sampleLlmResponse } from './fixtures/sample-input.js';
import { classifyMeasurability, MEASURABILITY_REASONS } from '../scenario/measurability.js';
import { deriveCoverageObligations } from '../scenario/obligations.js';

/**
 * The second half of the cross-run instability, and the quieter one.
 *
 * Recovery keeps the obligation universe stable, but a generation can still
 * instantiate a behaviour on Monday and reinterpret it away on Tuesday. That
 * was reported as a fraction in metadata and nowhere else - 16 of 29 and 16 of
 * 24 read the same, and neither named what was missing - so a suite could lose
 * the response mapping between runs and nothing in the output said so.
 *
 * Now every obligation no test case reaches is named, and the only way one
 * leaves the coverage figure is by being demonstrably untestable from the
 * source, with the reason attached. Reported, never repaired: nothing here
 * regenerates, pads or retries, because what to do about a gap is QA's call.
 */

function requirement(id, description, overrides = {}) {
  return {
    requirement_id: id,
    title: `Requirement ${id}`,
    description,
    category: 'Business Rule',
    source_references: [
      { document_id: 'DOC-001', page: 4, section: null, quote: description.slice(0, 120) },
    ],
    ambiguities: [],
    conflicts: [],
    ...overrides,
  };
}

function canonical(requirements) {
  return {
    project: { project_name: 'Settlement', sit_scope: [] },
    documents: [
      {
        document_id: 'DOC-001',
        filename: 'PRD.pdf',
        document_type: 'PRD',
        status: 'Extracted',
        page_count: 4,
        extracted_char_count: 900,
      },
    ],
    requirements,
    test_cases: [],
  };
}

/** One test case, citing whatever it is told to. */
function testCase(requirementIds, action, expected) {
  return {
    requirement_ids: requirementIds,
    section: 'Settlement',
    test_case: action,
    case_type: 'Positive',
    edge_polarity: null,
    priority: 'High',
    type: 'Functional',
    expected_result: expected,
    confidence: 'High',
    warnings: [],
  };
}

function reply(testCases) {
  return { ...sampleLlmResponse(), test_cases: testCases };
}

async function run(requirements, testCases) {
  return generateFromRequirements(canonical(requirements), {
    provider: new MockProvider({ responses: reply(testCases) }),
  });
}

const warningsOf = (result, code) => result.warnings.filter((entry) => entry.code === code);

describe('an uncovered obligation is named, not counted', () => {
  const RETRY = requirement(
    'REQ-001',
    'IF the status check returns FAILED, then trigger retry Release Settlement. The maximum number of retries is 3. ' +
      'IF the status remains unresolved after the 3rd retry attempt, then mark the transaction as permanently FAILED.'
  );

  it('names every measurable obligation no test case reaches', async () => {
    const result = await run(
      [RETRY],
      [
        testCase(
          ['REQ-001'],
          'Verify a FAILED status check triggers a retry of Release Settlement.',
          'A retry of the release is triggered.'
        ),
      ]
    );

    const [warning] = warningsOf(result, GENERATION_WARNINGS.OBLIGATION_NOT_COVERED);

    assert.ok(warning, 'the gap is reported');
    assert.equal(warning.requirement_id, 'REQ-001');
    assert.match(warning.message, /OB-\d{3}/, 'and the obligation is named');
    assert.ok(result.metadata.obligations_uncovered > 0, 'the count agrees with what was reported');
  });

  it('reports nothing once the same behaviours are all reached', async () => {
    const result = await run(
      [RETRY],
      [
        testCase(
          ['REQ-001'],
          'Verify a FAILED status check triggers a retry of Release Settlement.',
          'A retry of the release is triggered.'
        ),
        testCase(
          ['REQ-001'],
          'Verify the retry stops after the maximum of 3 attempts.',
          'No fourth retry is attempted after 3 retries.'
        ),
        testCase(
          ['REQ-001'],
          'Verify an unresolved transaction after the 3rd retry attempt is marked permanently FAILED.',
          'The transaction status becomes permanently FAILED after the 3rd retry.'
        ),
      ]
    );

    assert.deepEqual(warningsOf(result, GENERATION_WARNINGS.OBLIGATION_NOT_COVERED), []);
    assert.equal(result.metadata.obligations_uncovered, 0);
  });

  /**
   * The point of the whole change: decomposition is free, membership is not.
   * Three cases and two cases are both correct answers as long as the same
   * behaviours are present, so the check must not reward a particular count.
   */
  it('accepts two obligations instantiated by one test case', async () => {
    const result = await run(
      [RETRY],
      [
        testCase(
          ['REQ-001'],
          'Verify a FAILED status check triggers a retry of Release Settlement, and that no more than 3 retries run.',
          'A retry of the release is triggered and the 3rd retry is the last one attempted.'
        ),
        testCase(
          ['REQ-001'],
          'Verify an unresolved transaction after the 3rd retry attempt is marked permanently FAILED.',
          'The transaction status becomes permanently FAILED after the 3rd retry.'
        ),
      ]
    );

    assert.deepEqual(
      warningsOf(result, GENERATION_WARNINGS.OBLIGATION_NOT_COVERED),
      [],
      'fewer cases covering the same behaviours is not a gap'
    );
  });
});

describe('an unquantified quality is excused with a reason', () => {
  it('does not count "quickly" as a coverage miss', () => {
    const [obligation] = deriveCoverageObligations([
      requirement(
        'REQ-001',
        'WHEN the user opens the Settlement Report menu, then the transaction data grid loads quickly.'
      ),
    ]);

    assert.ok(obligation, 'the behaviour is still derived');
    assert.deepEqual(classifyMeasurability(obligation), {
      measurable: false,
      reason: MEASURABILITY_REASONS.UNQUANTIFIED_QUALITY,
    });
  });

  /**
   * The dangerous direction. Marking an obligation unmeasurable EXCUSES it, so
   * a false positive here is exactly the silent loss this whole change removes.
   * A stated value settles the question before any adjective is read.
   */
  it('keeps an obligation measurable when the source states a value', () => {
    const cases = [
      'The report must be produced within 5 minutes of the cut-off.',
      'IF the User pick Settled filter, then display all of the settled transactions.',
      'The system retries the release up to 3 times.',
      'Display a maximum of 10 rows of transaction per page.',
    ];

    for (const description of cases) {
      for (const obligation of deriveCoverageObligations([requirement('REQ-001', description)])) {
        assert.deepEqual(
          classifyMeasurability(obligation),
          { measurable: true, reason: null },
          `${description} -> ${obligation.statement}`
        );
      }
    }
  });

  it('keeps an obligation measurable when it merely reads fast', () => {
    for (const obligation of deriveCoverageObligations([
      requirement(
        'REQ-001',
        'IF the participant is Suspended, THEN the instruction is rejected with code KLR-01.'
      ),
    ])) {
      assert.equal(classifyMeasurability(obligation).measurable, true, obligation.statement);
    }
  });

  it('separates the excused from the missed in the report', async () => {
    const result = await run(
      [
        requirement(
          'REQ-001',
          'WHEN the user opens the Settlement Report menu, then the transaction data grid loads quickly.'
        ),
      ],
      [
        testCase(
          ['REQ-001'],
          'Verify the Settlement Report menu opens and displays the transaction data grid.',
          'The transaction data grid is displayed.'
        ),
      ]
    );

    const excused = warningsOf(result, GENERATION_WARNINGS.OBLIGATION_NOT_MEASURABLE);

    assert.equal(excused.length, 1, 'reported once, as a group');
    assert.match(excused[0].message, /belongs in the source document/);
    assert.equal(result.metadata.obligations_not_measurable, 1);
    assert.equal(result.metadata.obligations_uncovered, 0, 'and not counted as a miss');
  });
});

describe('the obligation ceiling is not silent', () => {
  /**
   * The ceiling drops from the end, and how many obligations one requirement
   * carries depends on how many blocks the structuring call merged into it - so
   * a run that grouped more aggressively used to lose whatever the requirement
   * stated last, invisibly.
   */
  it('reports how many behaviours a requirement exceeded the ceiling by', async () => {
    const dense = Array.from(
      { length: 22 },
      (_, index) =>
        `IF the response code is ${100 + index}, then set the transaction status to STATE${index}.`
    ).join(' ');

    const result = await run(
      [requirement('REQ-001', dense)],
      [testCase(['REQ-001'], 'Verify response code 100 sets STATE0.', 'The status becomes STATE0.')]
    );

    const [warning] = warningsOf(result, GENERATION_WARNINGS.OBLIGATIONS_TRUNCATED);

    assert.ok(warning, 'the ceiling was reported');
    assert.equal(warning.requirement_id, 'REQ-001');
    assert.ok(result.metadata.obligations_truncated > 0);
  });

  it('says nothing for an ordinary requirement', async () => {
    const result = await run(
      [
        requirement(
          'REQ-001',
          'IF the participant is Suspended, THEN the instruction is rejected.'
        ),
      ],
      [
        testCase(
          ['REQ-001'],
          'Verify an instruction from a Suspended participant is rejected.',
          'The instruction is rejected.'
        ),
      ]
    );

    assert.deepEqual(warningsOf(result, GENERATION_WARNINGS.OBLIGATIONS_TRUNCATED), []);
    assert.equal(result.metadata.obligations_truncated, 0);
  });
});
