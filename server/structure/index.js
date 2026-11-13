import { AppError } from '../lib/errors.js';
import { createProvider } from '../llm/provider.js';
import { assignBlockIds } from '../extract/blocks.js';
import { buildStructurePrompt, structureInstruction } from './prompt.js';
import { RESPONSE_SCHEMA, structureResponse } from './contract.js';
import { STRUCTURE_WARNINGS, reconstructRequirements, summariseSupporting } from './validate.js';
import { recoverBehaviouralBlocks } from './recover.js';
import { classifyLlmError, recordTiming, setStage, trace, upstreamCodeOf } from '../lib/trace.js';

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
 * Fail-fast by design. There is no deterministic extraction behind this call and
 * no second provider: if the model cannot be reached, answers too late, or
 * sends a reply that cannot be used, this throws and the workflow stops here.
 * Nothing downstream ever runs on requirements the model did not structure.
 *
 * (The `gemini_1_*` event names are the stage's original labels. Whichever
 * provider answered is in the `provider` field; the names are kept so existing
 * log queries keep working.)
 */

/** Everything the Upload stage needs to explain what did and did not run. */
function status(overrides = {}) {
  return {
    // 'ai' when the model structured the documents; 'none' when there was nothing to
    // structure and no call was made. There is no third value.
    mode: 'ai',
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
 * A reply the model sent that cannot be turned into requirements.
 *
 * There is no fallback behind it. The structuring call decides which blocks are
 * requirements and which are examples or background; a line-by-line reading
 * cannot make that call, and what it produced instead (a requirement per
 * sentence, empty "THEN the system must:" stubs, criteria lost as headings) looked
 * like a result and was not one. A run that cannot be structured fails here, in
 * this stage, with a code a visitor can be told and a log line an operator can
 * use. Retrying is the user's decision.
 */
function unusableReply(reason) {
  // Why, as a fixed word. The failure itself is traced once, by the catch below.
  trace('structuring_reply_rejected', { reason });
  // The model's own text is never in the error: it can quote the document.
  return new AppError(
    'LLM_MALFORMED_OUTPUT',
    'The model returned a reply that could not be used.',
    502
  );
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
  // So a run that stops in this call says so (`stage=STRUCTURE`), not whatever came before.
  setStage('STRUCTURE');
  trace('structure_started', { document_count: parsedDocuments.length });
  const { blocks, byId } = assignBlockIds(parsedDocuments);
  trace('blocks_assigned', {
    block_count: blocks.length,
    character_count: blocks.reduce((sum, block) => sum + (block.text?.length ?? 0), 0),
  });

  // Nothing to send, so no call is made and nothing is substituted: the caller
  // refuses an empty extraction (NO_REQUIREMENTS_EXTRACTED) with the per-document facts.
  if (blocks.length === 0) {
    return {
      requirements: [],
      testPoints: [],
      criteria: {},
      warnings: [],
      status: status({ mode: 'none', reason: 'No text blocks were extracted to structure.' }),
    };
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
      stage: 'structure',
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
    if (!parsed.success) throw unusableReply('wrong_shape');

    const rebuilt = reconstructRequirements(parsed.data, byId);
    trace('reconstruction_completed', {
      requirement_count: rebuilt.requirements.length,
      test_point_count: rebuilt.testPoints.length,
      warning_count: rebuilt.warnings.length,
      warning_codes: [...new Set(rebuilt.warnings.map((warning) => warning.code))],
    });

    // A reply that parsed but yielded nothing usable is a failure like any
    // other: no requirement could be rebuilt from the blocks it cited.
    if (rebuilt.requirements.length === 0) throw unusableReply('nothing_rebuildable');

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
    // Recorded, then rethrown untouched. Nothing is absorbed here: not a provider
    // error, not a rate limit, not a reply that could not be used. The caller sees
    // the same error it would have seen with no catch at all.
    //
    // A caller that cancelled is not a provider that failed; there is nothing to log.
    if (signal?.aborted || !(error instanceof AppError)) throw error;

    recordTiming('gemini1', Date.now() - startedAt);
    trace('gemini_1_failed', {
      call_number: 1,
      provider: llm?.name ?? null,
      model: llm?.model ?? null,
      duration_ms: Date.now() - startedAt,
      error_category: classifyLlmError(error),
      error_class: error.constructor?.name ?? 'Error',
      error_code: error.code ?? null,
      upstream_code: upstreamCodeOf(error),
      error_message: error.message,
      fail_soft: false,
      fallback_used: false,
    });

    throw error;
  }
}
