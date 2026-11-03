import { randomBytes, timingSafeEqual } from 'node:crypto';

import {
  alreadyActive,
  deadlineExceeded,
  jobNotFound,
  queueFull,
  serviceUnavailable,
  servicePaused,
  shuttingDown,
  toJobError,
  uploadBusy,
} from './errors.js';
import { isProviderOutage } from './breaker.js';
import { AsyncSemaphore } from './semaphore.js';

/**
 * The bounded, in-memory job system.
 *
 * One job is one workflow segment: a visitor's `from` phase and every phase after it.
 * Jobs are admitted, queued first-in first-out, and run by a small pool of workers.
 * Nothing is written anywhere: the whole table is this object, it is bounded in every
 * direction, and a restart loses all of it (clients are told, by `boot_id`).
 *
 *   reserve() -> commit() -> queued -> processing -> completed | failed | cancelled
 *
 * Bounds
 *   live jobs (queued + processing) + reservations <= workers + maxPending
 *   reservations <= uploadInflightMax    (uploads being read or parsed, all visitors)
 *   one live job or reservation per visitor `sid`
 *   at most maxTerminal finished jobs kept, each for a short time
 *
 * Workers
 *   The configured count is a ceiling. The gateway also says how many calls it runs at
 *   once (`max_active`), and QATOOL never starts more jobs than that, because the extra
 *   calls would only wait in the gateway's queue, past the point where a call gives up,
 *   and a call that gives up is not retried. Until the gateway has been asked, one.
 *
 * Time
 *   Queue wait and execution are tracked apart. The overall job deadline starts when a
 *   worker picks the job up, so waiting never spends it. A status poll renews a lease;
 *   a job nobody polls is abandoned: removed if still queued, cancelled if running, so
 *   a closed tab stops costing model calls.
 *
 * Isolation
 *   Every read goes through #own(sid, id): unknown, expired and someone else's job all
 *   look the same. The job id is a name, never a credential.
 *
 * The manager knows nothing about HTTP, documents or models. The work is `run`, handed
 * in by the caller (jobs/runner.js), which also makes the manager testable in isolation.
 */

const JOB_ID = /^j_[A-Za-z0-9_-]{22}$/;

export const PHASES = Object.freeze(['extract', 'generate', 'validate']);
export const STATES = Object.freeze(['queued', 'processing', 'completed', 'failed', 'cancelled']);
const TERMINAL = new Set(['completed', 'failed', 'cancelled']);

/** A reservation that never commits (a connection that died mid-upload) is dropped after this. */
const DEFAULT_RESERVATION_TTL_MS = 2 * 60_000;

/** The sweeper's tick. Lease and retention are measured in seconds, so a second is fine. */
const SWEEP_INTERVAL_MS = 1000;

/** How long shutdown waits for aborted work to wind down. */
const SHUTDOWN_GRACE_MS = 5000;

const iso = (ms) => (ms === null ? null : new Date(ms).toISOString());

function sameSid(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * @typedef {object} RunContext
 * @property {string} id
 * @property {'extract' | 'generate' | 'validate'} from
 * @property {any} input                what was committed with the job
 * @property {AbortSignal} signal
 * @property {(phase: string) => void} beginPhase
 * @property {(phase: string, result: object) => void} endPhase
 */

export class JobManager {
  #settings;
  #run;
  #breaker;
  #metrics;
  #now;
  #logger;
  #newId;
  #bootId;

  #jobs = new Map();
  /** queued jobs, oldest first */
  #queue = [];
  #liveBySid = new Map();
  #reservations = new Map();
  /** processing jobs, plus cancelled ones whose work has not yet wound down */
  #running = new Map();
  #settled = new Set();

  #providerMaxActive = null;
  #providerCompatible = true;
  #providerObservation = null;
  #clampLogged = false;

  #closed = false;
  #sweeper = null;
  #recentProcessing = [];
  #parsing = new AsyncSemaphore(1);
  #parsingNow = 0;

  /**
   * @param {object} options
   * @param {object} options.settings
   * @param {number} options.settings.workers
   * @param {number} options.settings.maxPending
   * @param {number} options.settings.leaseMs
   * @param {number} options.settings.deadlineMs           overall, from the moment a worker starts
   * @param {number} options.settings.retainCompletedMs
   * @param {number} options.settings.retainFailedMs
   * @param {number} options.settings.maxTerminal
   * @param {number} options.settings.uploadInflightMax
   * @param {number} options.settings.parseConcurrency
   * @param {number} options.settings.pollIntervalMs
   * @param {number} [options.settings.reservationTtlMs]
   * @param {(context: RunContext) => Promise<void>} options.run
   * @param {ReturnType<import('./breaker.js').createProviderBreaker>} options.breaker
   * @param {ReturnType<import('./metrics.js').createJobMetrics>} options.metrics
   * @param {() => number} [options.now]
   * @param {{ info?: Function, warn?: Function }} [options.logger]
   * @param {() => string} [options.newId]
   */
  constructor({ settings, run, breaker, metrics, now = Date.now, logger, newId }) {
    this.#settings = { reservationTtlMs: DEFAULT_RESERVATION_TTL_MS, ...settings };
    this.#run = run;
    this.#breaker = breaker;
    this.#metrics = metrics;
    this.#now = now;
    this.#logger = logger;
    this.#newId = newId ?? (() => `j_${randomBytes(16).toString('base64url')}`);
    this.#bootId = `b_${randomBytes(9).toString('base64url')}`;
    this.#parsing = new AsyncSemaphore(settings.parseConcurrency ?? 1);

    metrics.registerSource('jobs', () => this.#counts());
    metrics.registerSource('workers', () => ({
      configured: this.#settings.workers,
      effective: this.effectiveWorkers,
      busy: this.#running.size,
    }));
    metrics.registerSource('active_starts', () =>
      [...this.#running.values()].map((job) => job.startedAt)
    );
    metrics.registerSource('uploads', () => ({
      inflight: this.#reservations.size,
      inflight_max: this.#settings.uploadInflightMax,
      parsing: this.#parsingNow,
      waiting_to_parse: this.#parsing.state.waiting,
    }));
    metrics.registerSource('apayee', () => this.#providerObservation);
  }

  /** Identifies this process. A client that sees it change knows every job was lost. */
  get bootId() {
    return this.#bootId;
  }

  get settings() {
    return this.#settings;
  }

  get closed() {
    return this.#closed;
  }

  /** Whether the provider breaker is open: admission and new starts are paused. */
  get breakerOpen() {
    return this.#breaker.open;
  }

  /**
   * How many jobs may run at once right now: the configured count, held to what the
   * gateway reports it can run. Zero when the gateway's answer is not one to rely on.
   */
  get effectiveWorkers() {
    if (!this.#providerCompatible) return 0;
    return Math.min(this.#settings.workers, this.#providerMaxActive ?? 1);
  }

  /** Starts the cleanup timer. Unref'd: it never keeps the process alive. */
  start() {
    if (this.#sweeper) return;
    this.#metrics.startRuntimeSampling();
    this.#sweeper = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
    this.#sweeper.unref();
  }

  // --- the gateway's capacity ------------------------------------------------------------

  /**
   * Takes in what the gateway reported (llm/apayee.js readQueue). Called with every
   * health answer that admission or a job start gets, so the worker ceiling follows the
   * gateway rather than a number configured once.
   *
   * @param {{ maxActive: number, compatible: boolean, reported: boolean, active: number | null,
   *   pending: number | null, capacity: number | null } | null} capacity  null: no answer
   */
  observeCapacity(capacity) {
    if (!capacity) return;

    this.#providerCompatible = capacity.compatible !== false;
    this.#providerMaxActive = capacity.maxActive;
    this.#providerObservation = {
      active: capacity.active,
      max_active: capacity.maxActive,
      pending: capacity.pending,
      capacity: capacity.capacity,
      reported: capacity.reported,
      compatible: this.#providerCompatible,
      observed_at: iso(this.#now()),
    };

    if (capacity.maxActive < this.#settings.workers && !this.#clampLogged) {
      this.#clampLogged = true;
      this.#logger?.warn?.(
        {
          event: 'workers_clamped',
          configured: this.#settings.workers,
          max_active: capacity.maxActive,
        },
        'The gateway runs fewer calls at once than JOB_WORKERS; fewer workers will run.'
      );
    }
    this.#pump();
  }

  // --- admission --------------------------------------------------------------------------

  /**
   * The gate every submission passes before a byte of its body is read.
   *
   * @param {string} sid
   * @returns {{ commit: (spec: { from: string, input: any }) => object, release: () => void }}
   * @throws {AppError} 503 shutting down / paused / unavailable, 409 already active,
   *   429 upload busy / queue full
   */
  reserve(sid) {
    this.#expireReservations();

    if (this.#closed) throw shuttingDown();

    if (this.#breaker.open) {
      this.#metrics.inc('rejected_paused');
      throw servicePaused(Math.max(1, Math.ceil(this.#breaker.retryAfterMs() / 1000)));
    }
    if (!this.#providerCompatible) {
      this.#metrics.inc('rejected_unavailable');
      throw serviceUnavailable();
    }

    const live = this.#liveBySid.get(sid);
    if (live) {
      this.#metrics.inc('rejected_already_active');
      throw alreadyActive(live.id);
    }
    if ([...this.#reservations.values()].some((entry) => sameSid(entry.sid, sid))) {
      this.#metrics.inc('rejected_already_active');
      throw alreadyActive(null);
    }

    if (this.#reservations.size >= this.#settings.uploadInflightMax) {
      this.#metrics.inc('rejected_upload_busy');
      throw uploadBusy();
    }

    const capacity = Math.max(1, this.effectiveWorkers) + this.#settings.maxPending;
    if (this.#liveCount() + this.#reservations.size >= capacity) {
      this.#metrics.inc('rejected_queue_full');
      throw queueFull(this.#estimateRetryAfter());
    }

    const reservation = {
      id: this.#newId(),
      sid,
      expiresAt: this.#now() + this.#settings.reservationTtlMs,
      done: false,
      commit: (spec) => this.#commit(reservation, spec),
      release: () => this.#release(reservation),
    };
    this.#reservations.set(reservation.id, reservation);
    return reservation;
  }

  #release(reservation) {
    if (reservation.done) return;
    reservation.done = true;
    this.#reservations.delete(reservation.id);
  }

  #commit(reservation, { from, input }) {
    // First: a reservation that shutdown released is still, to its caller, a request that
    // arrived while the service was stopping, and that is a 503 to retry, not a bug.
    if (this.#closed) {
      this.#release(reservation);
      throw shuttingDown();
    }
    if (reservation.done) throw new Error('This reservation has already been used or released.');
    const start = PHASES.indexOf(from);
    if (start === -1) throw new Error(`Unknown phase: ${from}`);

    this.#release(reservation);

    const now = this.#now();
    const job = {
      id: this.#newId(),
      sid: reservation.sid,
      from,
      state: 'queued',
      phase: null,
      phases: Object.fromEntries(
        PHASES.map((phase, index) => [phase, index < start ? 'skipped' : 'pending'])
      ),
      createdAt: now,
      startedAt: null,
      updatedAt: now,
      completedAt: null,
      leaseUntil: now + this.#settings.leaseMs,
      controller: null,
      abortReason: null,
      cancelReason: null,
      deadlineTimer: null,
      input,
      results: {},
      error: null,
    };

    this.#jobs.set(job.id, job);
    this.#liveBySid.set(job.sid, job);
    this.#queue.push(job);
    this.#metrics.inc('jobs_submitted');
    this.#pump();
    return this.#view(job);
  }

  #liveCount() {
    return this.#queue.length + this.#running.size;
  }

  /**
   * A guess at when a slot frees up, for Retry-After: a slot opens when a running job ends,
   * so about one average run divided by the workers sharing the load.
   */
  #estimateRetryAfter() {
    const samples = this.#recentProcessing;
    const average =
      samples.length > 0 ? samples.reduce((a, b) => a + b, 0) / samples.length : 60_000;
    const workers = Math.max(1, this.effectiveWorkers);
    return Math.min(600, Math.max(5, Math.ceil(average / workers / 1000)));
  }

  #expireReservations() {
    const now = this.#now();
    for (const reservation of [...this.#reservations.values()]) {
      if (reservation.expiresAt <= now) this.#release(reservation);
    }
  }

  // --- parsing ---------------------------------------------------------------------------

  /**
   * Runs the parse of an upload under the parse limit. Parsing is CPU on the one thread
   * that answers every request, so at most `parseConcurrency` run at once and the rest
   * wait in turn (their number is bounded by the uploads-in-flight cap).
   *
   * @template T
   * @param {() => Promise<T> | T} work
   * @returns {Promise<T>}
   */
  async runParse(work) {
    const release = await this.#parsing.acquire();
    this.#parsingNow += 1;
    try {
      return await work();
    } finally {
      this.#parsingNow -= 1;
      release();
    }
  }

  // --- scheduling ------------------------------------------------------------------------

  #pump() {
    while (
      !this.#closed &&
      !this.#breaker.open &&
      this.#queue.length > 0 &&
      this.#running.size < this.effectiveWorkers
    ) {
      this.#start(this.#queue.shift());
    }
  }

  #start(job) {
    const now = this.#now();
    job.state = 'processing';
    job.startedAt = now;
    job.updatedAt = now;
    job.controller = new AbortController();
    this.#running.set(job.id, job);

    this.#metrics.observe('queue_wait_ms', now - job.createdAt);

    // Real time, not the injected clock: this is a timer, and it is cleared on every path.
    job.deadlineTimer = setTimeout(() => {
      if (TERMINAL.has(job.state)) return;
      job.abortReason = 'deadline';
      job.controller.abort(new Error('job deadline'));
    }, this.#settings.deadlineMs);

    /** @type {RunContext} */
    const context = {
      id: job.id,
      from: job.from,
      input: job.input,
      signal: job.controller.signal,
      beginPhase: (phase) => {
        job.phase = phase;
        job.phases[phase] = 'running';
        job.updatedAt = this.#now();
      },
      endPhase: (phase, result) => {
        job.phases[phase] = 'done';
        job.results[phase] = result;
        job.updatedAt = this.#now();
      },
    };

    let work;
    try {
      work = Promise.resolve(this.#run(context));
    } catch (error) {
      work = Promise.reject(error);
    }

    const finished = work
      .then(
        () => this.#settle(job, { ok: true }),
        (error) => this.#settle(job, { ok: false, error })
      )
      .catch((error) => {
        // A bug in the bookkeeping must not become an unhandled rejection.
        this.#logger?.warn?.(
          { event: 'job_bookkeeping_failed', error_class: error?.constructor?.name ?? 'Error' },
          'A job could not be recorded.'
        );
      })
      .finally(() => {
        clearTimeout(job.deadlineTimer);
        this.#metrics.recordBusy(job.startedAt, this.#now());
        this.#running.delete(job.id);
        this.#settled.delete(finished);
        job.input = null;
        this.#pump();
      });
    this.#settled.add(finished);
  }

  #settle(job, outcome) {
    // Cancelled while it ran: the state was set then, and the work has now stopped.
    if (TERMINAL.has(job.state)) return;

    const now = this.#now();
    job.completedAt = now;
    job.updatedAt = now;

    if (outcome.ok) {
      job.state = 'completed';
      job.phase = null;
      this.#metrics.inc('jobs_completed');
    } else {
      const error = job.abortReason === 'deadline' ? deadlineExceeded() : outcome.error;
      const phase = job.phase;

      if (phase) job.phases[phase] = 'failed';
      this.#closeOpenPhases(job);
      job.state = 'failed';
      job.error = toJobError(error, phase);
      job.phase = null;

      if (isProviderOutage(outcome.error)) {
        this.#breaker.trip();
        this.#metrics.inc('breaker_trips');
      }
      this.#metrics.inc('jobs_failed');
      this.#metrics.inc(`job_error_${job.error.code}`);
      // The cause stays on the server. A message can quote a document, so the log gets the
      // class and code, which is what an operator needs to find the failure.
      this.#logger?.warn?.(
        {
          event: 'job_failed',
          error_class: outcome.error?.constructor?.name ?? 'Error',
          error_code: outcome.error?.code ?? null,
          phase,
        },
        'A job failed.'
      );
    }

    this.#finish(job);
  }

  /** Bookkeeping shared by every way a job ends. */
  #finish(job) {
    this.#liveBySid.delete(job.sid);
    if (job.startedAt !== null) {
      const duration = (job.completedAt ?? this.#now()) - job.startedAt;
      this.#metrics.observe('processing_ms', duration);
      this.#recentProcessing.push(duration);
      if (this.#recentProcessing.length > 20) this.#recentProcessing.shift();
    }
    this.#evict();
  }

  #closeOpenPhases(job) {
    for (const phase of PHASES) {
      if (job.phases[phase] === 'pending') job.phases[phase] = 'not_run';
      else if (job.phases[phase] === 'running') job.phases[phase] = 'cancelled';
    }
  }

  // --- reads and cancellation --------------------------------------------------------------

  #own(sid, id) {
    const job = typeof id === 'string' && JOB_ID.test(id) ? this.#jobs.get(id) : undefined;
    if (!job || !sameSid(job.sid, sid)) throw jobNotFound();
    return job;
  }

  /** Status of the visitor's own job. Renews the lease of a job that is still live. */
  status(sid, id) {
    const job = this.#own(sid, id);
    if (!TERMINAL.has(job.state)) job.leaseUntil = this.#now() + this.#settings.leaseMs;
    return this.#view(job);
  }

  /** Whatever phases have finished, for the visitor's own job. */
  result(sid, id) {
    const job = this.#own(sid, id);
    return { job: this.#view(job), phases: { ...job.results } };
  }

  /** Idempotent. A finished job is reported as it is. */
  cancel(sid, id) {
    const job = this.#own(sid, id);
    this.#cancelJob(job, 'user');
    return this.#view(job);
  }

  #cancelJob(job, reason) {
    if (TERMINAL.has(job.state)) return;

    const wasQueued = job.state === 'queued';
    if (wasQueued) {
      this.#queue.splice(this.#queue.indexOf(job), 1);
      job.input = null;
    } else {
      // The worker keeps its slot until the work has actually stopped.
      job.abortReason = reason;
      job.controller.abort(new Error(`job ${reason}`));
    }

    const now = this.#now();
    job.state = 'cancelled';
    job.cancelReason = reason;
    job.completedAt = now;
    job.updatedAt = now;
    job.phase = null;
    this.#closeOpenPhases(job);

    this.#metrics.inc('jobs_cancelled');
    this.#metrics.inc(`jobs_cancelled_${reason}`);
    this.#finish(job);
  }

  // --- the public view ---------------------------------------------------------------------

  #view(job) {
    const now = this.#now();
    const queued = job.state === 'queued';

    return {
      id: job.id,
      state: job.state,
      from: job.from,
      phase: job.phase,
      phases: { ...job.phases },
      position: queued ? this.#queue.indexOf(job) + 1 : null,
      queue: { capacity: this.#settings.maxPending },
      paused: queued && this.#breaker.open,
      created_at: iso(job.createdAt),
      started_at: iso(job.startedAt),
      updated_at: iso(job.updatedAt),
      completed_at: iso(job.completedAt),
      elapsed_ms: (job.completedAt ?? now) - job.createdAt,
      queue_wait_ms: (job.startedAt ?? job.completedAt ?? now) - job.createdAt,
      processing_ms: job.startedAt === null ? 0 : (job.completedAt ?? now) - job.startedAt,
      poll_after_ms: this.#settings.pollIntervalMs,
      result_available: Object.keys(job.results).length > 0,
      cancel_reason: job.cancelReason,
      error: job.error,
      boot_id: this.#bootId,
    };
  }

  #counts() {
    const counts = { queued: 0, processing: 0, completed: 0, failed: 0, cancelled: 0 };
    for (const job of this.#jobs.values()) counts[job.state] += 1;
    // A cancelled job whose work is still winding down still holds a worker.
    return { ...counts, workers_busy: this.#running.size, retained: this.#jobs.size };
  }

  // --- housekeeping ------------------------------------------------------------------------

  /** Lease, retention and reservation expiry. Run by the timer; callable by tests. */
  sweep() {
    const now = this.#now();

    this.#expireReservations();

    for (const job of [...this.#jobs.values()]) {
      if (TERMINAL.has(job.state) || job.leaseUntil > now) continue;

      if (job.state === 'queued') {
        // Removed outright: nobody is waiting for it, and there is nothing to show.
        this.#queue.splice(this.#queue.indexOf(job), 1);
        this.#jobs.delete(job.id);
        this.#liveBySid.delete(job.sid);
        job.input = null;
        this.#metrics.inc('jobs_cancelled');
        this.#metrics.inc('jobs_cancelled_abandoned');
      } else {
        this.#cancelJob(job, 'abandoned');
      }
    }

    this.#evict();
    this.#pump();
  }

  /** Drops finished jobs past their retention, then the oldest beyond the cap. */
  #evict() {
    const now = this.#now();
    const finished = [];

    for (const job of this.#jobs.values()) {
      if (!TERMINAL.has(job.state)) continue;
      const keep =
        job.state === 'completed'
          ? this.#settings.retainCompletedMs
          : this.#settings.retainFailedMs;
      if (job.completedAt + keep <= now) this.#jobs.delete(job.id);
      else finished.push(job);
    }

    finished.sort((a, b) => a.completedAt - b.completedAt);
    while (finished.length > this.#settings.maxTerminal) this.#jobs.delete(finished.shift().id);
  }

  /**
   * Stops admission, cancels what is queued, aborts what is running and waits (briefly)
   * for the aborted work to stop. Idempotent.
   */
  async shutdown({ graceMs = SHUTDOWN_GRACE_MS } = {}) {
    if (this.#closed) return;
    this.#closed = true;

    for (const reservation of [...this.#reservations.values()]) this.#release(reservation);
    for (const job of [...this.#jobs.values()]) this.#cancelJob(job, 'shutdown');

    clearInterval(this.#sweeper);
    this.#sweeper = null;

    if (this.#settled.size > 0) {
      let timer;
      const timeout = new Promise((resolve) => {
        timer = setTimeout(resolve, graceMs);
      });
      await Promise.race([Promise.allSettled([...this.#settled]), timeout]);
      clearTimeout(timer);
    }
    this.#metrics.stopRuntimeSampling();
  }
}
