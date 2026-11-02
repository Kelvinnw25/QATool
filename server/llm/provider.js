import { AppError } from '../lib/errors.js';
import { config, redactSecrets } from '../config.js';

/**
 * The LLM provider boundary (PRD 5).
 *
 * Everything vendor-specific lives behind this interface and inside this
 * directory. The generator in server/generate/ knows it is asking "something"
 * for JSON matching a schema; it does not know which vendor answers, what the
 * request looks like on the wire, or how that vendor spells its errors.
 *
 * That isolation is the point: swapping provider must be a config change and a
 * new file here, never an edit to domain or schema code.
 */

/**
 * The contract every provider implements.
 *
 * One method, because one is all generation needs. A provider takes an
 * instruction, a prompt and a JSON schema, and returns parsed JSON plus usage
 * metadata. Streaming, tools and multi-turn are deliberately absent: nothing in
 * V1 wants them, and an interface that promises them would have to be honoured
 * by every future adapter.
 */
export class LLMProvider {
  /** @param {{name: string, model: string}} descriptor */
  constructor({ name, model }) {
    this.name = name;
    this.model = model;
  }

  /**
   * @param {object} _request
   * @param {string} _request.system      instruction that frames the task
   * @param {string} _request.prompt      the input to work from
   * @param {object} _request.schema      JSON Schema the response must match
   * @param {AbortSignal} [_request.signal]
   * @returns {Promise<{data: unknown, usage: object}>} `data` is parsed JSON
   * @throws {LlmError}
   */
  // eslint-disable-next-line no-unused-vars
  async generateJson(_request) {
    throw new Error(`${this.constructor.name} must implement generateJson().`);
  }
}

/**
 * A provider failure, in QATOOL's vocabulary rather than the vendor's.
 *
 * Providers translate their own status codes and error bodies into these, so
 * the route layer can map a failure to a user-facing message without knowing
 * anything about the vendor. The original vendor message is deliberately not
 * relayed: it can contain the request, and the request contains the key.
 */
export class LlmError extends AppError {
  constructor(code, message, statusCode, details) {
    super(code, redactSecrets(message), statusCode, details);
    this.name = 'LlmError';
  }
}

export const LLM_ERRORS = {
  /** No key, or a provider name nothing implements. A configuration fault, not a runtime one. */
  NOT_CONFIGURED: 'LLM_NOT_CONFIGURED',
  AUTH_FAILED: 'LLM_AUTH_FAILED',
  RATE_LIMITED: 'LLM_RATE_LIMITED',
  TIMEOUT: 'LLM_TIMEOUT',
  UNAVAILABLE: 'LLM_UNAVAILABLE',
  /** Reply arrived but was not usable JSON, or was cut off before it finished. */
  MALFORMED_OUTPUT: 'LLM_MALFORMED_OUTPUT',
  TRUNCATED: 'LLM_TRUNCATED',
  /** The provider declined to answer - safety filter, blocked prompt. */
  REFUSED: 'LLM_REFUSED',
};

/**
 * Maps a provider's HTTP status to QATOOL's error vocabulary.
 *
 * Shared because the mapping is about what the caller should do - retry, fix
 * config, wait - and that is the same question whoever the vendor is.
 */
export function errorForStatus(status, providerName) {
  if (status === 401 || status === 403) {
    return new LlmError(
      LLM_ERRORS.AUTH_FAILED,
      `The ${providerName} API rejected the credentials. Check the API key on the server.`,
      502
    );
  }

  if (status === 429) {
    return new LlmError(
      LLM_ERRORS.RATE_LIMITED,
      `The ${providerName} API is rate limiting requests. Wait a moment and retry generation - extracted requirements are kept.`,
      429
    );
  }

  if (status === 400 || status === 404 || status === 422) {
    return new LlmError(
      LLM_ERRORS.NOT_CONFIGURED,
      `The ${providerName} API rejected the request as malformed, which usually means the configured model name is wrong.`,
      502
    );
  }

  if (status === 503) {
    // Overload, not an outage: providers shed load this way during demand
    // spikes, especially on free tiers, and it usually clears within minutes.
    return new LlmError(
      LLM_ERRORS.UNAVAILABLE,
      `The ${providerName} API is temporarily overloaded (HTTP 503). This usually clears within a few minutes - wait, then retry. Nothing needs re-uploading.`,
      503
    );
  }

  return new LlmError(
    LLM_ERRORS.UNAVAILABLE,
    `The ${providerName} API is unavailable (HTTP ${status}). Retry generation - extracted requirements are kept.`,
    502
  );
}

/**
 * Provider registry.
 *
 * Lazily imported so that adding a provider never costs startup time for the
 * one that is actually configured, and so a broken adapter cannot stop the
 * server booting.
 */
const REGISTRY = {
  gemini: async () => (await import('./gemini.js')).GeminiProvider,
  mock: async () => (await import('./mock.js')).MockProvider,
  apayee: async () => (await import('./apayee.js')).ApayeeProvider,
};

export function availableProviders() {
  return Object.keys(REGISTRY);
}

/**
 * Builds the configured provider.
 *
 * @param {object} [settings] defaults to config.llm; injected in tests
 * @returns {Promise<LLMProvider>}
 * @throws {LlmError} LLM_NOT_CONFIGURED
 */
export async function createProvider(settings = config.llm) {
  const load = REGISTRY[settings.provider];

  if (!load) {
    throw new LlmError(
      LLM_ERRORS.NOT_CONFIGURED,
      `LLM_PROVIDER is set to '${settings.provider}', which is not implemented. Available: ${availableProviders().join(', ')}.`,
      500
    );
  }

  const Provider = await load();
  return new Provider(settings);
}
