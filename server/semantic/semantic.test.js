import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';

import { reviewSemantics } from './index.js';
import { outcomeOf, runHeuristics, technicalTokens } from './heuristics.js';
import { buildReviewPrompt, reviewInstruction } from './prompt.js';
import { generateFromRequirements } from '../generate/index.js';
import { sampleCanonicalInput, sampleLlmResponse } from '../generate/fixtures/sample-input.js';
import { buildCoverage } from '../schema/canonical.js';
import { MockProvider } from '../llm/mock.js';
import { LlmError, LLM_ERRORS } from '../llm/provider.js';

/**
 * Semantic validation, with the model replaced by a script.
 *
 * The starting point is a real generated project - the fixture requirements
 * run through the actual generation pipeline - so every test begins from the
 * shape the Results page really receives, and then introduces one problem.
 */

let generated;

before(async () => {
  const result = await generateFromRequirements(sampleCanonicalInput(), {
    provider: new MockProvider({ responses: sampleLlmResponse() }),
  });
  generated = { ...sampleCanonicalInput(), project: result.project, test_cases: result.test_cases };
});

/** A fresh copy, so no test can leak a mutation into another. */
function project() {
  return structuredClone(generated);
}

function caseById(canonical, caseId) {
  return canonical.test_cases.find((testCase) => testCase.case_id === caseId);
}

function reviewer(issues) {
  return new MockProvider({ responses: { issues } });
}

function llmIssue(overrides) {
  return {
    category: 'contradiction',
    severity: 'high',
    testcase_id: null,
    requirement_id: null,
    explanation: 'Placeholder explanation.',
    ...overrides,
  };
}

function find(issues, category, id) {
  return issues.find(
    (issue) =>
      issue.category === category && (issue.testcase_id === id || issue.requirement_id === id)
  );
}

describe('the clean case', () => {
  it('finds nothing wrong with a sound project', async () => {
    const { issues, status } = await reviewSemantics(project(), {
      useLlm: true,
      provider: reviewer([]),
    });

    assert.deepEqual(issues, []);
    assert.equal(status.heuristics, 'completed');
    assert.equal(status.llm, 'completed');
    assert.equal(status.provider, 'Mock');
  });

  it('has no deterministic findings on the generated fixture either', () => {
    assert.deepEqual(runHeuristics(project()), []);
  });
});

describe('contradiction', () => {
  it('surfaces a contradiction the reviewer reports, with both ids', async () => {
    const { issues } = await reviewSemantics(project(), {
      useLlm: true,
      provider: reviewer([
        llmIssue({
          category: 'contradiction',
          severity: 'high',
          testcase_id: 'TC-003',
          requirement_id: 'REQ-002',
          explanation:
            'REQ-002 says the transaction is rejected; TC-003 expects it to be forwarded.',
        }),
      ]),
    });

    const issue = find(issues, 'contradiction', 'TC-003');
    assert.ok(issue);
    assert.equal(issue.requirement_id, 'REQ-002');
    assert.equal(issue.severity, 'high');
    assert.deepEqual(issue.detected_by, ['llm']);
  });
});

describe('hallucinated detail', () => {
  it('flags an error code the cited requirement never mentions', async () => {
    const canonical = project();
    caseById(canonical, 'TC-002').expected_result =
      'Transaksi ditolak dengan error ADMI 005 dan tidak diteruskan ke BI-FAST.';

    const { issues } = await reviewSemantics(canonical);
    const issue = find(issues, 'unsupported_implementation_detail', 'TC-002');

    assert.ok(issue, 'the invented code is reported');
    assert.match(issue.explanation, /ADMI 005/);
    assert.deepEqual(issue.detected_by, ['heuristic']);
  });

  it('does not flag the code the requirement does state', () => {
    // TC-002 expects ADMI 002, which REQ-001 states verbatim.
    assert.equal(
      find(runHeuristics(project()), 'unsupported_implementation_detail', 'TC-002'),
      undefined
    );
  });

  it('flags an invented identifier in the test case itself', () => {
    const canonical = project();
    caseById(canonical, 'TC-001').test_case =
      'Verify transaksi berhasil ketika field beneficiaryBankCode diisi BIC Code 8 karakter.';

    const issue = find(runHeuristics(canonical), 'hallucinated_detail', 'TC-001');
    assert.ok(issue);
    assert.match(issue.explanation, /beneficiaryBankCode/);
  });

  it('marks a finding both layers agree on as found by both', async () => {
    const canonical = project();
    caseById(canonical, 'TC-002').expected_result =
      'Transaksi ditolak dengan error ADMI 005 dan tidak diteruskan ke BI-FAST.';

    const { issues } = await reviewSemantics(canonical, {
      useLlm: true,
      provider: reviewer([
        llmIssue({
          category: 'unsupported_implementation_detail',
          severity: 'high',
          testcase_id: 'TC-002',
          explanation: 'REQ-001 specifies ADMI 002, not ADMI 005.',
        }),
      ]),
    });

    const matching = issues.filter(
      (issue) =>
        issue.category === 'unsupported_implementation_detail' && issue.testcase_id === 'TC-002'
    );
    assert.equal(matching.length, 1, 'reported once, not twice');
    assert.deepEqual(matching[0].detected_by, ['heuristic', 'llm']);
    assert.equal(matching[0].severity, 'high', 'the more urgent severity wins');
  });
});

describe('unsupported test case', () => {
  it('surfaces behaviour the cited requirement does not describe', async () => {
    const { issues } = await reviewSemantics(project(), {
      useLlm: true,
      provider: reviewer([
        llmIssue({
          category: 'unsupported_behavior',
          severity: 'medium',
          testcase_id: 'TC-001',
          requirement_id: 'REQ-001',
          explanation: 'REQ-001 describes BIC Code validation, not forwarding to BI-FAST.',
        }),
      ]),
    });

    assert.ok(find(issues, 'unsupported_behavior', 'TC-001'));
  });
});

describe('duplicate test cases', () => {
  it('flags a near-duplicate that generation let through', () => {
    const canonical = project();
    const original = caseById(canonical, 'TC-003');
    canonical.test_cases.push({
      ...structuredClone(original),
      case_id: 'TC-006',
      order_index: 5,
      test_case: 'Verify penolakan transaksi ke bank peserta yang berstatus Suspended.',
      expected_result: 'Transaksi ditolak dan tidak diteruskan.',
    });

    const issue = find(runHeuristics(canonical), 'duplicate', 'TC-006');
    assert.ok(issue, 'the later case is the one reported');
    assert.match(issue.explanation, /TC-003/);
  });

  it('does not call the two sides of a boundary duplicates', () => {
    assert.equal(
      runHeuristics(project()).filter((issue) => issue.category === 'duplicate').length,
      0
    );
  });
});

describe('suspicious Edge polarity and case type', () => {
  it('flags a valid boundary whose expected result is a rejection', () => {
    const canonical = project();
    caseById(canonical, 'TC-004').expected_result = 'Batch ditolak dengan pesan error.';

    const issue = find(runHeuristics(canonical), 'suspicious_edge_polarity', 'TC-004');
    assert.ok(issue);
    assert.match(issue.explanation, /exports as Positive/);
  });

  it('flags an invalid boundary whose expected result is a success', () => {
    const canonical = project();
    caseById(canonical, 'TC-005').expected_result = 'Batch berhasil diproses seluruhnya.';

    assert.ok(find(runHeuristics(canonical), 'suspicious_edge_polarity', 'TC-005'));
  });

  it('flags a Positive case that expects a rejection', () => {
    const canonical = project();
    caseById(canonical, 'TC-001').expected_result = 'Transaksi ditolak oleh sistem.';

    assert.ok(find(runHeuristics(canonical), 'suspicious_case_type', 'TC-001'));
  });

  /**
   * The evaluation's real mistake: "exactly three failed attempts locks the
   * account" was marked a valid boundary, so it exported as Positive although
   * it asserts a lockout. A refusal is a refusal whether the word is rejected,
   * blocked or locked.
   */
  it('reads a lockout as a refusal, not a success', () => {
    assert.equal(outcomeOf('The account is locked for 30 minutes.'), 'rejection');
    assert.equal(outcomeOf('Akun dikunci selama 30 menit.'), 'rejection');
    assert.equal(outcomeOf('The participant is suspended.'), 'rejection');
  });

  it('flags a threshold case marked valid whose outcome is a lockout', () => {
    const canonical = project();
    const testCase = caseById(canonical, 'TC-004'); // Edge / valid
    testCase.test_case = 'Verify account lockout after exactly 3 consecutive failed attempts.';
    testCase.expected_result = 'The account is locked for 30 minutes.';

    const issue = find(runHeuristics(canonical), 'suspicious_edge_polarity', 'TC-004');
    assert.ok(issue, 'a boundary that triggers a restriction is not a valid boundary');
    assert.match(issue.explanation, /exports as Positive/);
  });

  it('reads negation correctly in both languages', () => {
    assert.equal(outcomeOf('Transaksi diterima tanpa error validasi.'), 'acceptance');
    assert.equal(outcomeOf('Transaksi tidak diproses.'), 'rejection');
    assert.equal(outcomeOf('The transfer is not processed.'), 'rejection');
    assert.equal(outcomeOf('Completed without errors.'), 'acceptance');
  });

  it('leaves mixed wording alone instead of guessing', () => {
    assert.equal(outcomeOf('Batch ditolak dan tidak ada transaksi yang diproses.'), 'unclear');
    assert.equal(outcomeOf('Pada log Kibana menampilkan payload request yang sesuai.'), 'unclear');
  });
});

describe('coverage', () => {
  it('leaves a requirement with no test case to the coverage check', async () => {
    const canonical = project();

    // REQ-004 was judged too thin to test. Coverage reports it...
    assert.deepEqual(buildCoverage(canonical).uncovered, ['REQ-004']);

    // ...and semantic validation does not report it a second time.
    const { issues } = await reviewSemantics(canonical);
    assert.equal(issues.filter((issue) => issue.requirement_id === 'REQ-004').length, 0);
  });

  it('flags a rejection path that only has positive tests', () => {
    const canonical = project();
    canonical.test_cases = canonical.test_cases.filter((testCase) => testCase.case_id !== 'TC-003');
    canonical.test_cases.push({
      ...structuredClone(caseById(canonical, 'TC-001')),
      case_id: 'TC-006',
      requirement_ids: ['REQ-002'],
      test_case: 'Verify transaksi ke bank peserta berstatus Active diteruskan.',
      expected_result: 'Transaksi diteruskan ke BI-FAST.',
    });

    const issue = find(runHeuristics(canonical), 'missing_coverage', 'REQ-002');
    assert.ok(issue);
    assert.match(issue.explanation, /rejection/);
  });

  it('flags a stated limit with no boundary test', () => {
    const canonical = project();
    canonical.test_cases = canonical.test_cases
      .filter((testCase) => testCase.case_type !== 'Edge')
      .concat({
        ...structuredClone(caseById(canonical, 'TC-003')),
        case_id: 'TC-006',
        requirement_ids: ['REQ-003'],
        test_case: 'Verify penolakan batch yang melebihi batas.',
        expected_result: 'Batch ditolak.',
      });

    const limit = runHeuristics(canonical).find(
      (issue) =>
        issue.category === 'missing_coverage' &&
        issue.requirement_id === 'REQ-003' &&
        /no Edge case at the boundary/.test(issue.explanation)
    );
    assert.ok(limit);
    assert.equal(limit.severity, 'low');
  });

  /**
   * One Edge case is not coverage of a limit. This is the set B regression:
   * the minimum was tested, the maximum was not, and every existing check
   * reported the requirement as covered.
   */
  it('reports a stated bound that no test case mentions', () => {
    const canonical = project();

    // REQ-003 states 500. Keep the 501 case, drop the one that tests 500.
    canonical.test_cases = canonical.test_cases.filter((testCase) => testCase.case_id !== 'TC-004');

    const issue = runHeuristics(canonical).find(
      (entry) =>
        entry.category === 'missing_coverage' &&
        entry.requirement_id === 'REQ-003' &&
        /no test case citing this requirement mentions that value/.test(entry.explanation)
    );

    assert.ok(issue, 'the untested bound is reported');
    assert.match(issue.explanation, /500/, 'and it names the value that is untested');
  });

  it('stays quiet once every stated bound is exercised', () => {
    const canonical = project();

    const untested = runHeuristics(canonical).filter(
      (entry) =>
        entry.requirement_id === 'REQ-003' && /mentions that value/.test(entry.explanation ?? '')
    );

    assert.deepEqual(untested, [], 'both 500 and 501 are covered, so there is nothing to say');
  });

  it('surfaces coverage that exists on paper but tests nothing', async () => {
    const { issues } = await reviewSemantics(project(), {
      useLlm: true,
      provider: reviewer([
        llmIssue({
          category: 'no_meaningful_test',
          severity: 'medium',
          requirement_id: 'REQ-002',
          explanation: 'TC-003 cites REQ-002 but never sets the participant status to Suspended.',
        }),
      ]),
    });

    assert.ok(find(issues, 'no_meaningful_test', 'REQ-002'));
  });
});

describe('the reviewer is itself checked', () => {
  it('discards and counts findings about ids that do not exist', async () => {
    const { issues, status } = await reviewSemantics(project(), {
      useLlm: true,
      provider: reviewer([
        llmIssue({ testcase_id: 'TC-099', explanation: 'About a case that does not exist.' }),
        llmIssue({ requirement_id: 'REQ-404', explanation: 'About a missing requirement.' }),
        llmIssue({ explanation: 'About nothing at all.' }),
        llmIssue({ testcase_id: 'TC-001', explanation: 'A real one.' }),
      ]),
    });

    assert.equal(issues.length, 1);
    assert.equal(issues[0].testcase_id, 'TC-001');
    assert.equal(status.discarded_issues, 3);
  });

  it('rejects malformed output and keeps the deterministic findings', async () => {
    const canonical = project();
    caseById(canonical, 'TC-004').expected_result = 'Batch ditolak dengan pesan error.';

    const { issues, status } = await reviewSemantics(canonical, {
      useLlm: true,
      provider: reviewer([llmIssue({ category: 'vibes', testcase_id: 'TC-001' })]),
    });

    assert.equal(status.llm, 'failed');
    assert.equal(status.error.code, 'LLM_MALFORMED_OUTPUT');
    assert.ok(find(issues, 'suspicious_edge_polarity', 'TC-004'), 'heuristics still stand');
    assert.ok(!issues.some((issue) => issue.category === 'vibes'));
  });

  it('rejects a reply that is not the agreed shape at all', async () => {
    const { status } = await reviewSemantics(project(), {
      useLlm: true,
      provider: new MockProvider({ responses: { findings: 'none' } }),
    });

    assert.equal(status.llm, 'failed');
    assert.equal(status.error.code, 'LLM_MALFORMED_OUTPUT');
  });
});

describe('provider failure', () => {
  for (const code of ['RATE_LIMITED', 'UNAVAILABLE', 'TIMEOUT', 'AUTH_FAILED']) {
    it(`reports ${code} without throwing, and keeps the deterministic findings`, async () => {
      const canonical = project();
      caseById(canonical, 'TC-001').expected_result = 'Transaksi ditolak oleh sistem.';

      const { issues, status } = await reviewSemantics(canonical, {
        useLlm: true,
        provider: new MockProvider({
          failWith: new LlmError(LLM_ERRORS[code], `${code} happened.`, 502),
        }),
      });

      assert.equal(status.llm, 'failed');
      assert.equal(status.error.code, LLM_ERRORS[code]);
      assert.ok(find(issues, 'suspicious_case_type', 'TC-001'));
    });
  }

  it('does not hide a programming error as a failed review', async () => {
    const broken = new MockProvider({ failWith: new TypeError('undefined is not a function') });

    await assert.rejects(reviewSemantics(project(), { useLlm: true, provider: broken }), TypeError);
  });
});

describe('what it does not do', () => {
  it('never modifies the test cases it reviews', async () => {
    const canonical = project();
    caseById(canonical, 'TC-004').expected_result = 'Batch ditolak dengan pesan error.';
    const before = JSON.stringify(canonical);

    await reviewSemantics(canonical, {
      useLlm: true,
      provider: reviewer([
        llmIssue({ testcase_id: 'TC-004', category: 'suspicious_edge_polarity' }),
      ]),
    });

    assert.equal(JSON.stringify(canonical), before);
  });

  it('makes exactly one model call for the whole project', async () => {
    const provider = reviewer([]);
    await reviewSemantics(project(), { useLlm: true, provider });

    assert.equal(provider.calls.length, 1);
  });

  it('makes no model call unless asked', async () => {
    const provider = reviewer([]);
    const { status } = await reviewSemantics(project(), { provider });

    assert.equal(provider.calls.length, 0);
    assert.equal(status.llm, 'not_requested');
    assert.equal(status.heuristics, 'completed');
  });

  it('makes no model call when there is nothing to review', async () => {
    const provider = reviewer([]);
    const { status } = await reviewSemantics(
      { ...project(), test_cases: [] },
      { useLlm: true, provider }
    );

    assert.equal(provider.calls.length, 0);
    assert.match(status.reason, /no test cases/);
  });

  it('does not review a structurally invalid project', async () => {
    const provider = reviewer([]);
    const { issues, status } = await reviewSemantics(project(), {
      useLlm: true,
      structurallyValid: false,
      provider,
    });

    assert.deepEqual(issues, []);
    assert.equal(provider.calls.length, 0);
    assert.match(status.reason, /structurally valid/);
  });
});

describe('the review prompt', () => {
  it('sends requirements and test cases, and nothing else', () => {
    const canonical = project();
    const prompt = buildReviewPrompt(canonical);

    assert.ok(prompt.includes('Field: BIC Code | Rule: Mandatory'), 'source quotes travel');
    for (const testCase of canonical.test_cases) {
      assert.ok(prompt.includes(testCase.case_id));
      assert.ok(prompt.includes(testCase.expected_result));
    }
    assert.ok(!prompt.includes('"status"'), 'execution fields are left out');
  });

  it('frames the model as a reviewer that must not rewrite anything', () => {
    const instruction = reviewInstruction();

    assert.match(instruction, /reviewer, not an author/);
    assert.match(instruction, /Do not rewrite test cases/);
    assert.match(instruction, /Never refer to an id that is not in the input/);
  });

  /**
   * The reviewer and the generator must mean the same thing by edge_polarity.
   * They disagreed once - the generator was told outcome, the reviewer input -
   * which let the reviewer bless a lockout case exported as Positive.
   */
  it('defines edge polarity by outcome, exactly as the generator is told', () => {
    const instruction = reviewInstruction();

    assert.match(instruction, /EXPECTED OUTCOME/);
    assert.match(instruction, /locks the account" is "invalid"/);
  });

  /**
   * Division of labour with the deterministic bound check. Asking the model to
   * re-derive findings the rules already produce costs tokens and duplicates
   * the finding.
   */
  it('leaves untested numeric bounds to the deterministic check', () => {
    const instruction = reviewInstruction();

    assert.match(instruction, /Do not report an untested numeric bound/);
    assert.match(instruction, /rejection path, a status or state transition/);
  });

  it('never sends the checklist to the reviewer', () => {
    const prompt = buildReviewPrompt(project());

    assert.doesNotMatch(prompt, /Coverage checklist/);
    assert.doesNotMatch(prompt, /bounds to test/);
  });
});

describe('token extraction', () => {
  it('finds codes, identifiers and quoted messages but not QATOOL ids', () => {
    const tokens = technicalTokens(
      'TC-003 cites REQ-002: expect ADMI 002, HTTP 400, field partnerServiceId, customer_no and "Saldo tidak cukup".'
    );

    for (const token of [
      'ADMI 002',
      'HTTP 400',
      'partnerServiceId',
      'customer_no',
      'Saldo tidak cukup',
    ]) {
      assert.ok(tokens.includes(token), `${token} found`);
    }
    assert.ok(!tokens.includes('TC-003'));
    assert.ok(!tokens.includes('REQ-002'));
  });
});
