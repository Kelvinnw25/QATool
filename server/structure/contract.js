import { z } from 'zod';

/**
 * What the structuring call is asked for, and what is accepted back.
 *
 * The same two-representation pattern as generation: a JSON Schema that shapes
 * the provider's decoding, and a Zod schema that decides whether the reply is
 * usable. What is different here is how little the model is trusted with.
 *
 * It is NOT asked for:
 *
 *   requirement text   the body is rebuilt from the blocks it cites, verbatim.
 *                      A model that writes the requirement can quietly improve
 *                      it, and an improved requirement is one nobody agreed to.
 *   source references  derived from the same blocks. Fabrication is impossible
 *                      rather than merely forbidden.
 *   category           deterministic, from the reconstructed text.
 *   requirement ids    assigned by the system in document order.
 *
 * What it IS asked for is the judgement a parser cannot make: which blocks
 * belong to one requirement, which blocks are examples rather than rules, and
 * what each requirement obliges the system to do.
 */

/** Test point types. Deliberately the same vocabulary the deterministic layer uses. */
export const TEST_POINT_TYPES = [
  'behavior',
  'branch',
  'transition',
  'bound',
  'mapping',
  'retry',
  'schedule',
  'ui_action',
  'side_effect',
];

export const BLOCK_ROLES = ['requirement', 'supporting_note', 'example', 'background'];

const MAX_REQUIREMENTS = 300;
const MAX_TEST_POINTS = 20;

export const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    requirements: {
      type: 'array',
      description:
        'One entry per actual requirement in the documents. Group every block belonging to the same requirement into one entry.',
      items: {
        type: 'object',
        properties: {
          title: {
            type: 'string',
            description:
              'A short handle naming what this requirement is about, for a reviewer to scan. Not the requirement text.',
          },
          source_block_ids: {
            type: 'array',
            minItems: 1,
            items: {
              type: 'string',
              description:
                'A source_block_id from the input, exactly as given, e.g. DOC-001-B014. Never invent one.',
            },
          },
          test_points: {
            type: 'array',
            description:
              'The separate things this requirement obliges the system to do. Only what the cited blocks actually state.',
            items: {
              type: 'object',
              properties: {
                type: { type: 'string', enum: TEST_POINT_TYPES },
                statement: {
                  type: 'string',
                  description:
                    'One testable behaviour, in one short sentence. "Status becomes PENDING on timeout", not "handle timeouts".',
                },
              },
              required: ['type', 'statement'],
            },
          },
          ambiguous: {
            type: 'boolean',
            description: 'True when the wording leaves a tester unable to know what to expect.',
          },
          conflicted: {
            type: 'boolean',
            description: 'True when the cited blocks contradict each other or another requirement.',
          },
          fragmented: {
            type: 'boolean',
            description:
              'True when the requirement appears to continue beyond the blocks available, e.g. it starts mid-sentence.',
          },
        },
        required: [
          'title',
          'source_block_ids',
          'test_points',
          'ambiguous',
          'conflicted',
          'fragmented',
        ],
      },
    },

    supporting_blocks: {
      type: 'array',
      description:
        'Blocks that are NOT requirements: synthetic examples, sample tables, screenshots reconstructed as text, background, objectives, references, approval tables.',
      items: {
        type: 'object',
        properties: {
          source_block_ids: {
            type: 'array',
            minItems: 1,
            items: { type: 'string' },
          },
          role: { type: 'string', enum: BLOCK_ROLES },
          reason: {
            type: 'string',
            description: 'A few words: "synthetic example", "background prose", "approval table".',
          },
        },
        required: ['source_block_ids', 'role', 'reason'],
      },
    },
  },
  required: ['requirements', 'supporting_blocks'],
};

/**
 * The enforcement pass.
 *
 * Strict about shape, silent about meaning. Whether a block really is an
 * example is a judgement this cannot check and does not try to - that is what
 * the warning surface is for.
 */
const testPoint = z.object({
  type: z.enum(TEST_POINT_TYPES).catch('behavior'),
  statement: z.string().trim().min(3).max(300),
});

const structuredRequirement = z.object({
  title: z.string().trim().min(1).max(300),
  source_block_ids: z.array(z.string().trim().min(1).max(64)).min(1),
  test_points: z.array(testPoint).max(MAX_TEST_POINTS).default([]),
  ambiguous: z.boolean().default(false),
  conflicted: z.boolean().default(false),
  fragmented: z.boolean().default(false),
});

const supportingBlock = z.object({
  source_block_ids: z.array(z.string().trim().min(1).max(64)).min(1),
  role: z.enum(BLOCK_ROLES).catch('supporting_note'),
  reason: z.string().trim().min(1).max(300).default('not a requirement'),
});

export const structureResponse = z.object({
  requirements: z.array(structuredRequirement).max(MAX_REQUIREMENTS).default([]),
  supporting_blocks: z.array(supportingBlock).default([]),
});
