import { STAGING } from './config.js';
import { extractTunnelUrl } from './tunnel-url.js';
import { tail } from './redact.js';

/**
 * The few Docker Compose operations the start and stop scripts use. Each one is a fixed argument list, run
 * through the injected `run`, so the tests replace it and nothing here can build a command from outside data.
 *
 * What is NOT here, on purpose: `down`, `rm`, `volume`, `prune`, `system`, `kill`, and any `exec` that runs
 * anything but `printenv <fixed name>`. `safeCompose` is the single door, and refuses a verb not on its list.
 */

const ALLOWED_VERBS = new Set(['up', 'stop', 'ps', 'logs', 'exec']);
const SERVICE = /^[a-z][a-z0-9-]*$/;
const ENV_NAME = /^[A-Z][A-Z0-9_]*$/;

/**
 * @param {object} options
 * @param {import('./shell.js').createRunner extends (...a: any) => infer R ? R : never} options.run
 * @param {number} [options.commandMs]
 * @param {(ms: number) => Promise<void>} [options.sleep]
 * @param {() => number} [options.now]
 */
export function createDocker({
  run,
  commandMs = STAGING.timeouts.commandMs,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  now = Date.now,
}) {
  /** `docker compose <verb> ...`, with the verb checked. */
  function safeCompose(args, options) {
    if (!ALLOWED_VERBS.has(args[0]))
      throw new Error(`docker compose ${args[0]} is not permitted here`);
    if (args.some((a) => a === '-v' || a === '--volumes' || a === '--rmi')) {
      throw new Error('removing volumes or images is not permitted here');
    }
    return run('docker', ['compose', ...args], { timeoutMs: commandMs, ...options });
  }

  function failure(result, what) {
    const reason = result.timedOut
      ? 'timed out'
      : result.missing
        ? 'docker was not found'
        : `exit ${result.code}`;
    const error = new Error(`${what} failed (${reason}).`);
    error.detail = tail(`${result.stdout}\n${result.stderr}`);
    return error;
  }

  /** @returns {Promise<{ exists: boolean, running: boolean, health: string | null, id: string | null }>} */
  async function serviceState(service) {
    if (!SERVICE.test(service)) throw new Error('bad service name');
    const result = await safeCompose(['ps', '-a', '--format', 'json', service]);
    if (result.code !== 0) throw failure(result, 'docker compose ps');
    const rows = result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.startsWith('{') || line.startsWith('['))
      .flatMap((line) => {
        try {
          const value = JSON.parse(line);
          return Array.isArray(value) ? value : [value];
        } catch {
          return [];
        }
      })
      .filter((row) => row.Service === service);
    const row = rows[0];
    if (!row) return { exists: false, running: false, health: null, id: null };
    return {
      exists: true,
      running: row.State === 'running',
      health: row.Health ? String(row.Health) : null,
      id: typeof row.ID === 'string' ? row.ID.slice(0, 12) : null,
    };
  }

  return {
    /** Is the Docker Engine answering? */
    async engineRunning() {
      const result = await run('docker', ['info', '--format', '{{.ServerVersion}}'], {
        timeoutMs: 30_000,
      });
      return result.code === 0 && result.stdout.trim() !== '';
    },

    serviceState,

    /** `docker compose up -d`: starts what is stopped or missing and recreates only what changed. */
    async up() {
      const result = await safeCompose(['up', '-d'], { timeoutMs: 600_000 });
      if (result.code !== 0) throw failure(result, 'docker compose up -d');
    },

    /** Waits until every named service is healthy (or running, if it has no health check). */
    async waitHealthy(
      services,
      { timeoutMs = STAGING.timeouts.healthyMs, intervalMs = 2000 } = {}
    ) {
      const deadline = now() + timeoutMs;
      let last = {};
      for (;;) {
        last = {};
        for (const service of services) last[service] = await serviceState(service);
        const bad = services.filter((s) => {
          const st = last[s];
          return !st.exists || !st.running || (st.health !== null && st.health !== 'healthy');
        });
        if (bad.length === 0) return;
        if (now() >= deadline) {
          const error = new Error(
            `Not healthy in time: ${bad.map((s) => `${s} (${last[s].running ? (last[s].health ?? 'running') : 'not running'})`).join(', ')}.`
          );
          throw error;
        }
        await sleep(intervalMs);
      }
    },

    /** One environment variable of a running container, or null if it is not set. Only names asked for. */
    async containerEnv(service, name) {
      if (!SERVICE.test(service) || !ENV_NAME.test(name))
        throw new Error('bad service or variable name');
      const result = await safeCompose(['exec', '-T', service, 'printenv', name], {
        timeoutMs: 30_000,
      });
      if (result.code === 0) return result.stdout.replace(/\r?\n$/, '');
      if (result.code === 1 && result.stdout === '') return null;
      throw failure(result, `reading ${name} in ${service}`);
    },

    /** The newest Quick Tunnel address in the tunnel container's log, or null. */
    async tunnelLogUrl() {
      const result = await safeCompose(
        ['logs', '--no-log-prefix', '--no-color', STAGING.services.tunnel],
        {
          timeoutMs: 30_000,
        }
      );
      if (result.code !== 0) return null;
      return extractTunnelUrl(`${result.stdout}\n${result.stderr}`);
    },

    /** A new tunnel container (so a new address and a fresh log), and nothing else recreated. */
    async recreateTunnel() {
      const result = await safeCompose([
        'up',
        '-d',
        '--force-recreate',
        '--no-deps',
        STAGING.services.tunnel,
      ]);
      if (result.code !== 0) throw failure(result, 'recreating the tunnel');
    },

    /** `docker compose stop [services...]`. Containers, networks and volumes all stay. */
    async stop(services = []) {
      for (const s of services) if (!SERVICE.test(s)) throw new Error('bad service name');
      const result = await safeCompose(['stop', ...services], { timeoutMs: 180_000 });
      if (result.code !== 0) throw failure(result, 'docker compose stop');
    },
  };
}
