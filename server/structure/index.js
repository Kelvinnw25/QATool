import { AppError } from '../lib/errors.js';
import { createProvider } from '../llm/provider.js';
import { assignBlockIds } from '../extract/blocks.js';
import { buildRequirements } from '../extract/requirements.js';
import { buildStructurePrompt, structureInstruction } from './prompt.js';
import { RESPONSE_SCHEMA, structureResponse } from './contract.js';
import { STRUCTURE_WARNINGS, reconstructRequirements, summariseSupporting } from './validate.js';
import { recoverBehaviouralBlocks } from './recover.js';
import { classifyLlmError, recordFacts, recordTiming, trace } from '../lib/trace.js';

/**
 * Gemini #1: requirement structuring and test point identification.
 *
 *   parsed blocks -> prompt -> provider -> contract -> structural check
 *                 -> reconstruct from source -> requirements + test points
 *
 * The first AI stage, and the one with the least authority. It decides which
 * blocks belong together and which are not requirements at all; it writes none
 * of the text, none of the identifiers and none of the source references. Those
 * are rebuilt from the blocks it cites, so the requirement a reviewer reads is
 * the document's own wording whatever the model said.
 *
 * Fail-soft by design. Deterministic extraction still exists and still works,
 * so a provider outage or a malformed reply costs the workflow its grouping
 * quality, not the workflow. The run continues on the deterministic
 * requirements with AI_REQUIREMENT_STRUCTURING_FAILED attached, and nothing is
 * invented to cover the gap.
 */

/** Everything the Upload stage needs to explain what did and did not run. */
function status(overrides = {}) {
  return {
    mode: 'deterministic',
    reason: null,
    error: null,
    provider: null,
    model: null,
    duration_ms: null,
    usage: null,
    blocks_sent: 0,
    blocks_omitted: 0,
    supporting_blocks: { total: 0, by_role: {} },
    ...overrides,
  };
}

/**
 * The fallback, and the floor on quality.
 *
 * One requirement per candidate block, exactly as extraction has always done
 * it: no grouping, no examples filtered, no test points. Worse than a good
 * structuring call and far better than nothing, which is the point.
 */
function deterministic(parsedDocuments, reason, error = null, category = null) {
  const { requirements } = buildRequirements(parsedDocuments);

  // The event the whole fail-soft design exists for. A run that reaches here
  // still produces output, so nothing downstream looks wrong - this line is
  // the only place the loss of grouping quality is visible.
  trace('deterministic_fallback_used', {
    failed_stage: 'GEMINI_1',
    reason,
    error_category: category,
    error_code: error?.code ?? null,
    fallback_used: true,
    fail_soft: true,
    requirement_count: requirements.length,
  });
  recordFacts({
    fallback_used: true,
    fallback_stage: 'GEMINI_1',
    fallback_reason: category ?? 'structuring_unusable',
  });

  return {
    requirements,
    testPoints: [],
    criteria: {},
    warnings: [
      {
        code: STRUCTURE_WARNINGS.AI_REQUIREMENT_STRUCTURING_FAILED,
        document_id: null,
        message:
          `${reason} Requirements fall back to deterministic extraction: each candidate block ` +
          `becomes its own requirement, examples are not filtered out, and no test points are ` +
          `available. Review the requirement list more closely than usual.`,
      },
    ],
    status: status({ mode: 'fallback', reason, error }),
  };
}

/**
 * @param {object[]} documents        document records from extraction
 * @param {object[]} parsedDocuments  {documentId, blocks} per document
 * @param {object} [options]
 * @param {import('../llm/provider.js').LLMProvider} [options.provider]  injected in tests
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<{requirements: object[], testPoints: object[], criteria: object, warnings: object[], status: object}>}
 */
export async function structureRequirements(documents, parsedDocuments, { provider, signal } = {}) {
  trace('structure_started', { document_count: parsedDocuments.length });
  const { blocks, byId } = assignBlockIds(parsedDocuments);
  trace('blocks_assigned', {
    block_count: blocks.length,
    character_count: blocks.reduce((sum, block) => sum + (block.text?.length ?? 0), 0),
  });

  if (blocks.length === 0) {
    return deterministic(parsedDocuments, 'No text blocks were extracted to structure.');
  }

  const startedAt = Date.now();
  let llm;

  try {
    llm = provider ?? (await createProvider());

    const { prompt, omitted } = buildStructurePrompt(documents, blocks);

    trace('gemini_1_started', {
      call_number: 1,
      provider: llm.name,
      model: llm.model,
      blocks_sent: blocks.length - omitted,
      truncated_block_count: omitted,
      // The size of what is sent, never the content of it.
      prompt_chars: prompt.length,
    });

    const { data, usage } = await llm.generateJson({
      system: structureInstruction(),
      prompt,
      schema: RESPONSE_SCHEMA,
      signal,
    });

    recordTiming('gemini1', Date.now() - startedAt);
    trace('gemini_1_completed', {
      call_number: 1,
      provider: llm.name,
      model: llm.model,
      duration_ms: Date.now() - startedAt,
      input_tokens: usage?.input_tokens ?? null,
      output_tokens: usage?.output_tokens ?? null,
      response_bytes: JSON.stringify(data ?? null).length,
    });

    const parsed = structureResponse.safeParse(data);
    if (!parsed.success) {
      return deterministic(
        parsedDocuments,
        'The structuring call returned JSON in the wrong shape, so none of it was used.',
        null,
        'parse_error'
      );
    }

    const rebuilt = reconstructRequirements(parsed.data, byId);
    trace('reconstruction_completed', {
      requirement_count: rebuilt.requirements.length,
      test_point_count: rebuilt.testPoints.length,
      warning_count: rebuilt.warnings.length,
      warning_codes: [...new Set(rebuilt.warnings.map((warning) => warning.code))],
    });

    // A reply that parsed but yielded nothing usable is a failure like any
    // other. Falling through with an empty requirement list would end the
    // workflow at the next gate with a far less helpful message.
    if (rebuilt.requirements.length === 0) {
      return deterministic(
        parsedDocuments,
        'The structuring call produced no requirement that could be rebuilt from the source blocks.',
        null,
        'nothing_rebuildable'
      );
    }

    // The grouping decides what is a requirement; it does not get to decide
    // what the document says. Any block it set aside that the obligation
    // detectors can read behaviour in comes back, so the coverage denominator
    // is a function of the document rather than of this call.
    const recovery = recoverBehaviouralBlocks(blocks, rebuilt.claimed, rebuilt.requirements.length);
    if (recovery.requirements.length > 0) {
      trace('behavioural_blocks_recovered', {
        recovered_requirements: recovery.requirements.length,
        recovered_blocks: recovery.requirements.reduce(
          (sum, requirement) => sum + requirement.source_references.length,
          0
        ),
        unclaimed_runs: recovery.considered,
      });
    }

    const warnings = [...rebuilt.warnings, ...recovery.warnings];
    if (omitted > 0) {
      warnings.push({
        code: STRUCTURE_WARNINGS.SOURCE_TRUNCATED,
        document_id: null,
        message: `${omitted} extracted block(s) exceeded the structuring size budget and were not sent. Requirements stated only in those blocks will be missing.`,
      });
    }

    return {
      requirements: [...rebuilt.requirements, ...recovery.requirements],
      testPoints: rebuilt.testPoints,
      criteria: rebuilt.criteria,
      warnings,
      status: status({
        mode: 'ai',
        provider: llm.name,
        model: llm.model,
        duration_ms: Date.now() - startedAt,
        usage,
        blocks_sent: blocks.length - omitted,
        blocks_omitted: omitted,
        supporting_blocks: summariseSupporting(parsed.data, byId),
      }),
    };
  } catch (error) {
    // Only controlled failures are absorbed: provider errors, missing
    // configuration, rate limits. A programming error should fail loudly rather
    // than be reported to the user as "structuring did not run".
    if (!(error instanceof AppError)) throw error;

    // A caller that cancelled is not a provider that failed. Falling back to
    // deterministic extraction would spend the work and record a degraded run
    // for a response nobody is waiting for.
    if (signal?.aborted) throw error;

    const category = classifyLlmError(error);
    recordTiming('gemini1', Date.now() - startedAt);
    trace('gemini_1_failed', {
      call_number: 1,
      provider: llm?.name ?? null,
      model: llm?.model ?? null,
      duration_ms: Date.now() - startedAt,
      error_category: category,
      error_class: error.constructor?.name ?? 'Error',
      error_code: error.code ?? null,
      error_message: error.message,
      fail_soft: true,
      fallback_used: true,
    });

    return deterministic(
      parsedDocuments,
      `The structuring call could not run: ${error.message}`,
      { code: error.code, message: error.message },
      category
    );
  }
}
