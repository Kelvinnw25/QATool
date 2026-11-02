/**
 * Controlled vocabularies (PRD 13: no dynamically invented enums).
 *
 * Values marked TEMPLATE are transcribed verbatim from the dataValidation
 * formulas inside templates/sit-script-template.xlsx. They are not a design
 * choice - writing anything else into those columns produces a workbook that
 * fails its own dropdown. Milestone 7 adds a test that reads the template and
 * asserts these constants still match it.
 *
 *   D2:D20  "Positive,Negative"
 *   E2:E20  "High,Medium,Low,Critical"
 *   H2:H20  "PASSED,FAILED,NOT TESTED,Take Out,BLOCKED"
 *   I2:I20  "Kelvin"
 */

/** TEMPLATE - Case Type values the office template's dropdown accepts. */
export const TEMPLATE_CASE_TYPES = ['Positive', 'Negative'];

/**
 * Internal Case Type vocabulary. Deliberately wider than the template.
 *
 * 'Edge' exists here and only here: it is never written to the workbook. The
 * export layer downgrades it to Positive/Negative using edge_polarity and marks
 * the row with an '[Edge Case] ' prefix on the Expected Result. See
 * server/export/edge-case-mapping.js (milestone 7) and docs/edge-cases.md.
 *
 * RECOMMENDED, not enforced on the canonical model. This list is what the
 * provider schema asks the model for and what review is judged against, but a
 * draft carrying 'Positiv' is kept and flagged rather than thrown away - see
 * server/schema/classification.js for why.
 */
export const CASE_TYPES = ['Positive', 'Negative', 'Edge'];

/**
 * Boundary polarity for Edge cases, describing the EXPECTED OUTCOME:
 * 'valid' the system accepts and completes, 'invalid' it refuses.
 *
 * Recommended vocabulary, same as CASE_TYPES. Export still refuses to guess -
 * an Edge row without a recognised polarity cannot be mapped to a template
 * Case Type and blocks the workbook rather than picking a side.
 */
export const EDGE_POLARITIES = ['valid', 'invalid'];

/** TEMPLATE - Priority dropdown. Recommended vocabulary on the canonical model. */
export const PRIORITIES = ['Critical', 'High', 'Medium', 'Low'];

/**
 * Bound on a classification value the model may put in case_type, priority or
 * edge_polarity. Long enough for any real label, short enough that a sentence
 * that landed in the wrong field is still a structural failure rather than a
 * classification warning.
 */
export const CLASSIFICATION_MAX_LENGTH = 60;

/** TEMPLATE - Status dropdown. Execution-only; exported blank (PRD 18). */
export const EXECUTION_STATUSES = ['PASSED', 'FAILED', 'NOT TESTED', 'Take Out', 'BLOCKED'];

/**
 * Type is NOT an enum in V1.
 *
 * The office template puts no dataValidation on the Type column, so there is no
 * authoritative vocabulary to copy - and inventing one would be exactly the kind
 * of uncontrolled taxonomy PRD 13 warns about, only worse for being ours rather
 * than the business's. The field is a controlled string instead: trimmed,
 * length-bounded, non-empty, defaulted to the one value the template actually
 * demonstrates.
 *
 * Suggestions offered to the UI, never enforced. Once real usage shows which
 * values QA settles on, this can become a proper enum with evidence behind it.
 */
export const DEFAULT_TEST_TYPE = 'Functional';

/** Every Type value observed in the supplied template. */
export const OBSERVED_TEST_TYPES = ['Functional'];

export const TEST_TYPE_MAX_LENGTH = 100;

/** Requirement categories from PRD 7. */
export const REQUIREMENT_CATEGORIES = [
  'Functional Behavior',
  'Business Rule',
  'Input Validation',
  'Expected Behavior',
  'Error Handling',
  'Status/State',
  'Data/Field Mapping',
  'Integration/Dependency',
  'Constraint',
];

/** Document classification, used to weight extraction in milestone 2. */
export const DOCUMENT_TYPES = [
  'PRD',
  'RFC',
  'Technical Specification',
  'API Specification',
  'Supporting Document',
];

/** PRD 14: a review signal, never fake precision such as 0.937. */
export const CONFIDENCE_LEVELS = ['High', 'Medium', 'Low'];

/** Per-document processing state, driven by the milestone 2 pipeline. */
export const DOCUMENT_STATUSES = ['Uploaded', 'Processing', 'Extracted', 'Failed'];

/**
 * What semantic validation (milestone 5) can report.
 *
 * These are findings, never fixes: each names a test case and/or requirement
 * and explains the concern, and nothing in the canonical object changes
 * because of one. The first eight are the checks the milestone asks for;
 * suspicious_case_type is the Positive/Negative sibling of
 * suspicious_edge_polarity, and matters for the same reason - it decides which
 * dropdown value the row is exported with.
 */
export const SEMANTIC_CATEGORIES = [
  'contradiction',
  'unsupported_behavior',
  'hallucinated_detail',
  'duplicate',
  'missing_coverage',
  'suspicious_edge_polarity',
  'unsupported_implementation_detail',
  'no_meaningful_test',
  'suspicious_case_type',
];

/**
 * Deliberately not error/warning: deterministic validation owns "error", and
 * nothing semantic blocks export. These rank how urgently a reviewer should
 * look, nothing more.
 */
export const SEMANTIC_SEVERITIES = ['high', 'medium', 'low'];
