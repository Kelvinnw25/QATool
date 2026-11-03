import { LlmError } from '../llm/provider.js';
import { LLM_MESSAGES } from '../security/public-errors.js';

/**
 * The model, as a job's stages see it.
 *
 * Three stages of the pipeline catch a provider failure and write its message into
 * what they return: structuring puts it in the reason of its deterministic fallback
 * and in a warning, and the semantic review puts it in its status. Those results go to
 * a visitor. The adapter's own messages are written for the owner's terminal and name
 * the gateway ("Could not reach Apayee at http://apayee:4100 (ECONNREFUSED)").
 *
 * Rather than rewrite three stages, the stages are handed this wrapper. It passes every
 * call straight through; when the provider fails with an LlmError it throws one of the
 * same code and status with the fixed public sentence for that code. The `upstreamCode`
 * property survives, because the breaker (breaker.js) needs it and it is not text.
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
  return failure;
}
