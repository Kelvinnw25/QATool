import { AppError } from '../lib/errors.js';
import { ProviderUnavailableError } from '../llm/catalog.js';
import { presentError } from '../security/public-errors.js';

/**
 * The errors of the job API, and how a pipeline failure is told to a visitor.
 *
 * A job fails far from the request that created it, so its error is turned into a
 * small public object when it happens and that object is all a visitor ever sees:
 *
 *   { code, message, retryable, phase, details? }
 *
 * The message is written for a person at a browser. It never carries what the
 * provider or the gateway said, an address, a path, a setting or an uploaded
 * filename (the same rules as every public error: security/public-errors.js), and
 * a provider outage is described by its effect, not its cause.
 */

export const jobNotFound = () => new AppError('JOB_NOT_FOUND', 'The job was not found.', 404);

export const shuttingDown = () =>
  Object.assign(
    new AppError('SERVICE_SHUTTING_DOWN', 'The service is restarting. Try again shortly.', 503),
    { retryAfterSeconds: 10 }
  );

export function queueFull(retryAfterSeconds) {
  return Object.assign(
    new AppError('QUEUE_FULL', 'The demo queue is full right now. Try again shortly.', 429),
    { retryAfterSeconds }
  );
}

export function uploadBusy(retryAfterSeconds = 2) {
  return Object.assign(
    new AppError('UPLOAD_BUSY', 'Other uploads are being processed. Try again in a moment.', 429),
    { retryAfterSeconds }
  );
}

export function alreadyActive(jobId) {
  return new AppError(
    'JOB_ALREADY_ACTIVE',
    'You already have a job in progress. Wait for it to finish or cancel it.',
    409,
    { job_id: jobId }
  );
}

export function servicePaused(retryAfterSeconds) {
  return Object.assign(
    new AppError(
      'SERVICE_PAUSED',
      'The AI service is paused for a short while. Try again shortly.',
      503
    ),
    { retryAfterSeconds }
  );
}

export const serviceUnavailable = () =>
  Object.assign(
    new AppError(
      'SERVICE_UNAVAILABLE',
      'The AI service is not available right now. Try again shortly.',
      503
    ),
    { retryAfterSeconds: 15 }
  );

export function rateLimited(retryAfterMs) {
  return Object.assign(
    new AppError('RATE_LIMITED', 'Too many requests. Wait a moment, then retry.', 429),
    { retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1000)) }
  );
}

export const deadlineExceeded = () =>
  new AppError(
    'JOB_DEADLINE_EXCEEDED',
    'The job took too long and was stopped. Nothing was kept on the server; retry.',
    504
  );

/** Statuses that mean "try again later" rather than "this input will never work". */
const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);

/**
 * @param {unknown} error  whatever the pipeline threw
 * @param {string | null} phase  the phase that was running
 * @returns {{ code: string, message: string, retryable: boolean, phase: string | null, details?: unknown }}
 */
export function toJobError(error, phase) {
  // Named before the general case: this error carries the provider's id, which a visitor
  // is not told.
  if (error instanceof ProviderUnavailableError) {
    return {
      code: 'SERVICE_UNAVAILABLE',
      message: 'The AI service is not available right now. Try again shortly.',
      retryable: true,
      phase,
    };
  }

  if (error instanceof AppError) {
    const { body } = presentError(error, { publicMode: true });
    return {
      code: body.code,
      message: body.message,
      retryable: RETRYABLE_STATUS.has(error.statusCode),
      phase,
      ...(body.details !== undefined ? { details: body.details } : {}),
    };
  }

  // Anything else is ours and might carry internals: the cause goes to the log (the
  // runner does that), the visitor gets a sentence.
  return {
    code: 'INTERNAL_ERROR',
    message: 'The job could not be completed. Try again.',
    retryable: false,
    phase,
  };
}
