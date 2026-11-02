import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';

import { redactSecrets } from '../config.js';
import { LLM_ERRORS } from '../llm/provider.js';

/**
 * Run tracing: one id per pipeline request, and a structured line per boundary.
 *
 * This exists because of a specific diagnostic failure. An intermittent browser
 * 500 could not be attributed - the extraction path, the three Gemini calls,
 * the proxy and a dev-server restart all present identically to the user as
 * "Request failed with status 500", and the answer turned out to be none of the
 * pipeline at all. Distinguishing those needs a name for the run and an honest
 * record of which boundary it reached.
 *
 * Observability only. Nothing here changes behaviour, error semantics or
 * control flow: every call is a side effect on a log, and `trace()` outside a
 * run is a no-op rather than an error, so a module that emits events works
 * unchanged when called from a test or a script.
 *
 * The run context travels through AsyncLocalStorage rather than a parameter.
 * That is deliberate: threading a tracer through extractDocuments ->
 * structureRequirements -> the provider would change signatures across the
 * pipeline for a logging concern, and a signature is a contract.
 *
 * WHAT IS NEVER LOGGED, enforced in safeFields() rather than by convention:
 * api keys, prompts, model replies, document text, requirement bodies, quotes.
 * Counts, sizes, durations, ids and classifications - everything needed to say
 * where a run stopped - are not content, and they are all this emits.
 */

const storage = new AsyncLocalStorage();

/** Keys that could carry document content or secrets, dropped whatever the value. */
const FORBIDDEN_KEYS =
  /^(prompt|system|text|content|body|quote|description|statement|response|reply|data|document|documents|requirement|requirements|test_case|expected_result|api_?key|key|token|authorization|secret|password)$/i;

/** A field is a label, not a payload. Anything longer is truncated rather than dropped. */
const MAX_FIELD_LENGTH = 200;

/**
 * The error categories the investigation asked to tell apart.
 *
 * Deliberately coarse: the question a category answers is "whose fault, and
 * does waiting help", not "what exactly happened" - the message carries that.
 */
export const LLM_ERROR_CATEGORIES = {
  RATE_LIMITED: '429',
  UNAVAILABLE: '503',
  TIMEOUT: 'timeout',
  PARSE_ERROR: 'parse_error',
  NETWORK_ERROR: 'network_error',
  UNKNOWN: 'unknown',
};

/**
 * Classifies a provider failure without inspecting its message.
 *
 * Driven by the error code the provider already assigns, so the taxonomy has
 * one source. A 503 is reported as '503' rather than folded into 'unknown'
 * because it is the one that looks like a bug and is not: it is refused
 * capacity, it still costs a request, and the only correct response is to wait.
 */
export function classifyLlmError(error) {
  switch (error?.code) {
    case LLM_ERRORS.RATE_LIMITED:
      return LLM_ERROR_CATEGORIES.RATE_LIMITED;
    case LLM_ERRORS.TIMEOUT:
      return LLM_ERROR_CATEGORIES.TIMEOUT;
    case LLM_ERRORS.UNAVAILABLE:
      // Transport failure and provider overload arrive as the same code; the
      // status distinguishes them, 502 being ours for "could not reach".
      return error.statusCode === 502
        ? LLM_ERROR_CATEGORIES.NETWORK_ERROR
        : LLM_ERROR_CATEGORIES.UNAVAILABLE;
    case LLM_ERRORS.MALFORMED_OUTPUT:
    case LLM_ERRORS.TRUNCATED:
      return LLM_ERROR_CATEGORIES.PARSE_ERROR;
    case LLM_ERRORS.AUTH_FAILED:
    case LLM_ERRORS.NOT_CONFIGURED:
    case LLM_ERRORS.REFUSED:
      return LLM_ERROR_CATEGORIES.UNKNOWN;
    default:
      return LLM_ERROR_CATEGORIES.UNKNOWN;
  }
}

/** QATOOL-20260924-4F2A9C: the date to find the log, the suffix to find the run. */
export function newRunId(now = new Date()) {
  const date =
    `${now.getFullYear()}` +
    `${String(now.getMonth() + 1).padStart(2, '0')}` +
    `${String(now.getDate()).padStart(2, '0')}`;

  return `QATOOL-${date}-${randomBytes(3).toString('hex').toUpperCase()}`;
}

/**
 * Strips anything that could carry content or a secret.
 *
 * A denylist of keys plus a length cap plus redaction, in that order, because
 * each catches what the others miss: the key check stops a whole field, the cap
 * stops a long value arriving under an innocent name, and redaction stops a key
 * that reached a message some other way.
 */
function safeFields(fields) {
  const safe = {};

  for (const [key, value] of Object.entries(fields ?? {})) {
    if (FORBIDDEN_KEYS.test(key)) continue;
    if (value === undefined) continue;

    if (typeof value === 'string') {
      const redacted = redactSecrets(value);
      safe[key] =
        redacted.length > MAX_FIELD_LENGTH
          ? `${redacted.slice(0, MAX_FIELD_LENGTH)}...[truncated]`
          : redacted;
      continue;
    }

    if (value === null || typeof value === 'number' || typeof value === 'boolean') {
      safe[key] = value;
      continue;
    }

    if (Array.isArray(value)) {
      // Arrays of labels - file types, warning codes - are useful. Arrays of
      // objects are content until proven otherwise, so only the count survives.
      safe[key] = value.every((entry) => typeof entry === 'string' || typeof entry === 'number')
        ? value.slice(0, 20).map((entry) => redactSecrets(String(entry)).slice(0, 60))
        : value.length;
      continue;
    }

    // Objects are not logged. A nested object is where document content hides.
    safe[key] = '[object]';
  }

  return safe;
}

/** The active run, or null when nothing started one. */
export function currentRun() {
  return storage.getStore() ?? null;
}

/**
 * Emits one structured line, or does nothing when no run is active.
 *
 * Silence outside a run is the point: the same modules are called by tests,
 * scripts and the evaluation harness, and none of those should have to set up
 * a tracer to avoid a crash.
 */
export function trace(event, fields = {}) {
  const run = currentRun();
  if (!run) return;

  run.events.push({ event, ...safeFields(fields) });

  run.logger?.info?.({
    run_id: run.id,
    stage: run.stage,
    event,
    elapsed_ms: Date.now() - run.startedAt,
    ...safeFields(fields),
  });
}

/**
 * Marks which phase later events belong to, so a failure has a stage name.
 *
 * Stages are coarse on purpose - REQUEST, EXTRACT, GENERATE, REVIEW, EXPORT -
 * because the summary line has to answer "where did it stop" in one word.
 */
export function setStage(stage) {
  const run = currentRun();
  if (run) run.stage = stage;
}

/** Records a stage duration for the summary without emitting a line of its own. */
export function recordTiming(name, durationMs) {
  const run = currentRun();
  if (run && Number.isFinite(durationMs)) run.timings[name] = durationMs;
}

/** Accumulates the counts the summary reports. */
export function recordFacts(facts) {
  const run = currentRun();
  if (!run) return;
  Object.assign(run.facts, safeFields(facts));
}

/**
 * Starts a run and executes `fn` inside it.
 *
 * @param {object} options
 * @param {object} [options.logger]  a pino-style logger; omitted in tests
 * @param {string} [options.route]
 * @param {Function} fn
 */
export function withRun({ logger = null, route = null, id = newRunId() }, fn) {
  const run = newRun({ logger, route, id });
  return storage.run(run, () => fn(run));
}

/** The run object every entry point shares. */
function newRun({ logger, route, id }) {
  return {
    id,
    route,
    logger,
    stage: 'REQUEST',
    startedAt: Date.now(),
    timings: {},
    facts: {},
    events: [],
    /** Set by the error handler, read by the summary. */
    failure: null,
    /** Guards the one-summary-per-run rule. */
    summarised: false,
  };
}

/**
 * Starts a run for the current async context and returns it.
 *
 * The counterpart to withRun, and the reason both exist: withRun wraps a
 * function, which suits a test or a script, but a Fastify hook cannot wrap the
 * handler that runs after it. enterWith attaches the store to the context the
 * hook is already in, so the handler and everything it awaits inherit the run
 * without the route having to pass anything down.
 */
export function beginRun({ logger = null, route = null, id = newRunId() } = {}) {
  const run = newRun({ logger, route, id });
  storage.enterWith(run);
  return run;
}

/**
 * The end-of-run line: one line, whatever happened.
 *
 * Written as text rather than JSON because its only reader is a person looking
 * at a terminal trying to find where a run stopped, and a 12-key object is
 * worse at that than a sentence.
 */
export function summarise(run, { status, reason = null, failSoft = null, stage = null }) {
  const parts = [
    `RUN ${run.id}`,
    `status=${status}`,
    `total=${((Date.now() - run.startedAt) / 1000).toFixed(1)}s`,
  ];

  for (const [name, duration] of Object.entries(run.timings)) {
    parts.push(`${name}=${(duration / 1000).toFixed(1)}s`);
  }

  if (status === 'SUCCESS') {
    for (const [name, value] of Object.entries(run.facts)) parts.push(`${name}=${value}`);
  } else {
    // An explicit stage beats the current one. A degraded run carries on to the
    // end, so run.stage would name where it finished rather than where it
    // degraded - "stage=EXPORT | reason=503" reads as an export failure caused
    // by a rate limit, which is not what happened.
    parts.push(`stage=${stage ?? run.stage}`);
    if (reason) parts.push(`reason=${reason}`);
    if (failSoft !== null) parts.push(`fail_soft=${failSoft}`);
  }

  return parts.join(' | ');
}
