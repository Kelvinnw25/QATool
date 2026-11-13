import { STAGING } from './config.js';

/**
 * The staging concurrency policy. The applications allow 1-3 (JOB_WORKERS, APAYEE_MAX_CONCURRENT); this
 * tooling only starts a public tunnel in front of 1 or 2, and only when both ends agree, because the jobs
 * that really run at once are min(JOB_WORKERS, Apayee max_active): a mismatch means one of the two numbers
 * is not what its owner thinks it is. An unset variable is the applications' own default, 1.
 */

const WHOLE = /^[0-9]{1,3}$/;

function readCount(raw, name, problems) {
  if (raw === null || raw === undefined || raw === '') return 1;
  const text = String(raw).trim();
  if (!WHOLE.test(text)) {
    problems.push(`${name} is not a whole number`);
    return null;
  }
  const value = Number(text);
  if (value < 1 || value > STAGING.maxConcurrency) {
    problems.push(`${name} must be between 1 and ${STAGING.maxConcurrency} for staging`);
    return null;
  }
  return value;
}

/**
 * @param {{ workers: string | null, gateway: string | null }} configured  the running containers' values
 * @returns {{ problems: string[], workers: number | null, gateway: number | null, ceiling: number | null }}
 */
export function assessConcurrency({ workers, gateway }) {
  const problems = [];
  const w = readCount(workers, 'JOB_WORKERS', problems);
  const g = readCount(gateway, 'APAYEE_MAX_CONCURRENT', problems);
  if (w !== null && g !== null && w !== g) {
    problems.push(
      `JOB_WORKERS (${w}) and APAYEE_MAX_CONCURRENT (${g}) differ; set both to the same value (1 or ${STAGING.maxConcurrency})`
    );
  }
  const ceiling = w !== null && g !== null ? Math.min(w, g) : null;
  return { problems, workers: w, gateway: g, ceiling };
}

/**
 * What the dashboard reports from the live backend and gateway: configured workers, effective workers and the
 * gateway's `max_active`. Read from the dashboard (no token needed); null when it cannot be read.
 *
 * @returns {Promise<{ configured: number, effective: number, maxActive: number | null } | null>}
 */
export async function readDashboardCapacity({ fetchImpl, url = STAGING.dashboardUrl }) {
  try {
    const response = await fetchImpl(`${url}/api/status`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(5000),
    });
    if (response.status !== 200) return null;
    const body = await response.json();
    const q = body?.capacity?.qatool;
    const a = body?.capacity?.apayee;
    const whole = (v) => (Number.isSafeInteger(v) && v >= 0 ? v : null);
    if (whole(q?.workersConfigured) === null || whole(q?.workersEffective) === null) return null;
    return {
      configured: q.workersConfigured,
      effective: q.workersEffective,
      maxActive: whole(a?.maxActive),
    };
  } catch {
    return null;
  }
}
