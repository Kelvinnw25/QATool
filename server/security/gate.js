import { AppError } from '../lib/errors.js';
import { withClientCancellation } from '../lib/cancellation.js';
import { currentRun } from '../lib/trace.js';
import { SlidingWindowLimiter } from './limiter.js';

/**
 * What one owner may ask of the models, and how many asks at once (owner mode).
 *
 * Three limits, all off (0) in local mode and on in owner public mode:
 *
 *  - a per-identity request rate for the whole API,
 *  - a ceiling on model calls running at once, with a short bounded queue,
 *  - a deadline for the whole request, shorter than the proxy's own timeout.
 *
 * There is NO request budget (no hourly or daily count of model calls). The only
 * quota on a model is the provider's own; this gate is a brake on bursts.
 *
 * Everything lives in this process's memory, and that is a stated limit, not an
 * oversight: counters reset when the backend restarts and are not shared between
 * processes. They stop a runaway page or a leaked session from hammering the model
 * in minutes. They are NOT a durable spending control; the model providers' own
 * limits and the owner's account settings are.
 *
 * Nothing is retried here or anywhere downstream. A refusal is an answer.
 *
 * The state belongs to one gate, and a gate belongs to one app instance, so tests
 * and restarts start clean. The public demo does not use this gate: its concurrency
 * control is the job manager (server/jobs/manager.js).
 */

const MINUTE = 60_000;

/** setTimeout fires at once for anything above this. */
const MAX_TIMER_MS = 2_147_483_647;

const tooMany = (code, message, retryAfterMs) =>
  Object.assign(new AppError(code, message, 429), {
    retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1000)),
  });

/** At most `max` holders at once; a bounded, abortable queue behind them. */
class Semaphore {
  #max;
  #queueMax;
  #waitMs;
  #active = 0;
  #queue = [];

  constructor({ max, queueMax, waitMs }) {
    this.#max = max;
    this.#queueMax = queueMax;
    this.#waitMs = waitMs;
  }

  /** @returns {Promise<() => void>} a release function; call it exactly once (extra calls are ignored) */
  acquire(signal) {
    if (this.#max <= 0) return Promise.resolve(() => {});
    if (signal?.aborted) return Promise.reject(signal.reason ?? new Error('aborted'));

    if (this.#active < this.#max) {
      this.#active += 1;
      return Promise.resolve(this.#releaser());
    }

    if (this.#queue.length >= this.#queueMax) {
      return Promise.reject(this.#busy());
    }

    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, timer: null, onAbort: null };

      const leave = () => {
        clearTimeout(waiter.timer);
        signal?.removeEventListener('abort', waiter.onAbort);
        const index = this.#queue.indexOf(waiter);
        if (index !== -1) this.#queue.splice(index, 1);
      };

      waiter.timer = setTimeout(() => {
        leave();
        reject(this.#busy());
      }, this.#waitMs);

      // A client that disconnects while queued must not keep its place.
      waiter.onAbort = () => {
        leave();
        reject(signal.reason ?? new Error('aborted'));
      };
      signal?.addEventListener('abort', waiter.onAbort, { once: true });

      waiter.grant = () => {
        leave();
        this.#active += 1;
        resolve(this.#releaser());
      };
      this.#queue.push(waiter);
    });
  }

  #releaser() {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#active -= 1;
      this.#queue.shift()?.grant();
    };
  }

  #busy() {
    return tooMany(
      'SERVER_BUSY',
      'Another model request is already running. Wait for it to finish, then retry.',
      this.#waitMs
    );
  }

  /** For tests and diagnostics. */
  get state() {
    return { active: this.#active, queued: this.#queue.length };
  }
}

/**
 * @param {object} settings  the `gate` block of the security settings
 * @param {{ now?: () => number }} [options]  a clock, for tests
 */
export function createModelGate(settings, { now = Date.now } = {}) {
  const requests = new SlidingWindowLimiter({
    limit: settings.perMinute,
    windowMs: MINUTE,
    now,
  });
  const semaphore = new Semaphore({
    max: settings.llmMaxConcurrent,
    queueMax: settings.llmQueueMax,
    waitMs: settings.llmQueueWaitMs,
  });

  const keyOf = (request) => request.identity?.id ?? 'local';

  // Refusals carry `retryAfterSeconds`; the app's error handler turns it into the
  // Retry-After header, so every 429 gets one whichever limit produced it.
  return {
    /** onRequest, after authentication: the whole-API rate. */
    async rateHook(request) {
      if (request.method === 'OPTIONS' || request.routeOptions?.config?.public === true) return;

      const result = requests.hit(keyOf(request));
      if (!result.ok) {
        throw tooMany(
          'RATE_LIMITED',
          'Too many requests. Wait a moment, then retry.',
          result.retryAfterMs
        );
      }
    },

    /**
     * Runs a model call under the gate: the client-disconnect signal, the request
     * deadline (counted from the start of the request, so uploads and queueing
     * use it up), and the concurrency ceiling.
     *
     * @template T
     * @param {boolean} [usesModel] false for work that never reaches a model
     */
    run(request, reply, work, { usesModel = true } = {}) {
      // The run records its start with Date.now(), so elapsed time is measured with
      // it too; the injected clock is only for the sliding windows above.
      const elapsed = Date.now() - (currentRun()?.startedAt ?? Date.now());
      const deadlineMs =
        settings.requestDeadlineMs > 0
          ? Math.min(MAX_TIMER_MS, Math.max(1, settings.requestDeadlineMs - elapsed))
          : 0;

      return withClientCancellation(
        request,
        reply,
        async (signal) => {
          if (!usesModel) return work(signal);

          const release = await semaphore.acquire(signal);
          try {
            return await work(signal);
          } finally {
            release();
          }
        },
        { deadlineMs }
      );
    },

    semaphore,
  };
}
