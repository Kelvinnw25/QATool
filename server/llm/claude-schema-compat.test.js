import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

// Ajv is not a direct dependency: Fastify brings it. It is used here only to judge schemas the way the
// Claude CLI does (Ajv, allErrors, no format checks), and nothing else in the project imports it.
import { Ajv } from 'ajv';

import {
  RESPONSE_SCHEMA as GENERATION_BASE,
  parseTestCases,
  responseSchemaFor,
} from '../generate/contract.js';
import { RESPONSE_SCHEMA as EXTRACTION } from '../structure/contract.js';
import { toGeminiSchema } from './gemini.js';

/**
 * QATOOL's shared schemas are written once and read by two kinds of provider. Gemini reads
 * `type: ['string', 'null']` as "nullable"; the Claude CLI validates it literally, so a nullable
 * property whose `enum` omits null rejects null. Apayee's Claude provider adds null to such enums
 * (Apayee: src/providers/claude/schema.js) so the shared contracts stay as they are.
 *
 * These tests do not call Apayee. They pin what QATOOL owns: where its schemas are nullable enums,
 * that the shared contract is unchanged, that Gemini's translation is unchanged, and that - once the
 * documented null-in-enum rule is applied - nothing QATOOL's own parser accepts is turned away by
 * the schema because of that contradiction.
 */

const OBLIGATION_IDS = ['OBL-1', 'OBL-2', 'OBL-3', 'OBL-4'];
const SCHEMAS = {
  extraction: EXTRACTION,
  'generation (no obligations)': GENERATION_BASE,
  'generation (4 obligations)': responseSchemaFor(OBLIGATION_IDS),
  'generation (41 obligations, plan bounds dropped)': responseSchemaFor(
    Array.from({ length: 41 }, (_, i) => `OBL-${i + 1}`)
  ),
};

/** The CLI's validator. */
const cliValidator = (schema) =>
  new Ajv({ allErrors: true, validateFormats: false, strict: false, logger: false }).compile(
    schema
  );

/** The rule Apayee applies for Claude: null joins the enum where the declared type allows null. */
function withNullInNullableEnums(node) {
  if (Array.isArray(node)) return node.map(withNullInNullableEnums);
  if (node === null || typeof node !== 'object') return node;
  const out = {};
  for (const [key, value] of Object.entries(node)) {
    out[key] = key === 'enum' ? [...value] : withNullInNullableEnums(value);
  }
  const types = Array.isArray(out.type) ? out.type : [out.type];
  if (types.includes('null') && Array.isArray(out.enum) && !out.enum.includes(null)) {
    out.enum = [...out.enum, null];
  }
  return out;
}

/** Paths of every node that is nullable and has an enum without null. */
function nullableEnumPaths(node, path = '') {
  if (Array.isArray(node))
    return node.flatMap((child, i) => nullableEnumPaths(child, `${path}/${i}`));
  if (node === null || typeof node !== 'object') return [];
  const here = [];
  const types = Array.isArray(node.type) ? node.type : [node.type];
  if (types.includes('null') && Array.isArray(node.enum) && !node.enum.includes(null))
    here.push(path || '/');
  for (const [key, value] of Object.entries(node)) {
    if (key !== 'enum') here.push(...nullableEnumPaths(value, `${path}/${key}`));
  }
  return here;
}

describe('the shared QATOOL contracts, as Claude will read them', () => {
  it('has exactly one nullable enum - the edge polarity - and none anywhere else', () => {
    const polarity = '/properties/test_cases/items/properties/edge_polarity';
    assert.deepEqual(nullableEnumPaths(EXTRACTION), []);
    assert.deepEqual(nullableEnumPaths(GENERATION_BASE), [polarity]);
    assert.deepEqual(nullableEnumPaths(SCHEMAS['generation (4 obligations)']), [polarity]);
    assert.deepEqual(
      nullableEnumPaths(SCHEMAS['generation (41 obligations, plan bounds dropped)']),
      [polarity]
    );
  });

  it('the shared contract itself is unchanged: still a nullable type over a two-value enum', () => {
    const polarity = GENERATION_BASE.properties.test_cases.items.properties.edge_polarity;
    assert.deepEqual(polarity.type, ['string', 'null']);
    assert.deepEqual(polarity.enum, ['valid', 'invalid']);
    assert.ok(!GENERATION_BASE.properties.test_cases.items.required.includes('edge_polarity'));
  });

  it('Gemini is given the same translation as before: nullable, with the two values only', () => {
    for (const [name, schema] of Object.entries(SCHEMAS)) {
      if (!name.startsWith('generation')) continue;
      const polarity = toGeminiSchema(schema).properties.test_cases.items.properties.edge_polarity;
      assert.equal(polarity.type, 'STRING', name);
      assert.equal(polarity.nullable, true, name);
      assert.deepEqual(polarity.enum, ['valid', 'invalid'], name);
    }
    // And translating never touches the shared object it was given.
    const before = JSON.stringify(GENERATION_BASE);
    toGeminiSchema(GENERATION_BASE);
    assert.equal(JSON.stringify(GENERATION_BASE), before);
  });

  it('the extraction schema is unaffected by the rule', () => {
    assert.deepEqual(withNullInNullableEnums(EXTRACTION), EXTRACTION);
  });
});

describe('what QATOOL accepts is not turned away because of a nullable enum', () => {
  const project = {
    project_description: 'x',
    project_summary: 'x',
    qa_guidance: 'x',
    sit_scope: ['a', 'b', 'c'],
    project_background: 'x',
  };
  const plan = OBLIGATION_IDS.map((id) => ({
    obligation_id: id,
    status: 'covered',
    target_test_case_ids: ['T1'],
  }));
  const testCase = (extra) => ({
    draft_id: 'T1',
    obligation_ids: ['OBL-1'],
    requirement_ids: ['REQ-001'],
    section: 's',
    test_case: 't',
    case_type: 'Positive',
    priority: 'High',
    type: 'Functional',
    expected_result: 'r',
    confidence: 'High',
    warnings: [],
    ...extra,
  });
  const reply = (cases) => ({ project, obligation_plan: plan, test_cases: cases, warnings: [] });

  const variants = {
    'polarity omitted (Positive)': testCase(),
    'polarity null (Positive, as the prompt instructs)': testCase({ edge_polarity: null }),
    'polarity null (Negative)': testCase({ case_type: 'Negative', edge_polarity: null }),
    'polarity "valid" (Edge)': testCase({ case_type: 'Edge', edge_polarity: 'valid' }),
    'polarity "invalid" (Edge)': testCase({ case_type: 'Edge', edge_polarity: 'invalid' }),
  };

  for (const [label, candidate] of Object.entries(variants)) {
    it(`${label}`, () => {
      // QATOOL's own parser keeps it ...
      const { kept, discarded } = parseTestCases([candidate]);
      assert.equal(discarded.length, 0, JSON.stringify(discarded));
      assert.equal(kept.length, 1);

      // ... the schema as sent may refuse it, but only on the nullable enum ...
      const schema = responseSchemaFor(OBLIGATION_IDS);
      const asSent = cliValidator(schema);
      if (!asSent(reply([candidate]))) {
        for (const error of asSent.errors) {
          assert.equal(error.keyword, 'enum', JSON.stringify(error));
          assert.match(error.instancePath, /\/edge_polarity$/, JSON.stringify(error));
        }
      }

      // ... and once null may join the enum there is nothing left to refuse.
      const forClaude = cliValidator(withNullInNullableEnums(schema));
      assert.equal(forClaude(reply([candidate])), true, JSON.stringify(forClaude.errors));
    });
  }

  it('the rule is not a general loosening: genuinely wrong replies are still refused', () => {
    const validate = cliValidator(withNullInNullableEnums(responseSchemaFor(OBLIGATION_IDS)));
    assert.equal(validate(reply([testCase({ edge_polarity: 'maybe' })])), false);
    assert.equal(validate(reply([testCase({ priority: 'Urgent' })])), false);
    assert.equal(validate(reply([(({ confidence, ...rest }) => rest)(testCase())])), false);
    assert.equal(validate({ ...reply([testCase()]), obligation_plan: plan.slice(0, 3) }), false);
  });
});
