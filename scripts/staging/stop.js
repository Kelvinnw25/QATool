import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { STAGING } from './config.js';
import { createDocker } from './docker.js';
import { redact } from './redact.js';
import { createRunner } from './shell.js';

/**
 * Stops the staging stack on purpose: `docker compose stop`, nothing else.
 *
 * `stop` keeps the containers, the networks and every volume (including the Claude sign-in), and leaves
 * `.env`, the Vercel link and the state in `.qatool-local/` exactly as they are. There is no `down`, no
 * `-v`, no `rm`, no `prune` anywhere in this file, and docker.js refuses them if one were ever added.
 *
 * `--tunnel-only` stops just the public tunnel: the page on Vercel then says the demo cannot be reached,
 * while the local stack and the dashboard keep running.
 *
 * @param {{ docker: ReturnType<typeof createDocker>, log: { ok: Function, info: Function, warn: Function } }} deps
 * @param {{ tunnelOnly?: boolean }} [options]
 */
export async function stopStaging({ docker, log }, { tunnelOnly = false } = {}) {
  if (!(await docker.engineRunning())) {
    log.warn('Docker Engine is not running, so there is nothing running to stop.');
    return { stopped: [], engineRunning: false };
  }
  const services = tunnelOnly ? [STAGING.services.tunnel] : [];
  await docker.stop(services);
  const stopped = tunnelOnly ? services : ['all services of this project'];
  log.ok(`stopped: ${stopped.join(', ')}`);
  log.info(
    'containers, networks and volumes were kept; .env, the Vercel link and .qatool-local/ were not touched'
  );
  return { stopped, engineRunning: true };
}

export async function main(argv = process.argv.slice(2)) {
  const known = new Set(['--tunnel-only']);
  const unknown = argv.filter((a) => !known.has(a));
  if (unknown.length > 0) {
    process.stderr.write(`Unknown option: ${unknown.join(' ')}\nOptions: --tunnel-only\n`);
    return 2;
  }
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const out = (line) => process.stdout.write(`${redact(line)}\n`);
  const log = {
    ok: (m) => out(`  OK    ${m}`),
    info: (m) => out(`  ..    ${m}`),
    warn: (m) => out(`  WARN  ${m}`),
  };
  try {
    const docker = createDocker({ run: createRunner({ cwd: root }) });
    await stopStaging({ docker, log }, { tunnelOnly: argv.includes('--tunnel-only') });
    return 0;
  } catch (error) {
    process.stderr.write(
      `${redact(`FAILED: ${error.message}${error.detail ? `\n${error.detail}` : ''}`)}\n`
    );
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => process.exit(code));
}
