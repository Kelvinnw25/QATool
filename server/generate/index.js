import { z } from 'zod';

import { AppError, zodIssues } from '../lib/errors.js';
import { projectSchema } from '../schema/project.js';
import { requirementSchema } from '../schema/requirement.js';
import { testCaseSchema } from '../schema/testcase.js';
import { createProvider } from '../llm/provider.js';
import { buildPrompt, systemInstruction } from './prompt.js';
import { llmResponse, parseTestCases, responseSchemaFor } from './contract.js';
import { auditObligationClaims } from './claims.js';
import {
  assembleTestCases,
  GENERATION_WARNINGS,
  renumber,
  reportObligationGaps,
  reportUncovered,
} from './assemble.js';
import { classificationFindings } from '../schema/classification.js';
import { acceptTestPoints } from '../structure/test-points.js';
import { deriveChecklist } from '../scenario/checklist.js';
import {
  deriveCoverageObligations,
  matchObligations,
  promptedObligations,
} from '../scenario/obligations.js';
import { withMeasurability } from '../scenario/measurability.js';
import { classifyLlmError, recordFacts, recordTiming, setStage, trace } from '../lib/trace.js';

/**
 * Milestone 4: requirements in, canonical outputs out.
 *
 *   requirements -> prompt -> provider -> contract parse -> assemble -> schema
 *
 * The LLM sits in the middle of that line and is trusted at exactly one point:
 * it proposes content. Both sides of it are deterministic. The prompt is built
 * only from structured requirements, and the reply is parsed against a
 * contract, rebuilt by application code and then validated against the same
 * canonical schemas everything else in QATOOL must satisfy.
 *
 * Nothing is repaired on the way through. If the result does not validate, the
 * generation fails and says why - the browser still holds the extracted
 * requirements, so retrying costs one call and no re-upload.
 */

/** Guard against a prompt too large to be answered in one response. */
const MAX_REQUIREMENTS = 200;

export const GENERATION_ERRORS = {
  NO_REQUIREMENTS: 'NO_REQUIREMENTS',
  INVALID_REQUIREMENTS: 'INVALID_REQUIREMENTS',
  TOO_MANY_REQUIREMENTS: 'TOO_MANY_REQUIREMENTS',
  MALFORMED_OUTPUT: 'LLM_MALFORMED_OUTPUT',
  INVALID: 'GENERATION_INVALID',
  EMPTY: 'GENERATION_EMPTY',
};

/**
 * Checks the input before a single token is spent on it.
 *
 * The canonical object is posted in by the browser, so it is untrusted like any
 * other request body. Validating it here means a malformed requirement is a
 * controlled 400 rather than a TypeError somewhere inside prompt building - and
 * it means everything downstream can read nested fields without guarding each
 * one.
 */
export function requireGeneratableInput(canonical) {
  const requirements = canonical?.requirements ?? [];

  if (requirements.length === 0) {
    throw new AppError(
      GENERATION_ERRORS.NO_REQUIREMENTS,
      'There are no requirements to generate from. Upload and extract documents first.',
      422
    );
  }

  if (requirements.length > MAX_REQUIREMENTS) {
    throw new AppError(
      GENERATION_ERRORS.TOO_MANY_REQUIREMENTS,
      `This project has ${requirements.length} requirements; generation handles up to ${MAX_REQUIREMENTS} in one pass.`,
      422
    );
  }

  const parsed = z.array(requirementSchema).safeParse(requirements);
  if (!parsed.success) {
    throw new AppError(
      GENERATION_ERRORS.INVALID_REQUIREMENTS,
      'The requirements posted for generation are not valid. Re-run extraction rather than editing them by hand.',
      400,
      zodIssues(parsed.error)
    );
  }

  return parsed.data;
}

/**
 * Validates the assembled output against the canonical schemas.
 *
 * Deliberately after assembly rather than instead of the contract parse: the
 * contract decides whether the reply is usable at all, this decides whether
 * what we built from it is a legal canonical project. It is also where the
 * cross-field rules bite - Edge without a polarity, a polarity on a
 * non-Edge case, an empty expected result, a one-sentence description that
 * turned out to be three.
 */
function validateAssembled(project, testCases) {
  // The project outputs are one indivisible thing - a description, a summary, a
  // scope - so there is nothing to salvage from a malformed one, and it stays
  // fatal.
  const parsedProject = projectSchema.safeParse(project);
  if (!parsedProject.success) {
    throw new AppError(
      GENERATION_ERRORS.INVALID,
      'The model returned project content that does not satisfy the canonical model, so it was rejected rather than repaired. Retry generation - your extracted requirements are kept.',
      502,
      zodIssues(parsedProject.error).map((issue) => ({ ...issue, path: `project.${issue.path}` }))
    );
  }

  // Test cases are judged one at a time, and only on whether they can be
  // carried safely: identifier, action, expected result, traceability, sizes.
  // A case that fails that is dropped, never mended - nothing here supplies a
  // missing field, because a case that quietly becomes something else is worse
  // than a case that is visibly gone.
  //
  // What this no longer judges is how well the case is classified. An
  // unrecognised case_type or priority, an Edge case with no polarity, a
  // polarity on a Positive case: all of those survive this gate and are
  // reported as warnings further down, because a reviewer can act on a flagged
  // draft and cannot act on a deleted one.
  const kept = [];
  const discarded = [];

  testCases.forEach((testCase, index) => {
    const parsed = testCaseSchema.safeParse(testCase);

    if (parsed.success) {
      kept.push(parsed.data);
      return;
    }

    discarded.push({
      position: index + 1,
      testCase,
      issues: zodIssues(parsed.error),
    });
  });

  return { project: parsedProject.data, testCases: kept, discarded };
}

/**
 * Describes a discarded case so a reviewer can tell what was lost.
 *
 * Identified by its position in the model's reply rather than by its case id:
 * the survivors are renumbered afterwards, so the id it briefly held will
 * belong to a different case by the time anyone reads this.
 */
function describeDiscarded({ position, testCase, issues }, total) {
  const reasons = issues
    .map((issue) => `${issue.path ? `${issue.path}: ` : ''}${issue.message}`)
    .join('; ');

  return {
    code: GENERATION_WARNINGS.INVALID_TEST_CASE_DISCARDED,
    message:
      `Generated test case ${position} of ${total} did not satisfy the canonical model and was discarded rather than repaired. ` +
      `It was a ${testCase.case_type} case with edge_polarity ${testCase.edge_polarity === null ? 'null' : `'${testCase.edge_polarity}'`}. ` +
      `Reason - ${reasons}. Action: "${testCase.test_case}".`,
    requirement_id: null,
  };
}

/**
 * Describes a case that could not be read as a test case at all.
 *
 * Separate from describeDiscarded below, which reports a case that parsed but
 * failed the canonical model. Both name a position rather than an id, for the
 * same reason: ids are assigned to survivors afterwards, so any id quoted here
 * would belong to a different test by the time QA reads it.
 */
function describeUnprocessable({ position, testCase, issues }, total) {
  const reasons = issues
    .map((issue) => `${issue.path ? `${issue.path}: ` : ''}${issue.message}`)
    .join('; ');

  const action = typeof testCase?.test_case === 'string' ? testCase.test_case : null;

  return {
    code: GENERATION_WARNINGS.INVALID_TEST_CASE_DISCARDED,
    message:
      `Generated test case ${position} of ${total} could not be read as a test case and was discarded rather than repaired. ` +
      `Reason - ${reasons}.${action ? ` Action: "${action}".` : ' It carried no readable action.'}`,
    requirement_id: null,
  };
}

/**
 * Attaches classification findings to the cases they are about.
 *
 * Deliberately after renumbering. A warning naming TC-004 has to mean the
 * TC-004 a reviewer will actually see, and ids are reassigned when a case is
 * discarded - flagging before that would hand QA a reference to a row that has
 * since become a different test. Per-case findings are attached to the case
 * itself and name the field rather than the id, which cannot go stale at all.
 *
 * @returns {object[]} the cases that need a classification decision
 */
function flagClassifications(testCases) {
  const flagged = [];

  for (const testCase of testCases) {
    const findings = classificationFindings(testCase);
    if (findings.length === 0) continue;

    testCase.warnings.push(...findings);
    flagged.push(testCase);
  }

  return flagged;
}

/** One line telling QA how many drafts need a classification decision, and which. */
function describeFlagged(flagged) {
  const listed = flagged
    .slice(0, 8)
    .map((testCase) => {
      const fields = [...new Set(testCase.warnings.map((entry) => entry.field).filter(Boolean))];
      return `${testCase.case_id} (${fields.join(', ')})`;
    })
    .join('; ');
  const rest = flagged.length - 8;

  return {
    code: GENERATION_WARNINGS.CLASSIFICATION_REVIEW_REQUIRED,
    message:
      `${flagged.length} test case${flagged.length === 1 ? '' : 's'} used a classification value outside the recommended vocabulary ` +
      `and ${flagged.length === 1 ? 'was' : 'were'} kept as drafted for QA to decide: ${listed}${rest > 0 ? ` and ${rest} more` : ''}. ` +
      `Nothing was converted or removed. Export refuses any value the office template cannot represent.`,
    requirement_id: null,
  };
}

/**
 * @param {object} canonical            the project held in the browser
 * @param {object} [options]
 * @param {import('../llm/provider.js').LLMProvider} [options.provider]  injected in tests
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<{project: object, test_cases: object[], warnings: object[], metadata: object}>}
 */
export async function generateFromRequirements(
  canonical,
  { provider, signal, testPoints = [] } = {}
) {
  setStage('GENERATE');
  trace('generation_started', {
    requirement_count: canonical?.requirements?.length ?? 0,
    test_point_count: Array.isArray(testPoints) ? testPoints.length : 0,
  });

  const requirements = requireGeneratableInput(canonical);

  // Guidance from Gemini #1, posted back by the browser. Validated and pinned
  // to real requirements before it reaches a prompt; it never touches ids,
  // source references or coverage arithmetic.
  const points = acceptTestPoints(testPoints, requirements);

  // Derived here rather than posted in: the canonical object arrives from the
  // browser and is untrusted, so a checklist travelling with it could be
  // tampered with, and it would have to be added to a strict schema to make the
  // trip. Deriving it server-side from requirements that have just passed the
  // gate costs microseconds and keeps it out of the canonical model entirely.
  const checklist = deriveChecklist(requirements);

  // The same bargain one level deeper: what each requirement separately
  // obliges the system to do, so the model is told what coverage will be
  // measured against before it drafts, not after.
  const truncated = [];
  const obligations = deriveCoverageObligations(requirements, {
    onTruncate: (report) => truncated.push(report),
  });

  const llm = provider ?? (await createProvider());

  const startedAt = Date.now();
  const prompt = buildPrompt({ ...canonical, requirements }, checklist, obligations, points);
  const prompted = promptedObligations(obligations);

  trace('gemini_2_started', {
    call_number: 2,
    provider: llm.name,
    model: llm.model,
    requirement_count: requirements.length,
    checklist_entries: checklist.length,
    obligation_count: obligations.length,
    test_point_count: points.length,
    prompt_chars: prompt.length,
  });

  let data;
  let usage;
  try {
    // Traced, then rethrown untouched. The catch exists only so a failure is
    // classified before it leaves - nothing about the control flow changes.
    ({ data, usage } = await llm.generateJson({
      system: systemInstruction(),
      prompt,
      // Built per call: the plan's id enum is exactly the obligations this
      // prompt lists, so the model cannot account for one it was never shown.
      schema: responseSchemaFor(prompted.map((obligation) => obligation.obligation_id)),
      signal,
    }));
  } catch (error) {
    recordTiming('gemini2', Date.now() - startedAt);
    trace('gemini_2_failed', {
      call_number: 2,
      provider: llm.name,
      model: llm.model,
      duration_ms: Date.now() - startedAt,
      error_category: classifyLlmError(error),
      error_class: error?.constructor?.name ?? 'Error',
      error_code: error?.code ?? null,
      error_message: error?.message,
      fail_soft: false,
      fallback_used: false,
    });
    throw error;
  }

  recordTiming('gemini2', Date.now() - startedAt);
  trace('gemini_2_completed', {
    call_number: 2,
    provider: llm.name,
    model: llm.model,
    duration_ms: Date.now() - startedAt,
    input_tokens: usage?.input_tokens ?? null,
    output_tokens: usage?.output_tokens ?? null,
    response_bytes: JSON.stringify(data ?? null).length,
  });

  const parsed = llmResponse.safeParse(data);
  if (!parsed.success) {
    throw new AppError(
      GENERATION_ERRORS.MALFORMED_OUTPUT,
      'The model returned JSON that does not match the agreed structure. Retry generation - your extracted requirements are kept.',
      502,
      zodIssues(parsed.error)
    );
  }

  // What the model said about obligation coverage, against what it wrote. Read
  // from the raw reply because per-case parsing strips draft_id and
  // obligation_ids - they are working, not part of a test case. Nothing below
  // reads this for coverage: that is computed from the survivors' text alone.
  const claims = auditObligationClaims({
    plan: parsed.data.obligation_plan,
    rawTestCases: parsed.data.test_cases,
    obligations: prompted,
  });

  // Structural safety, one case at a time. A case missing an action or an
  // expected result cannot be processed and is discarded whole; the rest of the
  // batch, and the project outputs, are unaffected.
  const proposed = parseTestCases(parsed.data.test_cases);

  const { testCases, warnings, stats } = assembleTestCases(
    { ...parsed.data, test_cases: proposed.kept },
    requirements
  );

  for (const entry of proposed.discarded) {
    warnings.push(describeUnprocessable(entry, parsed.data.test_cases.length));
  }

  if (testCases.length === 0) {
    throw new AppError(
      GENERATION_ERRORS.EMPTY,
      'The model produced no usable test cases from these requirements. Check the extraction report: the requirements may be too thin to test from.',
      422,
      warnings
    );
  }

  // project_name is the user's, never the model's - it names the export file
  // and nothing about it is a drafting question.
  const validated = validateAssembled(
    { ...parsed.data.project, project_name: canonical.project?.project_name ?? '' },
    testCases
  );

  for (const entry of validated.discarded) {
    warnings.push(describeDiscarded(entry, testCases.length));
  }

  // Renumbered after the discards, so the run is TC-001..TC-nnn with no gap
  // where a rejected case used to be.
  const survivors = renumber(validated.testCases);

  if (survivors.length === 0) {
    throw new AppError(
      GENERATION_ERRORS.EMPTY,
      'Every generated test case failed canonical validation and was discarded, so there is nothing usable to review. Retry generation - your extracted requirements are kept.',
      422,
      warnings
    );
  }

  // Soft validation, once the ids are final. Flagged cases stay in the batch,
  // stay in coverage and stay exportable unless the workbook genuinely cannot
  // represent them - the warning is for QA, not a quarantine.
  const flagged = flagClassifications(survivors);
  if (flagged.length > 0) warnings.push(describeFlagged(flagged));

  // Coverage is reported against what survived, not against what the model
  // sent: a requirement whose only test case was discarded is uncovered, and
  // saying otherwise would hide the loss.
  warnings.push(...reportUncovered(requirements, survivors, warnings));

  // Measured over the survivors for the same reason coverage is: this is what
  // the run actually produced, not what it was asked for. Reported only -
  // nothing here regenerates, pads or retries to raise the number.
  const obligationCoverage = withMeasurability(matchObligations(obligations, survivors));

  // The gap, named. Coverage was a fraction in metadata and nothing else, so a
  // behaviour one run instantiated and the next reinterpreted away left no
  // trace a reviewer could act on. Split by whether the source said enough to
  // test it, so a permanent limitation never hides a real miss.
  warnings.push(...reportObligationGaps(obligationCoverage, requirements, warnings));
  warnings.push(...reportClaims(claims));

  for (const report of truncated) {
    warnings.push({
      code: GENERATION_WARNINGS.OBLIGATIONS_TRUNCATED,
      requirement_id: report.requirement_id,
      message:
        `${report.requirement_id} states more separate behaviours than one requirement carries in ` +
        `coverage, so ${report.dropped} of them were not measured and are missing from the figures ` +
        `below. This usually means several requirements were grouped into one - check it in the ` +
        `extraction report before trusting its coverage.`,
    });
  }

  trace('testcase_validation_completed', {
    proposed: parsed.data.test_cases.length,
    kept: survivors.length,
    discarded: validated.discarded.length + proposed.discarded.length,
    duplicates_removed: stats.duplicates_removed,
    flagged_for_review: flagged.length,
    warning_count: warnings.length,
  });
  trace('coverage_completed', {
    obligations_total: obligationCoverage.length,
    obligations_covered: obligationCoverage.filter((obligation) => obligation.covered).length,
    obligations_uncovered: obligationCoverage.filter(
      (obligation) => !obligation.covered && obligation.measurable
    ).length,
    obligations_not_measurable: obligationCoverage.filter((obligation) => !obligation.measurable)
      .length,
    requirements_covered: new Set(survivors.flatMap((testCase) => testCase.requirement_ids)).size,
  });
  trace('obligation_claims_audited', claims.summary);
  recordFacts({ testcases: survivors.length });

  return {
    project: validated.project,
    test_cases: survivors,
    warnings,
    metadata: {
      provider: llm.name,
      model: llm.model,
      requirement_count: requirements.length,
      checklist_entries: checklist.length,
      test_points_used: points.length,
      obligations_total: obligationCoverage.length,
      obligations_covered: obligationCoverage.filter((obligation) => obligation.covered).length,
      obligations_measurable: obligationCoverage.filter((obligation) => obligation.measurable)
        .length,
      obligations_not_measurable: obligationCoverage.filter((obligation) => !obligation.measurable)
        .length,
      obligations_uncovered: obligationCoverage.filter(
        (obligation) => !obligation.covered && obligation.measurable
      ).length,
      obligations_truncated: truncated.reduce((sum, report) => sum + report.dropped, 0),
      test_case_count: survivors.length,
      duration_ms: Date.now() - startedAt,
      usage,
      ...stats,
      // Recomputed over the survivors: the assembly figures were taken before
      // canonical validation had a say.
      kept: survivors.length,
      discarded_invalid: validated.discarded.length + proposed.discarded.length,
      flagged_for_review: flagged.length,
      requirements_covered: new Set(survivors.flatMap((testCase) => testCase.requirement_ids)).size,
      // The model's own account, audited. Never a coverage figure: the
      // obligations_* counts above are the only ones computed from evidence.
      obligation_claims: claims.summary,
    },
  };
}

/** How many ids one warning names before it summarises the rest. */
const MAX_NAMED_CLAIMS = 12;

const named = (items) =>
  items.length > MAX_NAMED_CLAIMS
    ? `${items.slice(0, MAX_NAMED_CLAIMS).join(', ')} and ${items.length - MAX_NAMED_CLAIMS} more`
    : items.join(', ');

/**
 * The claim audit, as at most two warnings.
 *
 * Kept short on purpose. The coverage warnings already say which behaviours no
 * case states; these say where the model's account disagreed with its own text,
 * which is a different and rarer finding - a case labelled as covering a guard
 * it never states is exactly the thing a reviewer should not trust.
 *
 * A reply with no plan at all says nothing here: the schema requires one, so its
 * absence means an offline provider, and the metadata already records it.
 */
function reportClaims(claims) {
  const reported = [];

  if (claims.unverified_claims.length > 0) {
    const pairs = claims.unverified_claims.map(
      (claim) => `${claim.obligation_id} (${claim.draft_id})`
    );
    reported.push({
      code: GENERATION_WARNINGS.OBLIGATION_CLAIM_UNVERIFIED,
      requirement_id: null,
      message:
        `${claims.unverified_claims.length} obligation claim(s) are not supported by the text of the ` +
        `case making them: ${named(pairs)}. A claim never counts as coverage - only a case whose ` +
        `test case or expected result states the behaviour does.`,
    });
  }

  if (claims.summary.plan_present && claims.missing_from_plan.length > 0) {
    reported.push({
      code: GENERATION_WARNINGS.OBLIGATION_PLAN_INCOMPLETE,
      requirement_id: null,
      message:
        `The generation plan did not account for ${claims.missing_from_plan.length} listed ` +
        `obligation(s): ${named(claims.missing_from_plan)}.`,
    });
  }

  return reported;
}
