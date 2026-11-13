/**
 * Parsers for the three machine-readable sources. Each one copies a fixed list of fields and
 * checks their types; anything else in the input, wanted or not, is dropped. A reply that does
 * not look like what the source is documented to send is an error, not a guess.
 *
 * Shapes are taken from the code, not from documentation:
 *   - Apayee   src/routes/health.js            GET /v1/health
 *   - QATOOL   server/jobs/metrics.js          createJobMetrics().snapshot()
 *   - Docker   `docker inspect` / `stats`      with the fixed formats in exec.js
 */

import { redactText } from '../redact.js';

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** A finite number, or null. Never NaN, never a numeric string. */
export const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function shapeError(what) {
  const error = new Error(`unexpected ${what} reply`);
  error.code = 'BAD_SHAPE';
  return error;
}

function parseJson(text, what) {
  try {
    return JSON.parse(text);
  } catch {
    throw shapeError(what);
  }
}

/**
 * Apayee `/v1/health`.
 *
 * @returns {{
 *   status: string, version: string | null, provider: string | null,
 *   providerReady: boolean, providerState: string | null, providerReason: string | null,
 *   active: number, maxActive: number | null, pending: number, capacity: number | null,
 *   abandoned: number | null,
 *   totals: { succeeded: number | null, failed: number | null, timedOut: number | null,
 *             cancelled: number | null, rejected: number | null }
 * }}
 */
export function parseApayeeHealth(text) {
  const body = typeof text === 'string' ? parseJson(text, 'Apayee health') : text;
  if (!isObject(body) || body.service !== 'apayee' || !isObject(body.queue)) {
    throw shapeError('Apayee health');
  }
  const queue = body.queue;
  const status = isObject(body.provider_status) ? body.provider_status : {};

  // Older Apayee builds report only length/running; map them rather than refuse.
  const active = num(queue.active) ?? (queue.running === true ? 1 : 0);
  const pending = num(queue.pending) ?? num(queue.length);
  if (pending === null) throw shapeError('Apayee health');

  const totals = isObject(queue.totals) ? queue.totals : {};
  return {
    status: typeof body.status === 'string' ? redactText(body.status, { max: 40 }) : 'unknown',
    version: typeof body.version === 'string' ? redactText(body.version, { max: 40 }) : null,
    provider: typeof body.provider === 'string' ? redactText(body.provider, { max: 60 }) : null,
    providerReady: status.ready === true,
    providerState: typeof status.state === 'string' ? redactText(status.state, { max: 60 }) : null,
    providerReason:
      typeof status.reason === 'string' ? redactText(status.reason, { max: 200 }) : null,
    active,
    maxActive: num(queue.max_active),
    pending,
    capacity: num(queue.capacity),
    abandoned: num(queue.abandoned),
    totals: {
      succeeded: num(totals.succeeded),
      failed: num(totals.failed),
      timedOut: num(totals.timed_out),
      cancelled: num(totals.cancelled),
      rejected: num(totals.rejected),
    },
  };
}

/** Codes the backend reports when it could not reach the gateway at all (server/ops/apayee-view.js). */
const GATEWAY_UNREACHABLE = new Set(['gateway_offline', 'gateway_timeout', 'probe_failed']);

/**
 * The backend's view of Apayee, from its private socket (`GET /apayee`). The same shape as
 * `parseApayeeHealth` returns, so everything downstream is unchanged, with what the backend does not
 * pass on left null: version, provider state text, `abandoned` and the success/failure totals.
 *
 * A gateway the backend could not reach at all is an error (the gateway is down), not a reading.
 */
export function parseApayeeBridge(input) {
  const v = typeof input === 'string' ? parseJson(input, 'Apayee view') : input;
  if (!isObject(v) || typeof v.available !== 'boolean') throw shapeError('Apayee view');

  const code = typeof v.code === 'string' && /^[a-z][a-z0-9_]{0,39}$/.test(v.code) ? v.code : null;
  if (!v.available && (code === null || GATEWAY_UNREACHABLE.has(code))) {
    throw Object.assign(new Error(`The backend cannot reach Apayee (${code ?? 'unknown'}).`), {
      code: 'APAYEE_UNREACHABLE',
    });
  }

  return {
    status: v.available ? 'ok' : code,
    version: null,
    provider: v.available ? 'claude' : null,
    providerReady: v.available,
    providerState: v.available ? 'ready' : code,
    providerReason: null,
    active: num(v.active),
    maxActive: num(v.max_active),
    pending: num(v.pending),
    capacity: num(v.capacity),
    abandoned: null,
    totals: { succeeded: null, failed: null, timedOut: null, cancelled: null, rejected: null },
    // So the page can say what this reading does not include.
    viaBackend: true,
  };
}

const summary = (v) =>
  isObject(v) ? { count: num(v.count), p50: num(v.p50), p95: num(v.p95), max: num(v.max) } : null;

const counts = (v) => {
  if (!isObject(v)) return {};
  const out = {};
  for (const [key, value] of Object.entries(v)) {
    // Keys are code-chosen names (error codes, rejection kinds); bound them anyway.
    if (/^[a-z0-9_]{1,60}$/i.test(key) && num(value) !== null) out[key] = value;
  }
  return out;
};

/**
 * QATOOL `createJobMetrics().snapshot()`: counts and durations only, by design.
 * `sessions`, `tickets` and `uploads` are read as numbers; no sid or ticket ever appears there.
 */
export function parseJobMetrics(input) {
  const s = typeof input === 'string' ? parseJson(input, 'job metrics') : input;
  if (!isObject(s) || !isObject(s.jobs) || !isObject(s.workers) || num(s.uptime_ms) === null) {
    throw shapeError('job metrics');
  }
  // Outside PUBLIC_DEMO the backend has no job platform: the snapshot exists but its job sources were never
  // registered, so `current` is null. Reading that as "0 jobs" would be a lie; it is "no job metrics".
  if (!isObject(s.jobs.current)) {
    throw Object.assign(new Error('the backend has no job platform'), { code: 'NO_JOB_PLATFORM' });
  }
  const current = s.jobs.current;
  const apayee = isObject(s.apayee) ? s.apayee : null;
  const uploads = isObject(s.uploads) ? s.uploads : null;
  const rejections = counts(s.rejections);
  const durations = isObject(s.durations_ms) ? s.durations_ms : {};
  const proc = isObject(s.process) ? s.process : {};
  const loop = isObject(proc.event_loop_delay_ms) ? proc.event_loop_delay_ms : null;

  return {
    takenAt: typeof s.taken_at === 'string' ? s.taken_at.slice(0, 40) : null,
    uptimeMs: s.uptime_ms,
    activeSessions: num(s.sessions?.active_last_2m),
    ticketsMinted: num(s.tickets?.minted),
    // Now: what exists in the table at this moment.
    now: {
      queued: num(current.queued) ?? 0,
      processing: num(current.processing) ?? 0,
      completed: num(current.completed) ?? 0,
      failed: num(current.failed) ?? 0,
      cancelled: num(current.cancelled) ?? 0,
      retained: num(current.retained),
    },
    // Since boot: monotonic counters.
    total: {
      submitted: num(s.jobs.submitted) ?? 0,
      completed: num(s.jobs.completed) ?? 0,
      failed: num(s.jobs.failed) ?? 0,
      cancelled: num(s.jobs.cancelled) ?? 0,
      cancelledByReason: counts(s.jobs.cancelled_by_reason),
    },
    workers: {
      configured: num(s.workers.configured),
      effective: num(s.workers.effective),
      busy: num(s.workers.busy) ?? 0,
      utilization: num(s.workers.utilization),
      windowMs: num(s.workers.window_ms),
    },
    durationsMs: {
      queueWait: summary(durations.queue_wait),
      processing: summary(durations.processing),
    },
    rejections,
    errorsByCode: counts(s.errors?.by_code),
    breakerTrips: num(s.errors?.provider_breaker_trips) ?? 0,
    apayeeSeenByBackend: apayee
      ? {
          active: num(apayee.active),
          maxActive: num(apayee.max_active),
          pending: num(apayee.pending),
          capacity: num(apayee.capacity),
          reported: apayee.reported === true,
          compatible: apayee.compatible !== false,
          observedAt:
            typeof apayee.observed_at === 'string' ? apayee.observed_at.slice(0, 40) : null,
        }
      : null,
    uploads: uploads
      ? {
          inflight: num(uploads.inflight),
          inflightMax: num(uploads.inflight_max),
          parsing: num(uploads.parsing),
          waitingToParse: num(uploads.waiting_to_parse),
        }
      : null,
    process: {
      rssBytes: num(proc.rss_bytes),
      heapUsedBytes: num(proc.heap_used_bytes),
      eventLoopDelayMs: loop
        ? { mean: num(loop.mean), p95: num(loop.p95), max: num(loop.max) }
        : null,
    },
  };
}

// --- Docker -----------------------------------------------------------------------------------

/** `docker ps --format '{{json .}}'`: one JSON object per line. Returns short ids only. */
export function parseDockerPs(text) {
  const rows = [];
  for (const line of String(text).split('\n')) {
    if (!line.trim()) continue;
    const row = parseJson(line, 'docker ps');
    if (!isObject(row) || typeof row.ID !== 'string' || !/^[a-f0-9]{12,64}$/.test(row.ID)) {
      throw shapeError('docker ps');
    }
    rows.push(row.ID);
  }
  return rows;
}

const HEALTH = new Set(['healthy', 'unhealthy', 'starting']);

/**
 * One container from the fixed inspect format. `startedAt` is turned into an uptime so the
 * dashboard never needs a clock comparison of its own.
 */
export function parseDockerInspect(text, now = Date.now()) {
  const containers = [];
  for (const line of String(text).split('\n')) {
    if (!line.trim()) continue;
    const row = parseJson(line, 'docker inspect');
    if (!isObject(row) || !isObject(row.state) || !isObject(row.labels)) {
      throw shapeError('docker inspect');
    }
    const service = row.labels['com.docker.compose.service'];
    if (typeof service !== 'string' || !/^[a-z0-9_-]{1,60}$/i.test(service)) continue;

    const started = Date.parse(row.state.StartedAt);
    const running = row.state.Running === true;
    containers.push({
      id: typeof row.id === 'string' ? row.id.slice(0, 12) : null,
      service,
      status:
        typeof row.state.Status === 'string'
          ? redactText(row.state.Status, { max: 30 })
          : 'unknown',
      running,
      // No healthcheck configured shows as null, not as "healthy".
      health: HEALTH.has(row.state.Health?.Status) ? row.state.Health.Status : null,
      restarts: num(row.restarts) ?? 0,
      oomKilled: row.state.OOMKilled === true,
      exitCode: num(row.state.ExitCode),
      uptimeMs:
        running && Number.isFinite(started) && started > 0 ? Math.max(0, now - started) : null,
      memLimitBytes: num(row.mem_limit) > 0 ? row.mem_limit : null,
    });
  }
  return containers;
}

const UNITS = {
  b: 1,
  kb: 1e3,
  mb: 1e6,
  gb: 1e9,
  tb: 1e12,
  kib: 1024,
  mib: 1024 ** 2,
  gib: 1024 ** 3,
  tib: 1024 ** 4,
};

/** "12.3MiB" -> bytes. Null when the text is not a size. */
export function parseSize(text) {
  const match = /^\s*([0-9]+(?:\.[0-9]+)?)\s*([A-Za-z]+)\s*$/.exec(String(text));
  const unit = match ? UNITS[match[2].toLowerCase()] : undefined;
  return match && unit ? Math.round(Number(match[1]) * unit) : null;
}

const percent = (text) => {
  const m = /^\s*([0-9]+(?:\.[0-9]+)?)%\s*$/.exec(String(text));
  return m ? Number(m[1]) : null;
};

/** `docker stats --no-stream --format '{{json .}}'`, keyed by short container id. */
export function parseDockerStats(text) {
  const byId = new Map();
  for (const line of String(text).split('\n')) {
    if (!line.trim()) continue;
    const row = parseJson(line, 'docker stats');
    if (!isObject(row)) throw shapeError('docker stats');
    const id =
      typeof row.ID === 'string'
        ? row.ID.slice(0, 12)
        : typeof row.Container === 'string'
          ? row.Container.slice(0, 12)
          : null;
    if (!id) continue;
    const [used, limit] = String(row.MemUsage ?? '').split('/');
    byId.set(id, {
      cpuPercent: percent(row.CPUPerc),
      memUsedBytes: parseSize(used ?? ''),
      memLimitBytes: parseSize(limit ?? ''),
      memPercent: percent(row.MemPerc),
      pids: Number.isFinite(Number(row.PIDs)) ? Number(row.PIDs) : null,
    });
  }
  return byId;
}
