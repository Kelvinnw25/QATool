import {
  buildCoverage,
  canonicalProjectSchema,
  checkCanonicalReferences,
} from '../schema/canonical.js';
import { collectIssues } from '../lib/validate.js';
import { setStage, trace } from '../lib/trace.js';
import { diagnoseTestCases, skippedDiagnostics } from '../semantic/testcase-diagnostics.js';

/**
 * The two halves of `/api/validate`, shared by the route and by the job runner.
 *
 * Validation is two tiers. The deterministic checks (schema, references, coverage)
 * are authoritative and always run. The semantic review is advisory and sits between
 * them: the route runs it under the model gate, a job runs it on a worker, and both
 * hand its result to buildValidationReport(). Splitting the function here, rather than
 * copying the route, is what keeps the two from drifting.
 */

/** Schema and reference checks, with the trace the route has always written. */
export function deterministicChecks(canonical) {
  setStage('VALIDATE');
  trace('validation_started', {
    requirement_count: canonical.requirements?.length ?? 0,
    testcase_count: canonical.test_cases?.length ?? 0,
  });

  const schemaIssues = collectIssues(canonicalProjectSchema, canonical);
  const referenceIssues = schemaIssues.length === 0 ? checkCanonicalReferences(canonical) : [];
  const valid = schemaIssues.length === 0 && referenceIssues.length === 0;

  trace('traceability_completed', {
    valid,
    schema_issue_count: schemaIssues.length,
    reference_issue_count: referenceIssues.length,
  });

  return { schemaIssues, referenceIssues, valid };
}

/**
 * The response body of `/api/validate`.
 *
 * @param {object} canonical
 * @param {ReturnType<typeof deterministicChecks>} checks
 * @param {{ issues: object[], status: object }} semantic  from reviewSemantics()
 */
export function buildValidationReport(canonical, checks, semantic) {
  const { schemaIssues, referenceIssues, valid } = checks;

  const coverage = valid ? buildCoverage(canonical) : emptyCoverage();

  // Diagnostics about the shape of each drafted case - non-atomic, vague,
  // intermediate-only. Advisory and separate: computed after everything above
  // and read from nothing above, so they cannot move a coverage figure, a
  // semantic warning or the workbook. Same structural gate as semantic checks.
  const testcaseDiagnostics = valid
    ? diagnoseTestCases(canonical)
    : skippedDiagnostics('Test case diagnostics run only on a structurally valid project.');

  trace('result_ready', {
    valid,
    semantic_warning_count: semantic.issues.length,
    requirements_covered: coverage.summary.requirement_covered,
    obligations_covered: coverage.summary.obligations_covered,
    obligations_total: coverage.summary.obligations_total,
  });

  return {
    valid,
    schema_issues: schemaIssues,
    reference_issues: referenceIssues,
    semantic_warnings: semantic.issues,
    semantic: semantic.status,
    coverage,
    testcase_diagnostics: testcaseDiagnostics,
  };
}

/**
 * Coverage of a structurally invalid project cannot be trusted - a malformed
 * test case might not have a requirement_ids array to read - so it is reported
 * as empty rather than computed from bad data.
 */
function emptyCoverage() {
  return {
    entries: [],
    uncovered: [],
    orphan_test_cases: [],
    obligations: [],
    summary: {
      requirement_total: 0,
      requirement_covered: 0,
      requirement_partially_covered: 0,
      requirement_fully_covered: 0,
      obligations_total: 0,
      obligations_covered: 0,
      obligations_uncovered: 0,
      testcases_unresolved_classification: 0,
    },
  };
}
