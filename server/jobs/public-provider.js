import { LlmError } from '../llm/provider.js';
import { LLM_MESSAGES } from '../security/public-errors.js';

/**
 * The model, as a job's stages see it.
 *
 * A stage no longer absorbs a provider failure: structuring, generation and the semantic
 * review all let it propagate, and the job fails in that phase. The error still reaches a
 * visitor, as the job's error. The adapter's own messages are written for the owner's
 * terminal and name the gateway ("Could not reach Apayee at http://apayee:4100
 * (ECONNREFUSED)").
 *
 * So the stages are handed this wrapper. It passes every call straight through; when the
 * provider fails with an LlmError it throws one of the same code and status with the fixed
 * public sentence for that code. The `upstreamCode` property survives, because the breaker
 * (breaker.js) needs it and it is not text.
 *
 * It also reports a neutral name and model, so nothing the stages copy into a result
 * identifies the vendor.
 */

/** @param {import('../llm/provider.js').LLMProvider} provider */
export function publicProvider(provider) {
  return {
    name: 'ai',
    model: 'ai',

    async generateJson(request) {
      try {
        return await provider.generateJson(request);
      } catch (error) {
        throw publicFailure(error);
      }
    },
  };
}

export function publicFailure(error) {
  if (!(error instanceof LlmError)) return error;

  const failure = new LlmError(
    error.code,
    LLM_MESSAGES[error.code] ?? 'The model provider is temporarily unavailable. Retry later.',
    error.statusCode
  );
  if (error.upstreamCode) failure.upstreamCode = error.upstreamCode;
  // Log-only: the gateway's code for this failure. Never part of what a visitor is told.
  if (error.gatewayCode) failure.gatewayCode = error.gatewayCode;
  return failure;
}
