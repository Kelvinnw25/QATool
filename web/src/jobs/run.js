import { mergeCanonical } from '../state/merge.js';

/**
 * Runs the pipeline as one backend job and follows it to the end.
 *
 * The public demo's form of `runPipeline` (../pipeline.js). One job is a workflow segment: `from`
 * and every phase after it. This file submits it, polls it, and hands each finished phase to the
 * same callbacks the local runner uses, so the stages above do not care which one ran.
 *
 * Plain JavaScript with every dependency injected (api, clock, sleep), so Node tests it without a
 * browser, a network or a timer.
 *
 * The rules this file exists to keep:
 *
 *  - **The lease.** The backend abandons a job nobody has asked about for 45 s, and only a status
 *    request renews it. So the poll interval is the backend's `poll_after_ms` clamped to at most
 *    10 s, a tab returning to the foreground polls at once, and a silence longer than 30 s is
 *    reported (`leaseGap`) rather than ignored. Browsers throttle background timers; this cannot
 *    prevent that, but it never lets it pass unseen.
 *  - **One loop.** A job is followed by exactly one loop; it only ever awaits its own sleep.
 *  - **No blind resubmission.** After a failure that leaves it unknown whether the backend accepted
 *    the job (the connection dropped, or the answer never came), nothing is sent again by itself.
 *    The caller may resubmit on the visitor's say-so, and `JOB_ALREADY_ACTIVE` then hands back the
 *    job that was in fact accepted, which is followed instead of duplicated.
 *  - **Bounded retries.** Only `UPLOAD_BUSY` (rejected before the body was read, so nothing can have
 *    been accepted) is retried automatically, a few times, honouring Retry-After. A poll that fails
 *    in transit is retried a few times; polling is a read. A model call is never retried here.
 *  - **Cancelling is explicit.** Nothing in this file cancels a job because a component went away.
 *    `handle.cancel()` does, and only when someone calls it.
 */

export const LEASE_MS = 45_000;
export const DEFAULT_POLL_MS = 2_500;
export const MIN_POLL_MS = 1_000;
/** Comfortably under the lease, whatever the server suggests. */
export const MAX_POLL_MS = 10_000;
/** A silence this long between answered polls is surfaced to the visitor. */
export const LEASE_WARNING_MS = 30_000;
export const MAX_UPLOAD_BUSY_ATTEMPTS = 4;
export const MAX_RETRY_WAIT_SECONDS = 10;
export const MAX_POLL_FAILURES = 5;
export const MAX_RESULT_ATTEMPTS = 3;

/** The last `boot_id` this page saw, kept across runs so a restart between two jobs is noticed. */
export const sharedBoot = { current: null };

export const TERMINAL_STATES = new Set(['completed', 'failed', 'cancelled']);

export const PHASE_KEYS = ['extract', 'generate', 'validate'];

const clamp = (value, low, high) => Math.min(high, Math.max(low, value));

/** How long to wait before the next status request. */
export function pollDelay(job) {
  const asked = Number(job?.poll_after_ms);
  return clamp(
    Number.isFinite(asked) && asked > 0 ? asked : DEFAULT_POLL_MS,
    MIN_POLL_MS,
    MAX_POLL_MS
  );
}

/**
 * Waits `ms`. With `wakeOnVisible`, a tab coming back to the foreground ends the wait early, so a
 * page that was throttled in the background polls the moment it can.
 */
export function browserSleep(ms, { wakeOnVisible = false } = {}) {
  return new Promise((resolve) => {
    const doc = globalThis.document;
    let timer = null;
    const finish = () => {
      clearTimeout(timer);
      doc?.removeEventListener?.('visibilitychange', onVisible);
      resolve();
    };
    const onVisible = () => {
      if (doc.visibilityState === 'visible') finish();
    };
    timer = setTimeout(finish, ms);
    if (wakeOnVisible) doc?.addEventListener?.('visibilitychange', onVisible);
  });
}

/**
 * A handle the caller keeps so a visitor can cancel: it learns the job id when the job is accepted.
 */
export function createJobHandle(api) {
  const handle = {
    jobId: null,
    cancelRequested: false,
    /** @returns {Promise<object | null>} the job as the backend now reports it */
    async cancel() {
      if (handle.jobId === null) return null;
      handle.cancelRequested = true;
      const reply = await api.cancelJob(handle.jobId);
      return reply.job;
    },
  };
  return handle;
}

/** A job's own failure, as an Error the stages treat like any other. */
function jobError(info, phase) {
  const error = new Error(info?.message ?? 'The job could not be completed.');
  error.code = info?.code ?? 'JOB_FAILED';
  error.details = Array.isArray(info?.details) ? info.details : [];
  error.retryable = info?.retryable !== false;
  error.phase = info?.phase ?? phase;
  error.fromJob = true;
  return error;
}

function kindError(kind, message, extra = {}) {
  return Object.assign(new Error(message), { kind, ...extra });
}

/** Whether the backend may have accepted a submission whose answer never arrived. */
function isAmbiguous(error) {
  return error?.networkFailure === true || (error?.unanswered === true && error?.status >= 500);
}

const SUPERSEDED = Symbol('superseded');

/**
 * Submits the job. Returns `{ job, recovered }`, `SUPERSEDED`, or throws.
 */
async function submit({
  api,
  from,
  files,
  projectName,
  canonical,
  testPoints,
  isCurrent,
  on,
  sleep,
  random,
}) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      // Built fresh on every attempt: api.submitDocuments makes a new FormData each call.
      const reply =
        from === 'extract'
          ? await api.submitDocuments(files, projectName)
          : await api.submitResume({ from, canonical, testPoints });
      return { job: reply.job, recovered: false };
    } catch (error) {
      if (!isCurrent()) return SUPERSEDED;

      if (error.code === 'UPLOAD_BUSY' && attempt < MAX_UPLOAD_BUSY_ATTEMPTS) {
        // Refused before the body was read, so nothing was accepted and sending again is safe.
        const waitSeconds = clamp(error.retryAfterSeconds ?? 2, 1, MAX_RETRY_WAIT_SECONDS);
        on.waiting?.({
          kind: 'upload_busy',
          seconds: waitSeconds,
          attempt,
          of: MAX_UPLOAD_BUSY_ATTEMPTS,
        });
        await sleep(waitSeconds * 1000 + Math.floor(random() * 500));
        if (!isCurrent()) return SUPERSEDED;
        continue;
      }

      if (error.code === 'JOB_ALREADY_ACTIVE' && typeof error.details?.job_id === 'string') {
        // The job that is in fact running for this ticket - often the one an earlier, unanswered
        // submission created. Followed, not duplicated, when it is the same step.
        try {
          const existing = await api.jobStatus(error.details.job_id);
          if (existing.job.from === from) return { job: existing.job, recovered: true };
        } catch {
          // Could not look; report the conflict itself.
        }
      }

      if (isAmbiguous(error)) error.ambiguous = true;
      throw error;
    }
  }
}

/** Phase results, applied in order through the stage's callbacks. */
function applyPhases(phases, state, on) {
  if (phases.extract) {
    const result = phases.extract;
    state.testPoints = result.test_points ?? [];
    const partial = { documents: result.documents, requirements: result.requirements };
    state.canonical = mergeCanonical(state.canonical, partial);
    on.extracted?.(result, partial);
    on.completed?.('extract');
  }
  if (phases.generate) {
    const result = phases.generate;
    // Only the canonical fields: warnings and metadata are about the run, and the canonical schema
    // is strict.
    const partial = { project: result.project, test_cases: result.test_cases };
    state.canonical = mergeCanonical(state.canonical, partial);
    on.generated?.(result, partial);
    on.completed?.('generate');
  }
  if (phases.validate) {
    on.validated?.(phases.validate);
    on.completed?.('validate');
  }
}

/** The first phase of the segment that did not finish. */
function failedPhase(view, from) {
  const named = PHASE_KEYS.find((key) => view.phases?.[key] === 'failed');
  if (named) return named;
  return (
    PHASE_KEYS.slice(PHASE_KEYS.indexOf(from)).find((key) => view.phases?.[key] !== 'done') ?? from
  );
}

/**
 * Follows an accepted job to its end and applies what it produced.
 *
 * @returns {Promise<{ completed: boolean, superseded: boolean, cancelled: boolean, canonical: object, testPoints: any[], job: object | null }>}
 */
export async function followJob({
  api,
  job,
  from,
  canonical,
  testPoints = [],
  isCurrent = () => true,
  on = {},
  sleep = browserSleep,
  now = Date.now,
}) {
  const state = { canonical, testPoints };
  const outcome = (extra) => ({
    completed: false,
    superseded: false,
    cancelled: false,
    canonical: state.canonical,
    testPoints: state.testPoints,
    job: view,
    ...extra,
  });

  let view = job;
  let lastAnswered = now();
  let failures = 0;
  const bootId = job.boot_id;

  const fail = (phase, error) => {
    on.failed?.(phase, error);
    return outcome({});
  };

  while (!TERMINAL_STATES.has(view.state)) {
    if (!isCurrent()) return outcome({ superseded: true });

    await sleep(failures > 0 ? Math.min(1000 * 2 ** (failures - 1), 5000) : pollDelay(view), {
      wakeOnVisible: true,
    });
    if (!isCurrent()) return outcome({ superseded: true });

    try {
      const reply = await api.jobStatus(job.id);
      if (!isCurrent()) return outcome({ superseded: true });

      const silence = now() - lastAnswered;
      lastAnswered = now();
      failures = 0;
      view = reply.job;

      if (view.boot_id !== bootId) {
        return fail(failedPhase(view, from), kindError('restarted', 'The server restarted.'));
      }
      if (silence > LEASE_WARNING_MS) on.leaseGap?.(silence);
      on.progress?.(view);
    } catch (error) {
      if (!isCurrent()) return outcome({ superseded: true });

      if (error.code === 'JOB_NOT_FOUND') {
        // Not found after a long silence is the lease; otherwise it is gone for a reason the
        // server does not give (a restart, or retention) and the page cannot tell which.
        const silence = now() - lastAnswered;
        return fail(
          failedPhase(view, from),
          silence >= LEASE_MS - 5_000
            ? kindError('inactive', 'The job expired while the page was not checking on it.')
            : kindError('lost', 'The job is no longer on the server.')
        );
      }

      if (error.status === 401) {
        return fail(failedPhase(view, from), Object.assign(error, { jobId: job.id }));
      }

      const transient =
        error.status === 429 || error.networkFailure || error.unanswered || error.status >= 500;
      if (!transient) return fail(failedPhase(view, from), error);

      failures += 1;
      if (error.status === 429 && error.retryAfterSeconds) {
        await sleep(clamp(error.retryAfterSeconds, 1, 15) * 1000);
      }
      if (failures > MAX_POLL_FAILURES) {
        // The job may well still be running; the page can follow it again on request.
        return fail(failedPhase(view, from), Object.assign(error, { jobId: job.id }));
      }
      on.pollTrouble?.({ failures, of: MAX_POLL_FAILURES });
    }
  }

  // --- Terminal -----------------------------------------------------------------------------
  on.progress?.(view);

  let result = null;
  if (view.result_available) {
    for (let attempt = 1; ; attempt += 1) {
      try {
        result = await api.jobResult(job.id);
        break;
      } catch (error) {
        if (!isCurrent()) return outcome({ superseded: true });
        const transient = error.networkFailure || error.unanswered || error.status >= 500;
        if (transient && attempt < MAX_RESULT_ATTEMPTS) {
          await sleep(1000 * attempt);
          continue;
        }
        return fail(
          failedPhase(view, from),
          Object.assign(error, {
            jobId: job.id,
            // The job finished; only the reading failed. Say so.
            message: `The job finished, but its results could not be fetched. ${error.message}`,
          })
        );
      }
    }
  }
  if (!isCurrent()) return outcome({ superseded: true });

  applyPhases(result?.phases ?? {}, state, on);

  if (view.state === 'completed') return outcome({ completed: true });

  if (view.state === 'cancelled') {
    // Only a cancellation the visitor asked for is shown as one. The server also cancels jobs
    // nobody was checking on ('abandoned') and every job when it shuts down or restarts
    // ('shutdown'); those are failures of the run, not a decision, and say what to do next.
    if (view.cancel_reason === 'abandoned') {
      return fail(failedPhase(view, from), kindError('inactive', 'The job was abandoned.'));
    }
    if (view.cancel_reason === 'shutdown') {
      return fail(
        failedPhase(view, from),
        kindError('shutdown', 'The server stopped the job because it is restarting.')
      );
    }
    on.cancelled?.(view);
    return outcome({ cancelled: true });
  }

  const phase = view.error?.phase ?? failedPhase(view, from);
  return fail(phase, jobError(view.error, phase));
}

/**
 * Submits a job from `from` and follows it. The demo's counterpart of `runPipeline`.
 *
 * `on` receives the same callbacks as `runPipeline` (`extracted`, `generated`, `validated`,
 * `completed`, `failed`) plus the job's own: `accepted(job, {recovered, restarted})`,
 * `waiting({kind, seconds, attempt, of})`, `progress(job)`, `leaseGap(ms)`, `pollTrouble`,
 * `cancelled(job)`.
 *
 * `boot` is `{ current: string | null }`, kept by the caller across runs: a job accepted under a
 * different `boot_id` than the last one means the server restarted in between.
 *
 * `attach` follows a job that was already accepted (a reconnect) instead of submitting another.
 */
export async function runJobPipeline({
  from = 'extract',
  canonical,
  files = [],
  projectName = '',
  testPoints = [],
  isCurrent = () => true,
  api,
  on = {},
  handle = null,
  boot = { current: null },
  attach = null,
  sleep = browserSleep,
  now = Date.now,
  random = Math.random,
}) {
  if (!PHASE_KEYS.includes(from)) throw new Error(`Unknown pipeline phase: ${from}`);

  if (!isCurrent())
    return {
      completed: false,
      superseded: true,
      cancelled: false,
      canonical,
      testPoints,
      job: null,
    };

  let accepted;
  if (attach) {
    accepted = { job: attach, recovered: true };
  } else {
    on.submitting?.();
    try {
      accepted = await submit({
        api,
        from,
        files,
        projectName,
        canonical,
        testPoints,
        isCurrent,
        on,
        sleep,
        random,
      });
    } catch (error) {
      on.failed?.(from, error);
      return {
        completed: false,
        superseded: false,
        cancelled: false,
        canonical,
        testPoints,
        job: null,
      };
    }
    if (accepted === SUPERSEDED) {
      return {
        completed: false,
        superseded: true,
        cancelled: false,
        canonical,
        testPoints,
        job: null,
      };
    }
  }

  const { job, recovered } = accepted;
  const restarted = boot.current !== null && boot.current !== job.boot_id;
  boot.current = job.boot_id;
  if (handle) handle.jobId = job.id;

  on.accepted?.(job, { recovered, restarted });

  return followJob({
    api,
    job,
    from: job.from ?? from,
    canonical,
    testPoints,
    isCurrent,
    on,
    sleep,
    now,
  });
}
