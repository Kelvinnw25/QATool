import { monitorEventLoopDelay } from 'node:perf_hooks';

/**
 * In-memory operations metrics, for a future owner-only dashboard.
 *
 * There is deliberately NO route that serves this and no UI: `snapshot()` is an
 * internal interface, reached through `app.jobPlatform.metrics`. The numbers describe the
 * whole system (every visitor), so they must never be public; whoever adds the
 * dashboard puts it behind the owner-only Access hostname, not behind a ticket.
 *
 * Nothing here records who anybody is or what they uploaded: sessions are counted by
 * a bounded set of `sid`s that is never exposed, and the snapshot has counts and
 * durations only. All of it is lost on restart.
 *
 * Counters are monotonic since boot. Gauges (queue depth, busy workers, uploads in
 * flight) are read from the live sources registered by the components that own them,
 * so they cannot drift from the truth. Durations are kept as a bounded ring of recent
 * samples and reported as count / p50 / p95 / max.
 */

const SESSION_WINDOW_MS = 2 * 60_000;
const MAX_TRACKED_SESSIONS = 5_000;
const BUSY_HISTORY_MS = 10 * 60_000;

/**
 * How often the event loop is sampled. Node's histogram records the whole time between
 * two ticks, so an idle loop reads about this value, not zero; the excess over it is the
 * delay. Reported as the excess. Timer granularity still shows: on Windows (about 15 ms)
 * an idle loop reads roughly 10 ms. What matters is a block, which reads as its length.
 */
const LOOP_RESOLUTION_MS = 20;
const excess = (nanoseconds) =>
  Number(Math.max(0, nanoseconds / 1e6 - LOOP_RESOLUTION_MS).toFixed(2));

function percentile(sorted, fraction) {
  if (sorted.length === 0) return null;
  const index = Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1);
  return sorted[Math.max(0, index)];
}

function summarise(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    count: sorted.length,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    max: sorted.length > 0 ? sorted.at(-1) : null,
  };
}

/**
 * @param {object} [options]
 * @param {() => number} [options.now]
 * @param {number} [options.sampleSize]  recent samples kept per duration series
 */
export function createJobMetrics({ now = Date.now, sampleSize = 200 } = {}) {
  const counters = new Map();
  const series = new Map();
  const sources = new Map();
  /** sid -> last seen, oldest first */
  const sessions = new Map();
  /** [start, end] of finished stretches of worker time */
  let busy = [];
  const bootedAt = now();
  let loopDelay = null;

  function pruneSessions() {
    const cutoff = now() - SESSION_WINDOW_MS;
    for (const [sid, seen] of sessions) {
      if (seen > cutoff) break;
      sessions.delete(sid);
    }
  }

  return {
    /** Adds to a named counter. Names are fixed strings chosen by the code, never input. */
    inc(name, by = 1) {
      counters.set(name, (counters.get(name) ?? 0) + by);
    },

    /** Records one duration or size sample in a bounded ring. */
    observe(name, value) {
      if (!Number.isFinite(value)) return;
      const ring = series.get(name) ?? [];
      ring.push(value);
      if (ring.length > sampleSize) ring.shift();
      series.set(name, ring);
    },

    /** Notes that a session did something. Bounded, and expired entries are dropped. */
    touchSession(sid) {
      sessions.delete(sid);
      sessions.set(sid, now());
      pruneSessions();
      while (sessions.size > MAX_TRACKED_SESSIONS) {
        sessions.delete(sessions.keys().next().value);
      }
    },

    /** A live reading owned by another component, e.g. `queue`, `workers`, `uploads`. */
    registerSource(name, read) {
      sources.set(name, read);
    },

    /** One worker was busy from `start` to `end` (ms). Feeds utilization. */
    recordBusy(start, end) {
      busy.push([start, end]);
      const cutoff = now() - BUSY_HISTORY_MS;
      busy = busy.filter(([, finished]) => finished > cutoff);
    },

    /** Starts sampling event-loop delay. Its timer does not keep the process alive. */
    startRuntimeSampling() {
      if (loopDelay) return;
      loopDelay = monitorEventLoopDelay({ resolution: LOOP_RESOLUTION_MS });
      loopDelay.enable();
    },

    stopRuntimeSampling() {
      loopDelay?.disable();
      loopDelay = null;
    },

    /**
     * Everything, as plain numbers. Internal: see the note at the top of this file.
     *
     * @param {{ windowMs?: number }} [options]  the window utilization is measured over
     */
    snapshot({ windowMs = 60_000 } = {}) {
      pruneSessions();
      const time = now();
      const read = (name) => {
        try {
          return sources.get(name)?.() ?? null;
        } catch {
          return null;
        }
      };

      const workers = read('workers');
      const windowStart = time - windowMs;
      const finishedBusy = busy.reduce(
        (sum, [start, end]) => sum + Math.max(0, end - Math.max(start, windowStart)),
        0
      );
      const runningBusy = (read('active_starts') ?? []).reduce(
        (sum, start) => sum + Math.max(0, time - Math.max(start, windowStart)),
        0
      );
      const capacityMs = (workers?.effective ?? workers?.configured ?? 0) * windowMs;

      const count = (name) => counters.get(name) ?? 0;
      const failures = {};
      for (const [name, value] of counters) {
        if (name.startsWith('ticket_failed_'))
          failures[name.slice('ticket_failed_'.length)] = value;
      }

      return {
        taken_at: new Date(time).toISOString(),
        uptime_ms: time - bootedAt,
        sessions: { active_last_2m: sessions.size },
        tickets: { minted: count('tickets_minted'), failures },
        jobs: {
          current: read('jobs') ?? null,
          submitted: count('jobs_submitted'),
          completed: count('jobs_completed'),
          failed: count('jobs_failed'),
          cancelled: count('jobs_cancelled'),
          cancelled_by_reason: {
            user: count('jobs_cancelled_user'),
            abandoned: count('jobs_cancelled_abandoned'),
            shutdown: count('jobs_cancelled_shutdown'),
          },
        },
        workers: {
          configured: workers?.configured ?? null,
          effective: workers?.effective ?? null,
          busy: workers?.busy ?? null,
          utilization:
            capacityMs > 0
              ? Math.min(1, Number(((finishedBusy + runningBusy) / capacityMs).toFixed(3)))
              : null,
          window_ms: windowMs,
        },
        durations_ms: {
          queue_wait: summarise(series.get('queue_wait_ms') ?? []),
          processing: summarise(series.get('processing_ms') ?? []),
        },
        rejections: {
          queue_full: count('rejected_queue_full'),
          already_active: count('rejected_already_active'),
          rate_limited: count('rejected_rate_limited'),
          upload_busy: count('rejected_upload_busy'),
          paused: count('rejected_paused'),
          unavailable: count('rejected_unavailable'),
          upload_limits: count('rejected_upload_limits'),
          auth: count('auth_rejected'),
          session_rate_limited: count('session_rate_limited'),
        },
        errors: {
          by_code: Object.fromEntries(
            [...counters]
              .filter(([name]) => name.startsWith('job_error_'))
              .map(([name, value]) => [name.slice('job_error_'.length), value])
          ),
          provider_breaker_trips: count('breaker_trips'),
        },
        apayee: read('apayee'),
        uploads: read('uploads'),
        process: {
          rss_bytes: process.memoryUsage().rss,
          heap_used_bytes: process.memoryUsage().heapUsed,
          event_loop_delay_ms: loopDelay
            ? {
                mean: excess(loopDelay.mean),
                p95: excess(loopDelay.percentile(95)),
                max: excess(loopDelay.max),
              }
            : null,
        },
      };
    },
  };
}
