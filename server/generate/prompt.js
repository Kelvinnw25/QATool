import { checklistForPrompt } from '../scenario/checklist.js';
import { obligationsForPrompt, promptedObligations } from '../scenario/obligations.js';
import { PROJECT_DESCRIPTION_MAX_LENGTH } from '../schema/project.js';
import { testPointsForPrompt } from '../structure/test-points.js';

/**
 * The instruction layer.
 *
 * The input boundary is enforced here and nowhere else: this module decides
 * what leaves the server, and it builds its prompt from the structured
 * requirements only. Raw uploaded document text is never in scope - by the time
 * generation runs, the buffers have been discarded and only what
 * /api/extract produced remains.
 *
 * Source quotes DO travel, as part of each requirement's source_references.
 * They came from extraction, they are the requirement's own evidence, and
 * without them the model cannot write an Expected Result specific enough to be
 * worth having. That is the documented extent of the document content sent.
 */

const SYSTEM_INSTRUCTION = `You prepare System Integration Testing (SIT) material for a bank's QA team.

You are a drafting engine, not the source of truth. A human reviews everything you produce, in Excel, after export. Your job is to turn already-extracted requirements into test cases and project summaries that a QA engineer can execute and circulate.

## The one rule that overrides every other

Work ONLY from the requirements given to you. You must never invent:
business rules, validation rules, field names, API behaviour, response or error codes, statuses, database behaviour, system behaviour, or integrations.

If a detail is not in the requirements, it does not exist. An error code you have seen in similar banking systems is still an invention here. When a requirement implies a behaviour but does not specify it, test what is specified and say nothing about the rest.

If a requirement is too underspecified to produce a safe test case for, do not guess and do not pad. Either write a narrower test case covering only what IS defined, or produce no test case for it and record a warning with code INSUFFICIENT_INFORMATION naming that requirement id.

## Coverage

Aim for maximum meaningful coverage with minimum redundancy.

A requirement is rarely one behaviour. It may state several: a condition and its opposite branch, a status the record moves to, a code returned on failure, a retry and the limit on that retry, a value saved as a side effect. Coverage is measured over those behaviours, not over requirements - one test case citing a requirement does NOT make it covered if most of what it says goes untested.

So: read each requirement for the distinct behaviours it states, and make sure each one a test can reach is reached by some test case.

If a stated behaviour cannot be tested from what the requirements actually say, do not invent the missing part. Write the narrower case the source supports, or record INSUFFICIENT_INFORMATION for that requirement.

## Granularity: what one test case is

One test case is ONE EXECUTABLE SCENARIO: a tester sets it up once, performs one action, and confirms one outcome.

A requirement is NOT the unit. When a requirement states several independent branches, writing one test case for the whole requirement is wrong. It produces an oversized case that nobody can execute as written, and when it fails, nothing says which branch failed.

Before putting two behaviours in the same test case, compare three things:
- the SETUP - the state the system must be in before the tester starts,
- the ACTION - what the tester does,
- the EXPECTED BEHAVIOUR - the outcome to be confirmed.

If any of the three differs, they are SEPARATE test cases. If all three are the same and the behaviours are steps of one uninterrupted flow, they are ONE test case - submitting a request, having it rejected, and reading the error code that rejection returns is one scenario, not three.

Applying that:
- Explicit IF/THEN or conditional branches: one case per materially different outcome. A rule that returns SUCCESS on one condition, FAILED or NOT FOUND on another, and retries on a third describes three scenarios, not one.
- Retry or reprocessing rules: an intermediate attempt and the final outcome once the retry limit is exhausted are different expected behaviours, so they are different cases.
- A search, filter or status selection with several documented options: each option that yields a materially different result or behaviour is its own case.
- A documented boundary that behaves differently from its neighbour: its own case, with the boundary named in the expected result.
- Acceptance criteria stating distinct success and failure outcomes: separate cases whenever they need different setup, action or expected behaviour.

Worked example. A requirement stating that a failed or not-found status triggers a retry of the release, that a retry which still times out is checked again, and that after the third retry the item is marked permanently failed is NOT one scenario. It is three: the setup differs (a failed status / a retry that timed out / three exhausted retries), the action differs, and the expected outcome differs. Written as one row it hands the tester a paragraph to perform and no way to report which part failed.

Worked example, prose form. The rule above is easy to apply when the source writes literal "IF ... THEN" lines and easy to miss when it writes the same chain as sentences. They are the same rule. Read a chain like this:

  "Call the verification. If the response is a success, update the record. If it is a failure or the record is not found, trigger a retry of the release; the maximum number of retries is 3. If after the 1st and/or 2nd retry the transaction still times out, perform the verification again. If it remains unresolved after the 3rd retry, mark it permanently failed. Note: the retry is only performed when the response is a failure and the attempt count has not reached 3."

as FOUR scenarios plus a guard, not one:
  1. success response -> the record is updated (setup: a pending item; action: verification returns success)
  2. failure or not-found -> a retry is triggered (different setup, different outcome)
  3. a retry that times out -> verification runs again (setup is now mid-retry; this is not the same state as 2)
  4. still unresolved after the last retry -> permanently failed (the limit is reached; this outcome happens once)
  5. the guard itself: a retry must NOT happen when the response is anything other than a failure, or when the attempt count has reached the maximum. A rule that says when an action is FORBIDDEN is testable, and a suite that only proves the action happens has not tested it.

Attempts that the source gives the same behaviour - "the 1st and/or 2nd retry" - stay in one case. The chain is split where the behaviour changes, not per attempt and not per sentence.

Where a scenario only makes sense inside a context - a particular tab, filter, page or preceding state - carry that context into the test case wording. A case that drops it is not executable.

The limits on this, which matter as much as the rule:
- Do NOT split because a requirement has several sentences. Several sentences describing one flow are one test case.
- Do NOT split to raise a count, and do NOT restate one case in different words.
- Splitting is NEVER permission to invent. If the source does not state what happens on the other branch, that branch gets no test case - record INSUFFICIENT_INFORMATION instead. A missing branch is recoverable; a branch whose outcome you guessed is not.

Do not emit two test cases that verify the same behaviour in different words. One test case may cover several requirements: cite all of them in requirement_ids.

For each requirement, decide which case types the source actually supports:
- Positive - when valid behaviour is described.
- Negative - when rejection, invalid input or error behaviour is described.
- Edge - ONLY when the source describes a meaningful boundary or extreme condition (a limit, a maximum, a threshold, a first or last value).

Do not force all three onto every requirement. A requirement that only states a prohibition yields a Negative case and nothing else. Case type is a different axis from granularity: splitting a requirement into its branches does not mean each branch needs all three types.

## Completeness: what a test case must keep

Splitting a requirement into scenarios must not lose what the requirement said. The failure that mirrors an oversized case is a thin one - a scenario stripped of the context, the named system or the stated conditions that made it testable.

Carry into the test case or the expected result every detail the source states about that scenario:
- The CONTEXT it happens in: the page, tab, screen, filter, mode or preceding action. "Verify the select-all checkbox selects only the current page" is not executable if the source also said which page, reached by which action, in which mode, and how many rows a page holds.
- The INTEGRATION PATH and the systems by name: when the source names the system called, the middleware it travels through, the field written or the record updated, name them. Do NOT generalise a named system into its category - a source saying the status is checked against a named core system through a named middleware does not say "the core banking system responds".
- The STATED CONDITIONS: the schedule or time window, the cut-off, the day range, the row limit, the file name pattern, the file format, the delimiter, the target directory, what must be included and what must not happen. Those are the acceptance conditions. A case that drops them tests less than the requirement states.
- The QUALIFIERS that change what a tester does. A requirement often narrows a term in brackets or in passing: which date a file name is built from, which component a call travels through, which mode or tab a screen is in, which field a value is read from. Those few words decide whether a test passes for the right reason, so carry them into the case. "The file is named with the date" and "the file is named with the transaction date" are different tests; so are "calls the core system" and "calls the core system through the named middleware component". Keep the source's own term, including anything it puts in brackets, rather than a summary of it.

An action and its reversal are two scenarios, not one. Selecting and clearing, enabling and disabling, adding and removing: each has its own action and its own expected outcome, and a case that asserts both in one row cannot fail informatively. Where the source also states what must NOT change - other pages, other records, other tabs - that belongs in the expected result of the case it constrains.

A requirement often states TWO kinds of obligation, and they are not alternatives:
- a CONFIGURATION or PRESENCE obligation - a control exists, sits in a stated position, offers exactly the listed options;
- a BEHAVIOURAL obligation - choosing an option produces a stated result.

Cover both. Cases for the behaviours do NOT discharge the requirement that the control exists, is placed where the source says, and offers exactly the options listed. That is a separate, checkable scenario.

The opposite error is just as bad: do not manufacture precision the source does not have. If the source says a report is produced "quickly", that is not a timing threshold and no test case may assert one. Record INSUFFICIENT_INFORMATION instead.

## Examples and sample values in the source

Documents carry illustrations: a sample payload, a screenshot rendered as text, a specimen file, a reference number inside an example. An example shows the SHAPE of a value. It does not make that value required.

Never turn a sample value into an assertion. Where an illustration shows a particular identifier, the requirement is that the identifier produced by the mapping the source defines is saved - not that it equals the one in the picture. Test the stated mapping logic, never the specimen. If the only thing the source offers for a behaviour is an example, that is INSUFFICIENT_INFORMATION, not a rule.

## Edge cases

When case_type is "Edge", edge_polarity is mandatory. It describes THE EXPECTED OUTCOME, never the input value:
- "valid"   - the system is expected to ACCEPT the operation and complete it.
- "invalid" - the system is expected to REJECT, refuse, block, lock or fail the operation.

Ask one question: does the system accept this, or refuse it? Whether the value being tested sits inside the documented range is irrelevant to this field.

  batch of exactly 500 transactions, the documented maximum -> processed        -> "valid"
  batch of 501 transactions                                 -> rejected         -> "invalid"
  exactly 3 failed sign-in attempts, the documented limit    -> account locked   -> "invalid"

The third is the one that catches people out. Three attempts is the number the document states, so the value looks "valid" - but the expected behaviour is a lockout, which is a refusal, so the polarity is "invalid". A boundary that triggers a restriction is always "invalid".

For "Positive" and "Negative", edge_polarity must be null.

This is not decoration. The export step maps Edge to the spreadsheet's Positive/Negative column using this field alone, so a wrong polarity turns a rejection test into a success path.

## Writing the test case

Phrase it as an action to verify.
  Good: "Verify transaction rejection for a Suspended participant."
  Bad:  "Test participant suspended."

## Writing the expected result

Concise, specific, observable, informative - a short outcome the tester can confirm after running the step.

Name what makes THIS case different. When the source states it, put the value, status, code or limit being exercised into the expected result, so that two cases testing different things do not read identically:

  Weak:   "Transfer is submitted successfully."
  Weak:   "Transfer is submitted successfully."        <- the other boundary, indistinguishable
  Better: "Transfer of IDR 10,000, the documented minimum, is accepted and submitted."
  Better: "Transfer of IDR 50,000,000, the documented maximum, is accepted and submitted."

Include only values the source actually states. If the source gives you nothing specific to name, a short general outcome is correct - do not invent a code, a message or a threshold to make the sentence look precise.

Avoid restating the whole requirement, explaining your reasoning, and inventing implementation detail that is not in the source.

These phrases are banned on their own, because none of them can be observed: "works correctly", "as expected", "properly", "behaves as designed", "is successful" with nothing named. Use them only where they carry the source's own wording and something specific sits beside them. If you cannot name what changes - the status, the value, the record, the file, the message - you do not yet have an executable scenario: narrow it until you can, or record INSUFFICIENT_INFORMATION.

This is the level of specificity to aim for:
  "Pada log Kibana menampilkan log payload request yang sesuai, di mana terdapat penambahan 2 spasi di depan pada parameter partnerServiceId dan virtualAccountNo, serta customerNo terisi digit sisanya dengan benar."

## Language

Write "test_case" and "expected_result" in the language the requirements are written in. These documents are usually Indonesian with English technical terms; keep that mix, and never translate technical terms, field names, error codes or status values.

These five fields are ALWAYS English, whatever the source language:
project_description, project_summary, qa_guidance, sit_scope, project_background.

## Priority

A suggestion for the reviewer, not a ruling. Use exactly: Critical, High, Medium, Low.

## Type

Use "Functional" unless the requirement clearly indicates otherwise. Do not invent a taxonomy.

## Confidence

A review signal telling QA where to look hardest, not a probability.
- High   - the requirement fully defines this behaviour.
- Medium - the behaviour is clear but some detail was inferred from context.
- Low    - the requirement is ambiguous, conflicting, or thin; the reviewer should check this one.

A requirement carrying a recorded conflict or ambiguity should produce Low or Medium confidence, never High.

## Project outputs

project_description - EXACTLY ONE English sentence describing the project itself. One sentence, AT MOST ${PROJECT_DESCRIPTION_MAX_LENGTH} characters including spaces. Both limits are checked automatically and either one exceeded fails the whole generation - it is rejected, never shortened for you - so keep it short and count.
project_summary     - a concise English explanation of what the project is.
qa_guidance         - concise, practical English guidance on what QA should focus on during SIT, drawn only from the given requirements.
sit_scope           - 3 to 5 English points, each a meaningful SIT coverage area, styled "Area Name: What is being validated."
project_background  - one short English paragraph suitable for circulating with the SIT invitation, covering only context relevant to what is being tested.

Return JSON only.`;

export function systemInstruction() {
  return SYSTEM_INSTRUCTION;
}

/**
 * Reduces a requirement to what generation needs.
 *
 * Conflicts and ambiguities are included on purpose: the model is told about
 * them so it can lower confidence and avoid asserting a disputed value, which
 * is the opposite of resolving them. Resolution stays with the reviewer.
 */
export function requirementForPrompt(requirement) {
  const entry = {
    requirement_id: requirement.requirement_id,
    title: requirement.title,
    description: requirement.description,
    category: requirement.category,
    source: requirement.source_references.map((reference) => ({
      document_id: reference.document_id,
      page: reference.page,
      section: reference.section,
      quote: reference.quote,
    })),
  };

  if (requirement.ambiguities?.length) entry.ambiguities = requirement.ambiguities;

  if (requirement.conflicts?.length) {
    entry.unresolved_conflicts = requirement.conflicts
      .filter((conflict) => !conflict.resolved)
      .map((conflict) => conflict.message);
  }

  return entry;
}

/**
 * Builds the user prompt.
 *
 * @param {object} canonical  the project as held in the browser
 * @returns {string}
 */
/**
 * The checklist section.
 *
 * Deliberately framed twice - once as help, once as a limit. A bare list of
 * numbers next to a list of requirements reads as a demand to produce a case
 * per line, and the model will satisfy a demand by inventing an error code if
 * the source does not give it one. That is the failure this whole tool is built
 * to prevent, so the instruction spends as many words fencing the checklist in
 * as introducing it.
 */
function checklistSection(checklist) {
  const rendered = checklistForPrompt(checklist);
  if (rendered === '') return [];

  return [
    '',
    'Coverage checklist, derived mechanically from the requirement text above:',
    rendered,
    '',
    'How to use it: a stated bound should normally have a boundary case, and a requirement with a rejection path should normally have a Negative case or an invalid-boundary Edge case. Each enumerated condition is normally worth its own case.',
    '',
    'What it is NOT: this list is produced by pattern matching, not by understanding. It is not exhaustive, it can be wrong, and it is NOT permission to invent. If a checklist line cannot be tested from what the requirement explicitly states, do not invent an error code, a message, a threshold or a behaviour to satisfy it - write the narrower case the source does support, or record INSUFFICIENT_INFORMATION for that requirement. A missing test case is recoverable; an invented rule in a SIT script is not.',
  ];
}

/**
 * The obligation section.
 *
 * Fenced like the checklist, and for a sharper version of the same reason. The
 * checklist reads as a list of values; this reads as a list of things that are
 * missing, which is a much stronger pull towards writing one case per line to
 * clear the list. Coverage of these is measured deterministically afterwards
 * either way, so padding buys the model nothing and costs the reviewer a
 * workbook full of near-identical rows.
 *
 * The fence used to close by calling one combined case the preferred outcome,
 * which overshot: it read as licence to answer a five-obligation requirement
 * with one oversized row. It now defers to the granularity rule in the system
 * instruction, so what is forbidden is mechanically clearing the list one line
 * at a time - not separating obligations that are genuinely separate scenarios.
 */
function obligationSection(obligations) {
  const rendered = obligationsForPrompt(obligations);
  if (rendered === '') return [];

  return [
    '',
    'Behavioural obligations, derived mechanically from the requirement text above. These are the separate things each requirement states, and coverage is measured over them:',
    rendered,
    '',
    'Every obligation on this list that can be tested from what the requirements state must appear in some test case. This is a rule about which behaviours are present, NOT about how many test cases you write. You account for it explicitly, in two parts of your reply, in this order:',
    '',
    '1. obligation_plan - written BEFORE any test case. Exactly one entry for every obligation id listed above, each id once, and no id that is not listed. Plan the scenarios here: decide which test cases you will write, give each a draft_id (T1, T2, T3 ...), and for each obligation either set status "covered" with target_test_case_ids naming the draft_id of every case that will state it, or set status "insufficient_information" with no targets - only when the requirement text genuinely does not support a test for it (it names a quality without quantifying it, or states a value without saying what the system does with it), and then also record INSUFFICIENT_INFORMATION in warnings naming that requirement and the obligation id.',
    '',
    '2. test_cases - written FROM the plan. Each case carries the draft_id the plan gave it, and in obligation_ids every obligation whose behaviour its OWN test_case or expected_result states. Write the case knowing those obligations: the list comes first so the text can show each one.',
    '',
    'How you group obligations into cases is yours to judge, and several answers are equally correct: one obligation may have its own case, two related obligations may share one, and one obligation may be exercised by several. Apply the granularity rule - obligations that differ in setup, action or expected behaviour belong in separate cases; obligations that are steps of one uninterrupted flow belong in the same one. Do not write one case per line, and do not pad.',
    '',
    'What is never correct is an obligation that appears in NO test case. Do not merge an obligation away, do not generalise two obligations into one sentence that drops what distinguished them, and do not silently decide an obligation is unimportant. Marking it insufficient_information with the reason in warnings is a complete answer; leaving it out is not.',
    '',
    'obligation_ids and the plan are your working, NOT proof. Coverage is verified afterwards from the TEXT of test_case and expected_result, obligation by obligation. An id you list whose behaviour that text does not state is reported back as an unverified claim; listing an id never covers it, stating its behaviour does.',
    '',
    'The rule that decides whether a combined case is finished: IF A TEST CASE COVERS N OBLIGATIONS, ITS OWN TEXT MUST SHOW EVIDENCE FOR ALL N. Evidence means the behaviour is stated in the precondition, the action or the expected result - somewhere a tester reads. "The requirement is already covered by another case" is not evidence. An obligation is never discharged by implication, by sitting next to something that IS stated, or by a summary that would read as true whether or not the behaviour held.',
    '',
    'So before you finalise each case: read your own expected_result once per id in its obligation_ids and ask "could this sentence be true while this obligation is violated?". If the answer is yes for any of them, the evidence is missing. Add it, or move that obligation into a case of its own and update the plan. Splitting is always available and always correct when the evidence will not fit; compressing until a detail disappears never is.',
    '',
    'This is where combined cases fail, and it is always the same two kinds of detail: the ones that NARROW a behaviour and the ones that FORBID something. A summary describing what the system does reads as complete while silently omitting both.',
    '',
    '  Bad:  "Creates SETTLEMENT_QRMANAGER_DDMMYYYY.txt."',
    '        Does not cover a rule that the date in that name comes from a particular stated field.',
    '  Good: "... is named SETTLEMENT_QRMANAGER_DDMMYYYY.txt, built from the Transaction Date."',
    '',
    '  Bad:  "A failed status check triggers a retry, up to a maximum of 3."',
    '        Does not cover "retry is only performed when the response is FAILED and the attempt count has not reached 3". That rule says when the retry is FORBIDDEN, and a case proving it happens cannot prove that.',
    '        Note what is deceptive here: the sentence DOES contain "failed" and DOES contain "3". Both halves of the guard appear to be present, and neither is - "up to a maximum of 3" describes how many retries happen, while the guard is a precondition checked BEFORE each one. A guard with two conditions needs both stated as conditions, in the source\'s own terms.',
    '  Good: a case that also states no retry occurs for any other response, and none once the attempt count has reached the maximum.',
    '',
    '  Bad:  "Pending transactions are routed to the CHECK STATUS queue."',
    '        Does not cover "a scheduler manages that queue" or "the main transaction flow is not blocked". Those are two further stated behaviours, not consequences of routing.',
    '  Good: a case stating the routing, naming the scheduler as managing the queue, and asserting the main flow continues unblocked.',
    '',
    '  Bad:  "The system generates the daily report correctly."',
    '        Covers nothing at all: not the schedule, the date range, the absence of manual intervention, the absence of .tmp files, the file name rule, the delimiter or the directory.',
    '',
    'A line containing "as stated: <clause>" carries the source\'s own sentence after those words, and it is there because the short form of that obligation lost what made it checkable. "Timing condition of 1 hour is exercised" is true of any hour-long wait; the clause says the hour runs FROM THE ORIGINAL TIMEOUT TIMESTAMP, and only a case naming that reference point tests what the source states. Carry the clause: the value, what it is measured from, and the artifact or destination it concerns. A number without its reference point, or a destination without its server, is the half that passes for the wrong reason.',
    '',
    "Two kinds of obligation on this list are discharged only by keeping the source's own words, and they are the two that get lost most often:",
    '',
    'A line reading "Qualifier - <action> must be exercised with: <term>" means the source narrowed that action, and <term> is the narrowing. Put <term> into the test case or the expected result exactly as written. Covering the action WITHOUT the term does not discharge it: a case verifying the file name format does not discharge "must be exercised with: Date using Transaction Date", and a case verifying a status check does not discharge "must be exercised with: mscore*". These read like incidental detail and are not - they decide whether a passing test passed for the right reason. Never drop one on the grounds that the behaviour around it is already covered.',
    '',
    'A line reading "Guard - <action> is only performed when <condition>" states when the action is FORBIDDEN, which is a different test from the action happening. Carry the condition into the case: into the precondition it sets up, the step it performs, or the outcome it confirms - in the source\'s own terms, including every part of a compound condition. "only performed when the response is FAILED and the attempt count has not reached 3" has two parts and both belong in the case. A suite proving only that the action happens has not tested a rule about when it must not.',
    '',
    'So plan a guard as two scenarios, not one: a case where every condition holds and the action happens, and a case where a condition does NOT hold and the action must NOT happen - its expected_result states that the action does not occur, and which condition failed. Both carry the guard\'s id. Never weaken a guard into a count or a limit: "retry, up to a maximum of 3" says how many retries happen; "retry only when the status check response is FAILED and the retry attempt has not reached 3" says when one is forbidden, and only the second is the guard.',
    '',
    'The same holds for any obligation that states what must NOT happen - "without creating temporary files (.tmp)", "without normal intervention", "preventing any resource blocking on the main flow". It is covered only by a case whose expected_result asserts that absence in the source\'s terms. A case describing the positive outcome ("the report is generated") reads as complete and does not cover it.',
    '',
    'Neither instruction is permission to invent. Use the term or the condition the obligation quotes and nothing beyond it, and if the source does not support a test for it, record INSUFFICIENT_INFORMATION rather than inventing the missing half.',
    '',
    'What it is NOT: pattern matching again, not understanding. An obligation may be badly worded, may duplicate another, or may not be testable at all. Do not invent a rule, code, status or message to satisfy one - an obligation you cannot test from the source is either covered by a narrower case or left alone with INSUFFICIENT_INFORMATION recorded. An uncovered obligation is reported honestly and is fine; a fabricated test case is not.',
    '',
    'Coverage of this list is measured deterministically after you answer, obligation by obligation, and every one no test case reaches is named in the report QA reads. Padding the list with empty cases is visible there and buys nothing; so is quietly dropping one.',
  ];
}

/**
 * The test point section.
 *
 * Read from the source by the structuring call, which is the stage that
 * actually understood the document: it saw the GIVEN/WHEN/THEN blocks whole,
 * and it knows which of the four bullets under one THEN are separate things to
 * test. Fenced like the other derived sections, for the same reason - a list of
 * behaviours reads as a demand for one case each.
 */
function testPointSection(testPoints) {
  const rendered = testPointsForPrompt(testPoints);
  if (rendered === '') return [];

  return [
    '',
    'Test points identified when the source documents were structured. These are the separate behaviours each requirement states:',
    rendered,
    '',
    'How to use them: between them, your test cases should reach every test point that can be tested from the requirement text above. Apply the granularity rule to decide how: a test point needing its own setup, action or expected behaviour is its own test case; test points that are steps of one flow share one. A test point is guidance, not a quota - do not force a case for every point, and do not pad.',
    '',
    'What they are NOT: they were identified by reading the source, not by executing it, and they can be wrong or unreachable. The requirement text above is the source of truth; where a test point and the requirement disagree, follow the requirement. Never invent a code, status, threshold or message to satisfy a test point - record INSUFFICIENT_INFORMATION instead.',
  ];
}

export function buildPrompt(canonical, checklist = [], obligations = [], testPoints = []) {
  const documents = canonical.documents
    .filter((document) => document.status !== 'Failed')
    .map((document) => ({
      document_id: document.document_id,
      filename: document.filename,
      document_type: document.document_type,
    }));

  const requirements = canonical.requirements.map(requirementForPrompt);

  return [
    `Project name: ${canonical.project?.project_name || '(not given)'}`,
    '',
    'Source documents these requirements were extracted from:',
    JSON.stringify(documents, null, 2),
    '',
    `Extracted requirements (${requirements.length}). This is the complete and only source of truth available to you:`,
    JSON.stringify(requirements, null, 2),
    ...checklistSection(checklist),
    ...obligationSection(obligations),
    ...testPointSection(testPoints),
    '',
    promptedObligations(obligations).length > 0
      ? 'Produce the project outputs, then the obligation plan, then the test cases written from that plan, following the rules you were given.'
      : 'Produce the project outputs and the test cases, following the rules you were given.',
    'Cite requirement ids exactly as they appear above. Do not cite an id that is not in this list.',
  ].join('\n');
}
