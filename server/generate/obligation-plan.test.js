import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { generateFromRequirements } from './index.js';
import { GENERATION_WARNINGS } from './assemble.js';
import { auditObligationClaims } from './claims.js';
import { buildPrompt } from './prompt.js';
import { RESPONSE_SCHEMA, llmResponse, responseSchemaFor } from './contract.js';
import { toGeminiSchema } from '../llm/gemini.js';
import { MockProvider } from '../llm/mock.js';
import { sampleLlmResponse } from './fixtures/sample-input.js';
import { deriveCoverageObligations, matchObligations } from '../scenario/obligations.js';

/**
 * The obligation-driven generation contract, still one call.
 *
 * The prompt always said every obligation must reach a test case; the reply had
 * nowhere to show that it did, so a guard folded into "up to a maximum of 3"
 * cost nothing. The reply now carries a plan, written before the cases, and
 * each case names the obligations it claims.
 *
 * The rule these tests hold above all others: a claim is never coverage.
 * Coverage is computed from the text of the cases, exactly as before, and a
 * claim the text does not support is reported - not counted.
 */

// --- A requirement shaped like the real PRD's retry rule (REQ-008) -----------

const RETRY_RULE = {
  requirement_id: 'REQ-001',
  title: 'Status Verification and Conditional Retry',
  description: [
    'GIVEN the isolated scheduler picks up the PENDING transaction',
    'WHEN the system executes the status verification',
    'THEN the system must fulfill:',
    '- IF FAILED (Y.ISO.RESPONSE:1:1="01") or NOT FOUND, then trigger retry Release Settlement to Middleware. The maximum number of settlement release retries is 3.',
    '- IF the status remains unresolved (FAILED) after 3rd retry attempt, permanently mark the transaction status as FAILED.',
    'Notes: Retry for Settlement Release is only performed when the status check response is FAILED (transaction not completed) and the retry attempt has not reached 3 times.',
  ].join('\n'),
  category: 'Error Handling',
  source_references: [{ document_id: 'DOC-001', page: 8, section: null, quote: null }],
  ambiguities: [],
  conflicts: [],
};

const canonical = () => ({
  project: { project_name: 'QR Manager Settlement Report', sit_scope: [] },
  documents: [
    {
      document_id: 'DOC-001',
      filename: 'PRD.pdf',
      document_type: 'PRD',
      status: 'Extracted',
      page_count: 12,
      extracted_char_count: 1000,
    },
  ],
  requirements: [RETRY_RULE],
  test_cases: [],
});

const obligations = deriveCoverageObligations([RETRY_RULE]);
const guard = obligations.find((obligation) => /only performed when/i.test(obligation.statement));

const testCase = (overrides) => ({
  requirement_ids: ['REQ-001'],
  section: 'Conditional retry',
  case_type: 'Positive',
  edge_polarity: null,
  priority: 'High',
  type: 'Functional',
  confidence: 'High',
  warnings: [],
  ...overrides,
});

/** The weakening this whole change exists for: the guard reduced to a count. */
const WEAKENED = testCase({
  draft_id: 'T1',
  obligation_ids: [guard.obligation_id],
  test_case: 'Verify the retry when the status check response is FAILED.',
  expected_result:
    'A retry Release Settlement to Middleware is triggered, up to a maximum of 3 retries.',
});

/** The guard tested both ways: where it allows the retry, and where it forbids it. */
const GUARD_ALLOWS = testCase({
  draft_id: 'T2',
  obligation_ids: [guard.obligation_id],
  test_case:
    'Verify a retry is performed when the status check response is FAILED (transaction not completed) and the retry attempt has not reached 3 times.',
  expected_result:
    'Release Settlement is retried because the status check response is FAILED and the retry attempt has not reached 3 times.',
});

/**
 * The forbidding side. A case that names only the condition that fails - "the
 * attempt has reached 3" - does not state the guard, and the matcher reads each
 * case's claim against that case's own text, so it would be reported as an
 * unsupported claim. Stating why the retry is forbidden means stating the rule.
 */
const GUARD_FORBIDS = testCase({
  draft_id: 'T3',
  case_type: 'Negative',
  obligation_ids: [guard.obligation_id],
  test_case:
    'Verify no retry is performed when the status check response is FAILED (transaction not completed) but the retry attempt has reached 3 times.',
  expected_result:
    'No further Release Settlement retry occurs: a retry is only performed when the status check response is FAILED and the retry attempt has not reached 3 times, and the attempt count has reached 3.',
});

const planFor = (entries) =>
  obligations.map((obligation) => ({
    obligation_id: obligation.obligation_id,
    status: 'covered',
    target_test_case_ids: entries[obligation.obligation_id] ?? ['T1'],
  }));

async function generate(reply) {
  return generateFromRequirements(canonical(), {
    provider: new MockProvider({ responses: reply }),
  });
}

const reply = (testCases, plan = planFor({})) => ({
  ...sampleLlmResponse(),
  obligation_plan: plan,
  test_cases: testCases,
});

// --- The contract ------------------------------------------------------------

describe('the response schema', () => {
  const ids = obligations.map((obligation) => obligation.obligation_id);
  const translated = toGeminiSchema(responseSchemaFor(ids));

  it('puts the plan before the test cases, so it is written first', () => {
    assert.deepEqual(translated.propertyOrdering, [
      'project',
      'obligation_plan',
      'test_cases',
      'warnings',
    ]);
  });

  it('asks a case for its claims before its text', () => {
    const order = translated.properties.test_cases.items.propertyOrdering;

    assert.deepEqual(order.slice(0, 2), ['draft_id', 'obligation_ids']);
    assert.ok(order.indexOf('obligation_ids') < order.indexOf('test_case'));
    assert.ok(order.indexOf('obligation_ids') < order.indexOf('expected_result'));
  });

  it('allows only the listed ids, and exactly one plan entry per id', () => {
    const plan = translated.properties.obligation_plan;

    assert.deepEqual(plan.items.properties.obligation_id.enum, ids);
    assert.deepEqual(
      translated.properties.test_cases.items.properties.obligation_ids.items.enum,
      ids
    );
    assert.equal(plan.minItems, ids.length);
    assert.equal(plan.maxItems, ids.length);
    assert.deepEqual(plan.items.properties.status.enum, ['covered', 'insufficient_information']);
  });

  it('is the unchanged base schema when there is nothing to account for', () => {
    assert.equal(responseSchemaFor([]), RESPONSE_SCHEMA);
  });

  it('does not fail a reply over a malformed plan', () => {
    const parsed = llmResponse.safeParse({
      ...sampleLlmResponse(),
      obligation_plan: [null, 'nonsense', { obligation_id: 42 }],
    });

    assert.equal(parsed.success, true);
  });
});

describe('the prompt', () => {
  const withObligations = buildPrompt(canonical(), [], obligations, []);
  const without = buildPrompt(canonical(), [], [], []);

  it('asks for the plan first and the cases from it', () => {
    assert.match(withObligations, /obligation_plan - written BEFORE any test case/);
    assert.match(withObligations, /test_cases - written FROM the plan/);
    assert.match(withObligations, /then the obligation plan, then the test cases/);
  });

  it('says the claims are not proof', () => {
    assert.match(withObligations, /obligation_ids and the plan are your working, NOT proof/);
  });

  it('asks for a guard to be tested where it forbids the action, and never weakened to a count', () => {
    assert.match(withObligations, /plan a guard as two scenarios/);
    assert.match(withObligations, /the action must NOT happen/);
    assert.match(withObligations, /Never weaken a guard into a count/);
  });

  it('says nothing about a plan when there are no obligations', () => {
    assert.doesNotMatch(without, /obligation_plan/);
    assert.match(without, /Produce the project outputs and the test cases/);
  });
});

// --- The audit ---------------------------------------------------------------

describe('auditing what the model claimed', () => {
  it('reports a guard claimed by a case that only states a count', () => {
    const audit = auditObligationClaims({
      plan: planFor({}),
      rawTestCases: [WEAKENED],
      obligations,
    });

    assert.deepEqual(audit.unverified_claims, [
      { draft_id: 'T1', obligation_id: guard.obligation_id },
    ]);
  });

  it('accepts a claim whose case states the guard', () => {
    const audit = auditObligationClaims({
      plan: planFor({}),
      rawTestCases: [GUARD_ALLOWS],
      obligations,
    });

    assert.equal(audit.summary.claims_unverified, 0);
    assert.equal(audit.summary.claims_evidenced, 1);
  });

  it('counts an id that was never listed, and trusts none of it', () => {
    const audit = auditObligationClaims({
      plan: [{ obligation_id: 'OB-999', status: 'covered', target_test_case_ids: ['T1'] }],
      rawTestCases: [{ ...WEAKENED, obligation_ids: ['OB-998'] }],
      obligations,
    });

    assert.deepEqual(audit.invented_ids.sort(), ['OB-998', 'OB-999']);
    assert.equal(audit.summary.claims, 0, 'an invented id is not a claim about a real obligation');
  });

  it('names the obligations the plan left out and the ones it planned but no case shows', () => {
    const [first, ...rest] = obligations;
    const audit = auditObligationClaims({
      plan: rest.map((obligation) => ({
        obligation_id: obligation.obligation_id,
        status: 'covered',
        target_test_case_ids: ['T1'],
      })),
      rawTestCases: [WEAKENED],
      obligations,
    });

    assert.deepEqual(audit.missing_from_plan, [first.obligation_id]);
    assert.ok(audit.planned_covered_not_shown.includes(guard.obligation_id));
  });
});

// --- Never coverage ----------------------------------------------------------

describe('a claim is never coverage', () => {
  it('leaves the coverage figures exactly as the text alone sets them', async () => {
    const claimed = await generate(reply([WEAKENED]));
    const unclaimed = await generate(reply([{ ...WEAKENED, obligation_ids: [] }]));

    assert.equal(claimed.metadata.obligations_covered, unclaimed.metadata.obligations_covered);
    assert.equal(claimed.metadata.obligations_uncovered, unclaimed.metadata.obligations_uncovered);
  });

  it('leaves the guard uncovered when the claiming case only states a count', async () => {
    const result = await generate(reply([WEAKENED]));
    const matched = matchObligations(obligations, result.test_cases);

    assert.equal(matched.find((o) => o.obligation_id === guard.obligation_id).covered, false);
    assert.ok(
      result.warnings.some((w) => w.code === GENERATION_WARNINGS.OBLIGATION_CLAIM_UNVERIFIED),
      'the unsupported claim is reported'
    );
    assert.equal(result.metadata.obligation_claims.claims_unverified, 1);
  });

  it('keeps draft ids and claims out of the canonical test case', async () => {
    const result = await generate(reply([GUARD_ALLOWS]));

    for (const generated of result.test_cases) {
      assert.equal('draft_id' in generated, false);
      assert.equal('obligation_ids' in generated, false);
    }
  });

  it('still works for a reply with no plan at all, and says nothing about one', async () => {
    const result = await generate({ ...sampleLlmResponse(), test_cases: [GUARD_ALLOWS] });

    assert.equal(result.metadata.obligation_claims.plan_present, false);
    assert.ok(
      result.warnings.every((w) => w.code !== GENERATION_WARNINGS.OBLIGATION_PLAN_INCOMPLETE)
    );
  });
});

// --- GO-033 ------------------------------------------------------------------

describe('the retry guard (GO-033)', () => {
  /**
   * What the deterministic evaluator must be able to tell apart, unchanged:
   * the guard reduced to a count, and the guard stated as the conditions under
   * which a retry is allowed and forbidden.
   */
  it('is uncovered when weakened to a count, and covered when its conditions are tested', async () => {
    const weakened = await generate(reply([WEAKENED]));
    const tested = await generate(
      reply([GUARD_ALLOWS, GUARD_FORBIDS], planFor({ [guard.obligation_id]: ['T2', 'T3'] }))
    );

    const guardIn = (result) =>
      matchObligations(obligations, result.test_cases).find(
        (o) => o.obligation_id === guard.obligation_id
      );

    assert.equal(guardIn(weakened).covered, false);
    assert.equal(guardIn(tested).covered, true);
    assert.equal(tested.metadata.obligation_claims.claims_unverified, 0);
  });

  it('keeps the case where the retry must not happen', async () => {
    const tested = await generate(
      reply([GUARD_ALLOWS, GUARD_FORBIDS], planFor({ [guard.obligation_id]: ['T2', 'T3'] }))
    );

    assert.ok(
      tested.test_cases.some(
        (c) =>
          c.case_type === 'Negative' &&
          /No further Release Settlement retry occurs/.test(c.expected_result)
      )
    );
  });
});
