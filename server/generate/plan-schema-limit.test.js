import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { generateFromRequirements } from './index.js';
import { GENERATION_WARNINGS } from './assemble.js';
import { auditObligationClaims } from './claims.js';
import {
  MAX_EXACT_PLAN_LENGTH,
  RESPONSE_SCHEMA,
  llmResponse,
  responseSchemaFor,
} from './contract.js';
import { toGeminiSchema } from '../llm/gemini.js';
import { MockProvider } from '../llm/mock.js';
import { sampleLlmResponse } from './fixtures/sample-input.js';
import { deriveCoverageObligations, promptedObligations } from '../scenario/obligations.js';

/**
 * The obligation plan past 40 obligations.
 *
 * The plan was bounded to exactly one entry per id with minItems and maxItems.
 * Gemini rejects that schema at 41 ids (HTTP 400, before generating anything),
 * while the prompt lists up to 120 - so every document past 40 obligations
 * failed generation. Past MAX_EXACT_PLAN_LENGTH the two bounds are dropped and
 * nothing else changes: the id enum stays, and one entry per id is still
 * checked on every reply by the claim audit.
 *
 * What only the provider can show - that it accepts the schema - is not
 * provable here; these tests pin what the schema says and what the audit does.
 */

const ids = (count) =>
  Array.from({ length: count }, (_, index) => `OB-${String(index + 1).padStart(3, '0')}`);

const planOf = (schema) => schema.properties.obligation_plan;
const caseIdsOf = (schema) => schema.properties.test_cases.items.properties.obligation_ids;

/** One requirement per obligation: a single acceptance criterion each. */
const requirement = (number) => ({
  requirement_id: `REQ-${String(number).padStart(3, '0')}`,
  title: `Field ${number}`,
  description: [
    `GIVEN the user opens screen ${number}`,
    'WHEN the screen loads',
    'THEN the system must fulfill:',
    `- Display the field named Alpha${number} on the screen`,
  ].join('\n'),
  category: 'Functional Behavior',
  source_references: [{ document_id: 'DOC-001', page: 1, section: null, quote: null }],
  ambiguities: [],
  conflicts: [],
});

const requirements = (count) => Array.from({ length: count }, (_, index) => requirement(index + 1));

const canonical = (count) => ({
  project: { project_name: 'Plan schema limit', sit_scope: [] },
  documents: [
    {
      document_id: 'DOC-001',
      filename: 'PRD.pdf',
      document_type: 'PRD',
      status: 'Extracted',
      page_count: 1,
      extracted_char_count: 1000,
    },
  ],
  requirements: requirements(count),
  test_cases: [],
});

/** A case that states one requirement's criterion, claiming its obligation. */
const caseFor = (number, obligationId) => ({
  draft_id: `T${number}`,
  obligation_ids: [obligationId],
  requirement_ids: [`REQ-${String(number).padStart(3, '0')}`],
  section: `Field ${number}`,
  test_case: `Verify the field named Alpha${number} is displayed when screen ${number} loads.`,
  case_type: 'Positive',
  edge_polarity: null,
  priority: 'Medium',
  type: 'Functional',
  expected_result: `The system displays the field named Alpha${number} on the screen.`,
  confidence: 'High',
  warnings: [],
});

/**
 * Answers from the schema the generator actually sent: every id it was given,
 * planned once, with one case each. `edit` changes the plan before it is sent.
 */
const replyFromSchema =
  (edit = (plan) => plan) =>
  (request) => {
    const listed = planOf(request.schema).items.properties.obligation_id.enum;
    const plan = listed.map((obligationId, index) => ({
      obligation_id: obligationId,
      status: 'covered',
      target_test_case_ids: [`T${index + 1}`],
    }));
    return {
      ...sampleLlmResponse(),
      obligation_plan: edit(plan),
      test_cases: listed.map((obligationId, index) => caseFor(index + 1, obligationId)),
    };
  };

async function generate(count, edit) {
  const provider = new MockProvider({ responses: replyFromSchema(edit) });
  const result = await generateFromRequirements(canonical(count), { provider });
  return { provider, result };
}

// --- The schema ----------------------------------------------------------------

describe('the plan schema, up to 40 obligations', () => {
  it('keeps the exact plan length, as before', () => {
    assert.equal(MAX_EXACT_PLAN_LENGTH, 40);
    for (const count of [1, 36, 40]) {
      const plan = planOf(responseSchemaFor(ids(count)));
      assert.equal(plan.minItems, count, `${count} ids`);
      assert.equal(plan.maxItems, count, `${count} ids`);
    }
  });

  it('differs from the schema past the limit only by those two bounds', () => {
    // Everything but the bounds and the ids themselves, which differ by count.
    const shape = (schema) => {
      const copy = structuredClone(schema);
      delete planOf(copy).minItems;
      delete planOf(copy).maxItems;
      planOf(copy).items.properties.obligation_id.enum = [];
      caseIdsOf(copy).items.enum = [];
      return copy;
    };

    assert.deepEqual(shape(responseSchemaFor(ids(40))), shape(responseSchemaFor(ids(41))));
  });

  it('is still the unchanged base schema when there is nothing to account for', () => {
    assert.equal(responseSchemaFor([]), RESPONSE_SCHEMA);
    assert.equal('obligation_plan' in RESPONSE_SCHEMA.properties, false);
  });
});

describe('the plan schema past 40 obligations', () => {
  for (const count of [41, 120]) {
    it(`carries no minItems or maxItems at ${count} ids, in either form sent`, () => {
      const schema = responseSchemaFor(ids(count));
      for (const plan of [planOf(schema), planOf(toGeminiSchema(schema))]) {
        assert.equal('minItems' in plan, false);
        assert.equal('maxItems' in plan, false);
      }
    });

    it(`keeps the id enum exact, for the plan and for every case, at ${count} ids`, () => {
      const wire = toGeminiSchema(responseSchemaFor(ids(count)));

      assert.deepEqual(planOf(wire).items.properties.obligation_id.enum, ids(count));
      assert.deepEqual(caseIdsOf(wire).items.enum, ids(count));
      assert.deepEqual(planOf(wire).items.required, [
        'obligation_id',
        'status',
        'target_test_case_ids',
      ]);
      assert.ok(wire.required.includes('obligation_plan'));
    });
  }

  it('caps at the prompt ceiling: 130 obligations are prompted, and planned, as 120', async () => {
    const prompted = promptedObligations(deriveCoverageObligations(requirements(130)));
    const { provider, result } = await generate(130);
    const sent = provider.calls[0].schema;

    assert.equal(prompted.length, 120);
    assert.equal(planOf(sent).items.properties.obligation_id.enum.length, 120);
    assert.equal('minItems' in planOf(sent), false);
    assert.equal(result.metadata.obligation_claims.missing_from_plan, 0);
  });
});

// --- A 41-obligation reply, end to end through the generator -------------------

describe('a 41-obligation document', () => {
  it('sends the unbounded plan in its one generation call', async () => {
    const { provider } = await generate(41);

    assert.equal(provider.calls.length, 1);
    const plan = planOf(provider.calls[0].schema);
    assert.equal(plan.items.properties.obligation_id.enum.length, 41);
    assert.equal('minItems' in plan, false);
    assert.equal('maxItems' in plan, false);
  });

  it('accepts a complete reply, with every id planned once and nothing reported', async () => {
    const { result } = await generate(41);
    const claims = result.metadata.obligation_claims;

    const reply = replyFromSchema()({ schema: responseSchemaFor(ids(41)) });
    assert.equal(llmResponse.safeParse(reply).success, true);
    assert.equal(reply.obligation_plan.length, 41);
    assert.equal(claims.obligations_listed, 41);
    assert.equal(claims.planned, 41);
    assert.equal(claims.missing_from_plan, 0);
    assert.equal(claims.duplicated_in_plan, 0);
    assert.equal(claims.invented_ids, 0);
    assert.equal(claims.claims_unverified, 0);
    assert.equal(
      result.metadata.obligations_covered,
      41,
      'coverage comes from the text, as before'
    );
    assert.ok(
      result.warnings.every(
        (warning) =>
          warning.code !== GENERATION_WARNINGS.OBLIGATION_PLAN_INCOMPLETE &&
          warning.code !== GENERATION_WARNINGS.OBLIGATION_CLAIM_UNVERIFIED
      )
    );
  });

  it('reports an id the plan left out', async () => {
    const { result } = await generate(41, (plan) => plan.slice(1));

    assert.equal(result.metadata.obligation_claims.missing_from_plan, 1);
    const warning = result.warnings.find(
      (entry) => entry.code === GENERATION_WARNINGS.OBLIGATION_PLAN_INCOMPLETE
    );
    assert.ok(warning, 'the incomplete plan is reported');
    assert.match(warning.message, /OB-001/);
  });

  it('counts an id the plan lists twice, and keeps one entry for it', async () => {
    const { result } = await generate(41, (plan) => [...plan, plan[5]]);
    const claims = result.metadata.obligation_claims;

    assert.equal(claims.duplicated_in_plan, 1);
    assert.equal(claims.planned, 41);
  });

  it('keeps draft ids and claims out of the canonical test cases', async () => {
    const { result } = await generate(41);

    assert.equal(result.test_cases.length, 41);
    for (const generated of result.test_cases) {
      assert.equal('draft_id' in generated, false);
      assert.equal('obligation_ids' in generated, false);
      assert.equal('obligation_plan' in generated, false);
    }
  });
});

// --- The audit, which is what holds the plan past 40 ---------------------------

describe('the claim audit at 41 obligations', () => {
  const obligations = deriveCoverageObligations(requirements(41));
  const listed = obligations.map((obligation) => obligation.obligation_id);
  const fullPlan = () =>
    listed.map((obligationId, index) => ({
      obligation_id: obligationId,
      status: 'covered',
      target_test_case_ids: [`T${index + 1}`],
    }));
  const cases = () => listed.map((obligationId, index) => caseFor(index + 1, obligationId));
  const audit = (plan, rawTestCases = cases()) =>
    auditObligationClaims({ plan, rawTestCases, obligations });

  it('finds a complete plan complete', () => {
    const result = audit(fullPlan());

    assert.equal(listed.length, 41);
    assert.deepEqual(result.missing_from_plan, []);
    assert.equal(result.summary.duplicated_in_plan, 0);
    assert.deepEqual(result.invented_ids, []);
  });

  it('names a missing id', () => {
    const result = audit(fullPlan().filter((entry) => entry.obligation_id !== 'OB-041'));

    assert.deepEqual(result.missing_from_plan, ['OB-041']);
  });

  it('counts a duplicated id', () => {
    const plan = fullPlan();
    const result = audit([...plan, plan[40]]);

    assert.equal(result.summary.duplicated_in_plan, 1);
    assert.equal(result.summary.planned, 41);
  });

  it('refuses an invented id, in the plan and in a case', () => {
    const inventedCase = { ...caseFor(1, 'OB-999'), obligation_ids: ['OB-998'] };
    const result = audit(
      [...fullPlan(), { obligation_id: 'OB-999', status: 'covered', target_test_case_ids: ['T1'] }],
      [inventedCase, ...cases().slice(1)]
    );

    assert.deepEqual(result.invented_ids.sort(), ['OB-998', 'OB-999']);
    assert.equal(result.summary.planned, 41);
    assert.ok(result.unverified_claims.every((claim) => claim.obligation_id !== 'OB-998'));
  });

  it('finds an empty plan accounts for nothing', () => {
    const result = audit([]);

    assert.equal(result.summary.plan_present, false);
    assert.equal(result.summary.planned, 0);
    assert.deepEqual(result.missing_from_plan, listed);
  });

  it('finds a half plan incomplete', () => {
    const result = audit(fullPlan().slice(0, 20));

    assert.equal(result.summary.planned, 20);
    assert.equal(result.missing_from_plan.length, 21);
  });
});
