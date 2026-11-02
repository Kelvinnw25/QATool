import { CASE_TYPES, EDGE_POLARITIES, PRIORITIES } from './enums.js';

/**
 * Classification quality: what the recommended vocabulary is, and what to say
 * when a draft does not use it.
 *
 * QATOOL drafts; QA decides in Excel afterwards. That ordering is what settles
 * the question this module exists to answer - is a test case classified
 * 'Positiv' worth keeping? It is. The action, the expected result and the
 * traceability are all intact and useful; one misspelt label is a thing a
 * reviewer fixes in a dropdown in two seconds. Throwing the case away costs the
 * reviewer the draft AND hides that anything happened, which is the worse of
 * the two outcomes by a long way.
 *
 * So the vocabulary moved out of the canonical schema and into here, where it
 * produces findings instead of failures:
 *
 *   before   case_type: z.enum(CASE_TYPES)        one bad label, case discarded
 *            .superRefine(applyEdgePolarityRule)  Edge without polarity, discarded
 *   after    controlled strings + these findings  case kept, QA told exactly why
 *
 * What did NOT move is the refusal to guess. Nothing here rewrites 'Positiv' to
 * 'Positive', maps 'Urgent' onto 'High', or invents a polarity for an Edge case
 * that has none. A finding names the field, quotes the value the model actually
 * produced, and stops. Export still refuses to write a value the office
 * template cannot represent (server/export/edge-case-mapping.js), so a
 * questionable label reaches the reviewer but never silently reaches a
 * workbook.
 */

export const CLASSIFICATION_WARNINGS = {
  UNRECOGNIZED_CASE_TYPE: 'UNRECOGNIZED_CASE_TYPE',
  UNRECOGNIZED_PRIORITY: 'UNRECOGNIZED_PRIORITY',
  UNRECOGNIZED_EDGE_POLARITY: 'UNRECOGNIZED_EDGE_POLARITY',
  EDGE_POLARITY_MISSING: 'EDGE_POLARITY_MISSING',
  EDGE_POLARITY_ON_NON_EDGE: 'EDGE_POLARITY_ON_NON_EDGE',
};

const list = (values) => values.join(' / ');

function present(value) {
  return value !== null && value !== undefined && String(value).trim() !== '';
}

/**
 * The Edge/polarity relationship, as findings rather than as a schema rule.
 *
 * This is the former applyEdgePolarityRule, demoted. The rule itself is
 * unchanged and still matters - export reads edge_polarity alone to decide
 * whether an Edge row becomes a Positive or a Negative line in the workbook -
 * but breaking it no longer deletes the draft. It marks it for review, and the
 * export gate holds the line.
 */
function edgePolarityFindings(testCase) {
  const findings = [];
  const isEdge = testCase.case_type === 'Edge';
  const polarity = testCase.edge_polarity;

  if (isEdge && !present(polarity)) {
    findings.push({
      code: CLASSIFICATION_WARNINGS.EDGE_POLARITY_MISSING,
      field: 'edge_polarity',
      observed_value: null,
      message:
        `Edge polarity missing. Export maps an Edge case to Positive or Negative using this field alone, ` +
        `so it cannot be exported until QA sets it to ${list(EDGE_POLARITIES)}. No polarity was inferred.`,
    });
  }

  // A polarity on a Positive or Negative case is a confusion about what the
  // field means, not a corrupt row: export ignores the field for non-Edge
  // cases, so the workbook is unaffected and the draft stays whole.
  if (!isEdge && present(polarity)) {
    findings.push({
      code: CLASSIFICATION_WARNINGS.EDGE_POLARITY_ON_NON_EDGE,
      field: 'edge_polarity',
      observed_value: String(polarity),
      message:
        `Edge polarity '${polarity}' is set on a ${testCase.case_type} case, where it has no meaning - ` +
        `it applies only to Edge cases. The value was left exactly as drafted, not cleared. ` +
        `QA decides whether the case type or the polarity is the mistake.`,
    });

    return findings;
  }

  if (isEdge && present(polarity) && !EDGE_POLARITIES.includes(polarity)) {
    findings.push({
      code: CLASSIFICATION_WARNINGS.UNRECOGNIZED_EDGE_POLARITY,
      field: 'edge_polarity',
      observed_value: String(polarity),
      message:
        `Unrecognized edge polarity '${polarity}'. Recommended: ${list(EDGE_POLARITIES)}. ` +
        `The value was kept as drafted; export cannot map it, so QA must resolve it first.`,
    });
  }

  return findings;
}

/**
 * Every classification concern on one test case.
 *
 * Findings only. The caller attaches them to the case's own warnings array,
 * where the Results page shows them next to the value they are about.
 *
 * @param {object} testCase  a canonical test case
 * @returns {{code: string, message: string, field: string, observed_value: string|null}[]}
 */
export function classificationFindings(testCase) {
  const findings = [];

  if (!CASE_TYPES.includes(testCase.case_type)) {
    findings.push({
      code: CLASSIFICATION_WARNINGS.UNRECOGNIZED_CASE_TYPE,
      field: 'case_type',
      observed_value: String(testCase.case_type ?? ''),
      message:
        `Unrecognized case type '${testCase.case_type}'. Recommended: ${list(CASE_TYPES)}. ` +
        `The test case was kept exactly as drafted and nothing was converted. ` +
        `The office template accepts only ${list(['Positive', 'Negative'])}, so QA must choose one before export.`,
    });
  }

  if (!PRIORITIES.includes(testCase.priority)) {
    findings.push({
      code: CLASSIFICATION_WARNINGS.UNRECOGNIZED_PRIORITY,
      field: 'priority',
      observed_value: String(testCase.priority ?? ''),
      message:
        `Unrecognized priority '${testCase.priority}'. Recommended: ${list(PRIORITIES)}. ` +
        `The value was kept as drafted, not mapped onto a nearby one. QA decides what it should be.`,
    });
  }

  findings.push(...edgePolarityFindings(testCase));

  return findings;
}

/**
 * Whether this case's classification is still an open question.
 *
 * Used where a classification is an input to something else rather than just a
 * label - coverage evidence reads case_type and edge_polarity to decide whether
 * a rejection path was exercised, and a case whose type nobody has confirmed
 * cannot settle that. Reported as uncertainty; never used to drop the case.
 */
export function hasUnresolvedClassification(testCase) {
  return classificationFindings(testCase).length > 0;
}

/**
 * `type` is deliberately absent from every check above.
 *
 * It has no template dropdown to satisfy and no enum by design (see
 * DEFAULT_TEST_TYPE in enums.js): an unusual Type is a drafting choice, not a
 * mistake, and warning about it would train reviewers to ignore warnings.
 */
