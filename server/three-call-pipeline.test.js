import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { extractDocuments } from './extract/index.js';
import { generateFromRequirements } from './generate/index.js';
import { reviewSemantics } from './semantic/index.js';
import { canonicalProjectSchema, checkCanonicalReferences } from './schema/canonical.js';
import { exportSitScript } from './export/sit-script-export.js';
import { inspectWorkbook } from './export/inspect.js';
import { MockProvider } from './llm/mock.js';
import { LlmError, LLM_ERRORS } from './llm/provider.js';
import { buildDocx } from './extract/fixtures/build.js';
import { STRUCTURE_WARNINGS } from './structure/validate.js';
import { summarise, trace, withRun } from './lib/trace.js';

/**
 * The MVP pipeline, end to end, from an uploaded file to a workbook.
 *
 *   upload -> [SYSTEM] extraction -> [GEMINI #1] structuring
 *          -> [SYSTEM] structural validation + reconstruction from source
 *          -> [GEMINI #2] generation -> [SYSTEM] validation + traceability
 *          -> [GEMINI #3] review -> results -> export
 *
 * Every model is scripted, so the whole thing runs with no network, no key and
 * no quota. What it proves is the shape of the pipeline rather than the quality
 * of any one reply: three calls, in that order, with the system owning every
 * boundary between them.
 */

/** A DOCX whose acceptance criteria are split one line per block, as real ones are. */
function uploadedDocument() {
  return {
    filename: 'PRD Settlement Routing.docx',
    mimetype: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    buffer: buildDocx([
      { style: 'Heading1', text: 'Requirements' },
      { text: 'GIVEN the participant is Suspended' },
      { text: 'WHEN a settlement instruction is submitted' },
      { text: 'THEN the system must fulfill:' },
      { text: 'The instruction must be rejected with code KLR-01' },
      { text: 'The rejection must be recorded in the penalty log' },
      { style: 'Heading1', text: 'Synthetic UI example' },
      { text: 'QRDEMO001 FTDEMO014922 PENDING is shown for illustration only' },
    ]),
  };
}

/**
 * Block ids are assigned by position over every parsed block, so the reply has
 * to be built from what the parser actually produced rather than guessed at.
 */
function structuringReplyFor(blockIds) {
  const requirementBlocks = blockIds.filter((id, index) => index >= 1 && index <= 5);

  return {
    requirements: [
      {
        title: 'Suspended participant routing',
        source_block_ids: requirementBlocks,
        test_points: [
          { type: 'branch', statement: 'A Suspended participant has the instruction rejected' },
          { type: 'mapping', statement: 'Rejection returns code KLR-01' },
          { type: 'side_effect', statement: 'The rejection is written to the penalty log' },
        ],
        ambiguous: false,
        conflicted: false,
        fragmented: false,
      },
    ],
    supporting_blocks: [
      {
        source_block_ids: blockIds.slice(6),
        role: 'example',
        reason: 'synthetic UI example',
      },
    ],
  };
}

function generationReply() {
  return {
    project: {
      project_description: 'Settlement routing for suspended participants.',
      project_summary: 'Validates rejection behaviour for suspended participants.',
      qa_guidance: 'Focus on the rejection code and the penalty log entry.',
      sit_scope: [
        'Routing: rejection paths for suspended participants',
        'Codes: KLR-01 mapping',
        'Logging: penalty log entries',
      ],
      project_background: 'SIT for the settlement routing change.',
    },
    test_cases: [
      {
        requirement_ids: ['REQ-001'],
        section: 'Settlement routing',
        test_case: 'Verify a settlement instruction from a Suspended participant is rejected.',
        case_type: 'Negative',
        priority: 'High',
        type: 'Functional',
        expected_result:
          'The instruction is rejected with code KLR-01 and the rejection is recorded in the penalty log.',
        confidence: 'High',
        warnings: [],
      },
    ],
    warnings: [],
  };
}

const REVIEW_REPLY = {
  issues: [
    {
      category: 'missing_coverage',
      severity: 'low',
      testcase_id: null,
      requirement_id: 'REQ-001',
      explanation: 'The format of the penalty log entry is never verified.',
    },
  ],
};

/**
 * Runs the whole thing. The structuring provider answers from the block ids the
 * parser produced, which is why it is a function rather than a fixed object.
 */
async function runPipeline({ structuringProvider } = {}) {
  let capturedBlockIds = [];

  const structuring =
    structuringProvider ??
    new MockProvider({
      responses: (request) => {
        capturedBlockIds = [...request.prompt.matchAll(/"source_block_id": "([^"]+)"/g)].map(
          (match) => match[1]
        );
        return structuringReplyFor(capturedBlockIds);
      },
    });

  const generation = new MockProvider({ responses: generationReply() });
  const review = new MockProvider({ responses: REVIEW_REPLY });

  const extracted = await extractDocuments([uploadedDocument()], { provider: structuring });

  const input = {
    project: { project_name: 'Settlement Routing' },
    documents: extracted.documents,
    requirements: extracted.requirements,
    test_cases: [],
  };

  const generated = await generateFromRequirements(input, {
    provider: generation,
    testPoints: extracted.test_points,
  });

  const canonical = { ...input, project: generated.project, test_cases: generated.test_cases };

  const semantic = await reviewSemantics(canonical, {
    useLlm: true,
    structurallyValid: true,
    provider: review,
    testPoints: extracted.test_points,
  });

  return {
    extracted,
    generated,
    canonical,
    semantic,
    blockIds: capturedBlockIds,
    calls: { structuring, generation, review },
  };
}

describe('the three-call pipeline', () => {
  it('spends exactly three model calls, one per stage', async () => {
    const { calls } = await runPipeline();

    assert.equal(calls.structuring.calls.length, 1, 'Gemini #1 once');
    assert.equal(calls.generation.calls.length, 1, 'Gemini #2 once');
    assert.equal(calls.review.calls.length, 1, 'Gemini #3 once');
  });

  it('gives every extracted block a system-owned id before the model sees it', async () => {
    const { blockIds, calls } = await runPipeline();

    assert.ok(blockIds.length >= 7, 'every block was sent, not just the requirement-like ones');
    for (const id of blockIds) assert.match(id, /^DOC-001-B\d{3}$/);

    assert.match(calls.structuring.calls[0].prompt, /Do not write requirement text/);
  });

  /**
   * The audit finding this pipeline exists to fix. Line-based extraction turned
   * "THEN the system must fulfill:" into a requirement and lost the two bullets
   * underneath it; structuring keeps all five blocks together as one rule.
   */
  it('reconstructs the split acceptance criteria into one requirement', async () => {
    const { extracted } = await runPipeline();

    assert.equal(extracted.structuring.mode, 'ai');
    assert.equal(extracted.requirements.length, 1, 'five blocks, one requirement');

    const [requirement] = extracted.requirements;
    assert.match(requirement.description, /GIVEN the participant is Suspended/);
    assert.match(requirement.description, /rejected with code KLR-01/);
    assert.match(requirement.description, /recorded in the penalty log/);
  });

  it('keeps the synthetic example out of the requirements', async () => {
    const { extracted } = await runPipeline();

    const text = extracted.requirements.map((entry) => entry.description).join(' ');
    assert.ok(!text.includes('QRDEMO001'), 'illustration is not specification');
    assert.equal(extracted.structuring.supporting_blocks.by_role.example, 2);
  });

  it('carries test points from #1 into #2 and #3', async () => {
    const { calls, extracted } = await runPipeline();

    assert.equal(extracted.test_points.length, 3);
    assert.match(calls.generation.calls[0].prompt, /Rejection returns code KLR-01/);
    assert.match(calls.review.calls[0].prompt, /written to the penalty log/);
  });

  it('sends the reconstructed source text, not a model paraphrase, to #2', async () => {
    const { calls, extracted } = await runPipeline();

    assert.match(calls.generation.calls[0].prompt, /THEN the system must fulfill/);
    assert.equal(
      extracted.requirements[0].description.includes('Suspended participant routing'),
      false,
      'the title the model wrote is not in the body'
    );
  });

  it('keeps the reviewer advisory: findings change nothing', async () => {
    const { canonical, semantic } = await runPipeline();

    const before = JSON.stringify(canonical.test_cases);
    assert.ok(semantic.issues.length > 0, 'it did produce findings');
    assert.equal(JSON.stringify(canonical.test_cases), before, 'and mutated nothing');
    assert.equal(canonical.test_cases.length, 1, 'no case was deleted by a finding');
  });

  it('produces a valid project with system-owned ids and references', async () => {
    const { canonical } = await runPipeline();

    assert.doesNotThrow(() => canonicalProjectSchema.parse(canonical));
    assert.deepEqual(checkCanonicalReferences(canonical), []);
    assert.equal(canonical.test_cases[0].case_id, 'TC-001');

    for (const reference of canonical.test_cases[0].source_references) {
      assert.equal(reference.document_id, 'DOC-001');
    }
  });

  it('keeps test points out of the canonical project', async () => {
    const { canonical } = await runPipeline();

    assert.ok(!('test_points' in canonical));
    for (const requirement of canonical.requirements) {
      assert.ok(!('test_points' in requirement));
    }
  });

  it('exports a workbook that still satisfies the template contract', async () => {
    const { canonical } = await runPipeline();
    const result = exportSitScript(canonical.test_cases);
    const workbook = inspectWorkbook(result.buffer);

    assert.equal(result.rowCount, canonical.test_cases.length);
    assert.equal(workbook.tableRef, `C2:C${canonical.test_cases.length + 1}`);

    const sheet = workbook.dataRows.map((row) => Object.values(row.cells).join(' ')).join(' ');
    assert.ok(!sheet.includes('QRDEMO001'), 'no example data reaches the workbook');

    for (const row of workbook.dataRows) {
      assert.ok(!row.cells.H && !row.cells.I, 'execution columns stay blank');
    }
  });

  /**
   * Fail-soft, at the top of the pipeline. Losing the structuring call costs
   * grouping quality; it does not cost the workflow, and nothing is invented to
   * fill the gap.
   */
  it('still completes when Gemini #1 is unavailable', async () => {
    const down = new MockProvider({
      failWith: new LlmError(LLM_ERRORS.UNAVAILABLE, 'Provider is down.', 503),
    });

    const { extracted, canonical, calls } = await runPipeline({ structuringProvider: down });

    assert.equal(extracted.structuring.mode, 'fallback');
    assert.ok(extracted.requirements.length > 0, 'deterministic extraction carried it');
    assert.deepEqual(extracted.test_points, [], 'no test points were invented');
    assert.ok(
      extracted.warnings.some(
        (warning) => warning.code === STRUCTURE_WARNINGS.AI_REQUIREMENT_STRUCTURING_FAILED
      ),
      'and the loss is announced'
    );

    assert.equal(canonical.test_cases.length, 1, 'generation and review still ran');
    assert.equal(calls.generation.calls.length, 1);
    assert.equal(calls.review.calls.length, 1);
  });

  it('writes nothing to disk along the way', async () => {
    const { extracted } = await runPipeline();

    // The buffers are released with the request; what survives is structure.
    assert.ok(!('buffer' in extracted), 'no upload is returned');
    assert.ok(
      extracted.documents.every((document) => !('path' in document)),
      'no document carries a filesystem path'
    );
  });
});

/**
 * Tracing over the same pipeline.
 *
 * The property that matters is joinability: every stage of one request must
 * carry the same run_id, or the logs cannot be reassembled and the module is
 * decoration. Asserted against the real stage modules, not a mock of them.
 */
describe('run tracing across the pipeline', () => {
  function recorder() {
    const lines = [];
    return { lines, info: (fields) => lines.push(fields) };
  }

  function eventsOf(logger) {
    return logger.lines
      .filter((line) => typeof line === 'object' && line.event)
      .map((l) => l.event);
  }

  it('gives one request one run_id, shared by all three model calls', async () => {
    const logger = recorder();

    const { extracted, generated } = await withRun({ logger, route: '/api/extract' }, async () => {
      trace('request_received', { method: 'POST', route: '/api/extract' });
      return runPipeline();
    });

    assert.ok(extracted.requirements.length > 0, 'the pipeline really ran');
    assert.ok(generated.test_cases.length > 0);

    const ids = new Set(logger.lines.map((line) => line.run_id));
    assert.equal(ids.size, 1, 'one run, one id across extraction, generation and review');
    assert.match([...ids][0], /^QATOOL-\d{8}-[0-9A-F]{6}$/);

    const events = eventsOf(logger);
    for (const expected of [
      'request_received',
      'extraction_started',
      'parser_started',
      'parser_completed',
      'structure_started',
      'blocks_assigned',
      'gemini_1_started',
      'gemini_1_completed',
      'reconstruction_completed',
      'extraction_completed',
      'generation_started',
      'gemini_2_started',
      'gemini_2_completed',
      'testcase_validation_completed',
      'coverage_completed',
      'review_started',
      'gemini_3_started',
      'gemini_3_completed',
    ]) {
      assert.ok(events.includes(expected), `${expected} was traced`);
    }
  });

  it('numbers the three calls 1, 2 and 3', async () => {
    const logger = recorder();

    await withRun({ logger }, () => runPipeline());

    const numbered = logger.lines
      .filter((line) => line.event?.endsWith('_started') && line.call_number)
      .map((line) => [line.event, line.call_number]);

    assert.deepEqual(numbered, [
      ['gemini_1_started', 1],
      ['gemini_2_started', 2],
      ['gemini_3_started', 3],
    ]);
  });

  it('records a timing per model call and one summary from them', async () => {
    const logger = recorder();
    let summary;

    await withRun({ logger }, async (run) => {
      await runPipeline();
      summary = summarise(run, { status: 'SUCCESS' });
    });

    assert.match(summary, /gemini1=\d+\.\ds/);
    assert.match(summary, /gemini2=\d+\.\ds/);
    assert.match(summary, /gemini3=\d+\.\ds/);
    assert.match(summary, /testcases=\d+/);
    assert.equal(summary.split('RUN ').length - 1, 1, 'exactly one summary line');
  });

  it('traces the Gemini #1 fallback as degraded, with a category, and continues', async () => {
    const logger = recorder();
    let summary;

    const { extracted } = await withRun({ logger }, async (run) => {
      const result = await runPipeline({
        structuringProvider: new MockProvider({
          failWith: new LlmError(LLM_ERRORS.UNAVAILABLE, 'Gemini is overloaded.', 503),
        }),
      });

      summary = summarise(run, {
        status: run.facts.fallback_used ? 'DEGRADED' : 'SUCCESS',
        reason: run.facts.fallback_reason,
        failSoft: true,
      });
      return result;
    });

    const failure = logger.lines.find((line) => line.event === 'gemini_1_failed');
    assert.ok(failure, 'the failure itself is traced');
    assert.equal(failure.error_category, '503', 'and classified as refused capacity');
    assert.equal(failure.fail_soft, true);

    const fallback = logger.lines.find((line) => line.event === 'deterministic_fallback_used');
    assert.ok(fallback, 'the fallback is an explicit event, not an absence');
    assert.equal(fallback.fallback_used, true);

    // Fail-soft, unchanged: the run still produced requirements and reached
    // the later stages.
    assert.ok(extracted.requirements.length > 0);
    assert.equal(extracted.structuring.mode, 'fallback');
    assert.match(summary, /status=DEGRADED/);
    assert.match(summary, /reason=503/);
    assert.ok(eventsOf(logger).includes('gemini_2_completed'), 'generation still ran');
  });

  it('traces a Gemini #2 failure without swallowing it', async () => {
    const logger = recorder();

    const failure = new LlmError(LLM_ERRORS.RATE_LIMITED, 'Rate limited.', 429);

    await withRun({ logger }, async () => {
      const extracted = await extractDocuments([uploadedDocument()], {
        provider: new MockProvider({
          responses: (request) =>
            structuringReplyFor(
              [...request.prompt.matchAll(/"source_block_id": "([^"]+)"/g)].map((m) => m[1])
            ),
        }),
      });

      await assert.rejects(
        generateFromRequirements(
          {
            project: { project_name: 'Settlement Routing' },
            documents: extracted.documents,
            requirements: extracted.requirements,
            test_cases: [],
          },
          { provider: new MockProvider({ failWith: failure }), testPoints: extracted.test_points }
        ),
        // Rethrown unchanged: tracing must not turn a fatal into a fallback.
        (error) => error.code === LLM_ERRORS.RATE_LIMITED
      );
    });

    const traced = logger.lines.find((line) => line.event === 'gemini_2_failed');
    assert.ok(traced);
    assert.equal(traced.error_category, '429');
    assert.equal(traced.fail_soft, false, 'generation failure is not fail-soft');
    assert.equal(traced.fallback_used, false);
  });

  it('never emits a prompt, a reply or document text', async () => {
    const logger = recorder();

    await withRun({ logger }, () => runPipeline());

    const serialised = JSON.stringify(logger.lines);

    // Phrases that exist only inside the uploaded document and the prompts
    // built from it. If tracing leaked either, they would appear here.
    for (const secret of [
      'GIVEN the participant is Suspended',
      'penalty log',
      'QRDEMO001',
      'FTDEMO014922',
      'You prepare System Integration Testing',
    ]) {
      assert.ok(!serialised.includes(secret), `${secret} must not reach a log line`);
    }

    // And the diagnostics that replace them are present.
    const geminiStart = logger.lines.find((line) => line.event === 'gemini_1_started');
    assert.equal(typeof geminiStart.prompt_chars, 'number', 'size, not content');
    assert.ok(!('prompt' in geminiStart));
  });
});
