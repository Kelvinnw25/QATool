/**
 * Everything the dashboard concludes, as pure functions of the readings. No clock, no I/O, so
 * every rule here is a plain unit test.
 *
 * A reading view is what the collector keeps per adapter:
 *   { state: 'ok' | 'unavailable' | 'not_configured' | 'no_source' | 'pending',
 *     stale: boolean, data: object | null  (the last good data; `lastKnown` says it is old) }
 */

/** @typedef {'up' | 'degraded' | 'down' | 'stale' | 'unknown'} ComponentStatus */

const usable = (reading) => reading?.state === 'ok' && !reading.stale;

/** Per-component verdict. A component that was never configured is `unknown`, not `down`. */
export function componentStatus(name, reading) {
  if (!reading || reading.state === 'pending') return 'unknown';
  if (reading.state === 'not_configured' || reading.state === 'no_source') return 'unknown';

  if (reading.state === 'unavailable') {
    // Docker being unreachable says nothing about the services themselves: the HTTP probes
    // decide that. Everything else that cannot be read is a failure to reach it.
    if (name === 'docker' || name === 'jobs') return 'unknown';
    // In a container Apayee is read through the backend's socket. If that socket cannot be read, the
    // backend is the thing that is down (its own probe says so); nothing is known about Apayee.
    if (name === 'apayee' && /^SOCKET_|^BAD_SNAPSHOT$/.test(reading.error?.code ?? ''))
      return 'unknown';
    return 'down';
  }
  if (reading.stale) return 'stale';

  const d = reading.data;
  switch (name) {
    case 'backend':
    case 'frontend':
    case 'tunnel':
      return d.healthy ? 'up' : 'down';
    case 'apayee':
      return d.healthy ? 'up' : 'degraded'; // answers, but status is not ok or Claude is not ready
    case 'docker': {
      const bad = d.containers.some((c) => !c.running || c.health === 'unhealthy' || c.oomKilled);
      return bad ? 'degraded' : 'up';
    }
    default:
      return 'up';
  }
}

/** Capacity and queue figures, with every unknown left null rather than guessed. */
export function computeCapacity(jobs, apayee) {
  const qatool = jobs
    ? {
        workersConfigured: jobs.workers.configured,
        workersEffective: jobs.workers.effective,
        workersBusy: jobs.workers.busy,
        workersFree:
          jobs.workers.effective === null
            ? null
            : Math.max(0, jobs.workers.effective - jobs.workers.busy),
        queued: jobs.now.queued,
        processing: jobs.now.processing,
        utilization: jobs.workers.utilization,
      }
    : null;

  const gateway = apayee
    ? {
        active: apayee.active,
        maxActive: apayee.maxActive,
        available: apayee.maxActive === null ? null : Math.max(0, apayee.maxActive - apayee.active),
        pending: apayee.pending,
        capacity: apayee.capacity,
        // Share of the waiting room that is used. Null when Apayee does not report its size.
        pendingRatio:
          apayee.capacity > 0 ? Number((apayee.pending / apayee.capacity).toFixed(3)) : null,
        saturated: apayee.maxActive !== null && apayee.active >= apayee.maxActive,
      }
    : null;

  return { qatool, apayee: gateway };
}

/** Session aggregates from the counters. "Since the backend started": a restart resets them. */
export function computeJobStats(jobs) {
  if (!jobs) return null;
  const { completed, failed, cancelled, submitted } = jobs.total;
  const finished = completed + failed;
  return {
    sinceBootMs: jobs.uptimeMs,
    submitted,
    completed,
    failed,
    cancelled,
    // Cancelled jobs are a visitor's choice, not a failure of the system, so they are left out.
    successRate: finished > 0 ? Number((completed / finished).toFixed(4)) : null,
    failureRate: finished > 0 ? Number((failed / finished).toFixed(4)) : null,
    // The backend keeps p50/p95/max, not a mean, so no average is reported.
    processingMs: jobs.durationsMs.processing,
    queueWaitMs: jobs.durationsMs.queueWait,
  };
}

/**
 * Warnings, most severe first. Thresholds are in one place; each states what it saw, so the
 * operator does not have to guess why a banner is amber.
 */
export function computeWarnings({ readings, capacity }) {
  const out = [];
  const add = (level, code, text) => out.push({ level, code, text });

  const apayee = readings.apayee;
  if (usable(apayee)) {
    const d = apayee.data;
    if (d.status !== 'ok') add('critical', 'apayee_status', `Apayee reports status "${d.status}".`);
    if (!d.providerReady) {
      add(
        'critical',
        'provider_not_ready',
        `Claude provider is not ready (${d.providerState ?? 'unknown state'}).`
      );
    }
  }

  const a = capacity.apayee;
  if (a) {
    if (a.pendingRatio !== null && a.pendingRatio >= 0.8) {
      add(
        'critical',
        'apayee_queue_saturated',
        `Apayee waiting room is ${Math.round(a.pendingRatio * 100)}% full (${a.pending}/${a.capacity}).`
      );
    } else if (a.pendingRatio !== null && a.pendingRatio >= 0.5) {
      add(
        'warn',
        'apayee_queue_filling',
        `Apayee waiting room is ${Math.round(a.pendingRatio * 100)}% full (${a.pending}/${a.capacity}).`
      );
    }
    if (a.saturated && a.pending > 0) {
      add(
        'info',
        'apayee_at_capacity',
        `All ${a.maxActive} Apayee slot(s) busy; ${a.pending} request(s) waiting.`
      );
    }
  }

  const q = capacity.qatool;
  if (q && q.workersEffective !== null && q.workersBusy >= q.workersEffective && q.queued > 0) {
    add(
      'info',
      'jobs_queueing',
      `All ${q.workersEffective} job worker(s) busy; ${q.queued} job(s) queued.`
    );
  }

  const docker = readings.docker;
  if (usable(docker)) {
    for (const c of docker.data.containers) {
      if (!c.running)
        add('critical', 'container_stopped', `${c.service} is not running (${c.status}).`);
      else if (c.health === 'unhealthy')
        add('critical', 'container_unhealthy', `${c.service} is unhealthy.`);
      if (c.oomKilled)
        add('critical', 'container_oom', `${c.service} was killed for exceeding its memory limit.`);
      const r = c.resources;
      const percent =
        r?.memUsedBytes && r.memLimitBytes
          ? (r.memUsedBytes / r.memLimitBytes) * 100
          : r?.memPercent;
      if (percent >= 95)
        add(
          'critical',
          'memory_critical',
          `${c.service} memory at ${Math.round(percent)}% of its limit.`
        );
      else if (percent >= 85)
        add('warn', 'memory_high', `${c.service} memory at ${Math.round(percent)}% of its limit.`);
    }
  }

  for (const [name, reading] of Object.entries(readings)) {
    if (reading?.stale) add('warn', 'stale', `${name}: data is stale.`);
  }

  const rank = { critical: 0, warn: 1, info: 2 };
  return out.sort((x, y) => rank[x.level] - rank[y.level]);
}

/**
 * One word for the top of the page.
 *   starting  nothing collected yet
 *   critical  the backend or the gateway is down, or a warning is critical
 *   degraded  something works worse than it should, or a reading is stale
 *   ok
 */
export function overallStatus({ components, warnings, cycles }) {
  if (cycles === 0) return { status: 'starting', reasons: ['Waiting for the first poll.'] };

  const reasons = [];
  let status = 'ok';
  const raise = (to, reason) => {
    const order = { ok: 0, degraded: 1, critical: 2 };
    if (order[to] > order[status]) status = to;
    reasons.push(reason);
  };

  if (components.backend === 'down') raise('critical', 'QATOOL backend is not answering.');
  if (components.apayee === 'down') raise('critical', 'Apayee gateway is not answering.');
  if (components.apayee === 'degraded') raise('degraded', 'Apayee answers but is not ready.');
  if (components.frontend === 'down') raise('degraded', 'The Vercel frontend is not reachable.');
  if (components.tunnel === 'down') raise('degraded', 'The Cloudflare Tunnel is not healthy.');
  if (components.docker === 'degraded') raise('degraded', 'A container is stopped or unhealthy.');
  for (const [name, s] of Object.entries(components)) {
    if (s === 'stale') raise('degraded', `${name} data is stale.`);
  }
  for (const w of warnings) {
    if (w.level === 'critical') raise('critical', w.text);
    else if (w.level === 'warn') raise('degraded', w.text);
  }
  return { status, reasons: [...new Set(reasons)] };
}
