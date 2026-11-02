import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { generateFromRequirements } from './index.js';
import { GENERATION_WARNINGS } from './assemble.js';
import { buildPrompt, systemInstruction } from './prompt.js';
import { MockProvider } from '../llm/mock.js';
import { deriveCoverageObligations, matchObligations } from '../scenario/obligations.js';
import {
  branchedLlmResponse,
  branchingCanonicalInput,
  collapsedLlmResponse,
  overSplitLlmResponse,
  thinLlmResponse,
} from './fixtures/branching.js';

/**
 * Granularity: what one test case is.
 *
 * The defect these guard against was measured on a real PRD run. Gemini #1 had
 * just started reconstructing fragmented GIVEN/WHEN/THEN blocks correctly, and
 * Gemini #2 answered the better-formed requirement by compressing all of its
 * branches back into one oversized test case - four provider outcomes in one
 * row, three search options in one row. A case like that cannot be executed as
 * written, and when it fails nothing records which branch failed.
 *
 * Two halves, because only one of them is enforceable:
 *
 *   the instruction  what the model is asked for. Asserted because the previous
 *                    wording actively rewarded compression ("One test case may
 *                    cover several behaviours at once, and should"), and a
 *                    well-meaning tidy-up of the prompt would reintroduce that
 *                    invisibly - nothing about the failure shows up in the
 *                    shape of the JSON that comes back.
 *   the pipeline     that a split batch survives the deterministic stages
 *                    intact. We cannot make a model split, and nothing here
 *                    pretends to; what can be proved is that the system does
 *                    not undo a split, and that the over-correction is still
 *                    caught.
 */

function generate(response, canonical = branchingCanonicalInput()) {
  return generateFromRequirements(canonical, {
    provider: new MockProvider({ responses: response }),
  });
}

const branchingObligations = deriveCoverageObligations(branchingCanonicalInput().requirements);

describe('the granularity instruction', () => {
  it('asks for one executable scenario per case, not one case per requirement', () => {
    const system = systemInstruction();

    assert.match(system, /ONE EXECUTABLE SCENARIO/);
    assert.match(system, /A requirement is NOT the unit/);
    assert.match(system, /the SETUP/);
    assert.match(system, /the ACTION/);
    assert.match(system, /the EXPECTED BEHAVIOUR/);
    assert.match(
      system,
      /If any of the three differs, they are SEPARATE test cases/,
      'the split test is stated as a rule, not a preference'
    );
  });

  it('names the branch shapes that were being collapsed', () => {
    const system = systemInstruction();

    assert.match(system, /IF\/THEN or conditional branches/);
    assert.match(
      system,
      /retry limit is exhausted are different expected behaviours/,
      'the intermediate attempt and the final failure are different cases'
    );
    assert.match(system, /search, filter or status selection/);
    assert.match(
      system,
      /carry that context into the test case wording/,
      'a tab, page or filter context must survive into the case'
    );
  });

  /**
   * The retry chain measured on the real PRD stayed in one row even after the
   * granularity rule landed, so the rule is now carried by a worked example as
   * well - the same device the edge-polarity section uses, for the same reason.
   */
  it('works the retry chain through as an example', () => {
    const system = systemInstruction();

    assert.match(system, /Worked example/);
    assert.match(system, /triggers a retry of the release/);
    assert.match(system, /after the third retry the item is marked permanently failed/);
    assert.match(
      system,
      /It is three: the setup differs/,
      'the example states the verdict, not just the situation'
    );
    assert.match(
      system,
      /no way to report which part failed/,
      'and says why an oversized row costs the tester something'
    );
  });

  /**
   * Measured on a real PRD run: splitting worked where the source wrote literal
   * IF lines and did not where the same chain was written as sentences. The
   * rule is carried by a second worked example in prose form.
   *
   * Instruction-level only. Nothing here claims a model obeys it; it pins that
   * the rule is asked for, because a tidy-up would remove it invisibly.
   */
  it('works a prose retry chain through, not just an IF list', () => {
    const system = systemInstruction();

    assert.match(system, /Worked example, prose form/);
    assert.match(system, /easy to miss when it writes the same chain as sentences/);
    assert.match(system, /as FOUR scenarios plus a guard, not one/);

    assert.match(system, /success response -> the record is updated/);
    assert.match(system, /failure or not-found -> a retry is triggered/);
    assert.match(system, /a retry that times out -> verification runs again/);
    assert.match(system, /still unresolved after the last retry -> permanently failed/);
  });

  it('asks for the guard itself to be tested', () => {
    const system = systemInstruction();

    assert.match(system, /a retry must NOT happen when/);
    assert.match(
      system,
      /A rule that says when an action is FORBIDDEN is testable/,
      'a restriction is a scenario, not commentary'
    );
  });

  it('forbids splitting per attempt when the source gives them one behaviour', () => {
    const system = systemInstruction();

    assert.match(system, /stay in one case/);
    assert.match(system, /not per attempt and not per sentence/);
  });

  it('fences splitting so it cannot become padding or invention', () => {
    const system = systemInstruction();

    assert.match(system, /Do NOT split because a requirement has several sentences/);
    assert.match(system, /Do NOT split to raise a count/);
    assert.match(system, /Splitting is NEVER permission to invent/);
    assert.match(
      system,
      /that branch gets no test case - record INSUFFICIENT_INFORMATION instead/,
      'an unstated branch is refused, not guessed'
    );
  });

  /**
   * The superseded wording, asserted absent.
   *
   * This is the real regression guard. Adding the granularity section while
   * leaving the old sentences in place would hand the model two contradictory
   * instructions, and the compression one reads as the safer of the two.
   */
  it('no longer tells the model that combining behaviours is what it should do', () => {
    const system = systemInstruction();

    assert.doesNotMatch(system, /One test case may cover several behaviours at once/);
    assert.doesNotMatch(system, /has tested three things honestly/);
  });

  it('keeps the derived sections agreeing with the granularity rule', () => {
    const prompt = buildPrompt(branchingCanonicalInput(), [], branchingObligations, [
      { requirement_id: 'REQ-002', type: 'branch', statement: 'Settled shows only settled rows' },
    ]);

    assert.match(prompt, /obligations that are steps of one uninterrupted flow belong in the same/);
    assert.match(prompt, /a test point needing its own setup, action or expected behaviour/);

    // Both sections used to close by calling one combined case "the preferred
    // outcome, not a compromise" - the same instruction as the one removed from
    // the system prompt, restated where the model reads it last.
    assert.doesNotMatch(prompt, /the preferred outcome, not a compromise/);
    assert.doesNotMatch(prompt, /that is preferred, not a compromise/);

    // And neither may turn into a quota in the other direction.
    assert.match(prompt, /do not pad/);
    assert.match(prompt, /A test point is guidance, not a quota/);
  });
});

/**
 * Completeness: the failure that mirrors an oversized case.
 *
 * Once the generator started separating branches, the next measured defect on
 * the real PRD was thinness - scenarios stripped of the context, the named
 * systems and the stated conditions that made them testable, a named core
 * system generalised into its category, an illustrative value promoted into an
 * assertion, and expected results nobody can observe. `thinLlmResponse` is that
 * defect; no deterministic stage can detect it, which is exactly why the
 * instruction has to carry the rule.
 */
describe('the completeness instruction', () => {
  it('requires the context, the named systems and the stated conditions to survive', () => {
    const system = systemInstruction();

    assert.match(system, /## Completeness: what a test case must keep/);
    assert.match(system, /The CONTEXT it happens in/);
    assert.match(system, /The INTEGRATION PATH and the systems by name/);
    assert.match(system, /The STATED CONDITIONS/);
    assert.match(
      system,
      /Do NOT generalise a named system into its category/,
      'a named core system must not become "the core banking system"'
    );
    assert.match(
      system,
      /the file name pattern, the file format, the delimiter, the target directory/,
      'the report conditions are named as acceptance conditions, not decoration'
    );
  });

  it('requires bracketed qualifiers that change the test to survive', () => {
    const system = systemInstruction();

    assert.match(system, /The QUALIFIERS that change what a tester does/);
    assert.match(system, /which date a file name is built from/);
    assert.match(system, /which component a call travels through/);
    assert.match(
      system,
      /Keep the source's own term, including anything it puts in brackets/,
      'the source wording, not a summary of it'
    );
  });

  it('treats an action and its reversal as two scenarios', () => {
    const system = systemInstruction();

    assert.match(system, /An action and its reversal are two scenarios, not one/);
    assert.match(system, /Selecting and clearing/);
    assert.match(
      system,
      /what must NOT change - other pages, other records, other tabs/,
      'the unaffected-scope clause belongs in the expected result'
    );
  });

  it('keeps a configuration obligation from being discharged by behaviour cases', () => {
    const system = systemInstruction();

    assert.match(system, /a CONFIGURATION or PRESENCE obligation/);
    assert.match(system, /a BEHAVIOURAL obligation/);
    assert.match(
      system,
      /Cases for the behaviours do NOT discharge the requirement that the control exists/,
      'three filter cases do not replace the dropdown-exists case'
    );
    assert.match(system, /offers exactly the options listed/);
  });

  it('refuses precision the source does not have', () => {
    const system = systemInstruction();

    assert.match(system, /do not manufacture precision the source does not have/);
    assert.match(
      system,
      /"quickly", that is not a timing threshold and no test case may assert one/,
      'a vague word must not become a measurable assertion'
    );
    assert.match(system, /Record INSUFFICIENT_INFORMATION instead/);
  });

  it('forbids an example value from becoming a business rule', () => {
    const system = systemInstruction();

    assert.match(system, /## Examples and sample values in the source/);
    assert.match(system, /An example shows the SHAPE of a value/);
    assert.match(system, /Never turn a sample value into an assertion/);
    assert.match(
      system,
      /Test the stated mapping logic, never the specimen/,
      'mapping is tested, not the identifier printed in an illustration'
    );
  });

  it('bans expected results that cannot be observed', () => {
    const system = systemInstruction();

    assert.match(system, /These phrases are banned on their own/);
    for (const phrase of ['works correctly', 'as expected', 'properly', 'behaves as designed']) {
      assert.ok(system.includes(`"${phrase}"`), `${phrase} is named as unobservable`);
    }
    assert.match(system, /you do not yet have an executable scenario/);
  });

  /**
   * The thin reply is carried, not caught: nothing deterministic judges whether
   * a case kept its context. Asserted so the claim stays honest - if a later
   * change adds post-processing that rewrites or drops thin cases, this fails
   * and the claim gets revisited rather than quietly becoming false.
   */
  it('carries a thin batch unchanged, because no stage judges thinness', async () => {
    const result = await generate(thinLlmResponse());

    assert.equal(result.test_cases.length, 3, 'nothing was dropped for being thin');
    assert.equal(
      result.test_cases[0].test_case,
      'Verify Select All berfungsi.',
      'and nothing was rewritten to add the missing context'
    );
    assert.ok(
      result.test_cases.some((testCase) => testCase.expected_result.includes('250101ABCDEF')),
      'the promoted example value is still there - the prompt is what prevents it'
    );
  });
});

describe('the pipeline keeps a split batch intact', () => {
  it('keeps each branch of a conditional retry requirement as its own case', async () => {
    const result = await generate(branchedLlmResponse());

    const verification = result.test_cases.filter((testCase) =>
      testCase.requirement_ids.includes('REQ-001')
    );

    assert.equal(verification.length, 4, 'SUCCESS, FAILED/NOT FOUND, timeout retry, final failure');
    assert.equal(
      new Set(verification.map((testCase) => testCase.case_id)).size,
      4,
      'each branch keeps its own id'
    );

    // The four outcomes are distinguishable in the workbook, which is the whole
    // point of separating them.
    const outcomes = verification.map((testCase) => testCase.expected_result).join(' ');
    assert.match(outcomes, /settled/);
    assert.match(outcomes, /retry Release Settlement/);
    assert.match(outcomes, /Check Status kembali/);
    assert.match(outcomes, /permanently FAILED/);
  });

  /**
   * The one the observed run kept collapsing. Retry attempts 1 and 2 share a
   * case because the source gives them the same behaviour, so this also pins
   * the opposite failure: four cases, not six.
   */
  it('separates the retry chain without splitting per attempt', async () => {
    const result = await generate(branchedLlmResponse());

    const retry = result.test_cases.filter((testCase) =>
      testCase.requirement_ids.includes('REQ-001')
    );
    const actions = retry.map((testCase) => testCase.test_case);

    assert.ok(
      actions.some((action) => /FAILED atau NOT FOUND/.test(action)),
      'the failed / not-found branch triggering a retry is its own case'
    );
    assert.ok(
      actions.some((action) =>
        /retry Release Settlement ke-1 atau ke-2 masih timeout/.test(action)
      ),
      'the intermediate timeout re-check is its own case'
    );
    assert.ok(
      actions.some((action) => /setelah retry ke-3/.test(action)),
      'and the exhausted-limit outcome is its own case'
    );
    assert.ok(
      !actions.some((action) => /ke-1\b(?!.*ke-2)/.test(action)),
      'attempts 1 and 2 were not split apart - the source gives them one behaviour'
    );
  });

  it('keeps the search control obligation alongside each filter behaviour', async () => {
    const result = await generate(branchedLlmResponse());

    const search = result.test_cases.filter((testCase) =>
      testCase.requirement_ids.includes('REQ-002')
    );

    assert.equal(search.length, 4, 'one configuration case plus three filter behaviours');

    const configuration = search.find((testCase) =>
      /dropdown Settlement Status/i.test(testCase.test_case)
    );
    assert.ok(configuration, 'the control-exists case was not replaced by the behaviours');
    assert.match(
      configuration.test_case,
      /di bawah field Settlement Type/,
      'its stated placement survives'
    );
    assert.match(
      configuration.expected_result,
      /persis Settled, Unsettled, dan Settled & Unsettled/,
      'and the exact option list is what gets checked'
    );

    assert.deepEqual(
      search
        .filter((testCase) => testCase !== configuration)
        .map((testCase) => /"([^"]+)"/.exec(testCase.test_case)?.[1]),
      ['Settled', 'Unsettled', 'Settled & Unsettled'],
      'each behaviour case names the option it exercises'
    );
  });

  it('keeps the HOLD context, page scope and row limit of the selection cases', async () => {
    const result = await generate(branchedLlmResponse());

    const selection = result.test_cases.filter((testCase) =>
      testCase.requirement_ids.includes('REQ-003')
    );

    assert.equal(selection.length, 2, 'selecting and clearing are different actions');

    const [selectAll, clear] = selection;
    assert.match(selectAll.test_case, /Release/, 'the action that reaches the screen survives');
    assert.match(selectAll.test_case, /HOLD/, 'the settlement type survives');
    assert.match(selectAll.test_case, /halaman aktif/, 'the page scope survives');
    assert.match(selectAll.test_case, /10 baris/, 'and the stated page size');
    assert.match(
      selectAll.expected_result,
      /halaman lain tidak ikut terpilih/,
      'including what must NOT happen'
    );
    assert.match(clear.expected_result, /halaman lain tetap tidak terpengaruh/);
  });

  it('keeps the named core system and middleware on the integration case', async () => {
    const result = await generate(branchedLlmResponse());

    const integration = result.test_cases.find((testCase) =>
      testCase.requirement_ids.includes('REQ-004')
    );

    assert.match(integration.test_case, /CORE-T1/, 'the named core system survives');
    assert.match(integration.test_case, /MIDSVC/, 'and the middleware it travels through');
    assert.doesNotMatch(
      integration.test_case,
      /core banking/i,
      'the named path was not generalised into its category'
    );

    // The mapping is what is tested; the identifier printed in the document's
    // illustration is not an expected value.
    assert.match(integration.expected_result, /sesuai mapping response/);
    assert.doesNotMatch(
      integration.expected_result,
      /250101ABCDEF/,
      'the specimen reference number did not become an assertion'
    );
  });

  /**
   * Tightly coupled criteria, kept together. One scheduled generation run
   * produces one file, and the schedule, window, contents, naming, format and
   * cleanup are all confirmed from that one run - so this is one case, and
   * splitting it per condition would be the over-correction.
   */
  it('keeps the stated report conditions together in one executable case', async () => {
    const result = await generate(branchedLlmResponse());

    const report = result.test_cases.filter((testCase) =>
      testCase.requirement_ids.includes('REQ-005')
    );

    assert.equal(report.length, 1, 'one generation run, not one case per condition');

    const [daily] = report;
    assert.match(daily.test_case, /03\.00 AM/, 'the schedule survives');
    assert.match(daily.test_case, /tanpa intervensi manual/);
    assert.match(
      daily.expected_result,
      /SETTLEMENT_QRMANAGER_DDMMYYYY\.txt/,
      'the file name pattern'
    );
    assert.match(daily.expected_result, /Transaction Date/);
    assert.match(daily.expected_result, /tilde/, 'the delimiter');
    assert.match(daily.expected_result, /00\.00-23\.59/, 'the day window');
    assert.match(daily.expected_result, /H\+1/);
    assert.match(daily.expected_result, /On Hold/);
    assert.match(
      daily.expected_result,
      /tidak menyisakan file \.tmp/,
      'and what must not be left behind'
    );

    // "dengan cepat" in the source is not a threshold, and nothing asserts one.
    assert.doesNotMatch(daily.expected_result, /\d+\s*(detik|second|ms)/i);
  });

  /**
   * Measured, and the exact figures are pinned because they are the evidence.
   *
   * The split batch misses exactly ONE obligation, and it is a correct miss: a
   * REQ-005 rejection path. The source states no failure outcome for the
   * scheduled report, so writing a case for it would be invention, which the
   * instruction forbids. An uncovered obligation reported honestly is the wanted
   * result here.
   *
   * It used to miss two. The other was a REQ-003 ui_action whose statement was
   * the whole opening sentence - a longer restatement of two obligations already
   * covered, which this comment called "a known artefact of pattern-derived
   * obligations, not an untested behaviour". It is no longer derived: a coarse
   * reading of a line that a named detector has already read is now dropped in
   * favour of that reading, so the artefact stopped being a gap a reviewer was
   * asked to close.
   *
   * The denominator was 12 until obligations stopped being read out of the
   * requirement title. The twelfth was "UI behaviour: Advanced Search filter
   * Settlement Status" - REQ-002's heading, restated. A title is the one part of
   * a requirement the structuring model writes rather than rebuilds from source,
   * so it varied between runs over one document and moved the coverage
   * denominator with it. Losing it costs no behaviour: it was a paraphrase of a
   * heading, and REQ-002's actual filter behaviours are declarative Indonesian
   * prose that no detector reads - a pre-existing gap this change neither
   * created nor closed.
   */
  it('reaches far more obligations than the collapsed batch', async () => {
    const collapsed = await generate(collapsedLlmResponse());
    const branched = await generate(branchedLlmResponse());

    const matchesFor = (result) => matchObligations(branchingObligations, result.test_cases);
    const coveredIn = (result) => matchesFor(result).filter((entry) => entry.covered).length;

    assert.equal(collapsed.test_cases.length, 3, 'one case per requirement, as observed');
    assert.equal(branched.test_cases.length, 12);

    assert.equal(coveredIn(collapsed), 2, 'three oversized rows reach two obligations');
    assert.equal(coveredIn(branched), 9, 'the split batch reaches nine of ten');
    assert.equal(branchingObligations.length, 10);

    const missed = matchesFor(branched).filter((entry) => !entry.covered);
    assert.deepEqual(
      missed.map((entry) => `${entry.requirement_id}:${entry.type}`),
      ['REQ-005:rejection'],
      'and the one it misses is the failure path the source never states'
    );
  });

  it('still removes a case that repeats an action already covered', async () => {
    const result = await generate(overSplitLlmResponse());

    assert.equal(result.test_cases.length, 12, 'the repeat was dropped, the twelve scenarios kept');
    assert.equal(result.metadata.duplicates_removed, 1);
    assert.ok(
      result.warnings.some(
        (warning) => warning.code === GENERATION_WARNINGS.DUPLICATE_TEST_CASE_REMOVED
      ),
      'and the removal is announced rather than silent'
    );
  });

  it('assigns a dense run of ids across the split batch', async () => {
    const result = await generate(branchedLlmResponse());

    assert.deepEqual(
      result.test_cases.map((testCase) => testCase.case_id),
      Array.from({ length: 12 }, (_, index) => `TC-${String(index + 1).padStart(3, '0')}`),
      'splitting does not disturb system-owned numbering'
    );
    assert.equal(result.metadata.requirements_covered, 5);
  });

  it('derives every source reference from the cited requirement, never from the reply', async () => {
    const response = branchedLlmResponse();
    response.test_cases[0].case_id = 'TC-999';
    response.test_cases[0].source_references = [
      { document_id: 'DOC-666', page: 99, section: 'Invented', quote: 'Invented quote' },
    ];
    response.test_cases[0].requirement_ids = ['REQ-001', 'REQ-404'];

    const result = await generate(response);
    const canonical = branchingCanonicalInput();
    const known = new Map(
      canonical.requirements.map((requirement) => [
        requirement.requirement_id,
        requirement.source_references,
      ])
    );

    assert.equal(result.test_cases[0].case_id, 'TC-001', 'ids stay system-assigned');

    for (const testCase of result.test_cases) {
      assert.ok(testCase.requirement_ids.length > 0, 'every case still traces to a requirement');

      for (const requirementId of testCase.requirement_ids) {
        assert.ok(known.has(requirementId), `${requirementId} is a real requirement`);
      }

      const expected = testCase.requirement_ids.flatMap((id) =>
        known.get(id).map((reference) => `${reference.document_id}|${reference.section}`)
      );
      for (const reference of testCase.source_references) {
        assert.ok(
          expected.includes(`${reference.document_id}|${reference.section}`),
          'the reference came from the cited requirement, not the reply'
        );
      }
    }

    assert.ok(
      result.test_cases.every((testCase) =>
        testCase.source_references.every((reference) => reference.document_id !== 'DOC-666')
      ),
      'the invented reference never reached the canonical object'
    );
    assert.ok(
      result.test_cases[0].warnings.some(
        (warning) => warning.code === GENERATION_WARNINGS.UNKNOWN_REQUIREMENT_REFERENCE
      ),
      'and the invented requirement id was reported, not silently dropped'
    );
  });
});

/**
 * Qualifiers, end to end.
 *
 * Two were measured as lost on a real PRD run: "(Date using Transaction Date)"
 * and "via MW (mscore*)". Both are a few words in brackets, and both decide
 * whether a test passes for the right reason - a file named from the run date
 * instead of the transaction date is a different file, and a call that reaches
 * the core system by another route is a different integration.
 *
 * This follows them along the path they were lost on: structured requirement ->
 * generator prompt -> assembled test case. The prompt half is enforceable; the
 * case half proves nothing downstream strips them once a model has kept them.
 */
describe('qualifiers survive from requirement to test case', () => {
  function qualifiedCanonical() {
    return {
      project: { project_name: 'Settlement Report' },
      documents: [
        {
          document_id: 'DOC-001',
          filename: 'PRD Settlement (synthetic).pdf',
          document_type: 'PRD',
          status: 'Extracted',
          page_count: 12,
          extracted_char_count: 4000,
        },
      ],
      requirements: [
        {
          requirement_id: 'REQ-001',
          title: 'Daily report file naming',
          description:
            'Use SETTLEMENT_REPORT_DDMMYYYY.txt as file name format (Date using Transaction Date) and generate the file in .txt format using a tilde ~ as the delimiter.',
          category: 'Constraint',
          source_references: [
            { document_id: 'DOC-001', page: 6, section: 'Daily Report', quote: null },
          ],
          ambiguities: [],
          conflicts: [],
        },
        {
          requirement_id: 'REQ-002',
          title: 'Status verification call path',
          description:
            'Call Check Status to the core system via MW (mscore*) to verify the actual state of the transaction.',
          category: 'Integration/Dependency',
          source_references: [
            { document_id: 'DOC-001', page: 8, section: 'Check Status', quote: null },
          ],
          ambiguities: [],
          conflicts: [],
        },
      ],
      test_cases: [],
    };
  }

  function qualifiedReply() {
    return {
      project: {
        project_description: 'Settlement reporting with a scheduled daily file.',
        project_summary: 'Covers daily report naming and the status verification call path.',
        qa_guidance:
          'Confirm the file name date basis and the middleware the call travels through.',
        sit_scope: [
          'Daily Report: file naming and format conditions',
          'Integration: the status verification call path',
          'Delimiters: tilde separated output',
        ],
        project_background: 'SIT for the settlement report change.',
      },
      test_cases: [
        {
          requirement_ids: ['REQ-001'],
          section: 'Daily Report',
          test_case:
            'Verify the daily report file is named SETTLEMENT_REPORT_DDMMYYYY.txt using the Transaction Date.',
          case_type: 'Positive',
          edge_polarity: null,
          priority: 'High',
          type: 'Functional',
          expected_result:
            'The file name uses the Transaction Date, not the generation date, and the content is tilde ~ delimited .txt.',
          confidence: 'High',
          warnings: [],
        },
        {
          requirement_ids: ['REQ-002'],
          section: 'Integration',
          test_case:
            'Verify Check Status reaches the core system via MW (mscore*) for a pending transaction.',
          case_type: 'Positive',
          edge_polarity: null,
          priority: 'Critical',
          type: 'Functional',
          expected_result:
            'The Check Status call travels through MW (mscore*) and returns the actual transaction state.',
          confidence: 'High',
          warnings: [],
        },
      ],
      warnings: [],
    };
  }

  it('sends both qualifiers to the generator', () => {
    const prompt = buildPrompt(qualifiedCanonical());

    assert.match(prompt, /\(Date using Transaction Date\)/, 'the file-name date basis is sent');
    assert.match(prompt, /via MW \(mscore\*\)/, 'the middleware component is sent');
  });

  it('keeps the Transaction Date basis on the assembled case', async () => {
    const result = await generate(qualifiedReply(), qualifiedCanonical());
    const naming = result.test_cases.find((testCase) =>
      testCase.requirement_ids.includes('REQ-001')
    );

    assert.match(naming.test_case, /Transaction Date/);
    assert.match(
      naming.expected_result,
      /not the generation date/,
      'and says which date it is NOT, so the case can fail for the right reason'
    );
  });

  it('keeps the named middleware on the assembled case', async () => {
    const result = await generate(qualifiedReply(), qualifiedCanonical());
    const integration = result.test_cases.find((testCase) =>
      testCase.requirement_ids.includes('REQ-002')
    );

    assert.match(integration.test_case, /mscore/);
    assert.match(integration.expected_result, /MW \(mscore\*\)/);
    assert.doesNotMatch(
      integration.test_case,
      /\bcore banking\b/i,
      'the named path was not generalised into its category'
    );
  });

  it('assigns dense ids and system-derived references to both', async () => {
    const result = await generate(qualifiedReply(), qualifiedCanonical());

    assert.deepEqual(
      result.test_cases.map((testCase) => testCase.case_id),
      ['TC-001', 'TC-002']
    );
    assert.deepEqual(
      result.test_cases.map((testCase) => testCase.source_references[0].section),
      ['Daily Report', 'Check Status'],
      'references still come from the cited requirement'
    );
  });
});
