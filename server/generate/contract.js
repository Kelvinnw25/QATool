import { z } from 'zod';

import { zodIssues } from '../lib/errors.js';
import {
  CASE_TYPES,
  CLASSIFICATION_MAX_LENGTH,
  CONFIDENCE_LEVELS,
  EDGE_POLARITIES,
  PRIORITIES,
  TEST_TYPE_MAX_LENGTH,
} from '../schema/enums.js';
import { PROJECT_DESCRIPTION_MAX_LENGTH } from '../schema/project.js';

/**
 * What we ask the LLM for, and what we accept back.
 *
 * Two representations of one contract, deliberately kept side by side so they
 * cannot drift:
 *
 *   RESPONSE_SCHEMA  plain JSON Schema, handed to the provider to constrain
 *                    decoding. A shaping aid.
 *   llmResponse      Zod, run over whatever actually arrives. The enforcement.
 *
 * The second never trusts the first. Provider-side schemas are best-effort and
 * vendor-specific; this one decides whether a reply is usable.
 *
 * Note what the model is NOT asked for:
 *
 *   case_id           assigned by application code in assemble.js, in order.
 *                     Nothing is gained by letting a language model mint
 *                     identifiers, and duplicate or malformed ids are a whole
 *                     class of failure that simply cannot occur this way.
 *   source_references derived from the requirements a case cites. The rule is
 *                     "never fabricate a source reference"; deriving them makes
 *                     fabrication impossible rather than merely forbidden.
 *   status/tested_by  execution fields, exported blank (PRD 18).
 */

/** Long enough for a specific outcome, short enough to stay a test case. */
const MAX_EXPECTED_RESULT = 1500;

export const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    project: {
      type: 'object',
      properties: {
        project_description: {
          type: 'string',
          description: `Exactly ONE concise English sentence describing the project itself, at most ${PROJECT_DESCRIPTION_MAX_LENGTH} characters including spaces. One sentence - no second sentence, no bullet list. Over-length output is rejected, not shortened.`,
        },
        project_summary: {
          type: 'string',
          description: 'A concise explanation, in English, of what the project is.',
        },
        qa_guidance: {
          type: 'string',
          description:
            'Concise, practical guidance in English on what QA should focus on during SIT, derived only from the given requirements.',
        },
        sit_scope: {
          type: 'array',
          minItems: 3,
          maxItems: 5,
          items: {
            type: 'string',
            description:
              'One SIT coverage area, English, styled "Area Name: What is being validated." For example "Participant Status Routing: Validating transaction behavior based on Active vs. Suspended participant bank statuses."',
          },
        },
        project_background: {
          type: 'string',
          description:
            'One short English paragraph suitable for SIT circulation, covering only context relevant to what SIT is testing.',
        },
      },
      required: [
        'project_description',
        'project_summary',
        'qa_guidance',
        'sit_scope',
        'project_background',
      ],
    },

    test_cases: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          requirement_ids: {
            type: 'array',
            minItems: 1,
            items: {
              type: 'string',
              description: 'A requirement id from the input, exactly as given, e.g. REQ-003.',
            },
          },
          section: {
            type: 'string',
            description: 'The feature or area this case belongs to, used to group rows.',
          },
          test_case: {
            type: 'string',
            description:
              'What the tester does, phrased as an action to verify. Prefer "Verify transaction rejection for a Suspended participant." over "Test participant suspended."',
          },
          case_type: { type: 'string', enum: CASE_TYPES },
          edge_polarity: {
            type: ['string', 'null'],
            enum: EDGE_POLARITIES,
            description:
              'null for Positive and Negative - omit it or send null. REQUIRED only when case_type is Edge, where it describes the EXPECTED OUTCOME, not the input value: "valid" when the system should accept and complete the operation, "invalid" when it should reject, refuse, block, lock or fail it. A boundary that triggers a restriction is "invalid" even when the value tested is the documented limit - "exactly 3 failed attempts locks the account" is "invalid".',
          },
          priority: { type: 'string', enum: PRIORITIES },
          type: {
            type: 'string',
            description:
              'Test type. Use "Functional" unless the requirement clearly indicates another.',
          },
          expected_result: {
            type: 'string',
            description:
              'A short, specific, observable outcome the tester can verify after execution. Name the value, status or code this case exercises when the source states it, so two cases testing different boundaries do not read identically. Not a restatement of the requirement, and never an invented error code, field or status.',
          },
          confidence: { type: 'string', enum: CONFIDENCE_LEVELS },
          warnings: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                code: {
                  type: 'string',
                  description:
                    'Use INSUFFICIENT_INFORMATION when the source only partly defines this behaviour.',
                },
                message: { type: 'string' },
              },
              required: ['code', 'message'],
            },
          },
        },
        /**
         * edge_polarity is deliberately NOT required here.
         *
         * It used to be, and the provider schema then said two things at once:
         * "this field must be present" and "its value is one of valid|invalid"
         * - an enum that does not contain null. The system instruction says the
         * opposite, that Positive and Negative cases carry null. A strong model
         * followed the instruction; a smaller one followed the schema, put a
         * polarity on a Positive case, and the canonical validator correctly
         * rejected it. The contradiction was ours, not the model's.
         *
         * Leaving it out of `required` removes the pressure to emit a value.
         * An omitted field arrives as null through the Zod default below, which
         * is exactly right for a non-Edge case. An Edge case that arrives
         * without one is kept and flagged for QA rather than guessed at - see
         * server/schema/classification.js - and export still refuses to map it.
         */
        required: [
          'requirement_ids',
          'section',
          'test_case',
          'case_type',
          'priority',
          'type',
          'expected_result',
          'confidence',
          'warnings',
        ],
      },
    },

    warnings: {
      type: 'array',
      description:
        'Generation-level notes. Emit INSUFFICIENT_INFORMATION here, with the requirement_id, for any requirement too underspecified to produce a safe test case for.',
      items: {
        type: 'object',
        properties: {
          code: { type: 'string' },
          message: { type: 'string' },
          requirement_id: { type: ['string', 'null'] },
        },
        required: ['code', 'message', 'requirement_id'],
      },
    },
  },
  required: ['project', 'test_cases', 'warnings'],
};

/** How the model may account for one obligation in its plan. */
export const PLAN_STATUSES = ['covered', 'insufficient_information'];

/**
 * The most ids the plan can be held to an exact length for.
 *
 * Gemini rejects a response schema that is too large, before generating
 * anything, with HTTP 400 INVALID_ARGUMENT. minItems and maxItems on the plan
 * are what push this one over: measured on 2026-10-07 against this schema and
 * gemini-3.5-flash-lite, the plan bounded to its length is accepted at 40 ids
 * and rejected at 41, while the same schema without the two bounds is accepted
 * at 41 and at 120 - the prompt's ceiling (MAX_PROMPT_OBLIGATIONS). Every
 * document past 40 obligations failed generation outright.
 *
 * So the bounds are kept where the provider takes them and dropped past it. The
 * id enum stays either way. What the bounds guaranteed - one entry per id -
 * is checked on every reply regardless by the claim audit (claims.js: missing,
 * duplicated and invented ids), as it always was.
 *
 * The limit is on the whole schema, not on the plan alone: a field added to a
 * plan entry or to a test case lowers it. Re-measure after changing either.
 */
export const MAX_EXACT_PLAN_LENGTH = 40;

/**
 * The response schema for one generation call, given the obligations it lists.
 *
 * The prompt has always said every listed obligation must reach some test case,
 * and asked the model to check each case against the obligations it covers. The
 * schema gave it nowhere to write any of that, so the check was never made in
 * any form anyone could see, and nothing went wrong when it was skipped. Over
 * ten runs on the real PRD the guard on settlement retries - "only when the
 * response is FAILED and the attempt has not reached 3" - was dropped seven
 * times, every time folded into a case that said "up to a maximum of 3".
 *
 * So the accounting is now part of the reply, in an order the provider enforces
 * through propertyOrdering:
 *
 *   project -> obligation_plan -> test_cases -> warnings
 *
 * The plan comes before any case because a model writes left to right: a list
 * made after the cases can only describe them, while a plan made first decides
 * them. Inside a case, draft_id and obligation_ids come before the text for the
 * same reason - the case is written knowing what it has to show.
 *
 * Ids are an enum of exactly the obligations the prompt listed, so an invented
 * id cannot be expressed at all, and - up to MAX_EXACT_PLAN_LENGTH ids - the
 * plan holds exactly one entry per id.
 *
 * None of it is evidence. Coverage is still decided by the deterministic matcher
 * over test_case and expected_result; a claimed id is checked against that text
 * and reported when it is not supported (server/generate/claims.js). With no
 * obligations to account for, the base schema is returned unchanged.
 *
 * @param {string[]} obligationIds  the ids the prompt listed, in prompt order
 */
export function responseSchemaFor(obligationIds = []) {
  const ids = [...new Set(obligationIds)];
  if (ids.length === 0) return RESPONSE_SCHEMA;

  const { project, test_cases: testCases, warnings } = RESPONSE_SCHEMA.properties;
  const caseItems = testCases.items;

  return {
    ...RESPONSE_SCHEMA,
    properties: {
      project,
      obligation_plan: {
        type: 'array',
        ...(ids.length <= MAX_EXACT_PLAN_LENGTH
          ? { minItems: ids.length, maxItems: ids.length }
          : {}),
        description:
          'Written BEFORE any test case. Exactly one entry for every obligation id listed in the prompt, each id once. Decide here which test cases will cover which obligations, then write the cases from this plan.',
        items: {
          type: 'object',
          properties: {
            obligation_id: {
              type: 'string',
              enum: ids,
              description: 'An obligation id exactly as listed in the prompt.',
            },
            status: {
              type: 'string',
              enum: PLAN_STATUSES,
              description:
                '"covered" when a test case below will state this behaviour; "insufficient_information" only when the requirement text genuinely does not support a test for it.',
            },
            target_test_case_ids: {
              type: 'array',
              items: {
                type: 'string',
                description: 'The draft_id of a test case below that will state this behaviour.',
              },
              description: 'Empty when status is insufficient_information.',
            },
          },
          required: ['obligation_id', 'status', 'target_test_case_ids'],
        },
      },
      test_cases: {
        ...testCases,
        items: {
          ...caseItems,
          properties: {
            draft_id: {
              type: 'string',
              description:
                "This case's id in your plan - T1, T2, T3 ... - unique within this reply. The system assigns the final case ids.",
            },
            obligation_ids: {
              type: 'array',
              items: { type: 'string', enum: ids },
              description:
                "Every obligation whose behaviour THIS case's own test_case or expected_result states. A claim, not proof: each is checked against the text.",
            },
            ...caseItems.properties,
          },
          required: ['draft_id', 'obligation_ids', ...caseItems.required],
        },
      },
      warnings,
    },
    required: ['project', 'obligation_plan', 'test_cases', 'warnings'],
  };
}

/**
 * The enforcement pass.
 *
 * Tolerant only about shapes that carry no meaning - a missing warnings array
 * is an empty one, whitespace is trimmed - and strict about everything a
 * reviewer would rely on. Unknown keys are stripped rather than rejected: a
 * model volunteering an extra field is not a reason to throw away a whole
 * generation, and nothing downstream reads fields we did not ask for.
 */
const llmWarning = z.object({
  code: z.string().trim().min(1).max(80),
  message: z.string().trim().min(1).max(1000),
  requirement_id: z
    .string()
    .trim()
    .regex(/^REQ-\d{3,}$/)
    .nullish()
    .catch(null)
    .default(null),
});

/**
 * Classification fields are accepted as text, not as enums.
 *
 * This is the one place where the Zod side is deliberately MORE permissive than
 * the JSON Schema above, and the asymmetry is the whole point. RESPONSE_SCHEMA
 * still carries the enums, so the model is still asked for exactly
 * Positive|Negative|Edge and Critical|High|Medium|Low and is constrained by the
 * provider where the provider supports it.
 *
 * But this object is parsed as part of an array inside one response object, so
 * an enum failure here is not a failure of one test case - it fails
 * llmResponse, which throws away the project outputs and every other case in
 * the batch. A single 'Positiv' would cost twenty good test cases and one of a
 * free tier's twenty daily requests. That is a catastrophic response to a
 * spelling mistake in a field a reviewer edits with a dropdown.
 *
 * So the vocabulary is checked after assembly, per case, where the blast radius
 * is one row and the outcome is a warning rather than a deletion. Nothing here
 * coerces: whatever the model wrote is what the reviewer sees.
 */
const llmTestCase = z.object({
  requirement_ids: z.array(z.string().trim()).default([]),
  section: z.string().trim().min(1).max(300),
  test_case: z.string().trim().min(1).max(1000),
  case_type: z.string().trim().min(1).max(CLASSIFICATION_MAX_LENGTH),
  edge_polarity: z.string().trim().min(1).max(CLASSIFICATION_MAX_LENGTH).nullish().default(null),
  priority: z.string().trim().min(1).max(CLASSIFICATION_MAX_LENGTH),
  type: z.string().trim().min(1).max(TEST_TYPE_MAX_LENGTH).default('Functional'),
  expected_result: z.string().trim().min(1).max(MAX_EXPECTED_RESULT),
  confidence: z.enum(CONFIDENCE_LEVELS).default('Medium'),
  warnings: z.array(llmWarning).default([]),
});

/**
 * The envelope deliberately does NOT validate the test cases.
 *
 * It used to, as z.array(llmTestCase), and that made every test case a
 * single point of failure for the whole reply: one case missing an
 * expected_result failed the array, which failed the object, which threw away
 * the project outputs and the other nineteen good cases with it. The reviewer
 * saw "the model returned JSON that does not match the agreed structure" and
 * had nothing to review.
 *
 * Cases are parsed one at a time instead (parseTestCases), so a structurally
 * broken one is discarded on its own and says so. The envelope still fails as a
 * whole when the reply is not a reply at all - no project object, no test_cases
 * array - because there is nothing to salvage from that.
 */
export const llmResponse = z.object({
  project: z.object({
    // Looser than the canonical limit on purpose: a description over
    // PROJECT_DESCRIPTION_MAX_LENGTH but under this fails later, in
    // validateAssembled, with its own path and message. Past this it is not a
    // plausible description at all and the reply is malformed.
    project_description: z.string().trim().max(600),
    project_summary: z.string().trim().max(4000),
    qa_guidance: z.string().trim().max(4000),
    sit_scope: z.array(z.string().trim().min(1).max(500)).default([]),
    project_background: z.string().trim().max(4000),
  }),
  test_cases: z.array(z.unknown()).default([]),
  // Accepted as-is and read entry by entry by the claim audit, for the reason
  // test_cases is: the plan is a diagnostic, and a malformed entry in it must
  // never cost the project outputs and every test case with it.
  obligation_plan: z.array(z.unknown()).default([]),
  warnings: z.array(llmWarning).default([]),
});

/**
 * Parses each proposed test case on its own merits.
 *
 * This is the structural safety gate: does this object carry the things a test
 * case cannot be processed without - an action, a section, an expected result,
 * of sane sizes? A case that does is kept, whatever its classification says. A
 * case that does not is discarded whole, never patched up, and the caller
 * reports it by position.
 *
 * @param {unknown[]} rawTestCases  straight from the model's reply
 * @returns {{kept: object[], discarded: {position: number, testCase: unknown, issues: object[]}[]}}
 */
export function parseTestCases(rawTestCases) {
  const kept = [];
  const discarded = [];

  (rawTestCases ?? []).forEach((raw, index) => {
    const parsed = llmTestCase.safeParse(raw);

    if (parsed.success) {
      kept.push(parsed.data);
      return;
    }

    discarded.push({ position: index + 1, testCase: raw, issues: zodIssues(parsed.error) });
  });

  return { kept, discarded };
}
