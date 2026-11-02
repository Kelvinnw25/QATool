import { matchObligations } from '../scenario/obligations.js';
import { PLAN_STATUSES } from './contract.js';

/**
 * What the model SAID about obligation coverage, checked against what it WROTE.
 *
 * The obligation plan and each case's obligation_ids exist to make the model
 * account for every obligation while it drafts. They are never evidence. A model
 * that decides which obligations a case covers and then reports that it covered
 * them is grading its own homework, so coverage stays exactly where it was - the
 * deterministic matcher reading test_case and expected_result - and this module
 * only compares the two.
 *
 * Nothing here feeds coverage, changes a test case or decides what is kept. It
 * produces counts and named discrepancies for the generation report:
 *
 *   unverified claim     a case lists an obligation its own text does not state
 *   planned, not shown   the plan says "covered" and no case states it at all
 *   missing from plan    an obligation the plan never accounted for
 *   invented id          an id that was not in the prompt (the schema enum
 *                        prevents it; checked anyway, because a provider
 *                        guarantee is not ours)
 *
 * Read from the raw reply, before per-case parsing strips the fields the
 * canonical model has no place for. A case discarded later for being
 * structurally broken still made its claims; that is what is being audited.
 */

const text = (value) => (typeof value === 'string' ? value.trim() : '');

/** One plan entry, read tolerantly: a malformed entry is counted, not fatal. */
function readPlanEntry(raw) {
  if (raw === null || typeof raw !== 'object') return null;

  const obligationId = text(raw.obligation_id);
  if (!obligationId) return null;

  return {
    obligation_id: obligationId,
    status: PLAN_STATUSES.includes(raw.status) ? raw.status : 'unrecognised',
    targets: Array.isArray(raw.target_test_case_ids)
      ? raw.target_test_case_ids.map(text).filter(Boolean)
      : [],
  };
}

/** One drafted case, as the matcher needs it, with what it claims. */
function readDraft(raw, index) {
  const source = raw !== null && typeof raw === 'object' ? raw : {};

  return {
    draft_id: text(source.draft_id) || null,
    claimed: Array.isArray(source.obligation_ids)
      ? source.obligation_ids.map(text).filter(Boolean)
      : [],
    candidate: {
      // A position-based id, so evidence can be attributed to this draft even
      // when the model left draft_id out or repeated one.
      case_id: `DRAFT-${index + 1}`,
      test_case: text(source.test_case),
      expected_result: text(source.expected_result),
      case_type: text(source.case_type),
      edge_polarity: text(source.edge_polarity) || null,
      requirement_ids: Array.isArray(source.requirement_ids)
        ? source.requirement_ids.map(text).filter(Boolean)
        : [],
    },
  };
}

/**
 * @param {object} reply
 * @param {unknown[]} reply.plan          obligation_plan, raw
 * @param {unknown[]} reply.rawTestCases  test_cases, raw
 * @param {object[]} reply.obligations    the obligations the prompt listed
 */
export function auditObligationClaims({ plan = [], rawTestCases = [], obligations = [] } = {}) {
  const listed = new Set(obligations.map((obligation) => obligation.obligation_id));

  // --- The plan ---------------------------------------------------------------
  const planned = new Map();
  const duplicated = [];
  const invented = new Set();
  let malformed = 0;

  for (const raw of plan ?? []) {
    const entry = readPlanEntry(raw);
    if (!entry) {
      malformed += 1;
      continue;
    }
    if (!listed.has(entry.obligation_id)) {
      invented.add(entry.obligation_id);
      continue;
    }
    if (planned.has(entry.obligation_id)) {
      duplicated.push(entry.obligation_id);
      continue;
    }
    planned.set(entry.obligation_id, entry);
  }

  const missingFromPlan = [...listed].filter((id) => !planned.has(id));

  // --- The cases, and the evidence their own text carries ----------------------
  const drafts = (rawTestCases ?? []).map(readDraft);
  const draftIds = new Set(drafts.map((draft) => draft.draft_id).filter(Boolean));

  const matched = matchObligations(
    obligations,
    drafts.map((draft) => draft.candidate)
  );
  const evidencedBy = new Map(
    matched.map((obligation) => [obligation.obligation_id, new Set(obligation.case_ids)])
  );

  const claims = [];
  for (const draft of drafts) {
    for (const obligationId of new Set(draft.claimed)) {
      if (!listed.has(obligationId)) {
        invented.add(obligationId);
        continue;
      }
      claims.push({
        draft_id: draft.draft_id ?? draft.candidate.case_id,
        obligation_id: obligationId,
        evidenced: evidencedBy.get(obligationId)?.has(draft.candidate.case_id) ?? false,
      });
    }
  }

  const unverified = claims.filter((claim) => !claim.evidenced);

  const plannedCovered = [...planned.values()].filter((entry) => entry.status === 'covered');
  const plannedNotShown = plannedCovered
    .filter((entry) => (evidencedBy.get(entry.obligation_id)?.size ?? 0) === 0)
    .map((entry) => entry.obligation_id);
  const unknownTargets = [
    ...new Set(
      plannedCovered.flatMap((entry) => entry.targets).filter((target) => !draftIds.has(target))
    ),
  ];

  return {
    summary: {
      plan_present: (plan ?? []).length > 0,
      obligations_listed: listed.size,
      planned: planned.size,
      planned_covered: plannedCovered.length,
      planned_insufficient: [...planned.values()].filter(
        (entry) => entry.status === 'insufficient_information'
      ).length,
      missing_from_plan: missingFromPlan.length,
      duplicated_in_plan: duplicated.length,
      malformed_plan_entries: malformed,
      invented_ids: invented.size,
      claims: claims.length,
      claims_evidenced: claims.length - unverified.length,
      claims_unverified: unverified.length,
      planned_covered_not_shown: plannedNotShown.length,
      unknown_plan_targets: unknownTargets.length,
    },
    unverified_claims: unverified.map(({ draft_id, obligation_id }) => ({
      draft_id,
      obligation_id,
    })),
    missing_from_plan: missingFromPlan,
    planned_covered_not_shown: plannedNotShown,
    invented_ids: [...invented],
    insufficient_information: [...planned.values()]
      .filter((entry) => entry.status === 'insufficient_information')
      .map((entry) => entry.obligation_id),
  };
}
