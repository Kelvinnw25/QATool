import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { assessConcurrency, readDashboardCapacity } from './concurrency.js';
import { STAGING } from './config.js';
import { createDocker } from './docker.js';
import { isOn, peerListCovers, readSettings } from './envfile.js';
import { redact } from './redact.js';
import { createRunner } from './shell.js';
import { createState } from './state.js';
import { createVercel } from './vercel.js';
import { inspectFrontend, verifyTunnel } from './verify.js';

/**
 * One command to bring public staging up: `scripts/start-qatool.ps1` runs this.
 *
 *   1. Preflight   Docker running; Vercel CLI installed, logged in, linked to exactly `qatool-staging`;
 *                  the backend's settings are the public demo's (never a tunnel to the unauthenticated mode).
 *   2. Stack       `docker compose up -d`; wait for health; check the settings the RUNNING containers hold.
 *   3. Tunnel      reuse the running Quick Tunnel if it works, else make a new one; the address is read from
 *                  cloudflared's log and verified end to end (the backend answers, and refuses what it must).
 *   4. Monitoring  the verified address is written where the dashboard reads it. No container is recreated.
 *   5. Vercel      only if the deployed frontend was built with a different address: set VITE_API_BASE_URL for
 *                  Production, deploy to production, and confirm the live frontend now uses the new address.
 *
 * It never reports success for a step it did not complete: a failure stops the run, names the step, and
 * leaves the last known working state (and the recorded state file) as it was.
 */

export class StepError extends Error {
  /** @param {string} step @param {string} message @param {{ hint?: string, detail?: string }} [more] */
  constructor(step, message, { hint, detail } = {}) {
    super(message);
    this.name = 'StepError';
    this.step = step;
    this.hint = hint;
    this.detail = detail;
  }
}

/** Turns anything thrown into a StepError for `step`, keeping a tool's redacted output as detail. */
function asStepError(step, error) {
  if (error instanceof StepError) return error;
  return new StepError(step, error?.message ?? 'failed', { detail: error?.detail });
}

/**
 * @typedef {object} StartDeps
 * @property {string} root
 * @property {ReturnType<typeof createDocker>} docker
 * @property {ReturnType<typeof createVercel>} vercel
 * @property {ReturnType<typeof createState>} state
 * @property {(url: string, options?: { timeoutMs?: number }) => Promise<import('./verify.js').TunnelVerdict>} verifyTunnel
 * @property {() => Promise<{ reachable: boolean, bases: string[], assets: number }>} inspectFrontend
 * @property {() => Promise<{ configured: number, effective: number, maxActive: number | null } | null>} readCapacity
 * @property {(file: string) => Promise<string>} readText
 * @property {{ step: Function, ok: Function, info: Function, warn: Function }} log
 * @property {(ms: number) => Promise<void>} sleep
 * @property {() => number} now
 */

/**
 * @param {StartDeps} deps
 * @param {{ forceTunnel?: boolean, forceDeploy?: boolean, noDeploy?: boolean }} [options]
 */
export async function startStaging(deps, options = {}) {
  const { root, docker, vercel, state, log, sleep, now } = deps;
  const total = 5;
  const iso = () => new Date(now()).toISOString();
  const summary = {
    tunnelUrl: null,
    tunnelReused: false,
    deployed: false,
    deployNote: '',
    frontendUrl: STAGING.frontendOrigin,
    dashboardUrl: STAGING.dashboardUrl,
  };

  /** Runs one step, labelling any failure with its name. */
  async function step(number, name, fn) {
    log.step(number, total, name);
    try {
      return await fn();
    } catch (error) {
      throw asStepError(name, error);
    }
  }

  // --- 1. Preflight ----------------------------------------------------------------------------------------
  await step(1, 'Preflight', async () => {
    if (!(await docker.engineRunning())) {
      throw new StepError('Preflight', 'Docker Engine is not running.', {
        hint: 'Start Docker Desktop, wait until it says the engine is running, then run this again.',
      });
    }
    log.ok('Docker Engine is running');

    const version = await vercel.version();
    if (!version) {
      throw new StepError('Preflight', 'The Vercel CLI is not installed.', {
        hint: 'Install it: npm i -g vercel',
      });
    }
    let login = await vercel.loginStatus();
    if (login.state === 'error') {
      // A hiccup (network, the Vercel API) is not "logged out": once more before giving up.
      await sleep(3000);
      login = await vercel.loginStatus();
    }
    if (login.state === 'error') {
      throw new StepError(
        'Preflight',
        'Could not confirm the Vercel login: `vercel whoami` failed.',
        {
          detail: login.detail,
          hint: "This is not necessarily a logout. Check this PC's internet connection and run the script again; if it repeats, run: vercel whoami",
        }
      );
    }
    if (login.state === 'logged-out') {
      throw new StepError('Preflight', 'The Vercel CLI is not logged in.', {
        hint: 'Run: vercel login',
      });
    }
    log.ok(`Vercel CLI ${version}, logged in`);

    const linked = await vercel.linkedProject();
    if (linked.name !== STAGING.projectName) {
      throw new StepError(
        'Preflight',
        linked.name
          ? `This folder is linked to the Vercel project "${linked.name}", not "${STAGING.projectName}".`
          : 'This folder is not linked to a Vercel project (.vercel/project.json is missing or has no project name).',
        {
          hint: `Run: vercel link  (choose the existing project ${STAGING.projectName}; do not connect a Git repository)`,
        }
      );
    }
    const inspected = await vercel.inspectProject();
    if (inspected.name !== STAGING.projectName || !linked.id || inspected.id !== linked.id) {
      throw new StepError(
        'Preflight',
        `Vercel does not confirm the linked project as "${STAGING.projectName}" (the link file and Vercel disagree).`,
        { hint: 'Remove the .vercel folder and run: vercel link' }
      );
    }
    log.ok(`Vercel project confirmed: ${STAGING.projectName}`);

    let envText;
    try {
      envText = await deps.readText(path.join(root, '.env'));
    } catch {
      throw new StepError('Preflight', 'The backend .env file was not found.', {
        hint: 'See README.md, "Setup on a new Windows laptop", step 5.',
      });
    }
    const s = readSettings(envText, [
      'PUBLIC_DEMO',
      'PUBLIC_MODE',
      'TRUSTED_PROXY_PEERS',
      'ALLOWED_ORIGINS',
    ]);
    if (!isOn(s.PUBLIC_DEMO) || isOn(s.PUBLIC_MODE)) {
      throw new StepError(
        'Preflight',
        'The backend is not configured as the public demo (PUBLIC_DEMO=true, PUBLIC_MODE off). Not starting a public tunnel.',
        {
          hint: 'Local mode has no authentication: a tunnel to it would hand the model to the internet. Fix .env first.',
        }
      );
    }
    if (!peerListCovers(s.TRUSTED_PROXY_PEERS, STAGING.tunnelPeerIp)) {
      throw new StepError(
        'Preflight',
        `TRUSTED_PROXY_PEERS in .env does not include the tunnel container's address ${STAGING.tunnelPeerIp}.`,
        {
          hint:
            `Add ${STAGING.tunnelPeerIp} to that comma-separated list (for example TRUSTED_PROXY_PEERS=172.18.0.1,${STAGING.tunnelPeerIp}) ` +
            'and run this again. Without it every visitor shares one rate-limit address.',
        }
      );
    }
    if (
      !String(s.ALLOWED_ORIGINS ?? '')
        .split(',')
        .map((o) => o.trim())
        .includes(STAGING.frontendOrigin)
    ) {
      throw new StepError(
        'Preflight',
        `ALLOWED_ORIGINS in .env does not list ${STAGING.frontendOrigin}.`,
        {
          hint: 'Set ALLOWED_ORIGINS to the frontend origin exactly, and run this again.',
        }
      );
    }
    log.ok(
      '.env is the public demo (PUBLIC_DEMO on, the tunnel peer trusted, the frontend origin allowed)'
    );
  });

  // --- 2. Stack --------------------------------------------------------------------------------------------
  await step(2, 'Start the stack', async () => {
    await docker.up();
    await docker.waitHealthy(STAGING.requiredHealthy);
    log.ok(`healthy: ${STAGING.requiredHealthy.join(', ')}`);

    const tunnel = await docker.serviceState(STAGING.services.tunnel);
    if (!tunnel.exists || !tunnel.running) {
      throw new StepError('Start the stack', 'The tunnel container (cloudflared) is not running.', {
        hint: 'docker compose logs cloudflared',
      });
    }

    // What the RUNNING containers hold, not only what the files say. If anything is wrong the tunnel (which
    // `docker compose up -d` has already started) is stopped before anything else happens.
    const problems = [];
    const backend = STAGING.services.backend;
    const demo = await docker.containerEnv(backend, 'PUBLIC_DEMO');
    const mode = await docker.containerEnv(backend, 'PUBLIC_MODE');
    const workers = await docker.containerEnv(backend, 'JOB_WORKERS');
    const peers = await docker.containerEnv(backend, 'TRUSTED_PROXY_PEERS');
    const origins = await docker.containerEnv(backend, 'ALLOWED_ORIGINS');
    const gateway = await docker.containerEnv(STAGING.services.apayee, 'APAYEE_MAX_CONCURRENT');

    if (!isOn(demo)) problems.push('the running backend is not in PUBLIC_DEMO mode');
    if (isOn(mode)) problems.push('the running backend has PUBLIC_MODE on');
    const concurrency = assessConcurrency({ workers, gateway });
    problems.push(...concurrency.problems);

    // What the live backend and gateway report, through the dashboard. The backend only learns the gateway's
    // max_active at its first job admission, so "effective" may read 1 until then; that is not a failure.
    let live = null;
    if (concurrency.ceiling !== null) {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        live = await deps.readCapacity();
        if (live && live.maxActive !== null) break;
        await sleep(3000);
      }
      if (live && live.configured !== concurrency.workers) {
        problems.push(
          `the backend reports ${live.configured} configured workers, but JOB_WORKERS is ${concurrency.workers}`
        );
      }
      if (live && live.maxActive !== null && live.maxActive !== concurrency.gateway) {
        problems.push(
          `the gateway reports max_active ${live.maxActive}, but APAYEE_MAX_CONCURRENT is ${concurrency.gateway}`
        );
      }
    }
    if (!peerListCovers(peers, STAGING.tunnelPeerIp))
      problems.push(
        'the running backend does not trust the tunnel container (recreate it after editing .env)'
      );
    if (
      !String(origins ?? '')
        .split(',')
        .map((o) => o.trim())
        .includes(STAGING.frontendOrigin)
    ) {
      problems.push('the running backend does not allow the frontend origin');
    }

    if (problems.length > 0) {
      await docker.stop([STAGING.services.tunnel]);
      throw new StepError(
        'Start the stack',
        `Unsafe configuration; the tunnel was stopped: ${problems.join('; ')}.`,
        {
          hint: 'Fix .env (and ../Apayee/.env for the gateway), then run: docker compose up -d --no-deps apayee qatool-backend   and start this script again.',
        }
      );
    }
    log.ok(
      `running containers: public demo mode, ${concurrency.workers} worker(s), ${concurrency.gateway} gateway call(s) at a time, tunnel peer trusted`
    );
    if (live && live.maxActive !== null) {
      log.ok(
        `live capacity: ${live.configured} workers configured, gateway max_active ${live.maxActive}, ${live.effective} effective now` +
          (live.effective < concurrency.ceiling
            ? ` (rises to ${concurrency.ceiling} when the first job is admitted)`
            : '')
      );
    } else {
      log.warn(
        'Live worker and gateway capacity could not be read from the dashboard; the configured values above are from the running containers.'
      );
    }
  });

  // --- 3. Tunnel -------------------------------------------------------------------------------------------
  const tunnelUrl = await step(3, 'Tunnel', async () => {
    const saved = await state.read();
    let url = null;
    /** @type {import('./verify.js').TunnelVerdict | null} */
    let verified = null;

    const unsafe = async (verdict, address) => {
      await docker.stop([STAGING.services.tunnel]);
      const failed = verdict.checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`);
      throw new StepError(
        'Tunnel',
        `${address} reaches something that does not behave like the protected demo backend; the tunnel was stopped. ${failed.join('; ')}`,
        {
          hint: 'Check the backend logs and .env (PUBLIC_DEMO, ALLOWED_ORIGINS) before starting a tunnel again.',
        }
      );
    };

    if (!options.forceTunnel) {
      // A tunnel container that has only just started has not connected, or printed its address, yet. Its
      // health check passes once it is connected, so wait for that before judging what is in the log; a
      // tunnel that does not connect in time is handled below like any other that does not work.
      try {
        await docker.waitHealthy([STAGING.services.tunnel], { timeoutMs: 45_000 });
      } catch {
        log.info('the tunnel container is not connected yet');
      }
      const candidate = await docker.tunnelLogUrl();
      if (candidate) {
        // A tunnel already verified in an earlier run only needs a quick check; a new one may still be
        // propagating, so it is given time.
        const known = candidate === saved.tunnelUrl;
        log.info(
          `tunnel found in the log: ${candidate} (${known ? 'verified earlier' : 'not verified yet'})`
        );
        const verdict = await deps.verifyTunnel(candidate, {
          timeoutMs: known ? 20_000 : STAGING.timeouts.tunnelReachableMs,
        });
        if (verdict.ok) {
          url = candidate;
          verified = verdict;
          summary.tunnelReused = true;
          log.ok('reusing the running tunnel');
        } else if (verdict.kind === 'unsafe') {
          await unsafe(verdict, candidate);
        } else {
          log.warn(
            'that tunnel does not answer (expired, or the PC restarted); creating a new one'
          );
        }
      }
    }

    if (!url) {
      await docker.recreateTunnel();
      let fresh = null;
      const deadline = now() + STAGING.timeouts.tunnelLogMs;
      while (!fresh && now() < deadline) {
        fresh = await docker.tunnelLogUrl();
        if (!fresh) await sleep(2000);
      }
      if (!fresh) {
        throw new StepError('Tunnel', 'cloudflared did not print a tunnel address in time.', {
          hint: 'docker compose logs cloudflared   (is this PC online? Quick Tunnels need outbound access to Cloudflare)',
        });
      }
      log.info(`new tunnel: ${fresh}`);
      const verdict = await deps.verifyTunnel(fresh, {
        timeoutMs: STAGING.timeouts.tunnelReachableMs,
      });
      if (!verdict.ok) {
        if (verdict.kind === 'unsafe') await unsafe(verdict, fresh);
        throw new StepError('Tunnel', `The new tunnel ${fresh} did not become reachable.`, {
          detail: verdict.checks
            .map((c) => `${c.ok ? 'ok  ' : 'FAIL'} ${c.name}: ${c.detail}`)
            .join('\n'),
          hint: "Run this script again; if it keeps failing, check this PC's connection and docker compose logs cloudflared.",
        });
      }
      url = fresh;
      verified = verdict;
    }

    for (const check of verified.checks) log.ok(`${check.name}: ${check.detail}`);
    await state.update({ tunnelUrl: url, tunnelVerifiedAt: iso() });
    summary.tunnelUrl = url;
    return url;
  });

  // --- 4. Monitoring ---------------------------------------------------------------------------------------
  await step(4, 'Monitoring', async () => {
    // The dashboard re-reads this file on every poll. Nothing is recreated.
    await state.writeMonitorUrl(tunnelUrl);
    log.ok(`the dashboard will check ${tunnelUrl} (${STAGING.dashboardUrl})`);
  });

  // --- 5. Vercel -------------------------------------------------------------------------------------------
  await step(5, 'Vercel', async () => {
    if (options.noDeploy) {
      summary.deployNote = 'skipped (--no-deploy)';
      log.warn(
        'Vercel synchronisation skipped on request (--no-deploy). The public page may point at an older tunnel.'
      );
      return;
    }

    const saved = await state.read();
    const before = await deps.inspectFrontend();
    const current = before.reachable && before.bases.includes(tunnelUrl);

    if (current && !options.forceDeploy) {
      if (saved.lastDeployedUrl !== tunnelUrl)
        await state.update({ lastDeployedUrl: tunnelUrl, lastDeployedAt: iso() });
      summary.deployNote = 'unchanged: the live frontend already uses this tunnel';
      log.ok('the live frontend is already built with this tunnel address; no deployment needed');
      return;
    }
    if (saved.lastDeployedUrl === tunnelUrl && !current && before.reachable) {
      log.warn(
        'the state file says this address was deployed, but the live frontend does not use it; deploying again'
      );
    }

    // The variable: exactly one, for Production only.
    const rows = await vercel.variableRows().catch((error) => {
      throw new StepError('Vercel environment', error.message, { detail: error.detail });
    });
    if (rows.length > 1) {
      throw new StepError(
        'Vercel environment',
        `${STAGING.envName} exists more than once for Production.`,
        {
          hint: `Remove the duplicates in the Vercel dashboard (Project > Settings > Environment Variables), then run this again.`,
        }
      );
    }
    if (rows.some((row) => row.environments.some((e) => e.toLowerCase() !== STAGING.envTarget))) {
      throw new StepError(
        'Vercel environment',
        `${STAGING.envName} is also set for another environment; updating it would change more than Production. Nothing was changed.`,
        {
          hint: 'Split it in the Vercel dashboard so the Production value stands alone, then run this again.',
        }
      );
    }
    try {
      await vercel.setVariable(tunnelUrl, { exists: rows.length === 1 });
    } catch (error) {
      throw new StepError('Vercel environment', error.message, { detail: error.detail });
    }
    log.ok(
      `${STAGING.envName} ${rows.length === 1 ? 'updated' : 'added'} for ${STAGING.envTarget}`
    );

    let deployment;
    try {
      log.info('deploying to production (this takes a minute or two)');
      deployment = await vercel.deployProduction();
    } catch (error) {
      throw new StepError('Vercel deploy', error.message, {
        detail: error.detail,
        hint: `The variable is already updated; the live page still serves the previous build. Run this again to retry the deployment.`,
      });
    }
    log.ok(`deployment is ready${deployment.deploymentUrl ? `: ${deployment.deploymentUrl}` : ''}`);

    // The page a visitor loads must now carry this address.
    const deadline = now() + STAGING.timeouts.frontendMs;
    let after = await deps.inspectFrontend();
    while (!(after.reachable && after.bases.includes(tunnelUrl)) && now() < deadline) {
      await sleep(5000);
      after = await deps.inspectFrontend();
    }
    if (!(after.reachable && after.bases.includes(tunnelUrl))) {
      throw new StepError(
        'Vercel verify',
        `${STAGING.frontendOrigin} does not use ${tunnelUrl} after the deployment.`,
        {
          detail: after.reachable
            ? `it was built with: ${after.bases.join(', ') || '(no tunnel address found)'}`
            : 'the page was not reachable',
          hint: 'Run this again. If it repeats, check the deployment in the Vercel dashboard.',
        }
      );
    }
    await state.update({
      lastDeployedUrl: tunnelUrl,
      lastDeployedAt: iso(),
      ...(deployment.deploymentUrl ? { lastDeploymentUrl: deployment.deploymentUrl } : {}),
    });
    summary.deployed = true;
    summary.deployNote = 'deployed and verified';
    log.ok('the live frontend now uses this tunnel address');
  });

  return summary;
}

// --- command line ------------------------------------------------------------------------------------------

export function createLog(write = (line) => process.stdout.write(`${line}\n`)) {
  const out = (line) => write(redact(line));
  return {
    step: (n, total, title) => out(`\n[${n}/${total}] ${title}`),
    ok: (message) => out(`  OK    ${message}`),
    info: (message) => out(`  ..    ${message}`),
    warn: (message) => out(`  WARN  ${message}`),
  };
}

export function printFailure(error, write = (line) => process.stderr.write(`${line}\n`)) {
  const e = asStepError('start', error);
  const out = (line) => write(redact(line));
  out(`\nFAILED at step "${e.step}": ${e.message}`);
  if (e.detail) for (const line of String(e.detail).split('\n')) out(`  | ${line}`);
  if (e.hint) out(`  Next: ${e.hint}`);
  out('  Nothing was reported as done that was not. The last known working state is unchanged.');
}

function parseArgs(argv) {
  const known = new Set(['--force-tunnel', '--force-deploy', '--no-deploy']);
  const unknown = argv.filter((a) => !known.has(a));
  if (unknown.length > 0) throw new Error(`Unknown option: ${unknown.join(' ')}`);
  return {
    forceTunnel: argv.includes('--force-tunnel'),
    forceDeploy: argv.includes('--force-deploy'),
    noDeploy: argv.includes('--no-deploy'),
  };
}

export async function main(argv = process.argv.slice(2)) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    process.stderr.write(
      `${error.message}\nOptions: --force-tunnel  --force-deploy  --no-deploy\n`
    );
    return 2;
  }

  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const run = createRunner({ cwd: root });
  const fetchImpl = globalThis.fetch;
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const deps = {
    root,
    docker: createDocker({ run, sleep }),
    vercel: createVercel({ run, root }),
    state: createState({ dir: path.join(root, STAGING.stateDir) }),
    verifyTunnel: (url, o) => verifyTunnel({ url, fetchImpl, sleep, ...o }),
    inspectFrontend: () => inspectFrontend({ fetchImpl }),
    readCapacity: () => readDashboardCapacity({ fetchImpl }),
    readText: (file) => readFile(file, 'utf8'),
    log: createLog(),
    sleep,
    now: Date.now,
  };

  try {
    const summary = await startStaging(deps, options);
    const out = (line) => process.stdout.write(`${redact(line)}\n`);
    out('\nDone.');
    out(`  Frontend   ${summary.frontendUrl}`);
    out(`  Tunnel     ${summary.tunnelUrl}  (${summary.tunnelReused ? 'reused' : 'new'})`);
    out(`  Vercel     ${summary.deployNote || 'n/a'}`);
    out(`  Dashboard  ${summary.dashboardUrl}`);
    out('  Stop with: .\\scripts\\stop-qatool.ps1');
    return 0;
  } catch (error) {
    printFailure(error);
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => process.exit(code));
}
