import { Unavailable } from './errors.js';
import {
  componentStatus,
  computeCapacity,
  computeJobStats,
  computeWarnings,
  overallStatus,
} from './derive.js';
import { detectEvents } from './events.js';
import { describeError } from './redact.js';

/** A manual refresh closer than this to the last poll is answered with that poll. */
const MIN_REFRESH_GAP_MS = 1000;

const COMPONENTS = ['backend', 'apayee', 'frontend', 'tunnel', 'docker'];

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error('timed out');
      error.code = 'TIMEOUT';
      reject(error);
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * The single polling loop.
 *
 * One cycle at a time: the next is scheduled only after the previous one finished, and a
 * manual refresh while a cycle runs joins it instead of starting another. Every adapter runs
 * under its own timeout, so a hung Docker call cannot stop the others or stall the loop.
 *
 * Everything is in memory and bounded: `historyPoints` samples, `eventLimit` events. A restart
 * of this tool starts empty, and the dashboard says so (`startedAt`).
 *
 * @param {object} options
 * @param {ReturnType<import('./config.js').loadConfig>} options.config
 * @param {Array<{ name: string, timeoutMs: number, collect: () => Promise<unknown> }>} options.adapters
 * @param {() => number} [options.now]
 */
export function createCollector({ config, adapters, now = Date.now }) {
  const startedAt = now();
  /** @type {Map<string, object>} */
  const readings = new Map(adapters.map((a) => [a.name, { state: 'pending', data: null }]));
  /** @type {Array<object>} */
  let history = [];
  /** @type {Array<object>} */
  let events = [];
  let eventSeq = 0;
  let prevFacts = null;
  /** The last job metrics actually read, kept across an outage so a restart can still be recognised. */
  let lastJobs = null;
  let cycles = 0;
  let lastCycleStart = 0;
  let lastCycleEnd = null;
  let lastCycleMs = null;
  let timer = null;
  let running = null;
  let stopped = true;
  let backendResets = 0;

  async function collectOne(adapter) {
    const began = now();
    const previous = readings.get(adapter.name);
    try {
      const data = await withTimeout(
        Promise.resolve().then(() => adapter.collect()),
        adapter.timeoutMs
      );
      readings.set(adapter.name, {
        state: 'ok',
        data,
        lastData: data,
        error: null,
        collectedAt: now(),
        lastSuccessAt: now(),
        durationMs: now() - began,
      });
    } catch (error) {
      const state =
        error instanceof Unavailable
          ? error.code === 'NOT_CONFIGURED'
            ? 'not_configured'
            : 'no_source'
          : 'unavailable';
      readings.set(adapter.name, {
        state,
        data: null,
        // Kept so the page can show the last known figure, clearly marked as old.
        lastData: previous?.lastData ?? null,
        error:
          state === 'unavailable'
            ? describeError(error)
            : { code: error.code, message: error.message },
        collectedAt: now(),
        lastSuccessAt: previous?.lastSuccessAt ?? null,
        durationMs: now() - began,
      });
    }
  }

  function readingView(name) {
    const r = readings.get(name);
    const t = now();
    const ageMs = r.collectedAt ? t - r.collectedAt : null;
    const stale = r.state === 'ok' && ageMs !== null && ageMs > config.staleAfterMs;
    return {
      state: r.state,
      stale,
      ageMs,
      lastSuccessAgeMs: r.lastSuccessAt ? t - r.lastSuccessAt : null,
      durationMs: r.durationMs ?? null,
      error: r.error ?? null,
      data: r.state === 'ok' ? r.data : null,
      lastKnown: r.state === 'unavailable' ? (r.lastData ?? null) : null,
    };
  }

  function views() {
    return Object.fromEntries(adapters.map((a) => [a.name, readingView(a.name)]));
  }

  /** The compact facts events and history are computed from. */
  function factsOf(v) {
    const components = Object.fromEntries(COMPONENTS.map((n) => [n, componentStatus(n, v[n])]));
    return {
      components,
      jobs: v.jobs?.state === 'ok' ? v.jobs.data : null,
      apayee: v.apayee?.state === 'ok' ? v.apayee.data : null,
      containers: v.docker?.state === 'ok' ? v.docker.data.containers : [],
    };
  }

  function record(level, kind, text) {
    eventSeq += 1;
    events.push({ id: eventSeq, t: new Date(now()).toISOString(), level, kind, text });
    if (events.length > config.eventLimit) events = events.slice(-config.eventLimit);
  }

  function sample(facts) {
    const services = {};
    for (const c of facts.containers) {
      services[c.service] = {
        cpu: c.resources?.cpuPercent ?? null,
        mem: c.resources?.memUsedBytes ?? null,
      };
    }
    history.push({
      t: now(),
      queued: facts.jobs?.now.queued ?? null,
      processing: facts.jobs?.now.processing ?? null,
      apayeeActive: facts.apayee?.active ?? null,
      apayeePending: facts.apayee?.pending ?? null,
      services,
    });
    if (history.length > config.historyPoints) history = history.slice(-config.historyPoints);
  }

  async function cycle() {
    lastCycleStart = now();
    await Promise.all(adapters.map(collectOne));
    cycles += 1;
    lastCycleEnd = now();
    lastCycleMs = lastCycleEnd - lastCycleStart;

    const facts = factsOf(views());
    // The first cycle has nothing to compare with; reporting every counter as "new" would be noise.
    if (prevFacts) {
      // A backend that crashed and came back has no job metrics in between. Compare its first new
      // reading with the last one it gave, so a restart is still seen as a restart.
      const before = !prevFacts.jobs && lastJobs ? { ...prevFacts, jobs: lastJobs } : prevFacts;
      for (const e of detectEvents(before, facts)) record(e.level, e.kind, e.text);
      if (facts.jobs && before.jobs && facts.jobs.uptimeMs < before.jobs.uptimeMs)
        backendResets += 1;
    }
    if (facts.jobs) lastJobs = facts.jobs;
    sample(facts);
    prevFacts = facts;
  }

  function runCycle() {
    if (running) return running;
    running = cycle()
      .catch((error) => {
        // A bug in a derivation must not kill the loop. Say what, without a stack.
        record('warn', 'collector_error', `Collector error: ${describeError(error).message}`);
      })
      .finally(() => {
        running = null;
      });
    return running;
  }

  function schedule() {
    if (stopped) return;
    timer = setTimeout(async () => {
      await runCycle();
      schedule();
    }, config.pollMs);
    timer.unref?.();
  }

  return {
    start() {
      if (!stopped) return;
      stopped = false;
      runCycle().then(schedule);
    },

    stop() {
      stopped = true;
      clearTimeout(timer);
    },

    /** Manual refresh: joins a running cycle, or reuses one that just finished. */
    async refresh() {
      if (running) await running;
      else if (now() - lastCycleStart >= MIN_REFRESH_GAP_MS) await runCycle();
      return this.view();
    },

    /** One pass, for tests: no timer. */
    runOnce: runCycle,

    /** Everything the page and the export are built from. Plain data, no secrets by construction. */
    view() {
      const v = views();
      const facts = factsOf(v);
      const capacity = computeCapacity(facts.jobs, facts.apayee);
      const warnings = computeWarnings({ readings: v, capacity });
      const t = now();
      const sinceCycle = lastCycleEnd === null ? null : t - lastCycleEnd;
      const collectorStale = sinceCycle !== null && sinceCycle > config.staleAfterMs;

      return {
        generatedAt: new Date(t).toISOString(),
        monitor: {
          mode: config.mode,
          startedAt: new Date(startedAt).toISOString(),
          pollMs: config.pollMs,
          staleAfterMs: config.staleAfterMs,
          cycles,
          lastCycleAt: lastCycleEnd === null ? null : new Date(lastCycleEnd).toISOString(),
          lastCycleMs,
          ageMs: sinceCycle,
          stale: collectorStale,
          refreshing: running !== null,
          backendResetsSeen: backendResets,
          note: 'History and events live in memory and start empty when this monitor starts.',
        },
        overall: overallStatus({ components: facts.components, warnings, cycles }),
        components: facts.components,
        readings: v,
        capacity,
        jobs: computeJobStats(facts.jobs),
        warnings,
        events: events.slice(-100).reverse(),
        history,
      };
    },
  };
}
