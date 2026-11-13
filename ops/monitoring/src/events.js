/**
 * Turns two successive sets of facts into events.
 *
 * QATOOL keeps counters, not a log of jobs, so "recent job activity" is exactly what can be
 * known honestly: how many jobs reached each state since the previous poll. No job id, no
 * visitor, no document name is available here or invented. Event text is built from fixed
 * templates and numbers. The only strings from a monitored system are short state labels (the
 * gateway's provider state, an error-code name), which the parsers have already redacted and
 * bounded.
 *
 * @typedef {{ level: 'info' | 'warn' | 'critical', kind: string, text: string }} MonitorEvent
 */

const LABELS = {
  backend: 'QATOOL backend',
  apayee: 'Apayee gateway',
  frontend: 'Vercel frontend',
  tunnel: 'Cloudflare Tunnel',
  docker: 'Docker containers',
};

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const positive = (a, b) => (typeof a === 'number' && typeof b === 'number' && b > a ? b - a : 0);

/** @returns {MonitorEvent[]} */
export function detectEvents(prev, next) {
  /** @type {MonitorEvent[]} */
  const events = [];
  const push = (level, kind, text) => events.push({ level, kind, text });

  // Component transitions.
  for (const [name, label] of Object.entries(LABELS)) {
    const before = prev?.components?.[name];
    const after = next.components[name];
    if (!before || before === after) continue;
    const recovered = after === 'up';
    const level = recovered ? 'info' : after === 'down' ? 'critical' : 'warn';
    push(level, `component_${name}`, `${label}: ${before} → ${after}.`);
  }

  // QATOOL job counters.
  const pj = prev?.jobs;
  const nj = next.jobs;
  if (nj && pj) {
    if (nj.uptimeMs < pj.uptimeMs) {
      push(
        'warn',
        'jobs_reset',
        'QATOOL backend restarted: in-memory job metrics and all jobs were reset.'
      );
    } else {
      const submitted = positive(pj.total.submitted, nj.total.submitted);
      const completed = positive(pj.total.completed, nj.total.completed);
      const failed = positive(pj.total.failed, nj.total.failed);
      const cancelled = positive(pj.total.cancelled, nj.total.cancelled);
      if (submitted) push('info', 'jobs_submitted', `${plural(submitted, 'job')} submitted.`);
      if (completed) push('info', 'jobs_completed', `${plural(completed, 'job')} completed.`);
      if (failed) push('warn', 'jobs_failed', `${plural(failed, 'job')} failed.`);
      if (cancelled) push('info', 'jobs_cancelled', `${plural(cancelled, 'job')} cancelled.`);

      for (const [code, count] of Object.entries(nj.errorsByCode)) {
        const delta =
          positive(pj.errorsByCode[code], count) ||
          (pj.errorsByCode[code] === undefined ? count : 0);
        if (delta) push('warn', 'job_error', `Failure category ${code}: ${delta} new.`);
      }
      for (const [kind, count] of Object.entries(nj.rejections)) {
        const delta = positive(pj.rejections[kind], count);
        if (delta)
          push(
            kind === 'queue_full' ? 'warn' : 'info',
            'rejection',
            `${plural(delta, 'submission')} refused: ${kind}.`
          );
      }
      const trips = positive(pj.breakerTrips, nj.breakerTrips);
      if (trips)
        push(
          'critical',
          'breaker',
          `Provider circuit breaker tripped (${trips}×): new jobs are refused for a cooldown.`
        );
    }
  }

  // Apayee's own counters.
  const pa = prev?.apayee;
  const na = next.apayee;
  if (na && pa) {
    const t = na.totals;
    const p = pa.totals;
    const anyDrop = Object.keys(t).some(
      (k) => typeof t[k] === 'number' && typeof p[k] === 'number' && t[k] < p[k]
    );
    if (anyDrop) {
      push('warn', 'apayee_reset', 'Apayee restarted: its counters were reset.');
    } else {
      for (const [key, label, level] of [
        ['failed', 'failed', 'warn'],
        ['timedOut', 'timed out', 'warn'],
        ['rejected', 'rejected (waiting room full)', 'warn'],
        ['cancelled', 'cancelled', 'info'],
      ]) {
        const delta = positive(p[key], t[key]);
        if (delta) push(level, `apayee_${key}`, `Apayee: ${plural(delta, 'request')} ${label}.`);
      }
    }
    if (pa.providerReady && !na.providerReady) {
      push(
        'critical',
        'provider_not_ready',
        `Claude provider became not ready (${na.providerState ?? 'unknown'}).`
      );
    } else if (!pa.providerReady && na.providerReady) {
      push('info', 'provider_ready', 'Claude provider is ready again.');
    }
  }

  // Containers.
  const previousByService = new Map((prev?.containers ?? []).map((c) => [c.service, c]));
  for (const c of next.containers) {
    const before = previousByService.get(c.service);
    if (!before) continue;
    if (c.restarts > before.restarts) {
      push('critical', 'container_restart', `${c.service} restarted (${c.restarts} total).`);
    }
    if (c.oomKilled && !before.oomKilled) {
      push('critical', 'container_oom', `${c.service} was killed for exceeding its memory limit.`);
    }
  }

  return events;
}
