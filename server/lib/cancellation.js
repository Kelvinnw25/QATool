import { AppError } from './errors.js';

/**
 * Turns "the client went away" into an AbortSignal for the LLM call.
 *
 * Fastify has a request.signal, and it must not be used for this. It follows
 * the Node request object's 'close' event, which fires once the request body
 * has been read - measured on Node 22.13 and 24 - so by the time a handler is
 * waiting on a model the signal is already aborted, for every client, whether
 * or not it is still connected. Used as is, it would cancel every generation.
 *
 * The response is what tells the two cases apart. A response emits 'close'
 * when the connection ends, and `writableFinished` says whether the reply had
 * been fully written first: finished means a normal ending, not finished means
 * the client left. release() runs before the handler returns, so the listener
 * is gone before Fastify writes a reply and a normal response cannot cancel.
 *
 * Scoped to one request. Nothing is shared between requests, so cancelling one
 * can never reach another.
 *
 * @param {import('fastify').FastifyRequest} request
 * @param {import('fastify').FastifyReply} reply
 * @returns {{signal: AbortSignal, release: () => void}}
 */
export function watchClientDisconnect(request, reply) {
  const controller = new AbortController();
  const response = reply.raw;

  const onClose = () => {
    if (!response.writableFinished) controller.abort();
  };
  response.once('close', onClose);

  // A client that left before this ran has already emitted its 'close'.
  if (response.destroyed || request.raw.socket?.destroyed) controller.abort();

  return {
    signal: controller.signal,
    release: () => response.off('close', onClose),
  };
}

/**
 * The error a cancelled request ends with.
 *
 * Nobody reads it - the client is gone - but the log does, and a cancellation
 * should read as one there rather than as a provider that was "unavailable".
 * 499 is the status nginx and Apayee use for a client that closed the request.
 */
export function requestCancelled() {
  return new AppError(
    'REQUEST_CANCELLED',
    'The client closed the request before it finished.',
    499
  );
}

/**
 * The error a request ends with when it ran past its deadline.
 *
 * The deadline exists so that the backend answers before a proxy in front of it
 * gives up (Cloudflare's read timeout), instead of carrying on with a paid model
 * call nobody is waiting for.
 */
export function requestDeadlineExceeded() {
  return new AppError(
    'REQUEST_DEADLINE_EXCEEDED',
    'The request took too long and was stopped. Nothing was kept on the server; retry.',
    504
  );
}

/**
 * Runs the work with a signal that aborts if the client disconnects, and, when
 * `deadlineMs` is given, once that much time has passed.
 *
 * Whatever the work throws once the signal has fired is reported as one
 * cancellation (or one deadline), however the stage underneath chose to describe
 * it: Gemini calls an aborted fetch "unavailable", Apayee calls it "cancelled".
 * The listener and the timer are removed on every path.
 *
 * @template T
 * @param {import('fastify').FastifyRequest} request
 * @param {import('fastify').FastifyReply} reply
 * @param {(signal: AbortSignal) => Promise<T>} work
 * @param {{ deadlineMs?: number }} [options]  0 or absent means no deadline
 * @returns {Promise<T>}
 */
export async function withClientCancellation(request, reply, work, { deadlineMs = 0 } = {}) {
  const { signal: clientSignal, release } = watchClientDisconnect(request, reply);

  const deadline = new AbortController();
  const timer = deadlineMs > 0 ? setTimeout(() => deadline.abort(), deadlineMs) : null;
  const signal = timer ? AbortSignal.any([clientSignal, deadline.signal]) : clientSignal;

  try {
    return await work(signal);
  } catch (error) {
    // A client that left outranks a deadline that fired at the same moment.
    if (clientSignal.aborted) throw requestCancelled();
    if (deadline.signal.aborted) throw requestDeadlineExceeded();
    throw error;
  } finally {
    clearTimeout(timer);
    release();
  }
}
