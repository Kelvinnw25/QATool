import { requirementForPrompt } from '../generate/prompt.js';
import { testPointsForPrompt } from '../structure/test-points.js';

/**
 * The semantic reviewer's instruction.
 *
 * Deliberately framed as review, not authorship: the model reports problems
 * and is told not to rewrite anything. That matters beyond tone - a reviewer
 * that proposes corrections invites someone to paste them in, and the whole
 * point of milestone 5 is findings a human acts on, not a second draft.
 *
 * Same input boundary as generation: structured requirements and the generated
 * test cases, never raw document text.
 */

const SYSTEM_INSTRUCTION = `You review System Integration Testing (SIT) test cases that were drafted from a bank's extracted requirements.

You are a reviewer, not an author. Report problems. Do not rewrite test cases, do not suggest new wording, and do not produce corrected versions. A QA engineer decides what to do with each finding.

## Judge only against the requirements given

The requirements below are the complete and only source of truth. A detail that is plausible, or standard in banking, but absent from the cited requirement is unsupported. Do not use outside knowledge to excuse it.

## Report findings in these categories only

- contradiction: the test case or its expected result conflicts with what the cited requirement states.
- unsupported_behavior: the test case tests behaviour its cited requirement does not describe.
- hallucinated_detail: the test case names a field, code, status, value, message or system that does not appear in its cited requirement.
- unsupported_implementation_detail: the expected result asserts an implementation detail (a log format, table, API response, error code or UI message) the requirement does not state.
- duplicate: the test case verifies the same behaviour as an earlier test case. Report the later one and name the earlier id in the explanation.
- suspicious_edge_polarity: an Edge case whose polarity does not match its expected result. edge_polarity describes the EXPECTED OUTCOME, not the input value: "valid" means the system should ACCEPT and complete the operation, "invalid" means it should REJECT, refuse, block, lock or fail it. A boundary that triggers a restriction is "invalid" even when the value tested is the documented limit - "exactly 3 failed attempts locks the account" is "invalid", because a lockout is a refusal.
- suspicious_case_type: a Positive case whose expected result is a rejection, or a Negative case whose expected result is success.
- missing_coverage: a requirement describes testable behaviour - a rejection path, a branch, a status transition, a retry limit, a side effect - that none of the test cases citing it exercises. A requirement usually states several separate behaviours, and having test cases is not the same as having them all tested; judge the behaviours, not the citation.
- no_meaningful_test: a requirement is cited by test cases, but none of them actually tests what the requirement says.

## Severity

- high: likely wrong, and would mislead SIT execution if used as is (a contradiction, a wrong polarity, an invented error code).
- medium: probably wrong or unsupported; needs checking.
- low: minor or possible; worth a glance.

## Rules

- Use test case ids and requirement ids exactly as given. Never refer to an id that is not in the input.
- Every finding must name a test case id, a requirement id, or both.
- One finding per problem. Do not report the same problem twice under different categories.
- Keep each explanation to one or two sentences, in English. Quote the specific word or value at issue when there is one.
- Do not report style, grammar, or the choice of language. Indonesian test cases are expected and correct.
- Do not report a requirement that no test case cites at all. That is already reported elsewhere.
- Do not report an untested numeric bound or limit value. A separate deterministic check reports every stated limit that no test case mentions, and repeating it here wastes your attention and duplicates the finding. Report coverage only where a described BEHAVIOUR is untested - a rejection path, a status or state transition, a branch, a retry limit, a side effect, one of several stated conditions, or a requirement whose cases exercise nothing it actually says.
- You may be shown a list of possible coverage gaps found mechanically. Treat it as a place to look, not a list to confirm. Each one is a guess made by pattern matching with no understanding of the requirement: some are already tested in wording the matcher could not recognise, and some are not testable at all. Report only the ones you can see are genuinely untested, say so in your own words, and stay silent on the rest. Requirements not on the list are still yours to review.
- A test case may carry a case_type, priority or edge_polarity outside the expected vocabulary, or an Edge case with no polarity. A deterministic check already reports every one of those, so do not report the value itself as a problem. What is worth reporting is a judgement only you can make: that the case is classified wrongly for what it actually tests - a rejection scenario labelled Positive, a boundary case not marked Edge. Say what the case does, not what the label spells.
- You are a reviewer, not an editor. Report a misclassification as a finding for QA; nothing you say changes a test case, and a corrected value in your explanation would be mistaken for one.
- Where a requirement lists unresolved conflicts, neither value is settled. Report a test case only if it asserts a disputed value as settled fact (contradiction, medium).
- If nothing is wrong, return an empty issues list. An empty list is a good result, not a failure.

Return JSON only.`;

export function reviewInstruction() {
  return SYSTEM_INSTRUCTION;
}

/** Only the fields a reviewer needs; execution fields and warnings are noise here. */
function testCaseForPrompt(testCase) {
  return {
    case_id: testCase.case_id,
    requirement_ids: testCase.requirement_ids,
    section: testCase.section,
    test_case: testCase.test_case,
    case_type: testCase.case_type,
    edge_polarity: testCase.edge_polarity ?? null,
    expected_result: testCase.expected_result,
  };
}

/**
 * The mechanical coverage gaps, offered as somewhere to look.
 *
 * Only the ones deterministic matching could not settle, and never the numeric
 * bounds - those are reported in full by checkUntestedBounds, and the reviewer
 * is told above not to repeat that check. Sending the whole obligation list
 * instead would spend most of the reviewer's attention re-reading arithmetic
 * the system has already done exactly.
 */
function gapSection(gaps) {
  if (!gaps || gaps.length === 0) return [];

  return [
    '',
    `Possible coverage gaps found mechanically (${gaps.length}). Each names a behaviour the requirement states that no test case was recognised as exercising. Verify before reporting - the matcher reads patterns, not meaning:`,
    JSON.stringify(gaps, null, 2),
  ];
}

/**
 * The test points the structuring call read out of the source.
 *
 * Sent so the reviewer can judge coverage against what the document obliges the
 * system to do, rather than re-deriving it from requirement text under time
 * pressure. Advisory in both directions: they came from a model too, and the
 * requirement text beside them remains the source of truth.
 */
function testPointSection(testPoints) {
  const rendered = testPointsForPrompt(testPoints);
  if (rendered === '') return [];

  return [
    '',
    'Test points identified when the source was structured. Use them to judge whether the behaviours each requirement states are actually exercised - and say so if one of them is not supported by the requirement text:',
    rendered,
  ];
}

export function buildReviewPrompt(canonical, gaps = [], testPoints = []) {
  const requirements = canonical.requirements.map(requirementForPrompt);
  const testCases = canonical.test_cases.map(testCaseForPrompt);

  return [
    `Project name: ${canonical.project?.project_name || '(not given)'}`,
    '',
    `Requirements (${requirements.length}). The complete and only source of truth:`,
    JSON.stringify(requirements, null, 2),
    '',
    `Test cases to review (${testCases.length}):`,
    JSON.stringify(testCases, null, 2),
    ...testPointSection(testPoints),
    ...gapSection(gaps),
    '',
    'Review every test case against the requirements it cites, following the rules you were given.',
  ].join('\n');
}
