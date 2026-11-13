import { redactDeep } from './redact.js';

/**
 * The downloadable snapshot: the same view the dashboard shows, once more through
 * `redactDeep`, which drops any key that looks like a credential and masks any string that
 * looks like one. The view is already built from whitelisted fields; this is the belt to
 * those braces, so a field added carelessly later cannot reach a file the owner might share.
 *
 * @param {object} view  `collector.view()`
 * @param {() => number} [now]
 */
export function buildSnapshot(view, now = Date.now) {
  const readings = {};
  for (const [name, r] of Object.entries(view.readings)) {
    readings[name] = {
      state: r.state,
      stale: r.stale,
      ageMs: r.ageMs,
      lastSuccessAgeMs: r.lastSuccessAgeMs,
      durationMs: r.durationMs,
      error: r.error,
      data: r.data,
      lastKnown: r.lastKnown,
    };
  }

  return redactDeep({
    kind: 'qatool-ops-snapshot',
    version: 1,
    exportedAt: new Date(now()).toISOString(),
    notice:
      'Counts, durations and states only. No document content, visitor ticket, secret or job ' +
      'identity is collected. Job figures are since the QATOOL backend started; they reset on restart.',
    monitor: view.monitor,
    overall: view.overall,
    components: view.components,
    capacity: view.capacity,
    jobs: view.jobs,
    warnings: view.warnings,
    readings,
    events: view.events,
    history: view.history,
  });
}
