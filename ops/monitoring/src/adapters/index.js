import {
  APAYEE_HEALTH_SCRIPT,
  BACKEND_READER_PATH,
  isProcessRunning as defaultProcessCheck,
  runDocker as defaultRunDocker,
} from '../exec.js';
import { readFile as defaultReadFile } from 'node:fs/promises';

import { Unavailable } from '../errors.js';
import { probe } from './http.js';
import { readSocket as defaultReadSocket } from './socket.js';
import {
  parseApayeeBridge,
  parseApayeeHealth,
  parseDockerInspect,
  parseDockerPs,
  parseDockerStats,
  parseJobMetrics,
} from './parse.js';
import { INSPECT_FORMAT } from '../exec.js';

/**
 * Turns a failed run of the backend's metrics reader into a plain, specific error. The exit codes are
 * the reader's own contract (server/ops/read-metrics.js); any other failure (Docker stopped, the
 * container not running, an image built before the reader existed) stays a generic `FAILED`.
 */
export function readerFailure(error) {
  switch (error?.exitStatus) {
    case 2:
      return new Unavailable(
        'NO_SOURCE',
        'The backend has its metrics socket switched off. Set OPS_METRICS_SOCKET in its .env and recreate the container (see ops/monitoring/README.md).'
      );
    case 3:
      return Object.assign(
        new Error('The backend is running but its metrics socket is not reachable.'),
        {
          code: 'SOCKET_UNREACHABLE',
        }
      );
    case 4:
      return Object.assign(
        new Error('The backend answered with something that is not a valid snapshot.'),
        {
          code: 'BAD_SNAPSHOT',
        }
      );
    case 5:
      return Object.assign(new Error('The backend metrics socket did not answer in time.'), {
        code: 'SOCKET_TIMEOUT',
      });
    default:
      return error;
  }
}

/**
 * The adapters. Each is `{ name, timeoutMs, collect() }`; `collect` returns plain data or
 * throws. None of them writes anything to a monitored system, and none keeps state.
 *
 * Everything that reaches outside the process (HTTP, the Docker CLI, the process list) is
 * injected, so the tests run with none of it.
 *
 * @param {ReturnType<import('../config.js').loadConfig>} config
 * @param {object} [io]
 */
export function createAdapters(
  config,
  {
    fetchImpl = fetch,
    runDocker = defaultRunDocker,
    isProcessRunning = defaultProcessCheck,
    readSocket = defaultReadSocket,
    readFile = defaultReadFile,
    now = Date.now,
  } = {}
) {
  const t = config.adapterTimeoutMs;

  /**
   * The tunnel address from the file the start script maintains, or null. Strictly an https origin with
   * nothing else in it; anything odd (missing, empty, a path, credentials, http) is "no address".
   */
  async function readTunnelFile() {
    if (!config.tunnelUrlFile) return null;
    try {
      const text = String(await readFile(config.tunnelUrlFile, 'utf8'))
        .slice(0, 512)
        .trim();
      const url = new URL(text);
      const plain = url.protocol === 'https:' && !url.username && !url.password;
      return plain && url.origin === text ? url.origin : null;
    } catch {
      return null;
    }
  }
  const docker = (args, timeoutMs = t) => runDocker(config.dockerBin, args, { timeoutMs });
  /** `docker compose exec -T <service> node <program...>`; exec.js decides whether it may run. */
  const composeArgs = (service, ...program) => [
    'compose',
    ...(config.composeDir ? ['--project-directory', config.composeDir] : []),
    '-p',
    config.composeProject,
    'exec',
    '-T',
    service,
    'node',
    ...program,
  ];

  return [
    {
      // The QATOOL API on the loopback port compose publishes. /healthz is the one route that
      // needs no credentials and says nothing about the system, so this proves "answers".
      name: 'backend',
      timeoutMs: t,
      async collect() {
        const r = await probe(`${config.backendUrl}/healthz`, {
          timeoutMs: t,
          fetchImpl,
          now,
          readJson: true,
        });
        return {
          healthy: r.status === 200 && r.json?.status === 'ok',
          httpStatus: r.status,
          latencyMs: r.latencyMs,
        };
      },
    },
    {
      name: 'frontend',
      timeoutMs: t,
      async collect() {
        if (!config.frontendUrl) {
          throw new Unavailable(
            'NOT_CONFIGURED',
            'Set MONITOR_FRONTEND_URL to check the Vercel page.'
          );
        }
        const r = await probe(`${config.frontendUrl}/`, { timeoutMs: t, fetchImpl, now });
        return { healthy: r.ok, httpStatus: r.status, latencyMs: r.latencyMs };
      },
    },
    {
      // Two independent facts, reported separately: is cloudflared running on this PC, and does
      // the public Quick Tunnel address reach the backend's /healthz from here.
      name: 'tunnel',
      timeoutMs: t * 2,
      async collect() {
        // A container sees only its own processes, so there "is cloudflared running" cannot be asked,
        // and the public address is the only evidence.
        let processRunning = null;
        if (config.tunnelProcessCheck) {
          try {
            processRunning = await isProcessRunning('cloudflared', { timeoutMs: t });
          } catch {
            processRunning = null; // could not tell; shown as unknown, not as stopped
          }
        }

        // The address: set in the configuration, or the verified current one that the start script wrote to a
        // file this container mounts read-only (read again on every poll, so a new tunnel needs no restart).
        const tunnelUrl = config.tunnelUrl ?? (await readTunnelFile());

        let pub = null;
        if (tunnelUrl) {
          try {
            const r = await probe(`${tunnelUrl}/healthz`, {
              timeoutMs: t,
              fetchImpl,
              now,
              readJson: true,
            });
            pub = {
              healthy: r.status === 200 && r.json?.status === 'ok',
              httpStatus: r.status,
              latencyMs: r.latencyMs,
            };
          } catch (error) {
            pub = {
              healthy: false,
              httpStatus: null,
              latencyMs: null,
              error: error.code ?? 'FAILED',
            };
          }
        }

        if (processRunning === null && pub === null) {
          throw new Unavailable(
            'NOT_CONFIGURED',
            config.tunnelProcessCheck
              ? 'Cannot see the cloudflared process and no tunnel address is set.'
              : config.tunnelUrlFile
                ? 'No tunnel address yet. Start the stack with scripts/start-qatool.ps1, which verifies a tunnel and records its address.'
                : 'No tunnel address is set. Set MONITOR_TUNNEL_URL to check the Cloudflare Tunnel.'
          );
        }
        return {
          processRunning,
          public: pub,
          publicConfigured: Boolean(tunnelUrl),
          healthy: processRunning !== false && (pub ? pub.healthy : true),
        };
      },
    },
    {
      // Asked from inside the Apayee container with a fixed script, so the token never leaves it.
      name: 'apayee',
      timeoutMs: t * 2,
      async collect() {
        if (config.apayeeSource === 'none') {
          throw new Unavailable(
            'NO_SOURCE',
            'Apayee is read through the backend socket, which is switched off (MONITOR_JOBS_SOURCE is not "socket").'
          );
        }
        if (config.apayeeSource === 'socket') {
          // The backend holds the token and asks the gateway; the monitor only hears the numbers.
          const view = parseApayeeBridge(
            await readSocket(config.metricsSocket, '/apayee', { timeoutMs: t * 2 })
          );
          return { ...view, healthy: view.status === 'ok' && view.providerReady };
        }
        const out = await docker(composeArgs('apayee', '-e', APAYEE_HEALTH_SCRIPT), t * 2);
        const health = parseApayeeHealth(out);
        return { ...health, healthy: health.status === 'ok' && health.providerReady };
      },
    },
    {
      name: 'docker',
      timeoutMs: t * 3,
      async collect() {
        if (!config.dockerStats) {
          throw new Unavailable(
            'NO_SOURCE',
            'Container CPU, memory, restarts and uptime need the Docker API, which this container deliberately cannot reach (no Docker socket). Health and connectivity are shown instead.'
          );
        }
        const ids = parseDockerPs(
          await docker(
            [
              'ps',
              '-a',
              '--filter',
              `label=com.docker.compose.project=${config.composeProject}`,
              '--format',
              '{{json .}}',
            ],
            t
          )
        );
        if (ids.length === 0) {
          throw new Unavailable('NO_SOURCE', 'No containers found for this Compose project.');
        }
        const containers = parseDockerInspect(
          await docker(['inspect', '--format', INSPECT_FORMAT, ...ids], t),
          now()
        );

        // CPU and memory come from a separate, slower call. If it fails, the container list
        // above is still good, and the failure is reported rather than hidden.
        let resourcesError = null;
        let stats = new Map();
        try {
          stats = parseDockerStats(
            await docker(['stats', '--no-stream', '--format', '{{json .}}', ...ids], t * 2)
          );
        } catch (error) {
          resourcesError = error.code ?? 'FAILED';
        }
        return {
          resourcesError,
          containers: containers.map((c) => ({ ...c, resources: stats.get(c.id) ?? null })),
        };
      },
    },
    {
      // QATOOL's own job and queue numbers. They exist only inside the backend process; no route
      // serves them (server/jobs/metrics.js). The backend can publish them on a private Unix socket
      // inside its container (OPS_METRICS_SOCKET, server/ops/), and the fixed reader there prints
      // them. Every state in which that does not work is reported as what it is, never as zero jobs.
      name: 'jobs',
      timeoutMs: t * 2,
      async collect() {
        if (config.jobsSource === 'none') {
          throw new Unavailable(
            'NO_SOURCE',
            'Job metrics are switched off in the monitor. Set MONITOR_JOBS_SOURCE=socket (container) or docker-exec (host); see ops/monitoring/README.md.'
          );
        }

        let out;
        if (config.jobsSource === 'socket') {
          out = await readSocket(config.metricsSocket, '/snapshot', { timeoutMs: t * 2 });
        } else {
          try {
            out = await docker(composeArgs('qatool-backend', BACKEND_READER_PATH), t * 2);
          } catch (error) {
            // The reader's exit status says which step failed (server/ops/read-metrics.js).
            throw readerFailure(error);
          }
        }

        try {
          return parseJobMetrics(out);
        } catch (error) {
          if (error.code === 'NO_JOB_PLATFORM') {
            throw new Unavailable(
              'NO_SOURCE',
              'The backend is running without the job platform (PUBLIC_DEMO is off), so it has no job metrics.'
            );
          }
          throw error;
        }
      },
    },
  ];
}
