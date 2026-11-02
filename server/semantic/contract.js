import { z } from 'zod';
import { SEMANTIC_CATEGORIES, SEMANTIC_SEVERITIES } from '../schema/enums.js';

/**
 * What the semantic reviewer is asked for, and what is accepted back.
 *
 * The same two-representation pattern as generation: a JSON Schema handed to
 * the provider to shape decoding, and a Zod schema that decides whether the
 * reply is usable. Categories and severities are closed vocabularies - a
 * reviewer that invents a category has not followed the instruction, and its
 * reply is rejected rather than half-trusted.
 *
 * The reviewer is not asked for evidence quotes or source references. Its
 * findings point at test case and requirement ids, which already carry
 * traceability; anything it quoted would be its own words, and a quotation
 * that looks like a source but is not one is exactly what QATOOL avoids.
 */

export const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    issues: {
      type: 'array',
      description: 'Every problem found. An empty list means the test cases hold up.',
      items: {
        type: 'object',
        properties: {
          category: { type: 'string', enum: SEMANTIC_CATEGORIES },
          severity: { type: 'string', enum: SEMANTIC_SEVERITIES },
          testcase_id: {
            type: ['string', 'null'],
            description:
              'The test case the finding is about, exactly as given (e.g. TC-004), or null.',
          },
          requirement_id: {
            type: ['string', 'null'],
            description:
              'The requirement the finding is about, exactly as given (e.g. REQ-002), or null.',
          },
          explanation: {
            type: 'string',
            description:
              'One or two sentences in English. Quote the specific word or value at issue when there is one.',
          },
        },
        required: ['category', 'severity', 'testcase_id', 'requirement_id', 'explanation'],
      },
    },
  },
  required: ['issues'],
};

const optionalId = z
  .string()
  .trim()
  .nullish()
  .transform((value) => value || null);

export const semanticResponse = z.object({
  issues: z.array(
    z.object({
      category: z.enum(SEMANTIC_CATEGORIES),
      severity: z.enum(SEMANTIC_SEVERITIES),
      testcase_id: optionalId,
      requirement_id: optionalId,
      explanation: z.string().trim().min(1).max(1000),
    })
  ),
});
