import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';

import { STAGING } from './config.js';
import { StepError, printFailure, startStaging } from './start.js';
import { stopStaging } from './stop.js';
import { createState } from './state.js';

const FRONTEND = STAGING.frontendOrigin;
const OLD = 'https://old-name-from-before-reboot.trycloudflare.com';
const T1 = 'https://lucky-oval-seeing-fabric.trycloudflare.com';
const T2 = 'https://brand-new-quick-tunnel.trycloudflare.com';
const T3 = 'https://third-tunnel-after-restart.trycloudflare.com';
const SECRET = 'never-print-this-value-0123456789';

const tempDirs = [];
afterEach(async () => {
  while (tempDirs.length) await rm(tempDirs.pop(), { recursive: true, force: true });
});

const GOOD_ENV = [
  'PUBLIC_DEMO=true',
  `TICKET_SECRET=${SECRET}`,
  'TRUSTED_PROXY_PEERS=172.18.0.1,10.250.250.2',
  `ALLOWED_ORIGINS=${FRONTEND}`,
].join('\n');

/**
 * A stand-in for everything outside the script: Docker, the tunnel, Vercel and the deployed frontend.
 * Every call is recorded in `calls`, in order, so a test can say exactly what happened and what did not.
 */
async function build(over = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'qatool-start-'));
  tempDirs.push(dir);

  const w = {
    envText: GOOD_ENV,
    engine: true,
    vercelVersion: '65.10.0',
    loggedIn: true,
    loginErrors: 0,
    linked: { id: 'prj_1', name: 'qatool-staging' },
    inspected: { id: 'prj_1', name: 'qatool-staging' },
    running: { cloudflared: true },
    containerEnv: {
      PUBLIC_DEMO: 'true',
      PUBLIC_MODE: null,
      JOB_WORKERS: null,
      TRUSTED_PROXY_PEERS: '172.18.0.1,10.250.250.2',
      ALLOWED_ORIGINS: FRONTEND,
      APAYEE_MAX_CONCURRENT: null,
    },
    capacity: { configured: 1, effective: 1, maxActive: 1 }, // what the dashboard reports (null: unreadable)
    capacityReads: 0,
    tunnelLogUrl: null, // the address in the running tunnel's log
    alive: new Set(), // tunnels that answer
    unsafe: new Set(), // tunnels that answer but are not behind the protections
    deadOnArrival: false, // a newly created tunnel that never answers
    next: [T2, T3], // what the next tunnels will be called
    envRows: [{ environments: ['Production'] }],
    envValue: OLD,
    frontendBases: [OLD],
    envFails: false,
    deployFails: false,
    deployChangesBundle: true,
    upFails: false,
    calls: [],
    logs: [],
    ...over,
  };
  const call = (name) => w.calls.push(name);

  const docker = {
    engineRunning: async () => (call('docker.engineRunning'), w.engine),
    up: async () => {
      call('docker.up');
      if (w.upFails)
        throw Object.assign(new Error('docker compose up -d failed (exit 1).'), {
          detail: `TICKET_SECRET=${SECRET}`,
        });
    },
    waitHealthy: async (services) => {
      call(`docker.waitHealthy:${services.join(',')}`);
      // A tunnel container that has only just started prints its address, and answers, once it is connected.
      if (services.includes('cloudflared') && w.tunnelAppearsOnWait) {
        const url = w.tunnelAppearsOnWait;
        w.tunnelLogUrl = url;
        w.alive.add(url);
      }
      if (services.includes('cloudflared') && w.tunnelNeverConnects)
        throw new Error('Not healthy in time: cloudflared (starting).');
    },
    serviceState: async (service) => ({
      exists: true,
      running: w.running[service] ?? true,
      health: 'healthy',
      id: 'abc',
    }),
    containerEnv: async (service, name) => w.containerEnv[name] ?? null,
    tunnelLogUrl: async () => w.tunnelLogUrl,
    recreateTunnel: async () => {
      call('docker.recreateTunnel');
      const url = w.next.shift();
      w.tunnelLogUrl = url;
      if (!w.deadOnArrival) w.alive.add(url);
    },
    stop: async (services = []) => call(`docker.stop:${services.join(',')}`),
  };

  const vercel = {
    version: async () => (call('vercel.version'), w.vercelVersion),
    loginStatus: async () => {
      call('vercel.loginStatus');
      if (w.loginErrors > 0) {
        w.loginErrors -= 1;
        return { state: 'error', detail: 'getaddrinfo ENOTFOUND api.vercel.com' };
      }
      return w.loggedIn ? { state: 'ok', detail: '' } : { state: 'logged-out', detail: '' };
    },
    linkedProject: async () => w.linked,
    inspectProject: async () => w.inspected,
    variableRows: async () => (call('vercel.variableRows'), w.envRows),
    setVariable: async (url, { exists }) => {
      call(`vercel.${exists ? 'envUpdate' : 'envAdd'}:${url}`);
      if (w.envFails)
        throw Object.assign(new Error('vercel env update failed (exit 1).'), {
          detail: 'Error: VERCEL_TOKEN=vercel_abcdefghijklmnop123456',
        });
      w.envValue = url;
    },
    deployProduction: async () => {
      call('vercel.deploy');
      if (w.deployFails)
        throw Object.assign(new Error('vercel deploy --prod failed (exit 1).'), {
          detail: 'build error',
        });
      if (w.deployChangesBundle) w.frontendBases = [w.envValue];
      return { deploymentUrl: 'https://qatool-staging-abc123.vercel.app' };
    },
  };

  const state = createState({ dir, now: () => Date.parse('2026-11-06T01:02:03Z') });
  let clock = 0;

  const deps = {
    root: 'C:/repo',
    docker,
    vercel,
    state,
    verifyTunnel: async (url) => {
      call(`verifyTunnel:${url}`);
      const checks = [
        {
          name: 'GET /healthz answers',
          ok: w.alive.has(url) || w.unsafe.has(url),
          detail: 'HTTP 200',
        },
      ];
      if (w.unsafe.has(url))
        return {
          ok: false,
          kind: 'unsafe',
          checks: [
            ...checks,
            { name: 'no Origin is refused', ok: false, detail: 'HTTP 200 (expected 403)' },
          ],
        };
      if (!w.alive.has(url))
        return {
          ok: false,
          kind: 'unreachable',
          checks: [{ name: 'GET /healthz answers', ok: false, detail: 'ENOTFOUND' }],
        };
      return {
        ok: true,
        kind: 'ok',
        checks: [...checks, { name: 'no Origin is refused', ok: true, detail: 'HTTP 403' }],
      };
    },
    inspectFrontend: async () => ({ reachable: true, bases: [...w.frontendBases], assets: 2 }),
    readCapacity: async () => {
      w.capacityReads += 1;
      return w.capacity;
    },
    readText: async () => {
      if (w.envText === null) throw new Error('ENOENT');
      return w.envText;
    },
    log: {
      step: (n, total, title) => w.logs.push(`[${n}/${total}] ${title}`),
      ok: (m) => w.logs.push(`OK ${m}`),
      info: (m) => w.logs.push(`.. ${m}`),
      warn: (m) => w.logs.push(`WARN ${m}`),
    },
    sleep: async () => {},
    now: () => (clock += 1000),
  };
  return { w, deps, state, dir };
}

const names = (w) => w.calls.map((c) => c.split(':')[0]);
const has = (w, prefix) => w.calls.some((c) => c.startsWith(prefix));
const monitorFile = (dir) => readFile(path.join(dir, 'monitor', 'tunnel-url'), 'utf8');

async function failure(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  assert.fail('expected the run to fail');
}

// --- the normal paths ----------------------------------------------------------------------------------------

test('first start: a new tunnel is created, verified, published to the dashboard, and the frontend is deployed', async () => {
  const { w, deps, state, dir } = await build();
  const summary = await startStaging(deps);

  assert.equal(summary.tunnelUrl, T2);
  assert.equal(summary.tunnelReused, false);
  assert.equal(summary.deployed, true);
  assert.deepEqual(
    names(w).filter((n) => !n.startsWith('verifyTunnel')),
    [
      'docker.engineRunning',
      'vercel.version',
      'vercel.loginStatus',
      'docker.up',
      'docker.waitHealthy',
      'docker.waitHealthy',
      'docker.recreateTunnel',
      'vercel.variableRows',
      'vercel.envUpdate',
      'vercel.deploy',
    ]
  );
  assert.equal(await monitorFile(dir), `${T2}\n`);
  const saved = await state.read();
  assert.equal(saved.tunnelUrl, T2);
  assert.equal(saved.lastDeployedUrl, T2);
  assert.equal(saved.lastDeploymentUrl, 'https://qatool-staging-abc123.vercel.app');
  assert.equal(w.envValue, T2);
});

test('Vercel gets the verified address, never one that was not checked', async () => {
  const { w, deps } = await build();
  await startStaging(deps);
  const verified = w.calls
    .filter((c) => c.startsWith('verifyTunnel:'))
    .map((c) => c.slice('verifyTunnel:'.length));
  const sent = w.calls.find((c) => c.startsWith('vercel.env')).split(/:(.+)/)[1];
  assert.ok(verified.includes(sent));
  assert.ok(
    w.calls.indexOf(`verifyTunnel:${sent}`) < w.calls.findIndex((c) => c.startsWith('vercel.env'))
  );
});

test('a variable that does not exist yet is added, not updated', async () => {
  const { w, deps } = await build({ envRows: [] });
  await startStaging(deps);
  assert.ok(has(w, `vercel.envAdd:${T2}`));
  assert.equal(has(w, 'vercel.envUpdate'), false);
});

test('running again changes nothing: the tunnel is reused, nothing is recreated, nothing is deployed', async () => {
  const first = await build();
  await startStaging(first.deps);

  // The second run sees the world the first one left.
  const { w } = first;
  w.calls.length = 0;
  await startStaging(first.deps);

  assert.equal(has(w, 'docker.recreateTunnel'), false);
  assert.equal(has(w, 'vercel.variableRows'), false);
  assert.equal(has(w, 'vercel.env'), false);
  assert.equal(has(w, 'vercel.deploy'), false);
  assert.equal(names(w).filter((n) => n === 'docker.up').length, 1, 'only the idempotent `up -d`');
  assert.equal(w.envValue, T2, 'the variable was not touched');
  assert.equal(w.frontendBases.length, 1);
});

test('reuse: a tunnel that is already running and answering is kept as it is', async () => {
  const { w, deps, state } = await build({
    tunnelLogUrl: T1,
    alive: new Set([T1]),
    frontendBases: [T1],
    envValue: T1,
  });
  await state.update({ tunnelUrl: T1, lastDeployedUrl: T1 });
  const summary = await startStaging(deps);
  assert.equal(summary.tunnelReused, true);
  assert.equal(summary.deployed, false);
  assert.equal(has(w, 'docker.recreateTunnel'), false);
  assert.equal(has(w, 'vercel.deploy'), false);
});

test('a tunnel container that has only just started is waited for, not thrown away and recreated', async () => {
  const { w, deps } = await build({ tunnelAppearsOnWait: T1, frontendBases: [T1], envValue: T1 });
  const summary = await startStaging(deps);
  assert.equal(summary.tunnelUrl, T1);
  assert.equal(summary.tunnelReused, true);
  assert.ok(has(w, 'docker.waitHealthy:cloudflared'));
  assert.equal(has(w, 'docker.recreateTunnel'), false);
});

test('a tunnel container that never connects is replaced, once', async () => {
  const { w, deps } = await build({ tunnelNeverConnects: true });
  const summary = await startStaging(deps);
  assert.equal(summary.tunnelUrl, T2);
  assert.ok(w.logs.some((l) => /not connected yet/.test(l)));
  assert.equal(names(w).filter((n) => n === 'docker.recreateTunnel').length, 1);
});

test('--force-tunnel does not wait for the old tunnel; it replaces it', async () => {
  const { w, deps } = await build({ tunnelAppearsOnWait: T1 });
  await startStaging(deps, { forceTunnel: true });
  assert.equal(has(w, 'docker.waitHealthy:cloudflared'), false);
  assert.ok(has(w, 'docker.recreateTunnel'));
});

test('a tunnel the state never saw is verified with the full wait, a known one with a short one', async () => {
  const seen = [];
  const { deps, state } = await build({
    tunnelLogUrl: T1,
    alive: new Set([T1]),
    frontendBases: [T1],
  });
  const original = deps.verifyTunnel;
  deps.verifyTunnel = async (url, options) => (
    seen.push(options?.timeoutMs),
    original(url, options)
  );
  await startStaging(deps);
  const fresh = seen[0];
  seen.length = 0;
  await state.update({ tunnelUrl: T1, lastDeployedUrl: T1 });
  await startStaging(deps);
  assert.ok(fresh > seen[0], `${fresh} should exceed ${seen[0]}`);
});

// --- recovery ------------------------------------------------------------------------------------------------

test('after a reboot the old tunnel no longer answers: a new one is made, and Vercel follows', async () => {
  const { w, deps, state } = await build({
    tunnelLogUrl: OLD, // the restarted container's log still starts with the old name
    alive: new Set(), // ...which no longer exists on Cloudflare's side
    frontendBases: [OLD],
    envValue: OLD,
  });
  await state.update({ tunnelUrl: OLD, lastDeployedUrl: OLD });

  const summary = await startStaging(deps);

  assert.equal(summary.tunnelUrl, T2);
  assert.equal(summary.tunnelReused, false);
  assert.ok(w.logs.some((l) => /does not answer/.test(l)));
  assert.ok(has(w, 'docker.recreateTunnel'));
  assert.ok(has(w, `vercel.envUpdate:${T2}`));
  assert.ok(has(w, 'vercel.deploy'));
  assert.equal((await state.read()).lastDeployedUrl, T2);
});

test('a new tunnel after a restart: the unchanged address is not deployed twice, a changed one is', async () => {
  const { w, deps } = await build();
  await startStaging(deps); // T2 deployed
  w.calls.length = 0;

  w.tunnelLogUrl = T3; // the tunnel container restarted by itself and got a new name
  w.alive = new Set([T3]);
  await startStaging(deps);

  assert.equal(
    has(w, 'docker.recreateTunnel'),
    false,
    'the new tunnel is already running; it is only verified'
  );
  assert.ok(has(w, `vercel.envUpdate:${T3}`));
  assert.equal(names(w).filter((n) => n === 'vercel.deploy').length, 1);
  assert.deepEqual(w.frontendBases, [T3]);
});

test('--force-tunnel makes a new tunnel even when the running one works', async () => {
  const { w, deps } = await build({
    tunnelLogUrl: T1,
    alive: new Set([T1]),
    frontendBases: [T1],
    envValue: T1,
  });
  const summary = await startStaging(deps, { forceTunnel: true });
  assert.ok(has(w, 'docker.recreateTunnel'));
  assert.equal(summary.tunnelUrl, T2);
});

// --- deployment decisions ------------------------------------------------------------------------------------

test('the state file says deployed but the live page was built with another address: it is deployed again', async () => {
  const { w, deps, state } = await build({
    tunnelLogUrl: T1,
    alive: new Set([T1]),
    frontendBases: [OLD],
  });
  await state.update({ tunnelUrl: T1, lastDeployedUrl: T1 });
  await startStaging(deps);
  assert.ok(w.logs.some((l) => /state file says/.test(l)));
  assert.ok(has(w, 'vercel.deploy'));
});

test('the state file was lost but the live page already uses the address: it is adopted, not deployed', async () => {
  const { w, deps, state } = await build({
    tunnelLogUrl: T1,
    alive: new Set([T1]),
    frontendBases: [T1],
  });
  await startStaging(deps);
  assert.equal(has(w, 'vercel.deploy'), false);
  assert.equal((await state.read()).lastDeployedUrl, T1);
});

test('--force-deploy deploys even when the page is current; --no-deploy skips Vercel but still publishes to the dashboard', async () => {
  const forced = await build({
    tunnelLogUrl: T1,
    alive: new Set([T1]),
    frontendBases: [T1],
    envValue: T1,
  });
  await startStaging(forced.deps, { forceDeploy: true });
  assert.ok(has(forced.w, 'vercel.deploy'));

  const skipped = await build();
  const summary = await startStaging(skipped.deps, { noDeploy: true });
  assert.equal(has(skipped.w, 'vercel.deploy'), false);
  assert.equal(has(skipped.w, 'vercel.variableRows'), false);
  assert.match(summary.deployNote, /skipped/);
  assert.equal(await monitorFile(skipped.dir), `${T2}\n`);
  assert.equal((await skipped.state.read()).lastDeployedUrl, null, 'nothing was claimed deployed');
});

// --- failures never look like success ------------------------------------------------------------------------

test('Docker not running: stops at preflight, starts and changes nothing', async () => {
  const { w, deps } = await build({ engine: false });
  const error = await failure(startStaging(deps));
  assert.ok(error instanceof StepError);
  assert.equal(error.step, 'Preflight');
  assert.match(error.message, /Docker Engine is not running/);
  assert.match(error.hint, /Docker Desktop/);
  assert.equal(has(w, 'docker.up'), false);
});

test('Vercel CLI missing or not logged in: stops at preflight with the command to run', async () => {
  const missing = await build({ vercelVersion: null });
  const a = await failure(startStaging(missing.deps));
  assert.match(a.message, /not installed/);
  assert.match(a.hint, /npm i -g vercel/);
  assert.equal(has(missing.w, 'docker.up'), false);

  const out = await build({ loggedIn: false });
  const b = await failure(startStaging(out.deps));
  assert.match(b.message, /not logged in/);
  assert.match(b.hint, /vercel login/);
  assert.equal(has(out.w, 'docker.up'), false);
});

test('a hiccup while checking the Vercel login is retried once, and is never reported as a logout', async () => {
  const hiccup = await build({ loginErrors: 1 });
  await startStaging(hiccup.deps);
  assert.equal(
    hiccup.w.calls.filter((c) => c === 'vercel.loginStatus').length,
    2,
    'asked again after the first failure'
  );

  const broken = await build({ loginErrors: 5 });
  const error = await failure(startStaging(broken.deps));
  assert.equal(error.step, 'Preflight');
  assert.match(error.message, /Could not confirm the Vercel login/);
  assert.doesNotMatch(error.message + error.hint, /not logged in|vercel login/);
  assert.match(error.detail, /ENOTFOUND/);
  assert.equal(has(broken.w, 'docker.up'), false, 'nothing was started');
});

test('a project other than qatool-staging is refused before anything starts', async () => {
  for (const [label, over] of [
    ['linked to another project', { linked: { id: 'prj_9', name: 'some-other-project' } }],
    ['not linked at all', { linked: { id: null, name: null } }],
    [
      'the link file and Vercel disagree on the name',
      { inspected: { id: 'prj_1', name: 'some-other-project' } },
    ],
    [
      'the link file and Vercel disagree on the id',
      { inspected: { id: 'prj_2', name: 'qatool-staging' } },
    ],
  ]) {
    const { w, deps } = await build(over);
    const error = await failure(startStaging(deps));
    assert.equal(error.step, 'Preflight', label);
    assert.equal(has(w, 'docker.up'), false, label);
    assert.equal(has(w, 'vercel.env'), false, label);
    assert.equal(has(w, 'vercel.deploy'), false, label);
  }
});

test('a backend that is not the public demo never gets a tunnel', async () => {
  for (const [label, envText] of [
    ['PUBLIC_DEMO off', GOOD_ENV.replace('PUBLIC_DEMO=true', 'PUBLIC_DEMO=false')],
    ['PUBLIC_DEMO missing', GOOD_ENV.replace('PUBLIC_DEMO=true\n', '')],
    ['PUBLIC_MODE on', `${GOOD_ENV}\nPUBLIC_MODE=true`],
  ]) {
    const { w, deps } = await build({ envText });
    const error = await failure(startStaging(deps));
    assert.match(error.message, /not configured as the public demo/, label);
    assert.equal(
      has(w, 'docker.up'),
      false,
      `${label}: the stack (and its tunnel) was not even started`
    );
  }
});

test('the tunnel container must be a trusted proxy peer, and the frontend origin must be allowed', async () => {
  const peers = await build({ envText: GOOD_ENV.replace('172.18.0.1,10.250.250.2', '172.18.0.1') });
  const a = await failure(startStaging(peers.deps));
  assert.match(a.message, /TRUSTED_PROXY_PEERS/);
  assert.match(a.hint, /10\.250\.250\.2/);
  assert.equal(has(peers.w, 'docker.up'), false);

  const origins = await build({ envText: GOOD_ENV.replace(FRONTEND, 'https://elsewhere.example') });
  const b = await failure(startStaging(origins.deps));
  assert.match(b.message, /ALLOWED_ORIGINS/);
});

test('a missing .env is reported, not guessed', async () => {
  const { deps } = await build({ envText: null });
  const error = await failure(startStaging(deps));
  assert.match(error.message, /\.env file was not found/);
});

test('if the RUNNING containers are unsafe, the tunnel is stopped at once and nothing is published', async () => {
  const cases = {
    'demo mode off in the container': { PUBLIC_DEMO: 'false' },
    'public mode on in the container': { PUBLIC_MODE: 'true' },
    'more than two workers': { JOB_WORKERS: '3', APAYEE_MAX_CONCURRENT: '3' },
    'a worker count that is not a number': { JOB_WORKERS: 'two' },
    'two workers but a one-call gateway': { JOB_WORKERS: '2' },
    'a two-call gateway but one worker': { APAYEE_MAX_CONCURRENT: '2' },
    'the container does not trust the tunnel (not recreated after editing .env)': {
      TRUSTED_PROXY_PEERS: '172.18.0.1',
    },
    'the container does not allow the frontend': { ALLOWED_ORIGINS: 'https://elsewhere.example' },
  };
  for (const [label, patch] of Object.entries(cases)) {
    const { w, deps, dir } = await build({
      containerEnv: {
        PUBLIC_DEMO: 'true',
        PUBLIC_MODE: null,
        JOB_WORKERS: null,
        TRUSTED_PROXY_PEERS: '172.18.0.1,10.250.250.2',
        ALLOWED_ORIGINS: FRONTEND,
        APAYEE_MAX_CONCURRENT: null,
        ...patch,
      },
    });
    const error = await failure(startStaging(deps));
    assert.equal(error.step, 'Start the stack', label);
    assert.ok(has(w, 'docker.stop:cloudflared'), `${label}: the tunnel was stopped`);
    assert.equal(has(w, 'vercel.env'), false, label);
    await assert.rejects(
      readFile(path.join(dir, 'monitor', 'tunnel-url')),
      { code: 'ENOENT' },
      label
    );
  }
});

test('a tunnel that answers but is not behind the protections is shut, never published or deployed', async () => {
  const { w, deps, state, dir } = await build({ tunnelLogUrl: T1, unsafe: new Set([T1]) });
  const error = await failure(startStaging(deps));
  assert.equal(error.step, 'Tunnel');
  assert.match(error.message, /does not behave like the protected demo backend/);
  assert.ok(has(w, 'docker.stop:cloudflared'));
  assert.equal(has(w, 'vercel.env'), false);
  assert.equal(has(w, 'vercel.deploy'), false);
  assert.equal((await state.read()).tunnelUrl, null);
  await assert.rejects(readFile(path.join(dir, 'monitor', 'tunnel-url')), { code: 'ENOENT' });
});

test('a new tunnel that is unsafe is shut as well', async () => {
  const { w, deps } = await build();
  w.unsafe = new Set([T2]);
  const original = deps.docker.recreateTunnel;
  deps.docker.recreateTunnel = async () => original();
  const error = await failure(startStaging(deps));
  assert.match(error.message, /does not behave like the protected/);
  assert.ok(has(w, 'docker.stop:cloudflared'));
  assert.equal(has(w, 'vercel.deploy'), false);
});

test('a tunnel that never becomes reachable fails the tunnel step; nothing is deployed and the state is unchanged', async () => {
  const { w, deps, state } = await build({ deadOnArrival: true });
  await state.update({ tunnelUrl: T1, lastDeployedUrl: T1 });
  const error = await failure(startStaging(deps));
  assert.equal(error.step, 'Tunnel');
  assert.match(error.message, /did not become reachable/);
  assert.match(error.detail, /ENOTFOUND/);
  assert.equal(has(w, 'vercel.env'), false);
  assert.equal(has(w, 'vercel.deploy'), false);
  const saved = await state.read();
  assert.equal(saved.tunnelUrl, T1);
  assert.equal(saved.lastDeployedUrl, T1);
});

test('cloudflared that prints no address is a tunnel failure with the next thing to look at', async () => {
  const { deps, w } = await build();
  deps.docker.recreateTunnel = async () => {
    w.calls.push('docker.recreateTunnel');
    w.tunnelLogUrl = null;
  };
  const error = await failure(startStaging(deps));
  assert.equal(error.step, 'Tunnel');
  assert.match(error.message, /did not print a tunnel address/);
  assert.match(error.hint, /docker compose logs cloudflared/);
});

test('Vercel environment failure: reported at that step, no deployment, state and the live page untouched', async () => {
  const { w, deps, state } = await build({ envFails: true });
  await state.update({
    lastDeployedUrl: OLD.replace('old-name-from-before-reboot', 'earlier-good-tunnel'),
  });
  const before = await state.read();
  const error = await failure(startStaging(deps));
  assert.equal(error.step, 'Vercel environment');
  assert.equal(has(w, 'vercel.deploy'), false);
  assert.deepEqual((await state.read()).lastDeployedUrl, before.lastDeployedUrl);
  assert.deepEqual(w.frontendBases, [OLD]);
});

test('Vercel deploy failure: reported, the variable is already set, the old build still serves, state not advanced', async () => {
  const { w, deps, state } = await build({ deployFails: true });
  const error = await failure(startStaging(deps));
  assert.equal(error.step, 'Vercel deploy');
  assert.match(error.hint, /previous build/);
  assert.equal(w.envValue, T2);
  assert.deepEqual(w.frontendBases, [OLD]);
  assert.equal((await state.read()).lastDeployedUrl, null);
});

test('a deployment that does not carry the new address is not reported as success', async () => {
  const { deps, state } = await build({ deployChangesBundle: false });
  const error = await failure(startStaging(deps));
  assert.equal(error.step, 'Vercel verify');
  assert.match(error.detail, /built with: https:\/\/old-name-from-before-reboot/);
  assert.equal((await state.read()).lastDeployedUrl, null);
});

test('a variable that also covers another environment is not touched', async () => {
  const { w, deps } = await build({ envRows: [{ environments: ['Production', 'Preview'] }] });
  const error = await failure(startStaging(deps));
  assert.equal(error.step, 'Vercel environment');
  assert.match(error.message, /more than Production/);
  assert.equal(has(w, 'vercel.env'), false);
  assert.equal(has(w, 'vercel.deploy'), false);
});

test('a duplicated variable is refused rather than guessed at', async () => {
  const { w, deps } = await build({
    envRows: [{ environments: ['Production'] }, { environments: ['Production'] }],
  });
  const error = await failure(startStaging(deps));
  assert.match(error.message, /more than once/);
  assert.equal(has(w, 'vercel.env'), false);
});

test('only VITE_API_BASE_URL for Production is ever set, and nothing else is deployed to', async () => {
  const { w, deps } = await build();
  await startStaging(deps);
  const sets = w.calls.filter((c) => c.startsWith('vercel.env'));
  assert.equal(sets.length, 1);
  assert.equal(names(w).filter((n) => n === 'vercel.deploy').length, 1);
});

// --- secrets -------------------------------------------------------------------------------------------------

test('nothing printed during a run contains a value from .env or a token', async () => {
  const { w, deps } = await build();
  await startStaging(deps);
  const text = w.logs.join('\n');
  assert.equal(text.includes(SECRET), false);
  assert.doesNotMatch(text, /TICKET_SECRET|Bearer|vercel_/);
});

test("a failure prints a redacted tail, never the tool's secrets or the account name", async () => {
  const { deps } = await build({ envFails: true });
  const error = await failure(startStaging(deps));
  const lines = [];
  printFailure(error, (line) => lines.push(line));
  const text = lines.join('\n');
  assert.match(text, /FAILED at step "Vercel environment"/);
  assert.doesNotMatch(text, /vercel_abcdefghijklmnop/);
  assert.match(text, /last known working state is unchanged/);

  const second = [];
  printFailure(
    Object.assign(new Error('boom kelvins-projects-a05ff9d4 TICKET_SECRET=hunter22222'), {}),
    (l) => second.push(l)
  );
  assert.doesNotMatch(second.join('\n'), /a05ff9d4|hunter22222/);
});

test('a failure to start the stack surfaces the tool output, redacted', async () => {
  const { deps } = await build({ upFails: true });
  const error = await failure(startStaging(deps));
  assert.equal(error.step, 'Start the stack');
  const lines = [];
  printFailure(error, (l) => lines.push(l));
  assert.doesNotMatch(lines.join('\n'), new RegExp(SECRET));
});

// --- stopping ------------------------------------------------------------------------------------------------

function stopHarness({ engine = true } = {}) {
  const calls = [];
  const logs = [];
  const docker = {
    engineRunning: async () => engine,
    stop: async (services = []) => calls.push(['stop', ...services]),
  };
  const log = { ok: (m) => logs.push(m), info: (m) => logs.push(m), warn: (m) => logs.push(m) };
  return { docker, log, calls, logs };
}

test('stop: ordinary `docker compose stop` for everything, or only the tunnel', async () => {
  const all = stopHarness();
  await stopStaging(all, {});
  assert.deepEqual(all.calls, [['stop']]);

  const tunnel = stopHarness();
  await stopStaging(tunnel, { tunnelOnly: true });
  assert.deepEqual(tunnel.calls, [['stop', 'cloudflared']]);
  assert.ok(tunnel.logs.some((l) => /volumes were kept/.test(l)));
});

test('stop: when Docker is not running there is nothing to stop, and it says so', async () => {
  const h = stopHarness({ engine: false });
  const result = await stopStaging(h, {});
  assert.deepEqual(h.calls, []);
  assert.equal(result.engineRunning, false);
});

test('stop: the script and the Docker helper contain no way to remove anything', async () => {
  const source =
    (await readFile(new URL('./stop.js', import.meta.url), 'utf8')) +
    (await readFile(new URL('./docker.js', import.meta.url), 'utf8'));
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  // The only mentions of removal in the Docker helper are the refusals themselves.
  assert.doesNotMatch(
    code.replace(/ALLOWED_VERBS[^;]*;/, '').replace(/args\.some\([^)]*\)[^{]*\{[^}]*\}/, ''),
    /'down'|'rm'|'prune'|'volume'|'kill'/
  );
  const ps = await readFile(new URL('../stop-qatool.ps1', import.meta.url), 'utf8');
  const psCode = ps.replace(/<#[\s\S]*?#>/g, '');
  assert.doesNotMatch(psCode, /\b(down|prune|rm|volume|kill)\b|-v\b/i);
});

// --- concurrency policy (staging runs 1 or 2 calls at once, both ends in agreement) ---

const TWO = {
  JOB_WORKERS: '2',
  APAYEE_MAX_CONCURRENT: '2',
};
const twoWorld = (over = {}) => ({
  containerEnv: {
    PUBLIC_DEMO: 'true',
    PUBLIC_MODE: null,
    TRUSTED_PROXY_PEERS: '172.18.0.1,10.250.250.2',
    ALLOWED_ORIGINS: FRONTEND,
    ...TWO,
  },
  capacity: { configured: 2, effective: 1, maxActive: 2 },
  ...over,
});

test('two workers and a two-call gateway start; effective 1 before the first job is not a failure', async () => {
  const { w, deps } = await build(twoWorld());
  await startStaging(deps, { noDeploy: true });
  assert.equal(has(w, 'docker.stop:cloudflared'), false);
  assert.ok(w.logs.some((l) => /2 worker\(s\), 2 gateway call\(s\)/.test(l)));
  assert.ok(
    w.logs.some((l) => /2 workers configured, gateway max_active 2, 1 effective now/.test(l))
  );
  assert.ok(w.logs.some((l) => /rises to 2 when the first job is admitted/.test(l)));
});

test('already effective 2 is reported without the "rises" note', async () => {
  const { w, deps } = await build(
    twoWorld({ capacity: { configured: 2, effective: 2, maxActive: 2 } })
  );
  await startStaging(deps, { noDeploy: true });
  assert.ok(w.logs.some((l) => /2 effective now$/.test(l)));
  assert.equal(
    w.logs.some((l) => /rises to/.test(l)),
    false
  );
});

test('one worker and a one-call gateway (or both unset) still start', async () => {
  const { w, deps } = await build();
  await startStaging(deps, { noDeploy: true });
  assert.equal(has(w, 'docker.stop:cloudflared'), false);
  assert.ok(w.logs.some((l) => /1 worker\(s\), 1 gateway call\(s\)/.test(l)));
});

test('the live backend or gateway disagreeing with the container settings stops the tunnel', async () => {
  const cases = {
    'the gateway reports a different max_active': { configured: 2, effective: 1, maxActive: 3 },
    'the backend reports different workers': { configured: 3, effective: 1, maxActive: 2 },
  };
  for (const [label, capacity] of Object.entries(cases)) {
    const { w, deps } = await build(twoWorld({ capacity }));
    const error = await failure(startStaging(deps, { noDeploy: true }));
    assert.equal(error.step, 'Start the stack', label);
    assert.ok(has(w, 'docker.stop:cloudflared'), label);
    assert.equal(has(w, 'vercel.env'), false, label);
  }
});

test('an unreadable dashboard does not block startup, but is said plainly after a few tries', async () => {
  const { w, deps } = await build(twoWorld({ capacity: null }));
  await startStaging(deps, { noDeploy: true });
  assert.equal(w.capacityReads, 5);
  assert.ok(w.logs.some((l) => /WARN Live worker and gateway capacity could not be read/.test(l)));
});

test('the failure names the new maximum of 2 and both variables', async () => {
  const { deps } = await build(
    twoWorld({
      containerEnv: {
        PUBLIC_DEMO: 'true',
        PUBLIC_MODE: null,
        TRUSTED_PROXY_PEERS: '172.18.0.1,10.250.250.2',
        ALLOWED_ORIGINS: FRONTEND,
        JOB_WORKERS: '3',
        APAYEE_MAX_CONCURRENT: '3',
      },
    })
  );
  const error = await failure(startStaging(deps, { noDeploy: true }));
  assert.match(error.message, /JOB_WORKERS must be between 1 and 2/);
  assert.match(error.message, /APAYEE_MAX_CONCURRENT must be between 1 and 2/);
  assert.match(error.hint, /apayee qatool-backend/);
});
