import { EDGE_POLARITIES, PRIORITIES, TEMPLATE_CASE_TYPES } from '../schema/enums.js';

/**
 * The Edge downgrade. Pure, deterministic, and the only place it happens.
 *
 * No I/O, no configuration, no LLM. `edge_polarity` was decided at generation
 * time and confirmed by QA in review; this module only reads it. See
 * docs/edge-cases.md.
 */

export const EDGE_CASE_PREFIX = '[Edge Case] ';

/**
 * Tolerates hand-typed variants ('[edge case]', leading whitespace) so a
 * reviewer who added the marker themselves does not end up with it twice.
 */
const ALREADY_MARKED = /^\s*\[edge case\]\s*/i;

export class ExportMappingError extends Error {
  constructor(message, caseId) {
    super(message);
    this.name = 'ExportMappingError';
    this.caseId = caseId;
  }
}

/**
 * Internal case_type -> the value the office template's dropdown accepts.
 *
 *   Edge + valid boundary   -> Positive
 *   Edge + invalid boundary -> Negative
 */
export function toTemplateCaseType(testCase) {
  // A case with no case type at all is not a classification question, it is a
  // missing field, and there is nothing to preserve. Everything else is.
  if (!testCase.case_type || String(testCase.case_type).trim() === '') {
    throw new ExportMappingError(
      `Test case '${testCase.case_id}' has no case type, so there is nothing to write to the Case Type column.`,
      testCase.case_id
    );
  }

  if (testCase.case_type !== 'Edge') {
    // Whatever the draft said, verbatim - including a value the dropdown does
    // not offer. The alternatives are worse: mapping 'Positiv' onto 'Positive'
    // is the system settling a classification nobody has looked at, and
    // refusing the workbook costs QA every other row over one typo. A cell
    // outside its dropdown is visible, correctable in two seconds, and honest
    // about what the model produced. See exportWarnings.
    return testCase.case_type;
  }

  switch (testCase.edge_polarity) {
    case 'valid':
      return 'Positive';
    case 'invalid':
      return 'Negative';
    default:
      // No polarity, or one nobody recognises. The Edge case is kept as an
      // Edge case: converting it to Positive or Negative here would be
      // inventing the very judgement the field exists to record, and could
      // export a boundary-rejection test as a success path. 'Edge' is what the
      // draft says, so 'Edge' is what the cell gets.
      return testCase.case_type;
  }
}

/**
 * Edge rows carry their classification into the workbook as a prefix, since the
 * spreadsheet has nowhere else to put it. Never written back to the canonical
 * model - see docs/edge-cases.md.
 */
export function toTemplateExpectedResult(testCase) {
  const text = testCase.expected_result ?? '';

  if (testCase.case_type !== 'Edge') return text;
  if (ALREADY_MARKED.test(text)) return text;

  return EDGE_CASE_PREFIX + text;
}

/**
 * What actually stops a workbook being built.
 *
 * Structural only. A test case with no action or no expected result has nothing
 * to put in the columns that matter, and a row of blanks in a SIT script is
 * worse than an absent one.
 *
 * Classification is deliberately NOT here any more. An unrecognised case type
 * or priority, or an Edge case whose polarity is still open, used to block the
 * whole export - which meant one imperfect label cost QA every other row in the
 * file. Those are now exported with their values intact and reported by
 * exportWarnings, because QATOOL drafts and QA decides: a reviewer can fix a
 * dropdown in the workbook, and cannot fix a workbook they never received.
 *
 * @returns {{case_id: string, code: string, message: string}[]}
 */
export function checkExportable(testCase) {
  const issues = [];

  if (!testCase.expected_result || testCase.expected_result.trim() === '') {
    issues.push({
      case_id: testCase.case_id,
      code: 'EXPECTED_RESULT_EMPTY',
      message: `'${testCase.case_id}' has no Expected Result.`,
    });
  }

  if (!testCase.test_case || testCase.test_case.trim() === '') {
    issues.push({
      case_id: testCase.case_id,
      code: 'TEST_CASE_EMPTY',
      message: `'${testCase.case_id}' has no Test Case description.`,
    });
  }

  return issues;
}

/**
 * What was written that QA needs to look at, having been written anyway.
 *
 * Every one of these describes a cell that now holds a value its dropdown does
 * not offer. That is the intended outcome, not an accident: the workbook is a
 * draft handed to a reviewer, and a visible odd value in the right row is more
 * use than a corrected value nobody chose or a file that never arrived. Excel
 * will not complain on open - list validation constrains typing, not stored
 * content - and the odd value shows up the moment anyone touches the cell.
 *
 * Each warning names the case, the field and the exact value preserved, so the
 * notice can be acted on without cross-referencing anything.
 *
 * @returns {{case_id: string, code: string, field: string, observed_value: string|null, message: string}[]}
 */
export function exportWarnings(testCase) {
  const warnings = [];
  const isEdge = testCase.case_type === 'Edge';

  if (!isEdge && !TEMPLATE_CASE_TYPES.includes(testCase.case_type)) {
    warnings.push({
      case_id: testCase.case_id,
      code: 'UNRECOGNIZED_CASE_TYPE_EXPORTED',
      field: 'case_type',
      observed_value: String(testCase.case_type),
      message: `${testCase.case_id}: Case Type '${testCase.case_type}' is outside the recommended vocabulary and was preserved unchanged. The column's dropdown offers only ${TEMPLATE_CASE_TYPES.join(' and ')}. QA review required.`,
    });
  }

  if (isEdge && !EDGE_POLARITIES.includes(testCase.edge_polarity)) {
    const observed = testCase.edge_polarity ?? null;
    warnings.push({
      case_id: testCase.case_id,
      code: 'EDGE_POLARITY_UNRESOLVED_EXPORTED',
      field: 'edge_polarity',
      observed_value: observed === null ? null : String(observed),
      message:
        observed === null
          ? `${testCase.case_id}: Edge case has no edge_polarity. The row was exported as 'Edge'; no polarity was inferred and the case was not converted to Positive or Negative. QA review required.`
          : `${testCase.case_id}: Edge case has edge_polarity '${observed}', which is outside the recommended vocabulary. The row was exported as 'Edge'; nothing was inferred or converted. QA review required.`,
    });
  }

  if (!PRIORITIES.includes(testCase.priority)) {
    warnings.push({
      case_id: testCase.case_id,
      code: 'UNRECOGNIZED_PRIORITY_EXPORTED',
      field: 'priority',
      observed_value: String(testCase.priority ?? ''),
      message: `${testCase.case_id}: Priority '${testCase.priority}' is outside the recommended vocabulary and was preserved unchanged. The column's dropdown offers only ${PRIORITIES.join(', ')}. QA review required.`,
    });
  }

  return warnings;
}

/**
 * Canonical test case -> the nine template columns, in sheet order.
 *
 * Status and Tested By are always blank: PRD 18 reserves them for SIT
 * execution, which this tool does not perform.
 */
export function mapTestCaseToRow(testCase) {
  return {
    case_id: testCase.case_id,
    section: testCase.section ?? '',
    test_case: testCase.test_case ?? '',
    case_type: toTemplateCaseType(testCase),
    priority: testCase.priority ?? '',
    type: testCase.type ?? '',
    expected_result: toTemplateExpectedResult(testCase),
    status: '',
    tested_by: '',
  };
}
