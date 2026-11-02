import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

/**
 * Rendering tests for the Results page.
 *
 * The page has two genuinely different states, and the difference matters:
 * before test cases are generated, coverage cannot be evaluated, so anything
 * that reports it is reporting a number it does not have. These tests pin both
 * states down.
 *
 * Node cannot parse JSX, so the components are loaded through Vite - which is
 * already a dependency and already the thing that compiles them for the
 * browser. Rendering is `renderToStaticMarkup`, which needs no DOM. Effects do
 * not run under it, so no component here reaches the network: the state under
 * test is exactly the state that is passed in.
 */

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

let vite;
let ResultsStage;
let CanonicalProvider;

before(async () => {
  const { createServer } = await import('vite');
  const react = (await import('@vitejs/plugin-react')).default;

  vite = await createServer({
    root: webRoot,
    configFile: false,
    server: { middlewareMode: true, hmr: false },
    appType: 'custom',
    logLevel: 'error',
    plugins: [react()],
  });

  ({ ResultsStage } = await vite.ssrLoadModule('/src/stages/ResultsStage.jsx'));
  ({ CanonicalProvider } = await vite.ssrLoadModule('/src/state/canonical.jsx'));
});

after(async () => {
  await vite?.close();
});

function render(canonical, validation, generation = null, { detailed = false } = {}) {
  return renderToStaticMarkup(
    createElement(
      CanonicalProvider,
      {
        initialCanonical: canonical,
        initialValidation: validation,
        initialGeneration: generation,
      },
      createElement(ResultsStage, { onDownloaded: () => {}, detailed })
    )
  );
}

/** The page with the reviewer's tools shown. The app never sets this. */
function renderDetailed(canonical, validation, generation = null) {
  return render(canonical, validation, generation, { detailed: true });
}

/** One warning section: from its heading to the end of its list. */
function sectionAfter(html, heading) {
  const start = html.indexOf(heading);
  assert.notEqual(start, -1, `no "${heading}" section`);
  return html.slice(start, html.indexOf('</ul>', start));
}

/** Two requirements, as extraction leaves them. */
function requirements() {
  return [
    {
      requirement_id: 'REQ-001',
      title: 'BIC Code is mandatory',
      description: 'The BIC Code field must be present and 8 or 11 characters long.',
      category: 'Input Validation',
      source_references: [
        { document_id: 'DOC-001', page: null, section: 'Ketentuan', quote: 'BIC Code wajib diisi' },
      ],
      ambiguities: [],
      conflicts: [],
    },
    {
      requirement_id: 'REQ-002',
      title: 'Suspended participants are rejected',
      description: 'A transaction to a suspended participant bank must be rejected.',
      category: 'Business Rule',
      source_references: [
        { document_id: 'DOC-001', page: null, section: 'Business Rules', quote: 'ditolak' },
      ],
      ambiguities: [],
      conflicts: [],
    },
  ];
}

function canonicalAfterExtraction() {
  return {
    project: {
      project_name: 'BI-FAST Overdraft',
      project_description: null,
      project_summary: null,
      qa_guidance: null,
      project_background: null,
      sit_scope: [],
    },
    documents: [
      {
        document_id: 'DOC-001',
        filename: 'PRD Overdraft.docx',
        document_type: 'PRD',
        status: 'Extracted',
        page_count: null,
        extracted_char_count: 353,
      },
    ],
    requirements: requirements(),
    test_cases: [],
  };
}

function canonicalAfterGeneration() {
  return {
    ...canonicalAfterExtraction(),
    test_cases: [
      {
        case_id: 'TC-001',
        section: 'BIC Code validation',
        test_case: 'Submit a transfer with an empty BIC Code.',
        expected_result: 'The transaction is rejected with ADMI 002.',
        case_type: 'Negative',
        edge_polarity: null,
        priority: 'High',
        type: 'Functional',
        confidence: 'High',
        requirement_ids: ['REQ-001'],
        source_references: [],
        warnings: [],
      },
    ],
  };
}

/**
 * A batch as the new validation policy leaves it: one clean case, one whose
 * case type nobody recognises, one Edge case whose polarity is still open. All
 * three are drafts a reviewer can use, so all three are on the page.
 */
function canonicalWithFlaggedCases() {
  const base = canonicalAfterGeneration();
  const [clean] = base.test_cases;

  return {
    ...base,
    test_cases: [
      clean,
      {
        ...clean,
        case_id: 'TC-002',
        test_case: 'Submit a transfer with a valid BIC Code.',
        case_type: 'Positiv',
        priority: 'Urgent',
        warnings: [
          {
            code: 'UNRECOGNIZED_CASE_TYPE',
            field: 'case_type',
            observed_value: 'Positiv',
            message: 'Unrecognized case type. Recommended: Positive / Negative / Edge.',
          },
          {
            code: 'UNRECOGNIZED_PRIORITY',
            field: 'priority',
            observed_value: 'Urgent',
            message: 'Unrecognized priority. Recommended: Critical / High / Medium / Low.',
          },
        ],
      },
      {
        ...clean,
        case_id: 'TC-003',
        test_case: 'Submit a transfer at exactly the documented maximum.',
        case_type: 'Edge',
        edge_polarity: null,
        warnings: [
          {
            code: 'EDGE_POLARITY_MISSING',
            field: 'edge_polarity',
            observed_value: null,
            message: 'Edge polarity missing. QA review required.',
          },
        ],
      },
    ],
  };
}

/**
 * What /api/validate returns for each state. Not invented for the test: with no
 * test cases, buildCoverage() genuinely reports every requirement as uncovered,
 * and that is precisely the response the page must not put on screen as a
 * warning.
 */
const validationAfterExtraction = {
  valid: true,
  schema_issues: [],
  reference_issues: [],
  semantic_warnings: [],
  coverage: {
    entries: [
      { requirement_id: 'REQ-001', case_ids: [], covered: false },
      { requirement_id: 'REQ-002', case_ids: [], covered: false },
    ],
    uncovered: ['REQ-001', 'REQ-002'],
    orphan_test_cases: [],
  },
};

const validationAfterGeneration = {
  valid: true,
  schema_issues: [],
  reference_issues: [],
  semantic_warnings: [],
  coverage: {
    entries: [
      { requirement_id: 'REQ-001', case_ids: ['TC-001'], covered: true },
      { requirement_id: 'REQ-002', case_ids: [], covered: false },
    ],
    uncovered: ['REQ-002'],
    orphan_test_cases: [],
  },
};

/**
 * The state the obligation layer exists for: REQ-001 has a test case, so the
 * old report called it covered and said no more. Three of its five obligations
 * are untested, and the page has to be able to say so.
 */
const validationWithPartialCoverage = {
  ...validationAfterGeneration,
  coverage: {
    entries: [
      {
        requirement_id: 'REQ-001',
        case_ids: ['TC-001'],
        covered: true,
        obligations: {
          total: 5,
          covered: 2,
          uncovered: ['OB-003', 'OB-004', 'OB-005'],
          percent: 40,
          state: 'partial',
        },
      },
      {
        requirement_id: 'REQ-002',
        case_ids: [],
        covered: false,
        obligations: {
          total: 2,
          covered: 0,
          uncovered: ['OB-006'],
          percent: 0,
          state: 'uncovered',
        },
      },
    ],
    uncovered: ['REQ-002'],
    orphan_test_cases: [],
    obligations: [
      {
        obligation_id: 'OB-003',
        requirement_id: 'REQ-001',
        statement: 'Side effect on FT Number is observable',
      },
      {
        obligation_id: 'OB-004',
        requirement_id: 'REQ-001',
        statement: 'Retry limit of 3 is enforced',
      },
      {
        obligation_id: 'OB-005',
        requirement_id: 'REQ-001',
        statement: 'Timing condition of 1 hour is exercised',
      },
    ],
    summary: {
      requirement_total: 2,
      requirement_covered: 1,
      requirement_partially_covered: 1,
      requirement_fully_covered: 0,
      obligations_total: 7,
      obligations_covered: 2,
      obligations_uncovered: 5,
    },
  },
};

describe('Results after extraction, before generation', () => {
  it('does not report coverage it cannot evaluate', () => {
    const html = render(canonicalAfterExtraction(), validationAfterExtraction);

    assert.match(html, /<div class="label">Coverage<\/div>/);
    assert.doesNotMatch(html, /Uncovered reqs/);
    assert.doesNotMatch(html, /Uncovered requirements/);
  });

  it('does not flag the extracted requirements as uncovered', () => {
    const html = render(canonicalAfterExtraction(), validationAfterExtraction);

    // The validator did list both; the page must not turn that into warnings.
    assert.doesNotMatch(html, /badge warn mono"[^>]*>REQ-001/);
    assert.doesNotMatch(html, /badge warn mono"[^>]*>REQ-002/);
    assert.doesNotMatch(html, /No test case references these/);
  });

  it('says why, instead of claiming there is nothing wrong', () => {
    const html = render(canonicalAfterExtraction(), validationAfterExtraction);

    assert.match(html, /Test cases not generated yet\./);
    assert.doesNotMatch(html, /No warnings/);
  });

  it('keeps the extracted requirement count visible', () => {
    const html = render(canonicalAfterExtraction(), validationAfterExtraction);

    assert.match(html, /<div class="value">2<\/div><div class="label">Requirements<\/div>/);
  });

  it('disables export and explains what is missing', () => {
    const html = render(canonicalAfterExtraction(), validationAfterExtraction);

    assert.match(html, /<button type="button" disabled="">Download SIT Script\.xlsx<\/button>/);
    assert.match(html, /Generate test cases before exporting\./);
  });

  it('shows the traceability section as empty rather than absent', () => {
    const html = render(canonicalAfterExtraction(), validationAfterExtraction);

    assert.match(html, /Test cases &amp; traceability/);
    assert.match(html, /No test cases generated yet\./);
  });

  it('still offers the project outputs, as not-yet-generated placeholders', () => {
    const html = render(canonicalAfterExtraction(), validationAfterExtraction);

    for (const title of [
      'Project Description',
      'Project Summary',
      'QA Guidance',
      'SIT Scope',
      'Project Background',
    ]) {
      assert.match(html, new RegExp(`<h2>${title}</h2>`));
    }
    assert.match(html, /Not generated\. Run Processing to produce this output\./);
  });
});

describe('Results after generation', () => {
  it('reports coverage once there is something to measure it against', () => {
    const html = render(canonicalAfterGeneration(), validationAfterGeneration);

    assert.match(html, /<div class="value">1<\/div><div class="label">Uncovered reqs<\/div>/);
    assert.doesNotMatch(html, /<div class="label">Coverage<\/div>/);
  });

  it('warns about the requirement no test case reaches', () => {
    const html = render(canonicalAfterGeneration(), validationAfterGeneration);

    assert.match(html, /Uncovered requirements/);
    assert.match(html, /badge warn mono"[^>]*>REQ-002/);
    assert.doesNotMatch(html, /badge warn mono"[^>]*>REQ-001/);
    assert.doesNotMatch(html, /Test cases not generated yet\./);
  });

  it('enables export', () => {
    const html = render(canonicalAfterGeneration(), validationAfterGeneration);

    assert.match(html, /<button type="button">Download SIT Script\.xlsx<\/button>/);
    assert.doesNotMatch(html, /Generate test cases before exporting\./);
  });

  /**
   * A requirement with a test case against it used to disappear from this page
   * entirely, as "covered". It is reported once, at requirement level: which
   * requirement, and how much of what it states the generated cases cover.
   */
  it('reports a partially covered requirement once, at requirement level', () => {
    const html = render(canonicalAfterGeneration(), validationWithPartialCoverage);
    const section = sectionAfter(html, 'Partially covered requirements');

    assert.match(
      section,
      /The generated test cases do not cover all behaviours stated in these requirements\./
    );
    assert.match(section, /BIC Code is mandatory/, 'named by its title, not only its id');
    assert.match(section, /2 of 5 behaviours covered/);
    assert.equal(section.match(/REQ-001/g).length, 1, 'one entry per requirement');
  });

  it('does not list the individual behaviours on the default page', () => {
    const html = render(canonicalAfterGeneration(), validationWithPartialCoverage);

    assert.doesNotMatch(html, /Retry limit of 3 is enforced/);
    assert.doesNotMatch(html, /Timing condition of 1 hour is exercised/);
  });

  /**
   * Nothing on this page has been executed. "Tested" claimed a run that never
   * happened; a behaviour is covered when a generated case is written for it.
   */
  it('says covered, never tested', () => {
    const html = render(canonicalAfterGeneration(), validationWithPartialCoverage);
    const card = html.slice(
      html.indexOf('<h2>Warnings'),
      html.indexOf('<h2>', html.indexOf('<h2>Warnings') + 1)
    );

    assert.doesNotMatch(card, /\btested\b/i);
    assert.match(card, /behaviours covered/);
  });

  it('gives an uncovered requirement the same shape, so nothing is reported twice', () => {
    const html = render(canonicalAfterGeneration(), validationWithPartialCoverage);
    const section = sectionAfter(html, 'Uncovered requirements');

    assert.match(section, /No generated test case references these requirements\./);
    assert.match(section, /Suspended participants are rejected/);
    assert.match(section, /0 of 2 behaviours covered/);
    assert.equal(html.match(/>REQ-002</g).length, 1, 'REQ-002 appears in one warning only');
  });

  it('does not list a fully covered or uncovered requirement as partial', () => {
    const html = render(canonicalAfterGeneration(), validationWithPartialCoverage);
    const start = html.indexOf('Partially covered requirements');
    const section = html.slice(start, html.indexOf('</ul>', start));

    // REQ-002 has no test case at all; it belongs under uncovered, not here.
    assert.match(section, /REQ-001/);
    assert.doesNotMatch(section, /REQ-002/);
  });

  /**
   * The obligation layer is additive. A validation response from before it
   * existed - or one for a project whose requirements yield no obligations -
   * must render, not throw.
   */
  it('renders coverage that carries no obligation detail', () => {
    const html = render(canonicalAfterGeneration(), validationAfterGeneration);

    assert.doesNotMatch(html, /Partially covered requirements/);
    assert.match(html, /Uncovered requirements/);
  });

  /**
   * The point of the whole policy change: a questionable label costs the
   * reviewer a glance, not the draft. If any of these disappeared from the page
   * the tool would be deciding on QA's behalf without saying so.
   */
  it('shows a test case whose classification is unrecognized, rather than hiding it', () => {
    const html = render(canonicalWithFlaggedCases(), validationAfterGeneration);

    assert.match(html, /TC-002/);
    assert.match(html, /Submit a transfer with a valid BIC Code\./, 'the action is readable');
    assert.match(html, /Positiv</, 'the value the model produced is shown as-is');
    assert.match(html, /Urgent</, 'not mapped onto High');
    assert.doesNotMatch(html, />Positive</, 'and never silently corrected');
  });

  it('marks the questionable value and explains it next to the case', () => {
    const html = render(canonicalWithFlaggedCases(), validationAfterGeneration);

    assert.match(html, /badge warn">Positiv</, 'the badge itself is flagged');
    assert.match(html, /Case Type:\s*<\/strong>/, 'the note names the field');
    assert.match(html, /Unrecognized case type\. Recommended: Positive \/ Negative \/ Edge\./);
  });

  it('shows an Edge case with no polarity, without inventing one', () => {
    const html = render(canonicalWithFlaggedCases(), validationAfterGeneration);

    assert.match(html, /TC-003/);
    assert.match(html, /polarity missing/);
    assert.match(html, /Edge polarity missing\. QA review required\./);
    assert.doesNotMatch(html, /badge">valid</, 'no polarity was guessed for it');
  });

  /**
   * These used to block the workbook. They do not any more: the drafted value
   * is written to the cell and the reviewer is told where to look, so the
   * notice has to read as guidance rather than as a failure.
   */
  it('says the warnings were preserved in the export, not that they blocked it', () => {
    const html = renderDetailed(canonicalWithFlaggedCases(), validationAfterGeneration);

    assert.match(html, /2 test cases contain QA-review warnings\./);
    assert.match(html, /preserved in the export unchanged/);
    assert.match(html, /TC-002, TC-003/, 'both cases are named');
    assert.doesNotMatch(html, /Blocks export/, 'no longer a blocker');
  });

  /**
   * On the default page the case carries the mark itself, next to the value -
   * a second notice in the Warnings card named the same cases again.
   */
  it('keeps the QA-review notice off the default page, leaving the mark on the case', () => {
    const html = render(canonicalWithFlaggedCases(), validationAfterGeneration);

    assert.doesNotMatch(html, /QA-review warnings/);
    assert.match(html, /badge warn/, 'the questionable value is still marked');
  });

  it('says nothing about review warnings for a clean batch', () => {
    const html = render(canonicalAfterGeneration(), validationAfterGeneration);

    assert.doesNotMatch(html, /QA-review warnings/);
  });

  it('shows the generated test case and its traceability handle', () => {
    const html = render(canonicalAfterGeneration(), validationAfterGeneration);

    assert.match(html, /<div class="value">1<\/div><div class="label">Test cases<\/div>/);
    assert.match(html, /TC-001/);
    assert.match(html, /Submit a transfer with an empty BIC Code\./);
    assert.doesNotMatch(html, /No test cases generated yet\./);
  });
});

/**
 * What /api/generate returns alongside the canonical fields. These live beside
 * the canonical object rather than in it, so the page has to be given them
 * separately - which is exactly what this checks.
 */
const generationReport = {
  warnings: [
    {
      code: 'INSUFFICIENT_INFORMATION',
      message: 'REQ-002 has no stated trigger, so no test case could be defined safely.',
      requirement_id: 'REQ-002',
    },
    {
      code: 'DUPLICATE_TEST_CASE_REMOVED',
      message: '1 generated test case duplicated another and was removed.',
      requirement_id: null,
    },
  ],
  metadata: {
    provider: 'Gemini',
    model: 'gemini-2.5-pro',
    requirement_count: 2,
    test_case_count: 1,
    duplicates_removed: 1,
    duration_ms: 8400,
  },
};

describe('Results after a real generation run', () => {
  /**
   * The generator's own warning list is no longer rendered. It repeated itself:
   * on the real PRD, eight of ten entries ended in the identical "Each was
   * derived from the requirement's own wording ... write the case yourself"
   * clause, so what was specific to each entry sat buried in boilerplate.
   *
   * Nothing is suppressed upstream - the warnings are still produced and still
   * travel in the generation report. These tests pin that the page no longer
   * lists them, and that the facts they carried are still reachable.
   */
  it('does not list the generator warnings', () => {
    const html = render(canonicalAfterGeneration(), validationAfterGeneration, generationReport);

    assert.doesNotMatch(html, /INSUFFICIENT_INFORMATION/);
    assert.doesNotMatch(html, /DUPLICATE_TEST_CASE_REMOVED/);
    assert.doesNotMatch(html, /What the generator could not do/);
  });

  it('does not count them either, so the heading matches what is shown', () => {
    const html = render(canonicalAfterGeneration(), validationAfterGeneration, generationReport);

    // 1 uncovered requirement, and nothing from the generator's own list.
    assert.match(html, /<h2>Warnings \(1\)<\/h2>/);
  });

  it('still names the requirement no test case reaches', () => {
    const html = render(canonicalAfterGeneration(), validationAfterGeneration, generationReport);

    assert.match(html, /Uncovered requirements/, 'the coverage gap is still reported');
    assert.match(html, /No generated test case references these requirements/);
  });

  it('says which model drafted this, and that it needs review', () => {
    const html = render(canonicalAfterGeneration(), validationAfterGeneration, generationReport);

    assert.match(html, /Drafted by Gemini \(gemini-2\.5-pro\)/);
    assert.match(html, /8\.4s/);
    assert.match(html, /1 duplicate\(s\) removed/);
    assert.match(html, /Review before use/);
  });

  it('says nothing about a provider when the sample workflow was loaded', () => {
    const html = render(canonicalAfterGeneration(), validationAfterGeneration, null);

    assert.doesNotMatch(html, /Drafted by/);
    assert.doesNotMatch(html, /Review before use/);
  });
});

/** /api/validate after a semantic review, in each of the states it can report. */
function reviewed(llm, issues = [], extra = {}) {
  return {
    ...validationAfterGeneration,
    semantic_warnings: issues,
    semantic: {
      heuristics: 'completed',
      llm,
      reason: null,
      error: null,
      provider: llm === 'completed' ? 'Gemini' : null,
      model: llm === 'completed' ? 'gemini-3.8-flash' : null,
      duration_ms: 4200,
      usage: null,
      discarded_issues: 0,
      ...extra,
    },
  };
}

const polarityIssue = {
  severity: 'high',
  category: 'suspicious_edge_polarity',
  testcase_id: 'TC-001',
  requirement_id: null,
  explanation: 'Marked as a valid boundary, but its Expected Result describes a rejection.',
  detected_by: ['heuristic', 'llm'],
};

describe('Semantic review', () => {
  /**
   * The review still runs and its findings are still returned; the default page
   * just does not show them. Several findings restated a coverage warning about
   * the same requirement, so the page said one thing twice in two vocabularies.
   */
  it('is not shown on the default page', () => {
    const html = render(canonicalAfterGeneration(), reviewed('completed', [polarityIssue]));

    assert.doesNotMatch(html, /Semantic review/);
    assert.doesNotMatch(html, /describes a rejection/);
  });

  it('leaves no review note on a test case of the default page', () => {
    const html = render(canonicalAfterGeneration(), reviewed('completed', [polarityIssue]));

    assert.doesNotMatch(html, /review note/);
  });

  it('shows each finding with its severity, category, ids and source', () => {
    const html = renderDetailed(canonicalAfterGeneration(), reviewed('completed', [polarityIssue]));

    assert.match(html, /<h2>Semantic review \(1\)<\/h2>/);
    assert.match(html, /badge danger">high/);
    assert.match(html, /Suspicious Edge polarity/);
    assert.match(html, /describes a rejection/);
    assert.match(html, /AI review \+ rule check/);
    assert.match(html, /Checked by rules and by an AI review \(Gemini, gemini-3\.8-flash\)/);
  });

  it('marks the affected test case in the traceability list', () => {
    const html = renderDetailed(canonicalAfterGeneration(), reviewed('completed', [polarityIssue]));

    assert.match(html, /1 review note</);
  });

  it('says explicitly that nothing is changed or blocked', () => {
    const html = renderDetailed(canonicalAfterGeneration(), reviewed('completed', [polarityIssue]));

    assert.match(html, /Nothing here changes a test case or blocks export/);
    assert.match(html, /<button type="button">Download SIT Script\.xlsx<\/button>/);
  });

  it('reports a clean review as clean', () => {
    const html = renderDetailed(canonicalAfterGeneration(), reviewed('completed', []));

    assert.match(html, /No semantic concerns found/);
    assert.doesNotMatch(html, /Run AI review|Retry AI review/);
  });

  it('does not let a failed review pass for a clean one', () => {
    const html = renderDetailed(
      canonicalAfterGeneration(),
      reviewed('failed', [], {
        error: { code: 'LLM_UNAVAILABLE', message: 'The Gemini API is unavailable (HTTP 503).' },
      })
    );

    assert.match(html, /The AI review did not run/);
    assert.match(html, /HTTP 503/);
    assert.match(html, /not a clean result/);
    assert.match(html, /Retry AI review/);
    assert.doesNotMatch(html, /No semantic concerns found/);
  });

  it('offers to run the review when it has not been run', () => {
    const html = renderDetailed(canonicalAfterGeneration(), reviewed('not_requested'));

    assert.match(html, /Run AI review/);
    assert.match(html, /Only the rule checks have run/);
  });

  it('is absent before any test case exists, even on the detailed page', () => {
    const html = renderDetailed(canonicalAfterExtraction(), validationAfterExtraction);

    assert.doesNotMatch(html, /Semantic review/);
  });
});
