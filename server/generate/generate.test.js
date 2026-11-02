import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { generateFromRequirements, GENERATION_ERRORS } from './index.js';
import { GENERATION_WARNINGS } from './assemble.js';
import { CLASSIFICATION_WARNINGS } from '../schema/classification.js';
import { buildPrompt, systemInstruction } from './prompt.js';
import { llmResponse, parseTestCases, RESPONSE_SCHEMA } from './contract.js';
import { toGeminiSchema } from '../llm/gemini.js';
import { MockProvider } from '../llm/mock.js';
import { LlmError, LLM_ERRORS } from '../llm/provider.js';
import { sampleCanonicalInput, sampleLlmResponse } from './fixtures/sample-input.js';
import { deriveChecklist } from '../scenario/checklist.js';
import { buildCoverage } from '../schema/canonical.js';
import { reviewSemantics } from '../semantic/index.js';

/**
 * Generation, with the provider replaced by a script.
 *
 * Every test here is a pure function of a canned reply, so the suite never
 * touches the network, never needs a key and never costs anything. The live
 * provider is exercised separately and only on request - see gemini.live.test.js.
 */

function provider(responses) {
  return new MockProvider({ responses });
}

async function generate(response, canonical = sampleCanonicalInput()) {
  return generateFromRequirements(canonical, { provider: provider(response) });
}

async function failure(promise) {
  try {
    await promise;
    assert.fail('Expected generation to fail.');
  } catch (error) {
    return error;
  }
}

describe('the happy path', () => {
  it('produces project outputs and test cases', async () => {
    const result = await generate(sampleLlmResponse());

    assert.equal(result.test_cases.length, 5);
    assert.equal(result.project.project_name, 'BI-FAST Overdraft');
    assert.match(result.project.project_description, /BI-FAST Overdraft/);
    assert.equal(result.project.sit_scope.length, 3);
    assert.ok(result.project.qa_guidance.length > 0);
    assert.ok(result.project.project_background.length > 0);
  });

  it('assigns case ids itself, densely and in order', async () => {
    const result = await generate(sampleLlmResponse());

    assert.deepEqual(
      result.test_cases.map((testCase) => testCase.case_id),
      ['TC-001', 'TC-002', 'TC-003', 'TC-004', 'TC-005']
    );
    assert.deepEqual(
      result.test_cases.map((testCase) => testCase.order_index),
      [0, 1, 2, 3, 4]
    );
  });

  it('reports what it did', async () => {
    const result = await generate(sampleLlmResponse());

    assert.equal(result.metadata.provider, 'Mock');
    assert.equal(result.metadata.requirement_count, 4);
    assert.equal(result.metadata.test_case_count, 5);
    assert.equal(result.metadata.requirements_covered, 3);
  });

  it('leaves execution fields blank for the tester to fill in', async () => {
    const result = await generate(sampleLlmResponse());

    for (const testCase of result.test_cases) {
      assert.equal(testCase.status, null);
      assert.equal(testCase.tested_by, null);
    }
  });
});

describe('the input boundary', () => {
  it('sends the requirements and nothing but the requirements', () => {
    const canonical = sampleCanonicalInput();
    const prompt = buildPrompt(canonical);

    // Every requirement, with its evidence, is present...
    for (const requirement of canonical.requirements) {
      assert.ok(prompt.includes(requirement.requirement_id), 'requirement id is sent');
      assert.ok(prompt.includes(requirement.description), 'requirement text is sent');
    }
    assert.ok(prompt.includes('Field: BIC Code | Rule: Mandatory'), 'source quote is sent');
    assert.ok(prompt.includes('PRD Overdraft.docx'), 'document name is sent for traceability');

    // ...and the prompt is built from the canonical object alone. There is no
    // path from a raw upload to here: the buffers were discarded by extraction.
    assert.ok(!('raw_text' in canonical), 'canonical carries no raw document text');
  });

  it('tells the model the conflict exists without resolving it', () => {
    const prompt = buildPrompt(sampleCanonicalInput());

    assert.match(prompt, /unresolved_conflicts/);
    assert.match(prompt, /DOC-001 states 300 transactions; DOC-002 states 500 transactions/);
  });

  it('forbids invention in the instruction, not just in review', () => {
    const system = systemInstruction();

    assert.match(system, /never invent/i);
    assert.match(system, /response or error codes/i);
    assert.match(system, /INSUFFICIENT_INFORMATION/);
  });

  /**
   * Both of these instructions were rewritten after a synthetic evaluation
   * showed what the earlier wording produced. They are asserted here because a
   * well-meaning tidy-up of the prompt would silently reintroduce the defect,
   * and neither failure is visible in the generated JSON's shape.
   */
  it('defines edge polarity by the expected outcome, not by the input value', () => {
    const system = systemInstruction();

    assert.match(system, /EXPECTED OUTCOME/);
    assert.match(
      system,
      /triggers a restriction is always "invalid"/,
      'the threshold-lockout case is spelled out'
    );
  });

  it('asks for expected results that distinguish one case from another', () => {
    const system = systemInstruction();

    assert.match(system, /Name what makes THIS case different/);
    assert.match(
      system,
      /Include only values the source actually states/,
      'specificity must not become licence to invent'
    );
  });

  /**
   * The checklist is derived from the requirements and rendered into the
   * prompt. It is guidance, and the instruction that fences it in matters as
   * much as the list itself - a bare column of numbers reads as a demand to
   * produce a case per line, which is how invented error codes get written.
   */
  it('renders the derived checklist into the prompt', () => {
    const canonical = sampleCanonicalInput();
    const checklist = deriveChecklist(canonical.requirements);
    const prompt = buildPrompt(canonical, checklist);

    assert.ok(checklist.length > 0, 'the fixture has something worth listing');
    assert.match(prompt, /Coverage checklist, derived mechanically/);
    assert.match(prompt, /REQ-003/, 'the batch limit requirement is listed');
    assert.match(prompt, /500 \(maximum\)/, 'with the bound it states');
  });

  it('tells the model the checklist is not permission to invent', () => {
    const prompt = buildPrompt(
      sampleCanonicalInput(),
      deriveChecklist(sampleCanonicalInput().requirements)
    );

    assert.match(prompt, /NOT permission to invent/);
    assert.match(prompt, /INSUFFICIENT_INFORMATION for that requirement/);
    assert.match(prompt, /not exhaustive/);
  });

  it('builds a valid prompt when the checklist is empty', () => {
    const prompt = buildPrompt(sampleCanonicalInput(), []);

    assert.doesNotMatch(prompt, /Coverage checklist/, 'no empty section is emitted');
    assert.match(prompt, /Extracted requirements/, 'the rest of the prompt is unaffected');
  });

  it('reports how many checklist entries were derived', async () => {
    const result = await generate(sampleLlmResponse());

    assert.equal(typeof result.metadata.checklist_entries, 'number');
    assert.ok(result.metadata.checklist_entries > 0);
  });

  it('rejects a malformed requirement instead of crashing on it', async () => {
    // The canonical object is posted in by the browser, so it is untrusted.
    // This once reached prompt building and became a bare 500.
    const canonical = sampleCanonicalInput();
    canonical.requirements = [{ requirement_id: 'REQ-001', title: 'No source references' }];

    const error = await failure(generate(sampleLlmResponse(), canonical));

    assert.equal(error.code, GENERATION_ERRORS.INVALID_REQUIREMENTS);
    assert.equal(error.statusCode, 400);
    assert.ok(error.details.length > 0);
  });

  it('checks the input before spending a call on it', async () => {
    const mock = new MockProvider({ responses: sampleLlmResponse() });
    const canonical = sampleCanonicalInput();
    canonical.requirements = [{ requirement_id: 'nonsense' }];

    await failure(generateFromRequirements(canonical, { provider: mock }));

    assert.equal(mock.calls.length, 0, 'the provider was never called');
  });

  it('refuses to generate with no requirements', async () => {
    const error = await failure(
      generate(sampleLlmResponse(), { ...sampleCanonicalInput(), requirements: [] })
    );

    assert.equal(error.code, GENERATION_ERRORS.NO_REQUIREMENTS);
    assert.equal(error.statusCode, 422);
  });
});

describe('traceability', () => {
  it('derives source references from the requirements a case cites', async () => {
    const result = await generate(sampleLlmResponse());
    const batchCase = result.test_cases.find((testCase) =>
      testCase.requirement_ids.includes('REQ-003')
    );

    assert.deepEqual(batchCase.source_references, [
      {
        document_id: 'DOC-002',
        page: 2,
        section: 'Batch Size Limits',
        quote: 'Maximum 500 transactions per batch.',
      },
    ]);
  });

  it('cannot fabricate a source reference, because it never writes one', async () => {
    const canonical = sampleCanonicalInput();
    const documentIds = new Set(canonical.documents.map((document) => document.document_id));

    // The contract has no source_references field at all, so a model inventing
    // one has nowhere to put it.
    const invented = sampleLlmResponse();
    invented.test_cases[0].source_references = [
      { document_id: 'DOC-999', page: 41, section: 'Invented', quote: 'Never said' },
    ];

    const result = await generate(invented, canonical);

    for (const testCase of result.test_cases) {
      for (const reference of testCase.source_references) {
        assert.ok(documentIds.has(reference.document_id), 'every reference names a real document');
      }
    }
    assert.ok(
      !JSON.stringify(result.test_cases).includes('DOC-999'),
      'the invented reference did not survive'
    );
  });

  it('drops a citation to a requirement that does not exist, and says so', async () => {
    const response = sampleLlmResponse();
    response.test_cases[0].requirement_ids = ['REQ-001', 'REQ-404'];

    const result = await generate(response);
    const testCase = result.test_cases[0];

    assert.deepEqual(testCase.requirement_ids, ['REQ-001']);
    assert.ok(
      testCase.warnings.some(
        (warning) => warning.code === GENERATION_WARNINGS.UNKNOWN_REQUIREMENT_REFERENCE
      ),
      'the removal is reported on the case, not silent'
    );
  });

  it('flags a test case that traces back to nothing', async () => {
    const response = sampleLlmResponse();
    response.test_cases[0].requirement_ids = ['REQ-404'];

    const result = await generate(response);

    assert.ok(
      result.test_cases[0].warnings.some(
        (warning) => warning.code === GENERATION_WARNINGS.UNTRACEABLE_TEST_CASE
      )
    );
  });
});

describe('insufficient information', () => {
  it('keeps the warning for a requirement too thin to test', async () => {
    const result = await generate(sampleLlmResponse());

    const warning = result.warnings.find(
      (entry) => entry.requirement_id === 'REQ-004' && entry.code === 'INSUFFICIENT_INFORMATION'
    );

    assert.ok(warning, 'REQ-004 is reported as underspecified');
    assert.match(warning.message, /sesuai kebutuhan/);
  });

  it('reports an uncovered requirement even when the model said nothing', async () => {
    const response = sampleLlmResponse();
    response.warnings = [];

    const result = await generate(response);

    assert.ok(
      result.warnings.some(
        (warning) =>
          warning.code === GENERATION_WARNINGS.REQUIREMENT_NOT_COVERED &&
          warning.requirement_id === 'REQ-004'
      ),
      'silence about an uncovered requirement is itself reported'
    );
  });

  it('does not double-report a requirement the model already explained', async () => {
    const result = await generate(sampleLlmResponse());

    const forReq004 = result.warnings.filter((warning) => warning.requirement_id === 'REQ-004');
    assert.equal(forReq004.length, 1);
  });

  it('fails rather than return an empty generation', async () => {
    const response = sampleLlmResponse();
    response.test_cases = [];

    const error = await failure(generate(response));

    assert.equal(error.code, GENERATION_ERRORS.EMPTY);
    assert.equal(error.statusCode, 422);
  });
});

describe('duplicate removal', () => {
  it('removes a reworded repeat of the same action', async () => {
    const response = sampleLlmResponse();
    response.test_cases.push({
      ...response.test_cases[1],
      test_case: 'verify penolakan transaksi ketika field BIC Code dikosongkan!',
    });

    const result = await generate(response);

    assert.equal(result.test_cases.length, 5, 'the repeat was dropped');
    assert.equal(result.metadata.duplicates_removed, 1);
  });

  it('keeps a differently worded case rather than judging it a duplicate', async () => {
    // Deciding that two differently worded actions mean the same thing is a
    // judgement about meaning. Semantic review makes it and reports it; this
    // layer keeps both, because deleting the wrong one is unrecoverable.
    const response = sampleLlmResponse();
    response.test_cases.push({
      ...response.test_cases[2],
      test_case: 'Verify that a transfer to a Suspended participant bank is not forwarded.',
      expected_result: 'Transaksi ditolak dan tidak diteruskan ke BI-FAST.',
    });

    const result = await generate(response);

    assert.equal(result.test_cases.length, 6, 'the differently worded case survived');
    assert.equal(result.metadata.duplicates_removed, 0);
  });

  it('names what it removed instead of only counting it', async () => {
    const response = sampleLlmResponse();
    response.test_cases.push({ ...response.test_cases[1] });

    const result = await generate(response);
    const warning = result.warnings.find(
      (entry) => entry.code === GENERATION_WARNINGS.DUPLICATE_TEST_CASE_REMOVED
    );

    assert.ok(warning, 'the removal was reported');
    assert.match(
      warning.message,
      /Verify penolakan transaksi ketika field BIC Code dikosongkan/,
      'the reviewer can see which action was dropped'
    );
  });

  it('keeps the two sides of a boundary, which are not duplicates', async () => {
    const result = await generate(sampleLlmResponse());

    const edges = result.test_cases.filter((testCase) => testCase.case_type === 'Edge');
    assert.deepEqual(
      edges.map((testCase) => testCase.edge_polarity),
      ['valid', 'invalid']
    );
  });

  /**
   * The regression that motivated the rewrite.
   *
   * Both ends of one limit are accepted, so both say "submitted successfully".
   * Keying duplicates on the outcome made the maximum a duplicate of the
   * minimum and deleted it, leaving a workbook that tested one bound and
   * claimed to test the limit.
   */
  it('keeps minimum and maximum boundaries that share an expected result', async () => {
    const response = sampleLlmResponse();
    const boundary = (action, polarity, outcome) => ({
      requirement_ids: ['REQ-003'],
      section: 'Batch Limits',
      test_case: action,
      case_type: 'Edge',
      edge_polarity: polarity,
      priority: 'High',
      type: 'Functional',
      expected_result: outcome,
      confidence: 'High',
      warnings: [],
    });

    response.test_cases = [
      boundary(
        'Verify batch submission at the minimum of 1 transaction.',
        'valid',
        'Batch diproses sampai selesai.'
      ),
      boundary(
        'Verify batch submission at the maximum of 500 transactions.',
        'valid',
        'Batch diproses sampai selesai.'
      ),
      boundary('Verify batch rejection at 0 transactions.', 'invalid', 'Batch ditolak.'),
      boundary('Verify batch rejection at 501 transactions.', 'invalid', 'Batch ditolak.'),
    ];

    const result = await generate(response);

    assert.equal(result.test_cases.length, 4, 'no boundary was deleted');
    assert.equal(result.metadata.duplicates_removed, 0);
    assert.deepEqual(
      result.test_cases.map((testCase) => testCase.edge_polarity),
      ['valid', 'valid', 'invalid', 'invalid'],
      'both valid boundaries and both invalid boundaries survived'
    );
    assert.ok(
      result.test_cases.some((testCase) => /maximum of 500/.test(testCase.test_case)),
      'the maximum boundary is present'
    );
  });

  it('still removes an identical case, outcome text and all', async () => {
    const response = sampleLlmResponse();
    response.test_cases.push({ ...response.test_cases[3] });

    const result = await generate(response);

    assert.equal(result.test_cases.length, 5, 'the exact repeat was dropped');
    assert.equal(result.metadata.duplicates_removed, 1);
  });

  it('renumbers densely after a removal', async () => {
    const response = sampleLlmResponse();
    response.test_cases.splice(2, 0, { ...response.test_cases[1] });

    const result = await generate(response);

    assert.deepEqual(
      result.test_cases.map((testCase) => testCase.case_id),
      ['TC-001', 'TC-002', 'TC-003', 'TC-004', 'TC-005'],
      'no gap where the duplicate was'
    );
  });
});

describe('edge polarity', () => {
  /**
   * The policy these three encode: a classification QA can fix in a dropdown is
   * never worth deleting a draft over. The rule itself has not softened -
   * nothing below infers a polarity, converts a case type or clears a field -
   * and export still refuses to guess. What changed is that the reviewer now
   * gets the draft AND the warning, instead of neither.
   */
  it('keeps an Edge case with no polarity, and says so', async () => {
    const response = sampleLlmResponse();
    response.test_cases[3].edge_polarity = null;
    const action = response.test_cases[3].test_case;

    const result = await generate(response);

    assert.equal(result.test_cases.length, 5, 'nothing was dropped');

    const kept = result.test_cases.find((testCase) => testCase.test_case === action);
    assert.ok(kept, 'the draft survived');
    assert.equal(kept.case_type, 'Edge', 'not downgraded to Positive or Negative');
    assert.equal(kept.edge_polarity, null, 'and no polarity was invented for it');

    assert.ok(
      kept.warnings.some(
        (warning) => warning.code === CLASSIFICATION_WARNINGS.EDGE_POLARITY_MISSING
      ),
      'the case carries its own warning'
    );
    assert.ok(
      result.warnings.some(
        (warning) => warning.code === GENERATION_WARNINGS.CLASSIFICATION_REVIEW_REQUIRED
      ),
      'and the run summarises it'
    );
  });

  it('keeps a polarity on a non-Edge case without nulling it', async () => {
    const response = sampleLlmResponse();
    response.test_cases[0].edge_polarity = 'valid';

    const result = await generate(response);

    assert.equal(result.test_cases.length, 5);
    assert.equal(result.metadata.discarded_invalid, 0, 'nothing was discarded');

    const kept = result.test_cases[0];
    assert.equal(kept.case_type, 'Positive');
    assert.equal(kept.edge_polarity, 'valid', 'left exactly as drafted');
    assert.ok(
      kept.warnings.some(
        (warning) => warning.code === CLASSIFICATION_WARNINGS.EDGE_POLARITY_ON_NON_EDGE
      )
    );
  });

  it('keeps a polarity value outside the vocabulary and quotes it back', async () => {
    const response = sampleLlmResponse();
    response.test_cases[3].edge_polarity = 'borderline';

    const result = await generate(response);

    const kept = result.test_cases.find((testCase) => testCase.edge_polarity === 'borderline');
    assert.ok(kept, 'the value survives unchanged');

    const warning = kept.warnings.find(
      (entry) => entry.code === CLASSIFICATION_WARNINGS.UNRECOGNIZED_EDGE_POLARITY
    );
    assert.equal(warning.observed_value, 'borderline');
    assert.equal(warning.field, 'edge_polarity');
  });

  it('leaves a well-classified batch completely unflagged', async () => {
    const result = await generate(sampleLlmResponse());

    assert.equal(result.metadata.flagged_for_review, 0);
    for (const testCase of result.test_cases) {
      assert.deepEqual(
        testCase.warnings.filter((warning) => warning.field),
        [],
        `${testCase.case_id} has no classification warning`
      );
    }
  });
});

describe('unrecognised vocabulary', () => {
  it('keeps a case type outside the vocabulary rather than correcting it', async () => {
    const response = sampleLlmResponse();
    response.test_cases[0].case_type = 'Positiv';

    const result = await generate(response);

    assert.equal(result.test_cases.length, 5, 'the batch is intact');
    assert.equal(result.test_cases[0].case_type, 'Positiv', 'not silently corrected');

    const warning = result.test_cases[0].warnings.find(
      (entry) => entry.code === CLASSIFICATION_WARNINGS.UNRECOGNIZED_CASE_TYPE
    );
    assert.ok(warning);
    assert.equal(warning.observed_value, 'Positiv');
    assert.match(warning.message, /Positive \/ Negative \/ Edge/, 'QA is told what is expected');
  });

  it('keeps a priority outside the vocabulary rather than mapping it', async () => {
    const response = sampleLlmResponse();
    response.test_cases[0].priority = 'Urgent';

    const result = await generate(response);

    assert.equal(result.test_cases.length, 5);
    assert.equal(result.test_cases[0].priority, 'Urgent', 'not mapped onto High');
    assert.ok(
      result.test_cases[0].warnings.some(
        (entry) => entry.code === CLASSIFICATION_WARNINGS.UNRECOGNIZED_PRIORITY
      )
    );
  });

  /** Type has no template dropdown and no enum by design - it is not a mistake. */
  it('says nothing about an unusual free-form Type', async () => {
    const response = sampleLlmResponse();
    response.test_cases[0].type = 'Reconciliation Integration';

    const result = await generate(response);

    assert.equal(result.test_cases[0].type, 'Reconciliation Integration');
    assert.equal(result.metadata.flagged_for_review, 0);
  });

  it('names the flagged cases by their final id, not a pre-renumber one', async () => {
    const response = sampleLlmResponse();
    response.test_cases[2].priority = 'Urgent';

    const result = await generate(response);

    const summary = result.warnings.find(
      (entry) => entry.code === GENERATION_WARNINGS.CLASSIFICATION_REVIEW_REQUIRED
    );

    const flagged = result.test_cases.filter((testCase) =>
      testCase.warnings.some((warning) => warning.field === 'priority')
    );
    assert.equal(flagged.length, 1);
    assert.match(summary.message, new RegExp(flagged[0].case_id), 'the id resolves to a real case');
  });
});

/**
 * The Set C regression.
 *
 * A live run on gemini-3.5-flash-lite put edge_polarity on a Positive case and
 * the whole generation was thrown away - eight requirements' worth of work lost
 * to one field, and one of twenty daily requests with it. The cause was our own
 * provider schema marking the field required with a non-null enum while the
 * instruction said Positive and Negative carry null.
 */
/**
 * The policy in one run: three kinds of case in one reply, and each treated
 * according to what is actually wrong with it rather than by a single rule.
 */
describe('a mixed batch', () => {
  function mixedResponse() {
    const response = sampleLlmResponse();
    response.test_cases[0].case_type = 'Positiv'; // questionable label
    response.test_cases[3].edge_polarity = null; // unresolved classification
    response.test_cases[4].expected_result = '   '; // unprocessable
    return response;
  }

  it('keeps the clean and the questionable, and drops only the unprocessable', async () => {
    const result = await generate(mixedResponse());

    assert.equal(result.test_cases.length, 4, 'one of five was discarded');
    assert.equal(result.metadata.discarded_invalid, 1);
    assert.equal(result.metadata.flagged_for_review, 2);

    assert.ok(
      result.test_cases.some((testCase) => testCase.case_type === 'Positiv'),
      'the odd label survived'
    );
    assert.ok(
      result.test_cases.some(
        (testCase) => testCase.case_type === 'Edge' && testCase.edge_polarity === null
      ),
      'the unresolved Edge survived'
    );
  });

  it('numbers the survivors densely, flagged ones included', async () => {
    const result = await generate(mixedResponse());

    assert.deepEqual(
      result.test_cases.map((testCase) => testCase.case_id),
      ['TC-001', 'TC-002', 'TC-003', 'TC-004']
    );
  });

  it('keeps traceability system-owned on a flagged case', async () => {
    const canonical = sampleCanonicalInput();
    const result = await generate(mixedResponse(), canonical);

    const requirementIds = new Set(canonical.requirements.map((req) => req.requirement_id));
    const documentIds = new Set(canonical.documents.map((doc) => doc.document_id));

    const flagged = result.test_cases.find((testCase) => testCase.case_type === 'Positiv');
    assert.ok(flagged.requirement_ids.every((id) => requirementIds.has(id)));
    assert.ok(flagged.source_references.every((ref) => documentIds.has(ref.document_id)));
    assert.ok(flagged.source_references.length > 0, 'a warning does not cost it its evidence');
  });

  /**
   * A flagged case is a real test case. Excluding it from coverage would
   * understate the work as badly as miscounting it would overstate it - and it
   * would make a classification warning quietly change a coverage number.
   */
  it('counts flagged cases in coverage, and says how many are unresolved', async () => {
    const input = sampleCanonicalInput();
    const result = await generate(mixedResponse(), input);

    const coverage = buildCoverage({ ...input, test_cases: result.test_cases });
    const covered = new Set(coverage.entries.flatMap((entry) => entry.case_ids));

    for (const testCase of result.test_cases) {
      if (testCase.requirement_ids.length === 0) continue;
      assert.ok(covered.has(testCase.case_id), `${testCase.case_id} is counted`);
    }

    assert.equal(coverage.summary.testcases_unresolved_classification, 2, 'uncertainty is stated');
  });

  it('leaves the reviewer advisory: findings change nothing', async () => {
    const input = sampleCanonicalInput();
    const result = await generate(mixedResponse(), input);
    const canonical = { ...input, project: result.project, test_cases: result.test_cases };

    const before = JSON.stringify(canonical.test_cases);
    const semantic = await reviewSemantics(canonical, { structurallyValid: true });

    assert.equal(JSON.stringify(canonical.test_cases), before, 'review mutated nothing');
    assert.ok(
      semantic.issues.some((issue) => issue.category === 'suspicious_case_type'),
      'but it did report the odd label'
    );
  });
});

describe('an unprocessable case does not cost the batch', () => {
  /**
   * What "unprocessable" means now that vocabulary mistakes are warnings: a
   * mandatory part of the case is simply absent. Without an expected result
   * there is nothing for a tester to verify and nothing to put in column G, so
   * the object is not a test case at all - as distinct from a test case
   * somebody labelled oddly, which is kept.
   */
  function withUnprocessableCase() {
    const response = sampleLlmResponse();
    response.test_cases[0].expected_result = '   ';
    return response;
  }

  it('keeps the usable cases and drops only the unprocessable one', async () => {
    const result = await generate(withUnprocessableCase());

    assert.equal(result.test_cases.length, 4, 'four of five survived');
    assert.equal(result.metadata.discarded_invalid, 1);
    assert.equal(result.metadata.test_case_count, 4);
  });

  it('renumbers the survivors densely, with no gap where the case was', async () => {
    const result = await generate(withUnprocessableCase());

    assert.deepEqual(
      result.test_cases.map((testCase) => testCase.case_id),
      ['TC-001', 'TC-002', 'TC-003', 'TC-004']
    );
    assert.deepEqual(
      result.test_cases.map((testCase) => testCase.order_index),
      [0, 1, 2, 3]
    );
  });

  it('reports what was discarded and why', async () => {
    const result = await generate(withUnprocessableCase());

    const warning = result.warnings.find(
      (entry) => entry.code === GENERATION_WARNINGS.INVALID_TEST_CASE_DISCARDED
    );

    assert.ok(warning, 'the loss is announced');
    assert.match(warning.message, /discarded rather than repaired/);
    assert.match(warning.message, /expected_result/, 'the reason names the field');
    assert.match(warning.message, /test case 1 of 5/, 'identified by position, not by a reused id');
  });

  it('repairs nothing: the discarded content is absent from the survivors', async () => {
    const response = withUnprocessableCase();
    const discarded = response.test_cases[0];
    const result = await generate(response);

    const survivors = JSON.stringify(result.test_cases);
    assert.ok(!survivors.includes(discarded.test_case), 'its action is gone');
    assert.ok(
      result.test_cases.every((testCase) => testCase.expected_result.trim().length > 0),
      'and no placeholder was written to make it pass'
    );
  });

  it('keeps the rest of the batch when one case is not even an object', async () => {
    const response = sampleLlmResponse();
    response.test_cases[1] = 'Verify the thing works';

    const result = await generate(response);

    assert.equal(result.test_cases.length, 4);
    assert.ok(
      result.warnings.some(
        (warning) =>
          warning.code === GENERATION_WARNINGS.INVALID_TEST_CASE_DISCARDED &&
          /test case 2 of 5/.test(warning.message)
      ),
      'the position is still reported'
    );
  });

  it('fails cleanly when every case is discarded', async () => {
    const response = sampleLlmResponse();
    for (const testCase of response.test_cases) {
      testCase.expected_result = '   ';
    }

    const error = await failure(generate(response));

    assert.equal(error.code, GENERATION_ERRORS.EMPTY);
  });

  it('keeps project-level validation fatal', async () => {
    const response = sampleLlmResponse();
    response.project.project_description = 'One sentence. And then a second one.';

    const error = await failure(generate(response));

    assert.equal(error.code, GENERATION_ERRORS.INVALID);
    assert.ok(
      error.details.some((issue) => issue.path.startsWith('project.')),
      'the reason is a project field, and no test case was salvaged'
    );
  });

  it('tells the truth about coverage when a discard leaves a requirement bare', async () => {
    const response = sampleLlmResponse();

    // TC-003 is the only case citing REQ-002. Break it beyond processing.
    const orphaned = response.test_cases[2];
    assert.deepEqual(orphaned.requirement_ids, ['REQ-002'], 'fixture assumption');
    orphaned.expected_result = '   ';

    const result = await generate(response);

    assert.ok(
      !result.test_cases.some((testCase) => testCase.requirement_ids.includes('REQ-002')),
      'nothing covers REQ-002 any more'
    );
    assert.ok(
      result.warnings.some(
        (warning) =>
          warning.code === GENERATION_WARNINGS.REQUIREMENT_NOT_COVERED &&
          warning.requirement_id === 'REQ-002'
      ),
      'and the gap is reported rather than hidden'
    );
  });
});

describe('the provider schema', () => {
  /**
   * The contract guard. Putting edge_polarity back into `required` would tell
   * the model to emit one of valid|invalid on every case, which is what caused
   * the Set C failure, and nothing else in the suite would notice.
   */
  it('does not demand edge_polarity on every case', () => {
    const required = RESPONSE_SCHEMA.properties.test_cases.items.required;

    assert.ok(!required.includes('edge_polarity'), 'it is conditional, so it cannot be required');
    assert.ok(required.includes('case_type'), 'the fields that are always present still are');
  });

  it('still sends the field as a nullable enum', () => {
    const sent =
      toGeminiSchema(RESPONSE_SCHEMA).properties.test_cases.items.properties.edge_polarity;

    assert.equal(sent.type, 'STRING');
    assert.equal(sent.nullable, true);
    assert.deepEqual(sent.enum, ['valid', 'invalid']);
    assert.match(sent.description, /^null for Positive and Negative/);
  });
});

describe('malformed output', () => {
  it('rejects a reply that is not the agreed shape', async () => {
    const error = await failure(generate({ nonsense: true }));

    assert.equal(error.code, GENERATION_ERRORS.MALFORMED_OUTPUT);
    assert.equal(error.statusCode, 502);
    assert.ok(error.details.length > 0, 'the mismatch is itemised');
  });

  /**
   * An invented vocabulary value is no longer a malformed reply. It is one
   * questionable field on one otherwise usable draft, and it is handled where
   * the blast radius is one row - see 'unrecognised vocabulary' above. What
   * stays fatal here is a reply that is not a reply.
   */
  it('discards a case with an empty expected result without failing the reply', async () => {
    const response = sampleLlmResponse();
    response.test_cases[0].expected_result = '   ';

    const result = await generate(response);

    assert.equal(result.test_cases.length, 4, 'the other four are unaffected');
    assert.equal(result.metadata.discarded_invalid, 1);
  });

  it('still fails when the project outputs are missing entirely', async () => {
    const response = sampleLlmResponse();
    delete response.project;

    const error = await failure(generate(response));
    assert.equal(error.code, GENERATION_ERRORS.MALFORMED_OUTPUT);
  });

  /**
   * A model volunteering an extra field is not a reason to throw away a whole
   * generation. The stripping moved with the per-case parse - the envelope
   * takes test cases as-is now so one bad case cannot fail the array - so this
   * checks both halves and, more importantly, that nothing unasked-for reaches
   * the canonical output at the far end.
   */
  it('ignores fields it did not ask for instead of failing on them', async () => {
    const response = sampleLlmResponse();
    response.test_cases[0].estimated_minutes = 12;
    response.project.confidence_score = 0.91;

    const parsed = llmResponse.safeParse(response);
    assert.ok(parsed.success);
    assert.ok(!('confidence_score' in parsed.data.project));

    const { kept, discarded } = parseTestCases(parsed.data.test_cases);
    assert.deepEqual(discarded, [], 'an extra field is not a structural failure');
    assert.ok(!('estimated_minutes' in kept[0]), 'and it is dropped rather than carried');

    const result = await generate(response);
    assert.ok(!JSON.stringify(result.test_cases).includes('estimated_minutes'));
  });

  it('defaults Type rather than inventing a taxonomy for it', async () => {
    const response = sampleLlmResponse();
    delete response.test_cases[0].type;

    const result = await generate(response);
    assert.equal(result.test_cases[0].type, 'Functional');
  });
});

describe('the one-sentence project description', () => {
  it('rejects two sentences', async () => {
    const response = sampleLlmResponse();
    response.project.project_description =
      'The project adds overdraft handling to BI-FAST. It also tightens validation.';

    const error = await failure(generate(response));

    assert.equal(error.code, GENERATION_ERRORS.INVALID);
    assert.ok(error.details.some((issue) => issue.path === 'project.project_description'));
  });

  it('accepts a sentence containing an abbreviation', async () => {
    const response = sampleLlmResponse();
    response.project.project_description =
      'PT. Bank Sinarmas Tbk. is adding overdraft handling to its BI-FAST outgoing transfer flow.';

    const result = await generate(response);
    assert.match(result.project.project_description, /^PT\. Bank Sinarmas/);
  });
});

describe('the project description length contract', () => {
  const oneSentenceOf = (length) =>
    `Enables ${'routing '.repeat(length)}`
      .slice(0, length - 1)
      .trimEnd()
      .padEnd(length - 1, 'x') + '.';

  it('states the 300 character limit to the model, in the prompt and in the schema', () => {
    assert.match(systemInstruction(), /AT MOST 300 characters/);
    assert.match(
      RESPONSE_SCHEMA.properties.project.properties.project_description.description,
      /at most 300 characters/
    );
    // The provider schema is a shaping aid: the limit must survive to the model as prose.
    assert.match(
      toGeminiSchema(RESPONSE_SCHEMA).properties.project.properties.project_description.description,
      /300/
    );
  });

  it('accepts a description of exactly 300 characters, unchanged', async () => {
    const description = oneSentenceOf(300);
    assert.equal(description.length, 300);
    const response = sampleLlmResponse();
    response.project.project_description = description;

    const result = await generate(response);

    assert.equal(result.project.project_description, description);
    assert.equal(result.test_cases.length, sampleLlmResponse().test_cases.length);
  });

  it('rejects 301 characters instead of shortening them, and returns no partial result', async () => {
    const response = sampleLlmResponse();
    response.project.project_description = oneSentenceOf(301);
    assert.equal(response.project.project_description.length, 301);

    const error = await failure(generate(response));

    assert.equal(error.code, GENERATION_ERRORS.INVALID);
    const issue = error.details.find((entry) => entry.path === 'project.project_description');
    assert.ok(issue, 'the offending field is named');
    assert.match(issue.message, /300 characters or fewer/);
  });

  it('treats an absurdly long description as a malformed reply, not as something to cut', async () => {
    const response = sampleLlmResponse();
    response.project.project_description = oneSentenceOf(700);

    const error = await failure(generate(response));

    assert.equal(error.code, GENERATION_ERRORS.MALFORMED_OUTPUT);
    assert.ok(error.details.some((entry) => entry.path === 'project.project_description'));
  });

  it('counts the trimmed text, so padding cannot hide an over-length sentence', async () => {
    const response = sampleLlmResponse();
    response.project.project_description = `   ${oneSentenceOf(301)}   `;

    const error = await failure(generate(response));

    assert.equal(error.code, GENERATION_ERRORS.INVALID);
  });
});

describe('provider failures', () => {
  const cases = [
    ['AUTH_FAILED', 502],
    ['RATE_LIMITED', 429],
    ['TIMEOUT', 504],
    ['UNAVAILABLE', 502],
    ['TRUNCATED', 502],
    ['REFUSED', 502],
  ];

  for (const [code, status] of cases) {
    it(`passes a ${code} failure through as a controlled error`, async () => {
      const error = await failure(
        generateFromRequirements(sampleCanonicalInput(), {
          provider: new MockProvider({
            failWith: new LlmError(LLM_ERRORS[code], `${code} happened.`, status),
          }),
        })
      );

      assert.equal(error.code, LLM_ERRORS[code]);
      assert.equal(error.statusCode, status);
    });
  }

  it('leaves the caller free to retry, having changed nothing', async () => {
    const canonical = sampleCanonicalInput();
    const before = JSON.stringify(canonical);

    await failure(
      generateFromRequirements(canonical, {
        provider: new MockProvider({
          failWith: new LlmError(LLM_ERRORS.RATE_LIMITED, 'Slow down.', 429),
        }),
      })
    );

    assert.equal(JSON.stringify(canonical), before, 'the input was not mutated');

    // The same object generates cleanly on the retry: nothing had to be
    // re-uploaded or re-extracted.
    const result = await generateFromRequirements(canonical, {
      provider: provider(sampleLlmResponse()),
    });
    assert.equal(result.test_cases.length, 5);
  });
});

/**
 * Test points from Gemini #1 reaching Gemini #2.
 *
 * They are guidance and nothing more: they steer the prompt, and they are
 * refused entry to everything the system owns. A caller who tampers with them
 * gets worse advice for the model, never a forged source reference or a case id
 * it chose itself.
 */
describe('test points from structuring', () => {
  const testPoints = [
    {
      requirement_id: 'REQ-001',
      type: 'branch',
      statement: 'A rejected BIC Code returns ADMI 002',
    },
    { requirement_id: 'REQ-003', type: 'bound', statement: 'A batch of exactly 500 is accepted' },
  ];

  it('renders them into the generation prompt, grouped by requirement', () => {
    const prompt = buildPrompt(sampleCanonicalInput(), [], [], testPoints);

    assert.match(prompt, /Test points identified when the source documents were structured/);
    assert.match(prompt, /^REQ-001:/m);
    assert.match(prompt, /A batch of exactly 500 is accepted/);
  });

  it('fences them so they cannot become permission to invent', () => {
    const prompt = buildPrompt(sampleCanonicalInput(), [], [], testPoints);

    assert.match(prompt, /they can be wrong or unreachable/);
    assert.match(prompt, /follow the requirement/);
    assert.match(prompt, /INSUFFICIENT_INFORMATION/);
  });

  it('emits no section at all when structuring produced none', () => {
    const prompt = buildPrompt(sampleCanonicalInput(), [], [], []);
    assert.doesNotMatch(prompt, /Test points identified/);
  });

  it('sends them to the model and reports how many were used', async () => {
    const mock = provider(sampleLlmResponse());
    const result = await generateFromRequirements(sampleCanonicalInput(), {
      provider: mock,
      testPoints,
    });

    assert.match(mock.calls[0].prompt, /A rejected BIC Code returns ADMI 002/);
    assert.equal(result.metadata.test_points_used, 2);
  });

  it('ignores a test point aimed at a requirement this project does not have', async () => {
    const mock = provider(sampleLlmResponse());
    const result = await generateFromRequirements(sampleCanonicalInput(), {
      provider: mock,
      testPoints: [
        { requirement_id: 'REQ-404', type: 'branch', statement: 'Invented behaviour' },
        ...testPoints,
      ],
    });

    assert.equal(result.metadata.test_points_used, 2, 'the unanchored one was dropped');
    assert.ok(!mock.calls[0].prompt.includes('Invented behaviour'));
  });

  it('never accepts source references or case ids from the model', async () => {
    const response = sampleLlmResponse();
    response.test_cases[0].case_id = 'TC-999';
    response.test_cases[0].source_references = [{ document_id: 'DOC-666', page: 1 }];

    const result = await generateFromRequirements(sampleCanonicalInput(), {
      provider: provider(response),
      testPoints,
    });

    assert.equal(result.test_cases[0].case_id, 'TC-001', 'ids stay system-assigned');
    assert.ok(
      result.test_cases.every((testCase) =>
        testCase.source_references.every((reference) => reference.document_id !== 'DOC-666')
      ),
      'references stay system-derived'
    );
  });

  it('generates exactly as before when no test points are supplied', async () => {
    const withOut = await generateFromRequirements(sampleCanonicalInput(), {
      provider: provider(sampleLlmResponse()),
    });

    assert.equal(withOut.test_cases.length, 5);
    assert.equal(withOut.metadata.test_points_used, 0);
  });
});
