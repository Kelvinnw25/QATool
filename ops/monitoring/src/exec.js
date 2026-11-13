import { execFile } from 'node:child_process';

/**
 * The only way the monitor runs another program, and only the Docker CLI and the process
 * listing.
 *
 * Read-only by construction, not by convention: a command is allowed only if its argument
 * list matches one of the shapes below. Nothing a browser sends, and nothing read from a
 * monitored system, is ever placed in an argument. There is no shell (`execFile`), so no
 * quoting rules to get wrong, and every call has a timeout and an output cap.
 */

const MAX_OUTPUT_BYTES = 512 * 1024;

/** Fixed script run inside the Apayee container. It prints Apayee's own health body, nothing else. */
export const APAYEE_HEALTH_SCRIPT =
  "const h={};if(process.env.APAYEE_AUTH_TOKEN)h.Authorization='Bearer '+process.env.APAYEE_AUTH_TOKEN;" +
  "fetch('http://127.0.0.1:4100/v1/health',{headers:h}).then(r=>r.text()).then(t=>process.stdout.write(t))" +
  '.catch(()=>process.exit(1))';

/**
 * The fixed reader inside the QATOOL backend image (server/ops/read-metrics.js). The Dockerfile's
 * WORKDIR is /app and it copies `server/` to ./server, so this is its absolute path. The reader takes
 * no arguments and reads only OPS_METRICS_SOCKET from its own environment; it connects to that private
 * Unix socket, asks `GET /snapshot`, and prints the sanitized JSON. It is the only command the monitor
 * may run in the backend container.
 *
 * This is `docker compose exec` talking to a socket FILE inside the container. It is not the Docker
 * daemon socket, and nothing here mounts that.
 */
export const BACKEND_READER_PATH = '/app/server/ops/read-metrics.js';

/**
 * What `docker inspect` is asked to print. Deliberately not `{{json .}}`: that includes
 * `Config.Env`, which holds the values of the env files (every secret in this stack). This
 * template names the few fields the dashboard shows, so a secret never reaches the monitor.
 */
export const INSPECT_FORMAT =
  '{"id":{{json .Id}},"state":{{json .State}},"restarts":{{json .RestartCount}},' +
  '"labels":{{json .Config.Labels}},"mem_limit":{{json .HostConfig.Memory}}}';

const PROJECT = /^[a-z0-9][a-z0-9_-]*$/;

/**
 * Returns true only for an argument list this tool is meant to run.
 *
 * @param {string[]} args  arguments after the docker binary
 */
export function isAllowedDockerCommand(args) {
  if (!Array.isArray(args) || args.some((a) => typeof a !== 'string' || a.includes('\0'))) {
    return false;
  }
  const [first, ...rest] = args;

  // docker ps -a --filter label=com.docker.compose.project=<p> --format {{json .}}
  // (`ps` output has no environment, only names, state and labels.)
  if (first === 'ps') {
    return (
      rest.length === 5 &&
      rest[0] === '-a' &&
      rest[1] === '--filter' &&
      /^label=com\.docker\.compose\.project=/.test(rest[2]) &&
      PROJECT.test(rest[2].split('=')[2]) &&
      rest[3] === '--format' &&
      rest[4] === '{{json .}}'
    );
  }

  // docker inspect --format <INSPECT_FORMAT> <container ids>
  if (first === 'inspect') {
    return (
      rest[0] === '--format' &&
      rest[1] === INSPECT_FORMAT &&
      rest.length >= 3 &&
      rest.slice(2).every((id) => /^[a-f0-9]{12,64}$/.test(id))
    );
  }

  // docker stats --no-stream --format {{json .}} <container ids>
  if (first === 'stats') {
    return (
      rest[0] === '--no-stream' &&
      rest[1] === '--format' &&
      rest[2] === '{{json .}}' &&
      rest.length >= 4 &&
      rest.slice(3).every((id) => /^[a-f0-9]{12,64}$/.test(id))
    );
  }

  // docker compose [--project-directory <dir>] -p <p> exec -T <service> node <exactly one of two fixed things>:
  //   apayee          -e <APAYEE_HEALTH_SCRIPT>
  //   qatool-backend  <BACKEND_READER_PATH>
  if (first === 'compose') {
    let index = 0;
    if (rest[index] === '--project-directory') index += 2;
    if (rest[index] !== '-p' || !PROJECT.test(rest[index + 1] ?? '')) return false;
    const [verb, noTty, service, node, ...program] = rest.slice(index + 2);
    if (verb !== 'exec' || noTty !== '-T' || node !== 'node') return false;
    if (service === 'apayee') {
      return program.length === 2 && program[0] === '-e' && program[1] === APAYEE_HEALTH_SCRIPT;
    }
    if (service === 'qatool-backend') {
      return program.length === 1 && program[0] === BACKEND_READER_PATH;
    }
    return false;
  }

  return false;
}

function run(file, args, { timeoutMs, signal }) {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { timeout: timeoutMs, maxBuffer: MAX_OUTPUT_BYTES, windowsHide: true, signal },
      (error, stdout) => {
        if (error) {
          const failure = new Error(
            error.killed || error.code === 'ETIMEDOUT'
              ? 'command timed out'
              : error.code === 'ENOENT'
                ? 'command not found'
                : 'command failed'
          );
          // `code` is always a string (the dashboard shows it); a process exit status is kept apart.
          failure.code =
            error.killed || error.code === 'ETIMEDOUT'
              ? 'TIMEOUT'
              : error.code === 'ENOENT'
                ? 'NOT_FOUND'
                : 'FAILED';
          failure.exitStatus = typeof error.code === 'number' ? error.code : null;
          reject(failure);
          return;
        }
        resolve(String(stdout));
      }
    );
  });
}

/**
 * @param {string} dockerBin
 * @param {string[]} args
 * @param {{ timeoutMs: number, signal?: AbortSignal }} options
 */
export async function runDocker(dockerBin, args, options) {
  if (!isAllowedDockerCommand(args)) {
    const error = new Error('command not allowed');
    error.code = 'NOT_ALLOWED';
    throw error;
  }
  return run(dockerBin, args, options);
}

/** `tasklist` (Windows) or `pgrep` (elsewhere) for one fixed process name. Names only, no arguments. */
export async function isProcessRunning(name, { timeoutMs, platform = process.platform } = {}) {
  if (!/^[A-Za-z0-9_.-]+$/.test(name)) throw new Error('bad process name');
  if (platform === 'win32') {
    const out = await run('tasklist', ['/FI', `IMAGENAME eq ${name}.exe`, '/FO', 'CSV', '/NH'], {
      timeoutMs,
    });
    return out.toLowerCase().includes(`"${name.toLowerCase()}.exe"`);
  }
  try {
    await run('pgrep', ['-x', name], { timeoutMs });
    return true;
  } catch (error) {
    if (error.exitStatus === 1) return false; // pgrep: no match
    throw error;
  }
}
