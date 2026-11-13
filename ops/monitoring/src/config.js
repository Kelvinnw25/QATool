import { isIP } from 'node:net';

/**
 * Monitoring configuration. Every value has a default that works on the owner's PC with the
 * Compose stack from the repository root; every override is a MONITOR_* variable.
 *
 * None of these is a secret. The monitor holds no token. Two ways of running, chosen by MONITOR_MODE:
 *
 *   host       (default) a process on the owner's PC. Loopback only. It reads the backend's private socket
 *              and Apayee's health through `docker compose exec`, and container statistics through the
 *              Docker CLI.
 *   container  the `qatool-monitoring` Compose service. It reads the backend's private socket directly
 *              from a shared read-only volume, gets Apayee's numbers from the backend over that same
 *              socket (so it never holds APAYEE_TOKEN), and has no Docker CLI or Docker socket at all.
 *              It listens on all interfaces INSIDE its container because Compose publishes it on
 *              127.0.0.1 of the host only.
 */

const LOOPBACK_NAMES = new Set(['localhost']);

/** "All interfaces", spelled out once: the only non-loopback bind this tool ever accepts. */
const ALL_INTERFACES = ['0', '0', '0', '0'].join('.');

export function isLoopbackHost(host) {
  if (typeof host !== 'string' || host === '') return false;
  if (LOOPBACK_NAMES.has(host.toLowerCase())) return true;
  if (isIP(host) === 4) return host.startsWith('127.');
  if (isIP(host) === 6) return host === '::1';
  return false;
}

function integer(env, name, fallback, { min, max }) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be a whole number from ${min} to ${max}.`);
  }
  return value;
}

function httpUrl(env, name, fallback) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${name} must be an http(s) URL.`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(`${name} must be an http(s) URL.`);
  }
  if (url.username || url.password) throw new Error(`${name} must not contain credentials.`);
  // Origin only: a path or query could carry a token, and nothing here needs one.
  return url.origin;
}

/** An absolute, normalised POSIX path to a *.sock file. */
function socketPath(env, name, fallback) {
  const value = env[name] ?? fallback;
  const ok =
    typeof value === 'string' &&
    value.startsWith('/') &&
    !value.includes('//') &&
    !value.split('/').includes('..') &&
    /^[A-Za-z0-9._/-]+\.sock$/.test(value);
  if (!ok) throw new Error(`${name} must be an absolute path to a .sock file.`);
  return value;
}

/** An absolute, normalised POSIX path to any file, or null when unset. */
function absolutePath(env, name) {
  const value = env[name];
  if (value === undefined || value === '') return null;
  const ok =
    value.startsWith('/') &&
    !value.includes('//') &&
    !value.split('/').includes('..') &&
    /^[A-Za-z0-9._/-]+$/.test(value);
  if (!ok) throw new Error(`${name} must be an absolute path.`);
  return value;
}

/**
 * @param {Record<string, string | undefined>} [env]
 * @param {{ platform?: NodeJS.Platform }} [options]
 */
export function loadConfig(env = process.env, { platform = process.platform } = {}) {
  const mode = env.MONITOR_MODE ?? 'host';
  if (!['host', 'container'].includes(mode)) {
    throw new Error('MONITOR_MODE must be "host" or "container".');
  }
  const container = mode === 'container';

  const host = env.MONITOR_HOST ?? (container ? ALL_INTERFACES : '127.0.0.1');
  if (container) {
    // Inside the container the service must be reachable from the Docker network, so it listens on all
    // interfaces; compose.yaml publishes it on the host's loopback address only. Nothing else is allowed.
    if (host !== ALL_INTERFACES && !isLoopbackHost(host)) {
      throw new Error(
        'In container mode MONITOR_HOST must be the all-interfaces address or a loopback address.'
      );
    }
  } else if (!isLoopbackHost(host)) {
    // The one hard rule of host mode. There is no flag to relax it.
    throw new Error(
      'MONITOR_HOST must be a loopback address (127.0.0.1, ::1 or localhost). ' +
        'The dashboard is for the owner only and is never bound to a network interface.'
    );
  }

  const port = integer(env, 'MONITOR_PORT', 3300, { min: 1024, max: 65535 });
  const pollMs = integer(env, 'MONITOR_POLL_MS', 4000, { min: 3000, max: 5000 });

  // Where the job metrics come from:
  //   none         nowhere (the default)
  //   socket       connect directly to the backend's private Unix socket file (the container's way)
  //   docker-exec  run the fixed reader inside the backend container with `docker compose exec`, which
  //                reads that same socket there (the host's way). "docker-socket" was its earlier name and
  //                is still accepted, but it suggests the Docker daemon socket, which is never touched.
  const requestedSource = env.MONITOR_JOBS_SOURCE ?? 'none';
  if (!['none', 'socket', 'docker-exec', 'docker-socket'].includes(requestedSource)) {
    throw new Error('MONITOR_JOBS_SOURCE must be "none", "socket" or "docker-exec".');
  }
  const jobsSource = requestedSource === 'docker-socket' ? 'docker-exec' : requestedSource;
  if (container && jobsSource === 'docker-exec') {
    throw new Error('Container mode has no Docker CLI: use MONITOR_JOBS_SOURCE=socket.');
  }
  if (jobsSource === 'socket' && platform === 'win32') {
    throw new Error(
      'MONITOR_JOBS_SOURCE=socket needs Unix sockets, which Windows does not have: run the ' +
        'qatool-monitoring container, or use docker-exec.'
    );
  }

  return Object.freeze({
    mode,
    host,
    port,
    // The port the owner types in the browser. Equal to `port` on the host; in a container it is the
    // loopback port Compose publishes, and it is what the Host and Origin checks must expect.
    publicPort: integer(env, 'MONITOR_PUBLIC_PORT', port, { min: 1024, max: 65535 }),
    pollMs,
    // A reading older than this many polls is shown as stale, not as current.
    staleAfterMs: pollMs * 3,
    adapterTimeoutMs: integer(env, 'MONITOR_ADAPTER_TIMEOUT_MS', 3000, { min: 500, max: 10_000 }),
    historyPoints: integer(env, 'MONITOR_HISTORY_POINTS', 180, { min: 10, max: 2000 }),
    eventLimit: integer(env, 'MONITOR_EVENT_LIMIT', 200, { min: 10, max: 2000 }),
    // Host: published on the loopback by compose.yaml ('127.0.0.1:3001:3001'). Container: the backend's
    // address on the monitoring network (only /healthz is ever requested).
    backendUrl: httpUrl(
      env,
      'MONITOR_BACKEND_URL',
      container ? 'http://qatool-backend:3001' : 'http://127.0.0.1:3001'
    ),
    // The Vercel page and the Quick Tunnel address are public, but the tunnel's changes on every
    // restart, so neither has a default: an unset one is reported as "not configured".
    frontendUrl: httpUrl(env, 'MONITOR_FRONTEND_URL', null),
    tunnelUrl: httpUrl(env, 'MONITOR_TUNNEL_URL', null),
    // A file holding the current tunnel address, maintained by scripts/start-qatool.ps1 and mounted
    // read-only. Used when MONITOR_TUNNEL_URL is not set.
    tunnelUrlFile: absolutePath(env, 'MONITOR_TUNNEL_URL_FILE'),
    composeProject: env.MONITOR_COMPOSE_PROJECT ?? 'qatool',
    // Directory holding compose.yaml; only needed when the monitor is started from elsewhere.
    composeDir: env.MONITOR_COMPOSE_DIR ?? null,
    jobsSource,
    // Apayee is read through the same private socket in a container (the backend holds the token) and
    // through `docker compose exec` on the host.
    apayeeSource: container ? (jobsSource === 'socket' ? 'socket' : 'none') : 'docker-exec',
    metricsSocket: socketPath(env, 'MONITOR_METRICS_SOCKET', '/run/qatool-ops/metrics.sock'),
    // What a container cannot see: Docker's statistics (no Docker API) and the owner's process list.
    dockerStats: !container,
    tunnelProcessCheck: !container,
    dockerBin: env.MONITOR_DOCKER_BIN ?? 'docker',
  });
}
