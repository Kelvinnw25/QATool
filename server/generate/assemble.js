import { formatSequentialId, ID_PREFIX } from '../lib/ids.js';

/**
 * Turns a validated LLM reply into canonical test cases, deterministically.
 *
 * Everything here is a pure function of the reply and the requirements. The
 * model proposes; this module decides what the canonical object actually says,
 * and it is the reason three whole categories of LLM error cannot reach the
 * workbook:
 *
 *   identifiers       assigned here, in order, so they cannot collide
 *   source references derived from the cited requirements, so they cannot be
 *                     fabricated
 *   redundancy        duplicates removed by comparison, not by asking nicely
 *
 * What it does NOT do is fix semantic mistakes. A case citing a requirement
 * that does not exist keeps a warning attached to it rather than being quietly
 * mended, and a case whose case_type and edge_polarity disagree is left to fail
 * schema validation. Silent repair would hide exactly the errors review exists
 * to catch.
 */

export const GENERATION_WARNINGS = {
  INSUFFICIENT_INFORMATION: 'INSUFFICIENT_INFORMATION',
  UNKNOWN_REQUIREMENT_REFERENCE: 'UNKNOWN_REQUIREMENT_REFERENCE',
  UNTRACEABLE_TEST_CASE: 'UNTRACEABLE_TEST_CASE',
  DUPLICATE_TEST_CASE_REMOVED: 'DUPLICATE_TEST_CASE_REMOVED',
  REQUIREMENT_NOT_COVERED: 'REQUIREMENT_NOT_COVERED',
  OBLIGATION_NOT_COVERED: 'OBLIGATION_NOT_COVERED',
  OBLIGATION_NOT_MEASURABLE: 'OBLIGATION_NOT_MEASURABLE',
  OBLIGATION_NOT_DERIVED: 'OBLIGATION_NOT_DERIVED',
  OBLIGATIONS_TRUNCATED: 'OBLIGATIONS_TRUNCATED',
  OBLIGATION_CLAIM_UNVERIFIED: 'OBLIGATION_CLAIM_UNVERIFIED',
  OBLIGATION_PLAN_INCOMPLETE: 'OBLIGATION_PLAN_INCOMPLETE',
  INVALID_TEST_CASE_DISCARDED: 'INVALID_TEST_CASE_DISCARDED',
  CLASSIFICATION_REVIEW_REQUIRED: 'CLASSIFICATION_REVIEW_REQUIRED',
};

/**
 * Assigns the dense TC-001..TC-nnn run and the order it implies.
 *
 * Called twice: once when the survivors of deduplication are known, and again
 * if canonical validation discards a case, because a gap in the numbering
 * would be a worse artefact than the case that left. Nothing else about a test
 * case is touched.
 */
export function renumber(testCases) {
  testCases.forEach((testCase, index) => {
    testCase.case_id = formatSequentialId(ID_PREFIX.testCase, index + 1);
    testCase.order_index = index;
  });

  return testCases;
}

/**
 * Reports requirements that ended up with no test case.
 *
 * Deliberately callable after validation rather than only during assembly: a
 * case discarded for being malformed can be the only one a requirement had, and
 * a coverage report that still counted it would be a comfortable lie.
 *
 * A requirement the model explicitly declined to test is not reported again -
 * INSUFFICIENT_INFORMATION already says why, with better words than this can.
 */
export function reportUncovered(requirements, testCases, warnings) {
  const covered = new Set(testCases.flatMap((testCase) => testCase.requirement_ids));
  const explained = new Set(
    warnings
      .filter((warning) => warning.code === GENERATION_WARNINGS.INSUFFICIENT_INFORMATION)
      .map((warning) => warning.requirement_id)
      .filter(Boolean)
  );

  const already = new Set(
    warnings
      .filter((warning) => warning.code === GENERATION_WARNINGS.REQUIREMENT_NOT_COVERED)
      .map((warning) => warning.requirement_id)
  );

  return requirements
    .filter(
      (requirement) =>
        !covered.has(requirement.requirement_id) &&
        !explained.has(requirement.requirement_id) &&
        !already.has(requirement.requirement_id)
    )
    .map((requirement) => ({
      code: GENERATION_WARNINGS.REQUIREMENT_NOT_COVERED,
      message: `${requirement.requirement_id} produced no test case, and no reason was given.`,
      requirement_id: requirement.requirement_id,
    }));
}

/** Comparison form for duplicate detection: wording varies, behaviour does not. */
function normalizeForComparison(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * What makes two test cases the same test: the scenario, not the outcome.
 *
 * A test case is identified by what the tester DOES - the action - together
 * with the requirements it covers and how it is classified. Two entries that
 * agree on all of that are one test written twice, and the second is dropped.
 *
 * The expected result is deliberately NOT part of this. It used to be, and it
 * was wrong in a way that quietly destroyed exactly the coverage this tool
 * exists to produce: the two ends of one limit share an outcome by design.
 *
 *   "transfer of exactly IDR 10,000"  -> "Transfer is submitted successfully."
 *   "transfer of exactly IDR 50,000,000" -> "Transfer is submitted successfully."
 *
 * Same requirement, same type, same polarity, same outcome text - so the
 * maximum boundary was deleted as a duplicate of the minimum. Measured on a
 * synthetic evaluation, this removed half of one run's test cases, and the
 * only trace was a warning counting how many had gone.
 *
 * Erring the other way costs a reviewer one duplicate row to delete in Excel.
 * Erring this way costs an untested boundary that nobody knows is missing, so
 * anything short of an identical action is kept. Genuine same-action-different
 * -wording repeats are a judgement about meaning, which is semantic review's
 * job (server/semantic/), where they are reported rather than deleted.
 */
function identityKey(testCase) {
  return [
    normalizeForComparison(testCase.test_case),
    [...testCase.requirement_ids].sort().join('|'),
    testCase.case_type,
    testCase.edge_polarity ?? '-',
  ].join('::');
}

/**
 * Collects the source references of every requirement a case cites.
 *
 * This is the whole traceability chain - Test Case -> Requirement -> Document
 * -> Page/Section - and it is copied, never authored. Deduplicated because two
 * requirements often cite the same table.
 */
function deriveSourceReferences(requirementIds, requirementsById) {
  const seen = new Set();
  const references = [];

  for (const requirementId of requirementIds) {
    for (const reference of requirementsById.get(requirementId)?.source_references ?? []) {
      const key = `${reference.document_id}|${reference.page ?? ''}|${reference.section ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);

      references.push({
        document_id: reference.document_id,
        page: reference.page ?? null,
        section: reference.section ?? null,
        quote: reference.quote ?? null,
      });
    }
  }

  return references;
}

/**
 * @param {object} response      the parsed, contract-validated LLM reply
 * @param {object[]} requirements the requirements it was generated from
 * @returns {{testCases: object[], warnings: object[], stats: object}}
 */
export function assembleTestCases(response, requirements) {
  const requirementsById = new Map(
    requirements.map((requirement) => [requirement.requirement_id, requirement])
  );

  const warnings = response.warnings.map((warning) => ({ ...warning }));
  const testCases = [];
  const seenKeys = new Set();
  const covered = new Set();
  const removedActions = [];

  for (const candidate of response.test_cases) {
    const caseWarnings = candidate.warnings.map((warning) => ({
      code: warning.code,
      message: warning.message,
    }));

    // Citations are checked against the requirements that actually exist. An
    // invented id is dropped so it cannot reach the canonical object, but the
    // drop is always announced on the case itself.
    const known = [];
    const unknown = [];
    for (const requirementId of candidate.requirement_ids) {
      (requirementsById.has(requirementId) ? known : unknown).push(requirementId);
    }

    if (unknown.length > 0) {
      caseWarnings.push({
        code: GENERATION_WARNINGS.UNKNOWN_REQUIREMENT_REFERENCE,
        message: `Cited ${unknown.join(', ')}, which ${unknown.length === 1 ? 'is not a requirement' : 'are not requirements'} in this project. The citation was removed; the test case was kept for review.`,
      });
    }

    if (known.length === 0) {
      caseWarnings.push({
        code: GENERATION_WARNINGS.UNTRACEABLE_TEST_CASE,
        message:
          'This test case traces back to no requirement, so its source cannot be verified. Review it before use.',
      });
    }

    const assembled = {
      case_id: null, // assigned below, once the survivors are known
      requirement_ids: known,
      section: candidate.section,
      test_case: candidate.test_case,
      case_type: candidate.case_type,
      edge_polarity: candidate.edge_polarity ?? null,
      priority: candidate.priority,
      type: candidate.type,
      expected_result: candidate.expected_result,
      source_references: deriveSourceReferences(known, requirementsById),
      confidence: candidate.confidence,
      warnings: caseWarnings,
      status: null,
      tested_by: null,
      order_index: 0,
    };

    const key = identityKey(assembled);
    if (seenKeys.has(key)) {
      removedActions.push(assembled.test_case);
      continue;
    }
    seenKeys.add(key);

    for (const requirementId of known) covered.add(requirementId);
    testCases.push(assembled);
  }

  // Ids come last so they are always a dense TC-001..TC-nnn run over what
  // survived, with no gaps where a duplicate used to be.
  renumber(testCases);

  // Naming what was dropped, not just counting it. A reviewer who disagrees
  // with a removal can only say so if they can see what went.
  if (removedActions.length > 0) {
    const listed = removedActions
      .slice(0, 5)
      .map((action) => `"${action}"`)
      .join('; ');
    const rest = removedActions.length - 5;

    warnings.push({
      code: GENERATION_WARNINGS.DUPLICATE_TEST_CASE_REMOVED,
      message:
        `${removedActions.length} generated test case${removedActions.length === 1 ? '' : 's'} repeated an action already covered ` +
        `and ${removedActions.length === 1 ? 'was' : 'were'} removed: ${listed}${rest > 0 ? ` and ${rest} more` : ''}.`,
      requirement_id: null,
    });
  }

  // Uncovered requirements are reported by the caller, once canonical
  // validation has decided which cases are real. Reporting it here would count
  // a case that is about to be discarded for being malformed.

  return {
    testCases,
    warnings,
    stats: {
      generated: response.test_cases.length,
      kept: testCases.length,
      duplicates_removed: removedActions.length,
      requirements_covered: covered.size,
    },
  };
}

/**
 * Names every behavioural obligation no surviving test case reaches.
 *
 * Until this existed, obligation loss was reported as a fraction in metadata
 * and nowhere else. A run covering 16 of 29 and a run covering 16 of 24 read
 * identically, so a behaviour that one generation instantiated and the next
 * quietly reinterpreted away produced no signal at all - which is how repeated
 * runs over one document could differ in what they tested without anything
 * saying so.
 *
 * Reported, never repaired. Nothing here regenerates, pads or retries: an
 * uncovered obligation is a fact about this run that QA decides what to do
 * with, and a tool that silently fixed it would be making that decision.
 *
 * The two outcomes are kept apart on purpose:
 *
 *   uncovered       a testable behaviour nobody tested. Actionable.
 *   not measurable  the source never said enough to test it - "the report
 *                   loads quickly". Permanent, and reported once as a group so
 *                   it cannot bury the first kind.
 *
 *   unreadable      a requirement whose wording yields no obligation at all, so
 *                   coverage has nothing to measure over it either way. The
 *                   quietest of the three and the one worth saying out loud.
 *
 * @param {object[]} matched  from matchObligations, already classified
 * @param {object[]} requirements  what generation was given, for the third case
 * @param {object[]} reported  warnings so far, so the model's own explanations are not repeated
 * @returns {object[]} warnings
 */
export function reportObligationGaps(matched, requirements = [], reported = []) {
  const warnings = [];
  const uncovered = matched.filter((entry) => !entry.covered && entry.measurable);
  const unmeasurable = matched.filter((entry) => !entry.measurable);

  const byRequirement = new Map();
  for (const entry of uncovered) {
    if (!byRequirement.has(entry.requirement_id)) byRequirement.set(entry.requirement_id, []);
    byRequirement.get(entry.requirement_id).push(entry);
  }

  for (const [requirementId, entries] of byRequirement) {
    warnings.push({
      code: GENERATION_WARNINGS.OBLIGATION_NOT_COVERED,
      requirement_id: requirementId,
      message:
        `${requirementId} states ${entries.length} testable behaviour(s) that no generated test case ` +
        `reaches: ${entries.map((entry) => `${entry.obligation_id} ${entry.statement}`).join(' | ')}. ` +
        `Each was derived from the requirement's own wording. Nothing was generated to cover them - ` +
        `write the case yourself, or confirm the source does not really require it.`,
    });
  }

  // A requirement no detector could read anything out of.
  //
  // This is the quietest way behaviour leaves the pipeline, and a real run
  // showed it: the structuring call gave the core banking response table its own
  // requirement, titled "Core Banking Response Mapping", holding both response
  // rules - and the PDF had wrapped every row across three lines, splitting each
  // value from its closing quote and putting the column headers below the data.
  // Not one obligation came out of it. Coverage over that requirement was
  // therefore neither met nor missed; it was empty, and the figures looked
  // perfect. Whether any test case exercised the table was left to chance.
  //
  // Nothing is inferred from the silence. Pattern matching that cannot read a
  // requirement may be facing background prose, and saying so is the honest
  // answer; what is not acceptable is saying nothing.
  //
  // A requirement the model already said it could not work from is exempt: the
  // model explained the silence, and repeating it as a second finding tells the
  // reviewer nothing and costs them a second look.
  const measured = new Set(matched.map((entry) => entry.requirement_id));
  const explained = new Set(
    (reported ?? [])
      .filter((warning) => warning.code === GENERATION_WARNINGS.INSUFFICIENT_INFORMATION)
      .map((warning) => warning.requirement_id)
      .filter(Boolean)
  );

  const unread = (requirements ?? []).filter(
    (requirement) =>
      !measured.has(requirement.requirement_id) && !explained.has(requirement.requirement_id)
  );

  for (const requirement of unread) {
    warnings.push({
      code: GENERATION_WARNINGS.OBLIGATION_NOT_DERIVED,
      requirement_id: requirement.requirement_id,
      message:
        `${requirement.requirement_id} ("${requirement.title}") yielded no behavioural obligation, ` +
        `so nothing was measured over it and its coverage figure is empty rather than complete. ` +
        `This happens when wording carries no behaviour a pattern can read - background prose, or a ` +
        `table the document layout broke apart. Read the requirement yourself and decide whether it ` +
        `states something testable that no test case above reaches.`,
    });
  }

  if (unmeasurable.length > 0) {
    warnings.push({
      code: GENERATION_WARNINGS.OBLIGATION_NOT_MEASURABLE,
      requirement_id: null,
      message:
        `${unmeasurable.length} behavioural obligation(s) state a quality the source never quantifies, ` +
        `so no test case can assert one and none was expected to: ` +
        `${unmeasurable.map((entry) => `${entry.obligation_id} (${entry.requirement_id})`).join(', ')}. ` +
        `They are excluded from the coverage figure rather than counted as misses. If a threshold ` +
        `exists, it belongs in the source document, not in the test script.`,
    });
  }

  return warnings;
}
