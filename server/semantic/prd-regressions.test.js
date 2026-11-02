import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';

import { reviewSemantics } from './index.js';
import { runHeuristics } from './heuristics.js';
import { generateFromRequirements } from '../generate/index.js';
import { sampleCanonicalInput, sampleLlmResponse } from '../generate/fixtures/sample-input.js';
import { MockProvider } from '../llm/mock.js';

/**
 * Two defects measured on a real PRD run, and the reviewer plumbing they
 * exposed. Both were deterministic false positives: findings that told QA to
 * act on something that was not wrong.
 */

let generated;

before(async () => {
  const result = await generateFromRequirements(sampleCanonicalInput(), {
    provider: new MockProvider({ responses: sampleLlmResponse() }),
  });
  generated = { ...sampleCanonicalInput(), project: result.project, test_cases: result.test_cases };
});

function project() {
  return structuredClone(generated);
}

function reviewer(issues) {
  return new MockProvider({ responses: { issues } });
}

/**
 * Branch variants of one enumerated requirement.
 *
 * Three cases covering a Settlement Status filter - Settled, Unsettled,
 * Settled & Unsettled - were reported as two duplicates. They differ by a
 * single token in a twelve-word sentence, which scores 0.83 to 0.92 on the
 * similarity the detector uses, and that one token is the entire point of each
 * test. Acting on the finding would have deleted two branches nothing else
 * covers.
 */
describe('duplicate detection and enumerated branches', () => {
  function filterProject() {
    const requirement = {
      requirement_id: 'REQ-900',
      title: 'Add new filter options',
      description:
        'Add a new dropdown field named Settlement Status placed directly below the existing Settlement Type dropdown: Settled, Unsettled, and Settled & Unsettled. ' +
        'IF the User pick Settled filter, then display all of the settled transaction. ' +
        'IF the User pick Unsettled filter, then display all of the unsettled transaction. ' +
        'IF the User pick Settled & Unsettled, then display all of the settled and unsettled transaction.',
      category: 'Expected Behavior',
      source_references: [
        { document_id: 'DOC-001', page: 10, section: 'Advanced Search', quote: null },
      ],
      ambiguities: [],
      conflicts: [],
    };

    const branch = (index, option, outcome) => ({
      case_id: `TC-90${index}`,
      requirement_ids: ['REQ-900'],
      section: 'Advanced Search',
      test_case: `Verify data rendering when selecting the ${option} filter option in the Settlement Status advanced search dropdown.`,
      case_type: 'Positive',
      edge_polarity: null,
      priority: 'Medium',
      type: 'Functional',
      expected_result: `The system processes and renders all ${outcome} within the chosen time period.`,
      source_references: [],
      confidence: 'High',
      warnings: [],
      status: null,
      tested_by: null,
      order_index: index,
    });

    return {
      requirements: [requirement],
      test_cases: [
        branch(1, 'Settled', 'settled transactions'),
        branch(2, 'Unsettled', 'unsettled transactions'),
        branch(3, 'Settled & Unsettled', 'settled and unsettled transactions'),
      ],
    };
  }

  it('does not call three enumerated filter branches duplicates', () => {
    const duplicates = runHeuristics(filterProject()).filter(
      (issue) => issue.category === 'duplicate'
    );

    assert.deepEqual(duplicates, [], 'each branch names a different stated option');
  });

  /**
   * The subset case, which a symmetric comparison misses: every content word of
   * the Settled case also appears in the Settled & Unsettled case, so only one
   * side carries a distinguishing token.
   */
  it('keeps the combined option distinct from a single option', () => {
    const canonical = filterProject();
    canonical.test_cases = [canonical.test_cases[0], canonical.test_cases[2]];

    assert.equal(
      runHeuristics(canonical).filter((issue) => issue.category === 'duplicate').length,
      0
    );
  });

  it('still flags a repeat that differs only in filler wording', () => {
    const canonical = filterProject();
    const original = canonical.test_cases[0];

    canonical.test_cases.push({
      ...structuredClone(original),
      case_id: 'TC-999',
      order_index: 9,
      // Same option, same outcome; only a connecting word changes, and it is
      // not a word the requirement uses.
      test_case:
        'Verify data rendering when selecting the Settled filter option in that Settlement Status advanced search dropdown.',
    });

    const duplicates = runHeuristics(canonical).filter((issue) => issue.category === 'duplicate');

    assert.equal(duplicates.length, 1, 'a reworded repeat is still reported');
    assert.equal(duplicates[0].testcase_id, 'TC-999');
    assert.match(duplicates[0].explanation, /TC-901/);
  });
});

/**
 * Gemini #3 plumbing.
 *
 * A live run returned 9 output tokens and an empty issues array, so every
 * finding on the Results page came from the deterministic heuristics. These
 * prove the path from a model reply to a rendered finding is intact, so a
 * future empty result is attributable to the prompt or the model rather than
 * to the code carrying it. The reply here is scripted, and nothing about it
 * claims a real model would produce it.
 */
describe('the reviewer accepts meaningful findings', () => {
  const finding = {
    category: 'hallucinated_detail',
    severity: 'high',
    testcase_id: 'TC-001',
    requirement_id: 'REQ-001',
    explanation: 'The expected result names an error code the requirement never states.',
  };

  it('carries a model finding through parsing, anchoring and merging', async () => {
    const result = await reviewSemantics(project(), {
      useLlm: true,
      structurallyValid: true,
      provider: reviewer([finding]),
    });

    assert.equal(result.status.llm, 'completed');
    assert.equal(result.status.discarded_issues, 0, 'nothing was dropped on the way through');

    const carried = result.issues.find(
      (issue) => issue.category === 'hallucinated_detail' && issue.testcase_id === 'TC-001'
    );
    assert.ok(carried, 'the finding reached the final list');
    assert.equal(carried.explanation, finding.explanation, 'and its wording is unchanged');
  });

  it('keeps model findings distinguishable from deterministic ones', async () => {
    // The sample fixture is deliberately clean, so a deterministic finding has
    // to be provoked: an exact repeat of an existing action, which differs from
    // it in no word at all and is a duplicate by any reading.
    const canonical = project();
    canonical.test_cases.push({
      ...structuredClone(canonical.test_cases[0]),
      case_id: 'TC-901',
      order_index: canonical.test_cases.length,
    });

    const result = await reviewSemantics(canonical, {
      useLlm: true,
      structurallyValid: true,
      provider: reviewer([finding]),
    });

    const fromModel = result.issues.find((issue) => issue.category === 'hallucinated_detail');
    assert.deepEqual(fromModel.detected_by, ['llm']);

    const fromRules = result.issues.find((issue) => issue.category === 'duplicate');
    assert.ok(fromRules, 'the deterministic layer still produces its own findings');
    assert.deepEqual(fromRules.detected_by, ['heuristic']);
  });

  it('reports an empty reply as completed with no model findings, not as a failure', async () => {
    const result = await reviewSemantics(project(), {
      useLlm: true,
      structurallyValid: true,
      provider: reviewer([]),
    });

    assert.equal(result.status.llm, 'completed');
    assert.equal(result.status.discarded_issues, 0);
    assert.ok(
      result.issues.every((issue) => !issue.detected_by.includes('llm')),
      'no finding claims a model origin it does not have'
    );
  });

  it('remains advisory: no test case is changed or removed', async () => {
    const canonical = project();
    const before = structuredClone(canonical.test_cases);

    await reviewSemantics(canonical, {
      useLlm: true,
      structurallyValid: true,
      provider: reviewer([finding, { ...finding, severity: 'low', testcase_id: 'TC-002' }]),
    });

    assert.deepEqual(canonical.test_cases, before, 'the reviewer mutates nothing');
  });
});
