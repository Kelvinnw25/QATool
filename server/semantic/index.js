import { AppError, zodIssues } from '../lib/errors.js';
import { SEMANTIC_SEVERITIES } from '../schema/enums.js';
import { createProvider } from '../llm/provider.js';
import { runHeuristics } from './heuristics.js';
import { buildReviewPrompt, reviewInstruction } from './prompt.js';
import { RESPONSE_SCHEMA, semanticResponse } from './contract.js';
import { acceptTestPoints } from '../structure/test-points.js';
import {
  deriveCoverageObligations,
  matchObligations,
  reviewableGaps,
} from '../scenario/obligations.js';
import { classifyLlmError, recordTiming, setStage, trace } from '../lib/trace.js';

/**
 * Milestone 5: semantic validation.
 *
 *   generated test cases + requirements -> findings
 *
 * Two layers, one output shape:
 *
 *   heuristics  deterministic, free, always run. Catch mistakes with a
 *               recognisable shape and still stand when the model cannot run.
 *   LLM review  one call over the whole project, opt-in. Catches what needs
 *               reading comprehension: contradiction, unsupported behaviour,
 *               coverage that exists on paper but tests nothing.
 *
 * Findings only. Nothing here modifies, removes or reorders a test case, and
 * nothing here blocks export - deterministic validation remains the authority
 * on structure, and a semantic finding is something for QA to look at.
 *
 * A failed LLM review is reported, not thrown: the deterministic findings are
 * still returned, and the caller can retry the review without regenerating.
 */

/** Everything the Results page needs to explain what did and did not run. */
function status(overrides = {}) {
  return {
    heuristics: 'skipped',
    llm: 'not_requested',
    reason: null,
    error: null,
    provider: null,
    model: null,
    duration_ms: null,
    usage: null,
    discarded_issues: 0,
    ...overrides,
  };
}

const SEVERITY_RANK = Object.fromEntries(
  SEMANTIC_SEVERITIES.map((severity, index) => [severity, index])
);

function byUrgency(left, right) {
  return (
    SEVERITY_RANK[left.severity] - SEVERITY_RANK[right.severity] ||
    (left.testcase_id ?? '~').localeCompare(right.testcase_id ?? '~') ||
    (left.requirement_id ?? '~').localeCompare(right.requirement_id ?? '~') ||
    left.category.localeCompare(right.category)
  );
}

/** What a finding is about, so the two layers can recognise the same concern. */
function subjectKey(issue) {
  return issue.testcase_id
    ? `${issue.category}|tc:${issue.testcase_id}`
    : `${issue.category}|req:${issue.requirement_id}`;
}

/**
 * Keeps only findings anchored to something that exists.
 *
 * A finding about TC-099 in a project with twelve test cases is the reviewer's
 * own hallucination. It is dropped - it cannot be acted on - and counted, so the
 * Results page can say that it happened.
 */
function anchored(issues, canonical) {
  const caseIds = new Set(canonical.test_cases.map((testCase) => testCase.case_id));
  const requirementIds = new Set(canonical.requirements.map((req) => req.requirement_id));

  const kept = [];
  let discarded = 0;

  for (const issue of issues) {
    const hasAnchor = issue.testcase_id || issue.requirement_id;
    const knownCase = !issue.testcase_id || caseIds.has(issue.testcase_id);
    const knownRequirement = !issue.requirement_id || requirementIds.has(issue.requirement_id);

    if (hasAnchor && knownCase && knownRequirement) {
      kept.push({ ...issue, detected_by: ['llm'] });
    } else {
      discarded += 1;
    }
  }

  return { kept, discarded };
}

/**
 * Combines both layers. When they flag the same concern, the finding is kept
 * once and marked as found by both - agreement between a rule and a reader is
 * worth showing. The model's wording is kept, being written with the context,
 * and the more urgent of the two severities wins.
 */
function merge(heuristicIssues, llmIssues) {
  const merged = heuristicIssues.map((issue) => ({ ...issue }));
  const unmatched = new Map();
  for (const issue of merged) {
    const key = subjectKey(issue);
    if (!unmatched.has(key)) unmatched.set(key, []);
    unmatched.get(key).push(issue);
  }

  for (const issue of llmIssues) {
    const match = unmatched.get(subjectKey(issue))?.shift();
    if (!match) {
      merged.push(issue);
      continue;
    }
    match.explanation = issue.explanation;
    match.requirement_id ??= issue.requirement_id;
    match.detected_by = ['heuristic', 'llm'];
    if (SEVERITY_RANK[issue.severity] < SEVERITY_RANK[match.severity]) {
      match.severity = issue.severity;
    }
  }

  return merged.sort(byUrgency);
}

/**
 * @param {object} canonical
 * @param {object} [options]
 * @param {boolean} [options.useLlm]             run the model review as well
 * @param {boolean} [options.structurallyValid]  from deterministic validation
 * @param {import('../llm/provider.js').LLMProvider} [options.provider]  injected in tests
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<{issues: object[], status: object}>}
 */
export async function reviewSemantics(
  canonical,
  { useLlm = false, structurallyValid = true, provider, signal, testPoints = [] } = {}
) {
  const llmState = useLlm ? 'skipped' : 'not_requested';

  setStage('REVIEW');
  trace('review_started', {
    testcase_count: canonical.test_cases?.length ?? 0,
    structurally_valid: structurallyValid,
    llm_requested: useLlm,
  });

  if (!structurallyValid) {
    return {
      issues: [],
      status: status({
        llm: llmState,
        reason: 'Semantic checks run only on a structurally valid project.',
      }),
    };
  }

  if (canonical.test_cases.length === 0) {
    return {
      issues: [],
      status: status({ llm: llmState, reason: 'There are no test cases to review yet.' }),
    };
  }

  const heuristicIssues = runHeuristics(canonical);

  if (!useLlm) {
    return {
      issues: [...heuristicIssues].sort(byUrgency),
      status: status({ heuristics: 'completed' }),
    };
  }

  const startedAt = Date.now();
  let llm;

  try {
    llm = provider ?? (await createProvider());

    // Derived here, not asked for: the reviewer is handed the gaps the
    // deterministic matcher could not close, so its one call is spent on the
    // ones that need reading comprehension. Still exactly one call.
    const gaps = reviewableGaps(
      matchObligations(deriveCoverageObligations(canonical.requirements), canonical.test_cases)
    );

    const prompt = buildReviewPrompt(
      canonical,
      gaps,
      acceptTestPoints(testPoints, canonical.requirements)
    );

    trace('gemini_3_started', {
      call_number: 3,
      provider: llm.name,
      model: llm.model,
      testcase_count: canonical.test_cases.length,
      reviewable_gaps: gaps.length,
      prompt_chars: prompt.length,
    });

    const { data, usage } = await llm.generateJson({
      system: reviewInstruction(),
      prompt,
      schema: RESPONSE_SCHEMA,
      signal,
    });

    recordTiming('gemini3', Date.now() - startedAt);
    trace('gemini_3_completed', {
      call_number: 3,
      provider: llm.name,
      model: llm.model,
      duration_ms: Date.now() - startedAt,
      input_tokens: usage?.input_tokens ?? null,
      output_tokens: usage?.output_tokens ?? null,
      response_bytes: JSON.stringify(data ?? null).length,
    });

    const parsed = semanticResponse.safeParse(data);
    if (!parsed.success) {
      throw new AppError(
        'LLM_MALFORMED_OUTPUT',
        'The semantic review returned JSON in the wrong shape, so none of it was used.',
        502,
        zodIssues(parsed.error)
      );
    }

    const { kept, discarded } = anchored(parsed.data.issues, canonical);

    return {
      issues: merge(heuristicIssues, kept),
      status: status({
        heuristics: 'completed',
        llm: 'completed',
        provider: llm.name,
        model: llm.model,
        duration_ms: Date.now() - startedAt,
        usage,
        discarded_issues: discarded,
      }),
    };
  } catch (error) {
    // Only controlled failures are absorbed: provider errors, malformed output,
    // missing configuration. A programming error should fail loudly, not be
    // reported to the user as "the review did not run".
    if (!(error instanceof AppError)) throw error;

    // Cancelled, not failed: there is no one to report a failed review to.
    if (signal?.aborted) throw error;

    recordTiming('gemini3', Date.now() - startedAt);
    // fail_soft: the review is advisory, so a failure here costs findings, not
    // the run. /api/validate still returns 200 with the heuristic findings.
    trace('gemini_3_failed', {
      call_number: 3,
      provider: llm?.name ?? null,
      model: llm?.model ?? null,
      duration_ms: Date.now() - startedAt,
      error_category: classifyLlmError(error),
      error_class: error.constructor?.name ?? 'Error',
      error_code: error.code ?? null,
      error_message: error.message,
      fail_soft: true,
      fallback_used: false,
    });

    return {
      issues: [...heuristicIssues].sort(byUrgency),
      status: status({
        heuristics: 'completed',
        llm: 'failed',
        error: { code: error.code, message: error.message },
        provider: llm?.name ?? null,
        model: llm?.model ?? null,
        duration_ms: Date.now() - startedAt,
      }),
    };
  }
}
