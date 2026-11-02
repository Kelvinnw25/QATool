import { LLMProvider, LlmError, LLM_ERRORS, errorForStatus } from './provider.js';

/**
 * Google Gemini, via the Generative Language API.
 *
 * The only file in QATOOL that knows this vendor exists. It speaks plain
 * `fetch` rather than an SDK: the request is one POST and one JSON body, and a
 * dependency that pulls in a transport stack to build that object would be a
 * poor trade in a codebase with no native dependencies.
 *
 * Structured output uses `responseMimeType: application/json` plus
 * `responseSchema`, so the model is constrained at the provider rather than
 * asked nicely in the prompt. That is a strong shaping aid and nothing more -
 * the reply is still parsed and validated against our own schema afterwards,
 * because a provider guarantee is not a guarantee about our canonical model.
 */

/** The key goes in a header, never the query string - URLs end up in logs. */
const API_KEY_HEADER = 'x-goog-api-key';

/**
 * `responseSchema` takes an OpenAPI 3.0 subset, not full JSON Schema.
 * Unsupported keywords are rejected outright, so they are stripped here rather
 * than avoided by hand in the contract - the contract should read as what we
 * want, not as what this vendor tolerates.
 */
const SUPPORTED_SCHEMA_KEYS = new Set([
  'type',
  'format',
  'description',
  'nullable',
  'enum',
  'items',
  'properties',
  'required',
  'minItems',
  'maxItems',
  'propertyOrdering',
]);

export function toGeminiSchema(schema) {
  if (Array.isArray(schema)) return schema.map(toGeminiSchema);
  if (schema === null || typeof schema !== 'object') return schema;

  const output = {};

  for (const [key, value] of Object.entries(schema)) {
    if (!SUPPORTED_SCHEMA_KEYS.has(key)) continue;

    if (key === 'properties') {
      output.properties = Object.fromEntries(
        Object.entries(value).map(([name, child]) => [name, toGeminiSchema(child)])
      );
      // Object key order is not guaranteed in the reply unless it is stated.
      // Asking for our order keeps generated JSON readable when it is logged
      // or inspected during a live test.
      output.propertyOrdering ??= Object.keys(value);
      continue;
    }

    if (key === 'items') {
      output.items = toGeminiSchema(value);
      continue;
    }

    if (key === 'type') {
      // OpenAPI spells types in upper case, and expresses "or null" as a flag
      // rather than as a union type.
      const types = Array.isArray(value) ? value : [value];
      const concrete = types.filter((entry) => entry !== 'null');
      output.type = String(concrete[0] ?? 'string').toUpperCase();
      if (types.length !== concrete.length) output.nullable = true;
      continue;
    }

    output[key] = value;
  }

  return output;
}

export class GeminiProvider extends LLMProvider {
  constructor(settings) {
    super({ name: 'Gemini', model: settings.model });
    this.settings = settings;

    if (!settings.apiKey) {
      throw new LlmError(
        LLM_ERRORS.NOT_CONFIGURED,
        'GEMINI_API_KEY is not set on the server. Generation needs an API key; extraction and export do not.',
        500
      );
    }
  }

  async generateJson({ system, prompt, schema, signal }) {
    const body = {
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: toGeminiSchema(schema),
        maxOutputTokens: this.settings.maxOutputTokens,
        // Only sent when explicitly configured: Gemini 3 models are meant to
        // run at their default, and a low value can cause looping.
        ...(this.settings.temperature === null || this.settings.temperature === undefined
          ? {}
          : { temperature: this.settings.temperature }),
      },
    };

    const payload = await this.#post(body, signal);
    return { data: parseCandidate(payload), usage: usageFrom(payload) };
  }

  async #post(body, externalSignal) {
    const url = `${this.settings.baseUrl}/models/${encodeURIComponent(this.settings.model)}:generateContent`;

    // Own timer, because fetch has no timeout of its own and a hung provider
    // would otherwise hold the request open indefinitely.
    const timer = AbortSignal.timeout(this.settings.timeoutMs);
    const signal = externalSignal ? AbortSignal.any([externalSignal, timer]) : timer;

    let response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', [API_KEY_HEADER]: this.settings.apiKey },
        body: JSON.stringify(body),
        signal,
      });
    } catch (cause) {
      if (timer.aborted) {
        throw new LlmError(
          LLM_ERRORS.TIMEOUT,
          `Gemini did not respond within ${Math.round(this.settings.timeoutMs / 1000)} seconds. Retry generation - extracted requirements are kept.`,
          504
        );
      }
      throw new LlmError(
        LLM_ERRORS.UNAVAILABLE,
        `Could not reach the Gemini API: ${cause.message}`,
        502
      );
    }

    if (!response.ok) {
      // The body is read and dropped rather than relayed: a provider error can
      // quote the request back, and the request carries document content.
      await response.text().catch(() => '');
      throw errorForStatus(response.status, 'Gemini');
    }

    try {
      return await response.json();
    } catch {
      throw new LlmError(
        LLM_ERRORS.MALFORMED_OUTPUT,
        'The Gemini API returned a response that was not JSON.',
        502
      );
    }
  }
}

/** Pulls the model's JSON out of the envelope, or says precisely what went wrong. */
function parseCandidate(payload) {
  if (payload?.promptFeedback?.blockReason) {
    throw new LlmError(
      LLM_ERRORS.REFUSED,
      `Gemini declined to process the request (${payload.promptFeedback.blockReason}).`,
      502
    );
  }

  const candidate = payload?.candidates?.[0];

  if (!candidate) {
    throw new LlmError(LLM_ERRORS.MALFORMED_OUTPUT, 'Gemini returned no candidate response.', 502);
  }

  if (candidate.finishReason === 'MAX_TOKENS') {
    throw new LlmError(
      LLM_ERRORS.TRUNCATED,
      'Gemini hit its output limit before finishing, so the result is incomplete. Reduce the number of requirements or raise LLM_MAX_OUTPUT_TOKENS, then retry.',
      502
    );
  }

  if (candidate.finishReason && !['STOP', 'MAX_TOKENS'].includes(candidate.finishReason)) {
    throw new LlmError(
      LLM_ERRORS.REFUSED,
      `Gemini stopped before finishing (${candidate.finishReason}).`,
      502
    );
  }

  // Thinking models can return thought parts alongside the answer. Only the
  // answer is JSON, so thoughts are excluded rather than concatenated in.
  const text = (candidate.content?.parts ?? [])
    .filter((part) => !part.thought)
    .map((part) => part.text ?? '')
    .join('')
    .trim();

  if (!text) {
    throw new LlmError(LLM_ERRORS.MALFORMED_OUTPUT, 'Gemini returned an empty response.', 502);
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new LlmError(
      LLM_ERRORS.MALFORMED_OUTPUT,
      'Gemini returned text that is not valid JSON, despite being asked for JSON.',
      502
    );
  }
}

function usageFrom(payload) {
  const usage = payload?.usageMetadata ?? {};
  return {
    input_tokens: usage.promptTokenCount ?? null,
    output_tokens: usage.candidatesTokenCount ?? null,
    // Billed as output, but reported separately by the API.
    thinking_tokens: usage.thoughtsTokenCount ?? null,
    total_tokens: usage.totalTokenCount ?? null,
  };
}
