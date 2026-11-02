import { buildDocx } from '../../extract/fixtures/build.js';

/**
 * One synthetic PRD and a scripted "model" that answers QATOOL's three calls for
 * it the way a careful model would, deterministically.
 *
 * scripted-replies.js answers any document with placeholder text, which proves
 * the plumbing. This proves the pipeline: requirements are grouped and given
 * handles, rules are separated from background, test points are named, test
 * cases state specific outcomes, every obligation is accounted for, and the
 * reviewer raises a finding anchored to a real test case.
 *
 * The reader works from the prompt it is given, as a model must - block ids from
 * the blocks, requirement ids and obligation ids from the requirement and
 * obligation lists - so a change to what QATOOL sends changes the answer, and a
 * prompt that stopped carrying something it needs would fail loudly here.
 *
 * Invented for tests. Nothing in it is, or resembles, a real bank document.
 */

export const REFUND_PRD = [
  { heading: 'Refund Request Service', level: 1 },
  { text: 'This document describes how customers request refunds for settled payments.' },
  { heading: 'Business Rules', level: 2 },
  {
    text: 'A refund request for a payment with status SETTLED must be accepted and given status PENDING_REVIEW.',
  },
  {
    text: 'A refund amount greater than the settled amount must be rejected with error code RFD-101.',
  },
  {
    text: 'A refund request for a payment older than 90 days must be rejected with error code RFD-204.',
  },
  { text: 'The customer must receive a notification within 5 minutes after a refund is approved.' },
];

export function refundUpload() {
  const form = new FormData();
  form.append('documents', new Blob([buildDocx(REFUND_PRD)]), 'PRD Refund Service.docx');
  return form;
}

/** What the scenario is expected to produce, for assertions that name their numbers. */
export const EXPECTED = {
  requirementCount: 4,
  supportingBlockCount: 3,
  titles: [
    'Accept refund for a settled payment',
    'Reject refund above the settled amount',
    'Reject refund after 90 days',
    'Notify customer after approval',
  ],
  testCaseCount: 7,
  errorCodes: ['RFD-101', 'RFD-204'],
  edgeCaseCount: 2,
};

/** The facts the scripted reader knows about each rule, keyed by what it says. */
const RULES = [
  {
    matches: /status SETTLED/,
    title: 'Accept refund for a settled payment',
    testPoints: [
      {
        type: 'transition',
        statement: 'A SETTLED payment moves to PENDING_REVIEW on refund request',
      },
    ],
    cases: () => [
      {
        section: 'Refund Eligibility',
        test_case: 'Verify a refund request for a SETTLED payment is accepted.',
        type: 'Functional',
        case_type: 'Positive',
        priority: 'High',
        expected_result: 'The refund request is accepted and its status is PENDING_REVIEW.',
        confidence: 'High',
      },
    ],
  },
  {
    matches: /greater than the settled amount/,
    title: 'Reject refund above the settled amount',
    testPoints: [
      { type: 'bound', statement: 'A refund amount above the settled amount is rejected' },
      { type: 'mapping', statement: 'Error code RFD-101 is returned for that rejection' },
    ],
    cases: () => [
      {
        section: 'Refund Amount',
        test_case: 'Verify a refund amount greater than the settled amount is rejected.',
        type: 'Functional',
        case_type: 'Negative',
        priority: 'High',
        expected_result: 'The refund request is rejected with error code RFD-101.',
        confidence: 'High',
      },
      {
        section: 'Refund Amount',
        test_case: 'Verify a refund amount equal to the settled amount is accepted.',
        type: 'Functional',
        case_type: 'Edge',
        edge_polarity: 'valid',
        priority: 'Medium',
        expected_result: 'The refund request is accepted at the full settled amount.',
        confidence: 'Medium',
      },
    ],
  },
  {
    matches: /older than 90 days/,
    title: 'Reject refund after 90 days',
    testPoints: [
      { type: 'bound', statement: 'A payment older than 90 days is rejected' },
      { type: 'mapping', statement: 'Error code RFD-204 is returned for that rejection' },
    ],
    cases: () => [
      {
        section: 'Refund Window',
        test_case: 'Verify a refund request for a payment older than 90 days is rejected.',
        type: 'Functional',
        case_type: 'Negative',
        priority: 'High',
        expected_result: 'The refund request is rejected with error code RFD-204.',
        confidence: 'High',
      },
      {
        section: 'Refund Window',
        test_case: 'Verify a refund request for a payment exactly 90 days old is accepted.',
        type: 'Functional',
        case_type: 'Edge',
        edge_polarity: 'valid',
        priority: 'Medium',
        expected_result: 'The refund request is accepted for a payment exactly 90 days old.',
        confidence: 'Medium',
      },
    ],
  },
  {
    matches: /notification within 5 minutes/,
    title: 'Notify customer after approval',
    testPoints: [
      { type: 'schedule', statement: 'A notification is sent within 5 minutes of approval' },
    ],
    ambiguous: true,
    cases: () => [
      {
        section: 'Customer Notification',
        test_case:
          'Verify the customer receives a notification within 5 minutes after a refund is approved.',
        type: 'Functional',
        case_type: 'Positive',
        priority: 'Medium',
        expected_result:
          'A notification reaches the customer no later than 5 minutes after approval.',
        confidence: 'Medium',
      },
      {
        section: 'Customer Notification',
        test_case: 'Verify no notification is sent while the refund has not been approved.',
        type: 'Functional',
        case_type: 'Negative',
        priority: 'Low',
        expected_result: 'The customer receives no refund notification before approval.',
        confidence: 'Low',
      },
    ],
  },
];

function ruleFor(text) {
  const rule = RULES.find((candidate) => candidate.matches.test(text));
  if (!rule) throw new Error(`The scripted reader has no rule for: ${text}`);
  return rule;
}

/** The JSON array that follows a heading line in a prompt, found by bracket depth. */
function arrayAfter(prompt, heading) {
  const from = prompt.indexOf(heading);
  if (from < 0) throw new Error(`Prompt has no "${heading}" section.`);
  const start = prompt.indexOf('[', from);

  let depth = 0;
  for (let index = start; index < prompt.length; index += 1) {
    if (prompt[index] === '[') depth += 1;
    if (prompt[index] === ']' && --depth === 0) {
      return JSON.parse(prompt.slice(start, index + 1));
    }
  }
  throw new Error(`Prompt section "${heading}" is not a complete array.`);
}

function structuringReply({ prompt }) {
  const blocks = arrayAfter(prompt, 'Extracted blocks');
  const requirements = [];
  const supporting = [];

  for (const block of blocks) {
    if (block.kind === 'heading') {
      supporting.push({ block, role: 'background', reason: 'section heading' });
    } else if (/\bmust\b/.test(block.text)) {
      const rule = ruleFor(block.text);
      requirements.push({
        title: rule.title,
        source_block_ids: [block.source_block_id],
        test_points: rule.testPoints,
        ambiguous: rule.ambiguous ?? false,
        conflicted: false,
        fragmented: false,
      });
    } else {
      supporting.push({ block, role: 'background', reason: 'introductory prose' });
    }
  }

  return {
    requirements,
    supporting_blocks: supporting.map(({ block, role, reason }) => ({
      source_block_ids: [block.source_block_id],
      role,
      reason,
    })),
  };
}

/** Obligation ids with the requirement each is listed under, from the prompt text. */
function obligationsByRequirement(prompt) {
  const byRequirement = new Map();
  let current = null;

  for (const line of prompt.split('\n')) {
    const header = /^(REQ-\d+):$/.exec(line);
    if (header) current = header[1];
    const obligation = /^\s+- \[(OB-\d+)\]/.exec(line);
    if (obligation && current) {
      byRequirement.set(current, [...(byRequirement.get(current) ?? []), obligation[1]]);
    }
  }
  return byRequirement;
}

function generationReply({ prompt, schema }) {
  const requirements = arrayAfter(prompt, 'Extracted requirements');
  const obligations = obligationsByRequirement(prompt);

  const cases = [];
  const planTargets = new Map();

  for (const requirement of requirements) {
    const drafts = ruleFor(requirement.description).cases();

    drafts.forEach((draft, index) => {
      const draftId = `T${cases.length + 1}`;
      // The first case is the one that states the requirement's own obligations.
      const stated = index === 0 ? (obligations.get(requirement.requirement_id) ?? []) : [];
      for (const obligationId of stated) planTargets.set(obligationId, [draftId]);

      cases.push({
        draft_id: draftId,
        obligation_ids: stated,
        requirement_ids: [requirement.requirement_id],
        ...draft,
        warnings: [],
      });
    });
  }

  const planIds = schema.properties.obligation_plan.items.properties.obligation_id.enum;

  return {
    project: {
      project_description:
        'A refund service that lets customers request refunds for settled payments within a 90-day window.',
      project_summary:
        'Customers request a refund against a settled payment. The service accepts eligible requests for review, rejects those above the settled amount or older than 90 days with specific error codes, and notifies the customer after approval.',
      qa_guidance:
        'Focus SIT on the three rejection and acceptance rules and their boundaries, and on the 5-minute notification. The notification channel is not specified in the source.',
      sit_scope: [
        'Refund Eligibility: Validating that a SETTLED payment is accepted into PENDING_REVIEW.',
        'Refund Limits: Validating rejection above the settled amount (RFD-101) and after 90 days (RFD-204).',
        'Customer Notification: Validating the notification sent within 5 minutes of approval.',
      ],
      project_background:
        'The refund service handles customer requests against settled payments. The rules covered here are eligibility, amount and age limits, and the approval notification.',
    },
    obligation_plan: planIds.map((obligationId) => ({
      obligation_id: obligationId,
      status: 'covered',
      target_test_case_ids: planTargets.get(obligationId) ?? [],
    })),
    test_cases: cases,
    warnings: [],
  };
}

function reviewReply({ prompt }) {
  const testCases = arrayAfter(prompt, 'Test cases to review');
  const inferred = testCases.find((testCase) =>
    /equal to the settled amount/.test(testCase.test_case)
  );
  if (!inferred) return { issues: [] };

  return {
    issues: [
      {
        category: 'unsupported_behavior',
        severity: 'low',
        testcase_id: inferred.case_id,
        requirement_id: inferred.requirement_ids[0],
        explanation:
          'The requirement states what happens above the settled amount but not at an amount equal to it, so this expectation is an inference.',
      },
    ],
  };
}

/**
 * @param {{prompt: string, schema: object}} request
 * @returns {object} a reply that satisfies request.schema
 */
export function realisticReply(request) {
  const properties = request.schema?.properties ?? {};

  if (properties.issues) return reviewReply(request);
  if (properties.requirements) return structuringReply(request);
  if (properties.test_cases) return generationReply(request);

  throw new Error("realisticReply was given a schema that is not one of QATOOL's three.");
}
