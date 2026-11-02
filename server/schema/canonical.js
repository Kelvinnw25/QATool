import { z } from 'zod';
import { projectSchema } from './project.js';
import { documentSchema } from './document.js';
import { requirementSchema } from './requirement.js';
import { testCaseSchema } from './testcase.js';
import { deriveCoverageObligations, matchObligations } from '../scenario/obligations.js';
import { hasUnresolvedClassification } from './classification.js';

/**
 * The canonical project document (PRD 6) - the source of truth for one
 * workflow.
 *
 * It lives in the browser for the duration of a session and is passed to the
 * server on each pipeline call. Nothing stores it; a refresh ends the session.
 *
 * The exported workbook is a lossy projection of this structure, never the
 * other way round (PRD 19). Anything the spreadsheet cannot carry - Edge
 * classification, requirement mapping, source references, confidence,
 * warnings - exists only here.
 */
export const canonicalProjectSchema = z
  .object({
    project: projectSchema,
    documents: z.array(documentSchema),
    requirements: z.array(requirementSchema),
    test_cases: z.array(testCaseSchema),
  })
  .strict();

/**
 * Referential integrity across the canonical document. Deliberately separate
 * from the shape check: milestone 5 runs this as part of the deterministic
 * validation pass, and reports rather than throws.
 *
 * @returns {{path: string, code: string, message: string}[]}
 */
export function checkCanonicalReferences(canonical) {
  const issues = [];
  const documentIds = new Set(canonical.documents.map((doc) => doc.document_id));
  const requirementIds = new Set(canonical.requirements.map((req) => req.requirement_id));

  const seenRequirementIds = new Set();
  for (const [index, requirement] of canonical.requirements.entries()) {
    if (seenRequirementIds.has(requirement.requirement_id)) {
      issues.push({
        path: `requirements[${index}].requirement_id`,
        code: 'DUPLICATE_REQUIREMENT_ID',
        message: `Requirement id '${requirement.requirement_id}' is used more than once.`,
      });
    }
    seenRequirementIds.add(requirement.requirement_id);

    for (const [refIndex, reference] of requirement.source_references.entries()) {
      if (!documentIds.has(reference.document_id)) {
        issues.push({
          path: `requirements[${index}].source_references[${refIndex}].document_id`,
          code: 'UNKNOWN_DOCUMENT_REFERENCE',
          message: `Requirement '${requirement.requirement_id}' cites unknown document '${reference.document_id}'.`,
        });
      }
    }
  }

  const seenCaseIds = new Set();
  for (const [index, testCase] of canonical.test_cases.entries()) {
    if (seenCaseIds.has(testCase.case_id)) {
      issues.push({
        path: `test_cases[${index}].case_id`,
        code: 'DUPLICATE_CASE_ID',
        message: `Case id '${testCase.case_id}' is used more than once.`,
      });
    }
    seenCaseIds.add(testCase.case_id);

    for (const requirementId of testCase.requirement_ids) {
      if (!requirementIds.has(requirementId)) {
        issues.push({
          path: `test_cases[${index}].requirement_ids`,
          code: 'UNKNOWN_REQUIREMENT_REFERENCE',
          message: `Test case '${testCase.case_id}' cites unknown requirement '${requirementId}'.`,
        });
      }
    }

    for (const [refIndex, reference] of testCase.source_references.entries()) {
      if (!documentIds.has(reference.document_id)) {
        issues.push({
          path: `test_cases[${index}].source_references[${refIndex}].document_id`,
          code: 'UNKNOWN_DOCUMENT_REFERENCE',
          message: `Test case '${testCase.case_id}' cites unknown document '${reference.document_id}'.`,
        });
      }
    }
  }

  return issues;
}

/**
 * How a requirement's obligations stand.
 *
 *   uncovered       no test case cites it at all
 *   not_measurable  cited, but its wording yields no obligation this system can
 *                   read. Honest about its own limits: no percentage is
 *                   offered, because there is nothing to be a percentage of.
 *   partial         cited, and some of what it says is demonstrably untested.
 *                   Zero of five counts as partial - cases exist, they just do
 *                   not reach the behaviour.
 *   full            every obligation has a test case with explicit evidence
 */
function coverageState(caseIds, total, covered) {
  if (caseIds.length === 0) return 'uncovered';
  if (total === 0) return 'not_measurable';
  return covered === total ? 'full' : 'partial';
}

/**
 * Requirement coverage (PRD 16), in two layers. Reports gaps; never invents a
 * test case to close one.
 *
 * The outer layer is unchanged and still authoritative for "is this requirement
 * tested at all": entries, uncovered and orphan_test_cases mean exactly what
 * they have always meant, and everything reading them keeps working.
 *
 * The inner layer is what a citation is worth. A requirement that states six
 * things and is cited by one test case used to report as covered, full stop -
 * the report agreed with itself and was wrong about the project. Obligations
 * are derived from the requirement's own wording (server/scenario/obligations.js)
 * and matched against the cases citing it by explicit evidence, so "covered"
 * can now be qualified by how much of it is actually true.
 *
 * Both layers are deterministic and both are computed here rather than asked
 * for: coverage is the system's claim, not the model's.
 */
export function buildCoverage(canonical) {
  const coverage = new Map(
    canonical.requirements.map((requirement) => [requirement.requirement_id, []])
  );

  for (const testCase of canonical.test_cases) {
    for (const requirementId of testCase.requirement_ids) {
      if (coverage.has(requirementId)) {
        coverage.get(requirementId).push(testCase.case_id);
      }
    }
  }

  const obligations = matchObligations(
    deriveCoverageObligations(canonical.requirements),
    canonical.test_cases
  );

  const byRequirement = new Map();
  for (const obligation of obligations) {
    if (!byRequirement.has(obligation.requirement_id)) {
      byRequirement.set(obligation.requirement_id, []);
    }
    byRequirement.get(obligation.requirement_id).push(obligation);
  }

  const entries = [...coverage.entries()].map(([requirementId, caseIds]) => {
    const own = byRequirement.get(requirementId) ?? [];
    const covered = own.filter((obligation) => obligation.covered);

    return {
      requirement_id: requirementId,
      case_ids: caseIds,
      covered: caseIds.length > 0,
      obligations: {
        total: own.length,
        covered: covered.length,
        uncovered: own
          .filter((obligation) => !obligation.covered)
          .map((obligation) => obligation.obligation_id),
        // Null rather than 100 when there is nothing to measure: a requirement
        // whose wording yields no obligation has not earned a full mark.
        percent: own.length === 0 ? null : Math.round((covered.length / own.length) * 100),
        state: coverageState(caseIds, own.length, covered.length),
      },
    };
  });

  return {
    entries,
    uncovered: entries.filter((entry) => !entry.covered).map((entry) => entry.requirement_id),
    orphan_test_cases: canonical.test_cases
      .filter((testCase) => testCase.requirement_ids.length === 0)
      .map((testCase) => testCase.case_id),
    obligations,
    summary: {
      requirement_total: entries.length,
      requirement_covered: entries.filter((entry) => entry.covered).length,
      requirement_partially_covered: entries.filter(
        (entry) => entry.obligations.state === 'partial'
      ).length,
      requirement_fully_covered: entries.filter((entry) => entry.obligations.state === 'full')
        .length,
      obligations_total: obligations.length,
      obligations_covered: obligations.filter((obligation) => obligation.covered).length,
      obligations_uncovered: obligations.filter((obligation) => !obligation.covered).length,

      /**
       * How much of this arithmetic rests on a classification nobody has
       * confirmed. Obligation evidence reads case_type and edge_polarity - a
       * rejection path counts as exercised when a Negative or invalid-Edge case
       * cites it - so a case labelled 'Positiv', or an Edge case with no
       * polarity, cannot settle that question either way.
       *
       * Such cases stay in coverage: they are real drafts and excluding them
       * would understate the work as badly as miscounting it would overstate
       * it. What changes is that the figure stops claiming to be exact, and the
       * Results page says which cases the uncertainty comes from.
       */
      testcases_unresolved_classification: canonical.test_cases.filter((testCase) =>
        hasUnresolvedClassification(testCase)
      ).length,
    },
  };
}
