import { randomUUID } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import { LLMProvider, LlmError, LLM_ERRORS, errorForStatus } from './provider.js';

/**
 * Apayee, a private AI gateway reached over HTTP.
 *
 * The only file in QATOOL that knows Apayee exists. Apayee owns the queue, the
 * concurrency limit and the choice of model; this adapter sends one request and
 * translates the reply into the same `{ data, usage }` every other provider
 * returns. It adds nothing to the prompt or the schema and removes nothing.
 *
 * node:http, not fetch. Apayee answers synchronously, so response headers
 * arrive only when generation ends, after any time spent queued. fetch's
 * default headersTimeout is 300 seconds and would abort a call that Apayee
 * would still have completed. The deadline here is explicit instead.
 *
 * One connection per call (`agent: false`). Calls are minutes apart, so pooling
 * saves nothing, and a pooled socket that Apayee closed in the meantime would
 * fail the next POST with ECONNRESET, which this adapter must never retry.
 *
 * Nothing is retried. A failed call is reported and the caller decides.
 */

const GENERATE_PATH = '/v1/generate';
const HEALTH_PATH = '/v1/health';

/**
 * Apayee requires a task. QATOOL's contract has no field for one, and the three
 * call sites share one signature, so every call is 'generic' rather than
 * widening the contract for a label the gateway does not need.
 */
const TASK = 'generic';

/** A reply this large is not a generation; stop reading rather than buffer it. */
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;

/** Node timers fire immediately above this. */
const MAX_TIMER_MS = 2_147_483_647;

export const DEFAULT_APAYEE_BASE_URL = 'http://127.0.0.1:4100';

function misconfigured(message) {
  return new LlmError(LLM_ERRORS.NOT_CONFIGURED, message, 500);
}

function isLoopbackHostname(hostname) {
  const host = hostname.toLowerCase();
  return host === 'localhost' || host === '[::1]' || /^127(\.\d{1,3}){3}$/.test(host);
}

/**
 * Checks the settings and returns what the adapter needs from them.
 *
 * Called from the constructor and, for `LLM_PROVIDER=apayee`, at server startup,
 * so a mistake is found when the server boots and not on the first generation.
 * Messages name the variable and never quote its value: the URL or token could
 * carry a credential.
 *
 * @throws {LlmError} LLM_NOT_CONFIGURED
 */
export function validateApayeeSettings(settings) {
  let base;
  try {
    base = new URL(settings.apayeeBaseUrl);
  } catch {
    throw misconfigured('APAYEE_BASE_URL is not a valid URL, e.g. http://127.0.0.1:4100.');
  }

  if (base.protocol !== 'http:' && base.protocol !== 'https:') {
    throw misconfigured('APAYEE_BASE_URL must start with http:// or https://.');
  }
  if (base.username || base.password) {
    throw misconfigured(
      'APAYEE_BASE_URL must not contain credentials. Put the token in APAYEE_TOKEN.'
    );
  }
  if (base.search || base.hash) {
    throw misconfigured('APAYEE_BASE_URL must not contain a query string or fragment.');
  }

  const token = settings.apayeeToken || null;
  if (token && !/^[\x21-\x7e]+$/.test(token)) {
    throw misconfigured(
      'APAYEE_TOKEN contains spaces or characters that cannot be sent in an HTTP header.'
    );
  }
  if (!token && !isLoopbackHostname(base.hostname)) {
    // Apayee itself refuses remote access without a token, and this is the other
    // half of that rule: documents should not be sent to a gateway on another
    // machine that is not asking who is calling.
    throw misconfigured(
      'APAYEE_BASE_URL points at another machine, which needs APAYEE_TOKEN. Apayee requires one for remote access.'
    );
  }

  const { timeoutMs, apayeeQueueWaitMs: queueWaitMs } = settings;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw misconfigured('LLM_TIMEOUT_MS must be a positive number of milliseconds.');
  }
  if (!Number.isSafeInteger(queueWaitMs) || queueWaitMs < 0) {
    throw misconfigured('APAYEE_QUEUE_WAIT_MS must be zero or a positive number of milliseconds.');
  }
  if (timeoutMs + queueWaitMs > MAX_TIMER_MS) {
    throw misconfigured('LLM_TIMEOUT_MS plus APAYEE_QUEUE_WAIT_MS is too large.');
  }

  // Kept as a prefix so a gateway behind a reverse proxy (http://host/apayee)
  // is reached at /apayee/v1/generate rather than at the host root.
  const endpoint = new URL(base);
  endpoint.pathname = base.pathname.replace(/\/+$/, '') + GENERATE_PATH;

  return { endpoint, origin: base.origin, token, timeoutMs, queueWaitMs };
}

/**
 * Apayee's error codes, in QATOOL's vocabulary.
 *
 * Keyed by the code Apayee documents. The message Apayee sent is not relayed:
 * these are written for the QATOOL operator, and nothing a remote service says
 * reaches a user or a log verbatim - the rule Gemini's adapter follows too.
 * Status values matter beyond the response: classifyLlmError() reads 502 on
 * LLM_UNAVAILABLE as "could not reach" and anything else as "overloaded".
 */
const CONFIG_MISMATCH = (code) =>
  new LlmError(
    LLM_ERRORS.NOT_CONFIGURED,
    `Apayee rejected the request (${code}). This usually means a configuration mismatch: check APAYEE_BASE_URL, that LLM_TIMEOUT_MS does not exceed Apayee's APAYEE_MAX_TIMEOUT_MS, and Apayee's request size limits.`,
    502
  );

function authFailed() {
  return new LlmError(
    LLM_ERRORS.AUTH_FAILED,
    'Apayee rejected the credentials. Check APAYEE_TOKEN on the server.',
    502
  );
}

const FOR_APAYEE_CODE = {
  UNAUTHORIZED: authFailed,
  QUEUE_FULL: () =>
    new LlmError(
      LLM_ERRORS.RATE_LIMITED,
      "Apayee's request queue is full. Wait a moment and retry generation - extracted requirements are kept.",
      429
    ),
  PROVIDER_TIMEOUT: () => timedOut('Apayee did not finish generating in time.'),
  QUEUE_TIMEOUT: () => timedOut('The request waited too long in the Apayee queue.'),
  INVALID_PROVIDER_RESPONSE: () =>
    new LlmError(
      LLM_ERRORS.MALFORMED_OUTPUT,
      'Apayee reported that its provider returned output that does not match the requested structure.',
      502
    ),
  PROVIDER_NOT_READY: () =>
    new LlmError(
      LLM_ERRORS.NOT_CONFIGURED,
      "Apayee's provider is not ready, for example the Claude CLI is signed out or the provider is disabled. Waiting will not fix this: check the provider status on the Apayee host.",
      503
    ),
  PROVIDER_RATE_LIMITED: () =>
    new LlmError(
      LLM_ERRORS.RATE_LIMITED,
      "Apayee's provider reported a rate or usage limit. A subscription's session or weekly limit can take hours to reset, so do not retry straight away. Extracted requirements are kept.",
      429
    ),
  PROVIDER_UNAVAILABLE: () => overloaded('Apayee could not complete the request.'),
  SERVICE_SHUTTING_DOWN: () => overloaded('Apayee is shutting down.'),
  REQUEST_CANCELLED: () => unreachable('Apayee reported the request as cancelled.'),
  INTERNAL_ERROR: () => unreachable('Apayee reported an internal error.'),
  INVALID_REQUEST: () => CONFIG_MISMATCH('INVALID_REQUEST'),
  INVALID_SCHEMA: () => CONFIG_MISMATCH('INVALID_SCHEMA'),
  UNSUPPORTED_TASK: () => CONFIG_MISMATCH('UNSUPPORTED_TASK'),
  FORBIDDEN_ORIGIN: () => CONFIG_MISMATCH('FORBIDDEN_ORIGIN'),
  NOT_FOUND: () => CONFIG_MISMATCH('NOT_FOUND'),
  DUPLICATE_REQUEST_ID: () => CONFIG_MISMATCH('DUPLICATE_REQUEST_ID'),
  REQUEST_TOO_LARGE: () => CONFIG_MISMATCH('REQUEST_TOO_LARGE'),
  UNSUPPORTED_MEDIA_TYPE: () => CONFIG_MISMATCH('UNSUPPORTED_MEDIA_TYPE'),
};

function timedOut(reason) {
  return new LlmError(
    LLM_ERRORS.TIMEOUT,
    `${reason} Retry generation - extracted requirements are kept.`,
    504
  );
}

function overloaded(reason) {
  return new LlmError(
    LLM_ERRORS.UNAVAILABLE,
    `${reason} This usually clears within a few minutes - wait, then retry. Nothing needs re-uploading.`,
    503
  );
}

function unreachable(reason) {
  return new LlmError(LLM_ERRORS.UNAVAILABLE, reason, 502);
}

function malformed(reason) {
  return new LlmError(LLM_ERRORS.MALFORMED_OUTPUT, `Apayee ${reason}.`, 502);
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function tokenCount(value) {
  return Number.isFinite(value) ? value : null;
}

/** Apayee reports what its provider reports. Only counts are carried over. */
function usageFrom(usage) {
  const input = tokenCount(usage?.input_tokens);
  const output = tokenCount(usage?.output_tokens);

  return {
    input_tokens: input,
    output_tokens: output,
    thinking_tokens: null,
    total_tokens: input !== null && output !== null ? input + output : null,
  };
}

/**
 * How long a health check may take. It is a liveness question, not a
 * generation, so it gets a short, fixed bound of its own.
 */
export const HEALTH_TIMEOUT_MS = 2_000;

const MAX_HEALTH_BYTES = 64 * 1024;

/**
 * Reads Apayee's documented `GET /v1/health` reply into a state QATOOL can act on.
 * Only the state and the provider's name leave this function: nothing else the
 * gateway reports (version, queue figures) is carried further.
 */
function readHealth(status, text) {
  if (status === 401 || status === 403) return { state: 'unauthorized' };
  if (status !== 200) return { state: 'unexpected' };

  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    return { state: 'unexpected' };
  }

  if (!isRecord(body) || body.service !== 'apayee') return { state: 'unexpected' };
  if (body.status === 'shutting_down') return { state: 'shutting_down' };
  if (body.status !== 'ok') return { state: 'unexpected' };
  if (typeof body.provider !== 'string' || body.provider === '') return { state: 'unexpected' };

  return { state: 'ready', provider: body.provider };
}

/**
 * Asks the gateway whether it is up, whether it accepts QATOOL's credentials and
 * which provider it is running.
 *
 * Never throws and never retries: the answer is one of `ready` (with the
 * provider's name), `offline`, `timeout`, `unauthorized`, `shutting_down`,
 * `unexpected` or `misconfigured`. The gateway reply is not relayed, and the
 * URL and token are used for the request only.
 *
 * @param {object} settings  config.llm
 * @param {{ timeoutMs?: number }} [options]
 * @returns {Promise<{state: string, provider?: string}>}
 */
export function probeGateway(settings, { timeoutMs = HEALTH_TIMEOUT_MS } = {}) {
  let checked;
  try {
    checked = validateApayeeSettings(settings);
  } catch {
    return Promise.resolve({ state: 'misconfigured' });
  }

  const url = new URL(checked.endpoint);
  url.pathname = url.pathname.slice(0, -GENERATE_PATH.length) + HEALTH_PATH;

  const deadline = AbortSignal.timeout(timeoutMs);

  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const lost = () => finish({ state: deadline.aborted ? 'timeout' : 'offline' });

    const transport = url.protocol === 'https:' ? https : http;
    const request = transport.request(
      url,
      {
        method: 'GET',
        agent: false,
        signal: deadline,
        headers: {
          accept: 'application/json',
          ...(checked.token ? { authorization: `Bearer ${checked.token}` } : {}),
        },
      },
      (response) => {
        const chunks = [];
        let size = 0;

        response.on('data', (chunk) => {
          size += chunk.length;
          if (size > MAX_HEALTH_BYTES) {
            finish({ state: 'unexpected' });
            request.destroy();
            return;
          }
          chunks.push(chunk);
        });
        response.on('end', () =>
          finish(readHealth(response.statusCode, Buffer.concat(chunks).toString('utf8')))
        );
        response.on('error', lost);
        response.on('close', lost);
      }
    );

    request.on('error', lost);
    request.end();
  });
}

export class ApayeeProvider extends LLMProvider {
  #endpoint;
  #origin;
  #token;
  #timeoutMs;
  #queueWaitMs;
  #expectedGatewayProvider;

  constructor(settings) {
    super({ name: 'Apayee', model: 'apayee-gateway' });

    const checked = validateApayeeSettings(settings);
    this.#endpoint = checked.endpoint;
    this.#origin = checked.origin;
    this.#token = checked.token;
    this.#timeoutMs = checked.timeoutMs;
    this.#queueWaitMs = checked.queueWaitMs;

    // Set only when a run chose a specific model behind the gateway. The gateway
    // names the provider that answered; a different one means it changed after
    // the availability check, and the reply is refused rather than accepted.
    this.#expectedGatewayProvider = settings.expectGatewayProvider ?? null;
  }

  async generateJson({ system, prompt, schema, signal }) {
    const requestId = `qatool-${randomUUID()}`;

    const body = Buffer.from(
      JSON.stringify({
        request_id: requestId,
        task: TASK,
        system,
        prompt,
        schema,
        // Apayee's execution budget. LLM_TIMEOUT_MS keeps meaning "how long the
        // model may take", as it does for Gemini; Apayee enforces it at its end.
        timeout_ms: this.#timeoutMs,
      })
    );

    // Covers waiting in Apayee's queue as well, which its own timeout does not.
    // When this fires the connection closes and Apayee cancels the request.
    const deadline = AbortSignal.timeout(this.#timeoutMs + this.#queueWaitMs);

    const reply = await this.#post(body, signal, deadline);
    return this.#accept(reply, requestId);
  }

  #post(body, caller, deadline) {
    const signal = caller ? AbortSignal.any([caller, deadline]) : deadline;

    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (settle, value) => {
        if (settled) return;
        settled = true;
        settle(value);
      };

      // One place decides why a call stopped, so a deadline that cuts the
      // response short is a timeout and not a lost connection.
      const fail = (cause) => {
        if (caller?.aborted) {
          return finish(reject, unreachable('The request to Apayee was cancelled.'));
        }
        if (deadline.aborted) {
          return finish(
            reject,
            timedOut(
              `Apayee did not respond within ${Math.round((this.#timeoutMs + this.#queueWaitMs) / 1000)} seconds.`
            )
          );
        }
        return finish(
          reject,
          unreachable(
            `Could not reach Apayee at ${this.#origin} (${cause?.code ?? 'connection error'}). Check that it is running and that APAYEE_BASE_URL is correct.`
          )
        );
      };

      const transport = this.#endpoint.protocol === 'https:' ? https : http;
      const request = transport.request(
        this.#endpoint,
        {
          method: 'POST',
          agent: false,
          signal,
          headers: {
            'content-type': 'application/json',
            'content-length': body.length,
            accept: 'application/json',
            ...(this.#token ? { authorization: `Bearer ${this.#token}` } : {}),
          },
        },
        (response) => {
          const chunks = [];
          let size = 0;

          response.on('data', (chunk) => {
            size += chunk.length;
            if (size > MAX_RESPONSE_BYTES) {
              finish(reject, malformed('sent a reply larger than QATOOL will read'));
              request.destroy();
              return;
            }
            chunks.push(chunk);
          });
          response.on('end', () =>
            finish(resolve, {
              status: response.statusCode,
              text: Buffer.concat(chunks).toString('utf8'),
            })
          );
          response.on('error', fail);
          // 'close' after 'end' is a no-op; without 'end' the reply was cut short.
          response.on('close', () => fail(null));
        }
      );

      request.on('error', fail);
      request.end(body);
    });
  }

  /** Turns Apayee's envelope into `{ data, usage }`, or the matching QATOOL error. */
  #accept({ status, text }, requestId) {
    let envelope = null;
    try {
      envelope = JSON.parse(text);
    } catch {
      // Handled below by status: a proxy's HTML error page is not Apayee's reply.
    }

    if (isRecord(envelope) && envelope.status === 'error' && isRecord(envelope.error)) {
      const known = FOR_APAYEE_CODE[envelope.error.code];
      if (known) throw known();
    }

    if (status === 401 || status === 403) throw authFailed();
    if (status < 200 || status >= 300) throw errorForStatus(status, 'Apayee');

    if (!isRecord(envelope) || status !== 200 || envelope.status !== 'success') {
      throw malformed('returned a reply that is not a generation result');
    }
    if (envelope.request_id !== requestId) {
      throw malformed('answered a different request than the one sent');
    }
    if (envelope.result === null || typeof envelope.result !== 'object') {
      throw malformed('returned a result that is not structured JSON');
    }
    if (
      this.#expectedGatewayProvider !== null &&
      envelope.provider !== this.#expectedGatewayProvider
    ) {
      throw new LlmError(
        LLM_ERRORS.UNAVAILABLE,
        'Apayee answered with a different provider than the one selected for this run, so the reply was not accepted. Nothing fell back to another provider.',
        503
      );
    }

    return { data: envelope.result, usage: usageFrom(envelope.metadata?.usage) };
  }
}
