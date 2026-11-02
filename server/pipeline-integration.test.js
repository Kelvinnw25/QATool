import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { deriveChecklist } from './scenario/checklist.js';
import { generateFromRequirements } from './generate/index.js';
import { reviewSemantics } from './semantic/index.js';
import {
  buildCoverage,
  canonicalProjectSchema,
  checkCanonicalReferences,
} from './schema/canonical.js';
import { exportSitScript } from './export/sit-script-export.js';
import { inspectWorkbook } from './export/inspect.js';
import { MockProvider } from './llm/mock.js';
import { sampleCanonicalInput, sampleLlmResponse } from './generate/fixtures/sample-input.js';

/**
 * The whole chain in one place, with the model scripted.
 *
 *   requirements -> checklist -> prompt -> (mock) -> assemble -> validate
 *                -> semantic review -> coverage -> XLSX
 *
 * The per-module suites prove each stage; this proves they still fit together,
 * and that adding the checklist did not change what comes out of the far end.
 * No network, no key, no quota.
 */

async function runPipeline({ provider } = {}) {
  const input = sampleCanonicalInput();
  const checklist = deriveChecklist(input.requirements);

  const mock = provider ?? new MockProvider({ responses: sampleLlmResponse() });
  const generated = await generateFromRequirements(input, { provider: mock });

  const canonical = {
    ...input,
    project: generated.project,
    test_cases: generated.test_cases,
  };

  const semantic = await reviewSemantics(canonical, { structurallyValid: true });
  const coverage = buildCoverage(canonical);

  return { canonical, checklist, generated, semantic, coverage, mock };
}

describe('the pipeline end to end', () => {
  it('carries the checklist into generation without entering the canonical object', async () => {
    const { canonical, checklist, mock } = await runPipeline();

    assert.ok(checklist.length > 0);
    assert.match(mock.calls[0].prompt, /Coverage checklist, derived mechanically/);
    assert.match(mock.calls[0].prompt, /REQ-003/);

    // The checklist is derived, used and discarded. It is not canonical data.
    assert.ok(!('checklist' in canonical), 'not on the canonical object');
    assert.ok(!('scenario_checklist' in canonical), 'not under another name either');
    assert.doesNotThrow(
      () => canonicalProjectSchema.parse(canonical),
      'the canonical object still satisfies the strict schema'
    );
  });

  it('produces a structurally valid, referentially sound project', async () => {
    const { canonical } = await runPipeline();

    assert.deepEqual(checkCanonicalReferences(canonical), []);
    assert.ok(canonical.test_cases.length > 0);
  });

  it('keeps identifiers and source references system-owned', async () => {
    const { canonical } = await runPipeline();

    const documentIds = new Set(canonical.documents.map((document) => document.document_id));
    const requirementIds = new Set(canonical.requirements.map((req) => req.requirement_id));

    canonical.test_cases.forEach((testCase, index) => {
      assert.equal(testCase.case_id, `TC-${String(index + 1).padStart(3, '0')}`);
      for (const id of testCase.requirement_ids) assert.ok(requirementIds.has(id));
      for (const reference of testCase.source_references) {
        assert.ok(documentIds.has(reference.document_id), 'every reference names a real document');
      }
    });
  });

  it('reports coverage and semantic findings without touching the test cases', async () => {
    const { canonical, semantic, coverage } = await runPipeline();

    const before = JSON.stringify(canonical.test_cases);
    await reviewSemantics(canonical, { structurallyValid: true });

    assert.equal(JSON.stringify(canonical.test_cases), before, 'review changed nothing');
    assert.equal(semantic.status.heuristics, 'completed');
    assert.ok(Array.isArray(coverage.uncovered));
  });

  it('exports a workbook that satisfies the template contract', async () => {
    const { canonical } = await runPipeline();
    const { buffer, rowCount } = exportSitScript(canonical.test_cases);
    const workbook = inspectWorkbook(buffer);
    const lastRow = canonical.test_cases.length + 1;

    assert.equal(rowCount, canonical.test_cases.length);
    assert.equal(workbook.tableRef, `C2:C${lastRow}`);
    assert.ok(Object.values(workbook.headerRow).includes('Exected Result'));

    for (const row of workbook.dataRows) {
      assert.ok(['Positive', 'Negative'].includes(row.cells.D), 'template vocabulary only');
      assert.ok(!row.cells.H && !row.cells.I, 'execution columns stay blank');
    }

    // Edge mapping is unchanged by any of this work.
    const rowsById = new Map(workbook.dataRows.map((row) => [row.cells.A, row.cells]));
    for (const testCase of canonical.test_cases.filter((entry) => entry.case_type === 'Edge')) {
      const cells = rowsById.get(testCase.case_id);
      assert.equal(cells.D, testCase.edge_polarity === 'valid' ? 'Positive' : 'Negative');
      assert.equal(cells.G, `[Edge Case] ${testCase.expected_result}`);
    }
  });

  it('still returns deterministic findings when the review call fails', async () => {
    const { canonical } = await runPipeline();

    const failing = new MockProvider({ failWith: Object.assign(new Error('down'), { name: 'x' }) });
    const semantic = await reviewSemantics(canonical, {
      useLlm: true,
      structurallyValid: true,
      provider: failing,
    }).catch((error) => error);

    // A non-AppError must surface rather than be reported as "review skipped".
    assert.ok(semantic instanceof Error, 'a programming error is not swallowed');
  });

  it('spends exactly one model call on generation', async () => {
    const { mock } = await runPipeline();

    assert.equal(
      mock.calls.length,
      1,
      'generation is one call, checklist and obligations included'
    );
  });

  /**
   * Obligations are derived data with a short life: built from the requirements
   * at the start of a request, spent on a prompt and a coverage figure, and
   * gone. The canonical schema is strict, so an obligation that leaked into the
   * project would fail the parse below - but the browser posts that object back
   * on every call, and derived data that makes the round trip stops being
   * derived and starts being something a client can forge.
   */
  it('carries obligations into generation without entering the canonical object', async () => {
    const { canonical, mock } = await runPipeline();

    assert.match(mock.calls[0].prompt, /Behavioural obligations, derived mechanically/);
    assert.match(mock.calls[0].prompt, /\[OB-001\]/);

    assert.ok(!('obligations' in canonical), 'not on the canonical object');
    assert.ok(!('coverage_obligations' in canonical), 'not under another name either');
    for (const testCase of canonical.test_cases) {
      assert.ok(!('obligations' in testCase), 'not smuggled onto a test case');
    }
    for (const requirement of canonical.requirements) {
      assert.ok(!('obligations' in requirement), 'not smuggled onto a requirement');
    }

    assert.doesNotThrow(
      () => canonicalProjectSchema.parse(canonical),
      'the canonical object still satisfies the strict schema'
    );
  });

  it('keeps obligations out of the exported workbook', async () => {
    const { canonical, coverage } = await runPipeline();

    assert.ok(coverage.obligations.length > 0, 'there are obligations to leak');

    const workbook = inspectWorkbook(exportSitScript(canonical.test_cases).buffer);
    const sheet = workbook.dataRows.map((row) => Object.values(row.cells).join(' ')).join(' ');

    assert.ok(!/OB-\d{3}/.test(sheet), 'no obligation id reaches a cell');
    for (const obligation of coverage.obligations) {
      assert.ok(!sheet.includes(obligation.statement), 'no obligation statement reaches a cell');
    }
  });

  /**
   * Structural coverage is the system's claim and stays the system's claim.
   * The reviewer is handed the gaps deterministic matching could not settle, as
   * somewhere to look - what it says back never changes the numbers.
   */
  it('reports obligation coverage deterministically, without a model', async () => {
    const { canonical } = await runPipeline();

    const first = buildCoverage(canonical);
    const second = buildCoverage(canonical);

    assert.deepEqual(first.summary, second.summary, 'the same input gives the same figure');
    assert.equal(
      first.summary.obligations_total,
      first.summary.obligations_covered + first.summary.obligations_uncovered
    );

    const withReview = await reviewSemantics(canonical, { structurallyValid: true });
    assert.deepEqual(buildCoverage(canonical).summary, first.summary, 'review moved nothing');
    assert.ok(Array.isArray(withReview.issues));
  });
});

/**
 * A drafting tool has to hand over the draft.
 *
 * One reply carrying a misspelt case type, an odd priority and an Edge case
 * whose polarity is still open used to cost the reviewer the entire workbook.
 * Now every row arrives with its drafted value intact, coverage still counts
 * them, traceability still holds, and the template contract is untouched - the
 * odd values simply sit outside their dropdowns, where QA can see and fix them.
 */
describe('a batch with QA-review warnings still reaches the workbook', () => {
  function messyReply() {
    const response = sampleLlmResponse();
    response.test_cases[0].case_type = 'Positiv';
    response.test_cases[1].priority = 'Urgent';
    response.test_cases[3].edge_polarity = null; // an Edge case
    return response;
  }

  async function runMessy() {
    const input = sampleCanonicalInput();
    const mock = new MockProvider({ responses: messyReply() });
    const generated = await generateFromRequirements(input, { provider: mock });
    const canonical = { ...input, project: generated.project, test_cases: generated.test_cases };

    return { input, canonical, generated, exported: exportSitScript(canonical.test_cases) };
  }

  it('exports every case, with each drafted value written verbatim', async () => {
    const { canonical, exported } = await runMessy();

    assert.equal(exported.rowCount, canonical.test_cases.length, 'nothing was dropped');

    const cells = new Map(
      inspectWorkbook(exported.buffer).dataRows.map((row) => [row.cells.A, row.cells])
    );

    for (const testCase of canonical.test_cases) {
      const row = cells.get(testCase.case_id);
      assert.ok(row, `${testCase.case_id} is in the workbook`);
      assert.equal(row.E, testCase.priority, 'priority written as drafted');
    }

    assert.ok(
      [...cells.values()].some((row) => row.D === 'Positiv'),
      'not corrected'
    );
    assert.ok(
      [...cells.values()].some((row) => row.E === 'Urgent'),
      'not mapped onto High'
    );
    assert.ok(
      [...cells.values()].some((row) => row.D === 'Edge'),
      'not guessed into a direction'
    );
  });

  it('names every questionable cell instead of silently fixing it', async () => {
    const { exported } = await runMessy();

    assert.deepEqual(
      exported.warnings.map((warning) => warning.code).sort(),
      [
        'EDGE_POLARITY_UNRESOLVED_EXPORTED',
        'UNRECOGNIZED_CASE_TYPE_EXPORTED',
        'UNRECOGNIZED_PRIORITY_EXPORTED',
      ],
      'one per questionable field'
    );

    for (const warning of exported.warnings) {
      assert.match(warning.message, /QA review required/);
    }
  });

  it('keeps a resolved Edge case mapping exactly as it was', async () => {
    const { canonical, exported } = await runMessy();
    const cells = new Map(
      inspectWorkbook(exported.buffer).dataRows.map((row) => [row.cells.A, row.cells])
    );

    const resolved = canonical.test_cases.filter(
      (testCase) => testCase.case_type === 'Edge' && testCase.edge_polarity
    );
    assert.ok(resolved.length > 0, 'the fixture still has a resolved Edge case');

    for (const testCase of resolved) {
      const row = cells.get(testCase.case_id);
      assert.equal(row.D, testCase.edge_polarity === 'valid' ? 'Positive' : 'Negative');
      assert.equal(row.G, `[Edge Case] ${testCase.expected_result}`);
    }
  });

  it('leaves the template contract untouched', async () => {
    const { canonical, exported } = await runMessy();
    const workbook = inspectWorkbook(exported.buffer);
    const lastRow = canonical.test_cases.length + 1;

    assert.equal(workbook.tableRef, `C2:C${lastRow}`, 'the table still spans every row');
    assert.ok(workbook.hasDrawing, 'the drawing reference survived');

    for (const validation of workbook.validations) {
      assert.match(
        validation.sqref,
        new RegExp(`:[A-Z]+${lastRow}$`),
        `dropdown ${validation.sqref} still reaches the last row`
      );
    }

    for (const row of workbook.dataRows) {
      assert.ok(!row.cells.H && !row.cells.I, 'execution columns stay blank');
    }
  });

  it('keeps warned cases in coverage and in traceability', async () => {
    const { input, canonical } = await runMessy();
    const coverage = buildCoverage(canonical);
    const counted = new Set(coverage.entries.flatMap((entry) => entry.case_ids));

    const documentIds = new Set(input.documents.map((doc) => doc.document_id));

    for (const testCase of canonical.test_cases) {
      if (testCase.requirement_ids.length > 0) {
        assert.ok(counted.has(testCase.case_id), `${testCase.case_id} still counts for coverage`);
      }
      for (const reference of testCase.source_references) {
        assert.ok(documentIds.has(reference.document_id), 'source references stay system-owned');
      }
    }
  });
});
