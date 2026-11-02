import { z } from 'zod';
import {
  CLASSIFICATION_MAX_LENGTH,
  CONFIDENCE_LEVELS,
  DEFAULT_TEST_TYPE,
  EXECUTION_STATUSES,
  TEST_TYPE_MAX_LENGTH,
} from './enums.js';
import { nonEmptyText, optionalText, sourceReferences, warnings } from './common.js';

/**
 * What this schema does and does not decide.
 *
 * It decides whether a test case can be carried safely: it has an identifier
 * the system assigned, an action, an expected result, traceability that points
 * at real things, and nothing oversized or unknown. Failing any of that means
 * the object cannot be processed, and it is discarded rather than mended.
 *
 * It deliberately does NOT decide whether the case is classified well.
 * case_type, priority and edge_polarity are controlled strings here, not enums,
 * because QATOOL is a drafting tool: a case labelled 'Positiv' still tells a
 * reviewer what to test and why, and deleting it would destroy useful work over
 * a typo in a dropdown value. The recommended vocabularies still exist, are
 * still what the model is asked for, and are still checked - by
 * server/schema/classification.js, which produces warnings the Results page
 * shows and which QA resolves.
 *
 * The Edge/polarity invariant moved with them. It used to be a superRefine here
 * (applyEdgePolarityRule) that made an Edge case with no polarity fatal. The
 * reason for the rule is unchanged - export maps Edge to Positive/Negative from
 * this field alone and must never guess - but the enforcement point moved to
 * where the consequence is: server/export/edge-case-mapping.js refuses to build
 * a workbook it cannot represent honestly. Between drafting and export the case
 * stays visible, flagged, and unrepaired.
 */
export const testCaseSchema = z
  .object({
    case_id: z.string().regex(/^TC-\d{3,}$/, 'Must be formatted as TC-nnn.'),

    /** Requirements this case covers (PRD 16/19) - the traceability link. */
    requirement_ids: z
      .array(z.string().regex(/^REQ-\d{3,}$/, 'Must reference a requirement as REQ-nnn.'))
      .default([]),

    section: nonEmptyText(300),
    test_case: nonEmptyText(1000),

    /**
     * Recommended vocabulary CASE_TYPES / PRIORITIES / EDGE_POLARITIES, checked
     * by classification.js rather than enforced here. Still bounded and
     * non-empty: a label is a label, and a paragraph arriving in one of these
     * fields is a structural failure, not a classification opinion.
     */
    case_type: nonEmptyText(CLASSIFICATION_MAX_LENGTH),
    edge_polarity: z.string().trim().min(1).max(CLASSIFICATION_MAX_LENGTH).nullable().default(null),
    priority: nonEmptyText(CLASSIFICATION_MAX_LENGTH),

    /** Controlled string, not an enum - see DEFAULT_TEST_TYPE in enums.js. */
    type: nonEmptyText(TEST_TYPE_MAX_LENGTH).default(DEFAULT_TEST_TYPE),

    expected_result: nonEmptyText(4000),

    source_references: sourceReferences,
    confidence: z.enum(CONFIDENCE_LEVELS).default('Medium'),
    warnings,

    /**
     * Execution fields. PRD 18 requires both to be exported blank, so nothing
     * in V1 writes them; they exist because the canonical model in PRD 6
     * declares them and a later SIT-execution feature would use them.
     */
    status: z.enum(EXECUTION_STATUSES).nullable().default(null),
    tested_by: optionalText(150),

    /** Controls row order in the exported workbook. */
    order_index: z.number().int().nonnegative().default(0),
  })
  .strict();
