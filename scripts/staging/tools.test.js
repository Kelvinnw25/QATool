import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createDocker } from './docker.js';
import { createVercel } from './vercel.js';
import { inspectFrontend, verifyTunnel } from './verify.js';

const TUNNEL = 'https://lucky-oval-seeing-fabric.trycloudflare.com';
const FRONTEND = 'https://qatool-staging.vercel.app';
const done = (stdout = '', code = 0, extra = {}) => ({
  code,
  stdout,
  stderr: '',
  timedOut: false,
  missing: false,
  ...extra,
});

// --- docker ------------------------------------------------------------------------------------------------

function dockerWith(handler) {
  const calls = [];
  const run = async (program, args, options) => {
    calls.push([program, ...args]);
    return handler(args, options);
  };
  return {
    docker: createDocker({
      run,
      sleep: async () => {},
      now: (() => {
        let t = 0;
        return () => (t += 1000);
      })(),
    }),
    calls,
  };
}

test('docker: only the fixed operations exist, and none can remove anything', async () => {
  const { docker, calls } = dockerWith(() => done());
  await docker.up();
  await docker.stop();
  await docker.stop(['cloudflared']);
  await docker.recreateTunnel();
  assert.deepEqual(calls, [
    ['docker', 'compose', 'up', '-d'],
    ['docker', 'compose', 'stop'],
    ['docker', 'compose', 'stop', 'cloudflared'],
    ['docker', 'compose', 'up', '-d', '--force-recreate', '--no-deps', 'cloudflared'],
  ]);
  const text = JSON.stringify(calls);
  assert.doesNotMatch(text, /"down"|"rm"|"prune"|"volume"|"-v"|"--volumes"|"kill"|"--rmi"/);
});

test('docker: a service name or variable name that is not a plain identifier is refused', async () => {
  const { docker, calls } = dockerWith(() => done());
  await assert.rejects(docker.stop(['x; rm -rf /']), /bad service name/);
  await assert.rejects(
    docker.containerEnv('qatool-backend', 'lowercase'),
    /bad service or variable/
  );
  await assert.rejects(docker.containerEnv('a b', 'PUBLIC_DEMO'), /bad service or variable/);
  await assert.rejects(docker.serviceState('Bad Name'), /bad service name/);
  assert.equal(calls.length, 0, 'nothing was run');
});

test('docker: the engine check, and a variable that is set, unset, or fails to read', async () => {
  let reply;
  const { docker } = dockerWith((args) => (args[0] === 'info' ? reply : reply));
  reply = done('29.9.2\n');
  assert.equal(await docker.engineRunning(), true);
  reply = done('', 1, { stderr: 'cannot connect to the Docker daemon' });
  assert.equal(await docker.engineRunning(), false);
  reply = done('true\n');
  assert.equal(await docker.containerEnv('qatool-backend', 'PUBLIC_DEMO'), 'true');
  reply = done('', 1);
  assert.equal(await docker.containerEnv('qatool-backend', 'PUBLIC_MODE'), null);
  reply = done('', 125, { stderr: 'service is not running' });
  await assert.rejects(docker.containerEnv('qatool-backend', 'PUBLIC_MODE'), /failed/);
});

test('docker: service state is read from compose json, in either of its shapes', async () => {
  const row = {
    Service: 'qatool-backend',
    State: 'running',
    Health: 'healthy',
    ID: 'abcdef1234567890',
  };
  let reply = done(`${JSON.stringify(row)}\n`);
  const { docker } = dockerWith(() => reply);
  assert.deepEqual(await docker.serviceState('qatool-backend'), {
    exists: true,
    running: true,
    health: 'healthy',
    id: 'abcdef123456',
  });
  reply = done(JSON.stringify([row]));
  assert.equal((await docker.serviceState('qatool-backend')).running, true);
  reply = done('');
  assert.deepEqual(await docker.serviceState('qatool-backend'), {
    exists: false,
    running: false,
    health: null,
    id: null,
  });
});

test('docker: waiting for health succeeds once healthy, and names what is not when time runs out', async () => {
  const row = (Health) =>
    done(JSON.stringify({ Service: 'qatool-backend', State: 'running', Health, ID: 'abc' }));
  const clock = () => {
    let t = 0;
    return () => (t += 100);
  };

  let polls = 0;
  const becomesHealthy = createDocker({
    run: async () => row(++polls >= 3 ? 'healthy' : 'starting'),
    sleep: async () => {},
    now: clock(),
  });
  await becomesHealthy.waitHealthy(['qatool-backend'], { timeoutMs: 60_000 });
  assert.ok(polls >= 3, 'it kept polling until healthy');

  const staysStarting = createDocker({
    run: async () => row('starting'),
    sleep: async () => {},
    now: clock(),
  });
  await assert.rejects(
    staysStarting.waitHealthy(['qatool-backend'], { timeoutMs: 3000 }),
    /Not healthy in time: qatool-backend \(starting\)/
  );

  const missing = createDocker({ run: async () => done(''), sleep: async () => {}, now: clock() });
  await assert.rejects(
    missing.waitHealthy(['qatool-backend'], { timeoutMs: 1000 }),
    /qatool-backend \(not running\)/
  );
});

test("docker: the tunnel address comes from the tunnel service's log, and from nothing else", async () => {
  const { docker, calls } = dockerWith(() => done(`INF |  ${TUNNEL}  |\n`));
  assert.equal(await docker.tunnelLogUrl(), TUNNEL);
  assert.deepEqual(calls[0], [
    'docker',
    'compose',
    'logs',
    '--no-log-prefix',
    '--no-color',
    'cloudflared',
  ]);
  const failing = dockerWith(() => done('', 1)).docker;
  assert.equal(await failing.tunnelLogUrl(), null);
});

// --- vercel ------------------------------------------------------------------------------------------------

function vercelWith(
  handler,
  readText = async () => JSON.stringify({ projectId: 'prj_abc123', projectName: 'qatool-staging' })
) {
  const calls = [];
  const run = async (program, args, options) => {
    calls.push({ program, args, input: options?.input });
    return handler(args, options);
  };
  return { vercel: createVercel({ run, root: 'C:/repo', readText }), calls };
}

const ENV_LIST = `
Vercel CLI 65.10.0
> Environment Variables found for kelvins-projects-a05ff9d4/qatool-staging [370ms]

 name                       value                       type      environments        created
 VITE_API_BASE_URL          eyJ2IjoidjIiLCJjIj…         Config    Production          2d ago
 VITE_PUBLIC_DEMO           eyJ2IjoidjIiLCJjIj…         Config    Production          2d ago
`;

test('vercel: the version and login are exit-status checks only', async () => {
  let reply = done('Vercel CLI 65.10.0\n65.10.0\n');
  const { vercel } = vercelWith(() => reply);
  assert.equal(await vercel.version(), '65.10.0');
  reply = done('', null, { missing: true });
  assert.equal(await vercel.version(), null);
  reply = done('someone\n');
  assert.deepEqual(await vercel.loginStatus(), { state: 'ok', detail: '' });
});

test('vercel: "logged out" and "could not find out" are different answers', async () => {
  let reply;
  const { vercel } = vercelWith(() => reply);

  reply = done('', 1, { stderr: 'Error: No existing credentials found. Please log in' });
  assert.equal((await vercel.loginStatus()).state, 'logged-out');
  reply = done('', 1, {
    stderr: 'Error: The specified token is not valid. Use `vercel login` to generate a new token.',
  });
  assert.equal((await vercel.loginStatus()).state, 'logged-out');

  // A network or API failure is not a logout, and its output is shown redacted, without the editor hint.
  reply = done('', 1, {
    stderr:
      '<claude-code-hint v="1" type="plugin" value="vercel@x" />\nError: getaddrinfo ENOTFOUND api.vercel.com VERCEL_TOKEN=vercel_abcdefghijklmnop123',
  });
  const status = await vercel.loginStatus();
  assert.equal(status.state, 'error');
  assert.match(status.detail, /ENOTFOUND/);
  assert.doesNotMatch(status.detail, /claude-code-hint|vercel_abcdef/);

  reply = done('', null, { timedOut: true });
  assert.deepEqual(await vercel.loginStatus(), { state: 'error', detail: 'timed out' });
});

test('vercel: the linked project is read from the link file, and confirmed by Vercel itself', async () => {
  const inspect =
    '> Found Project kelvins-projects-a05ff9d4/qatool-staging [1s]\n\n  General\n\n    ID\t\t\t\tprj_abc123\n    Name\t\t\tqatool-staging\n    Owner\t\t\tsomeone\n';
  const { vercel } = vercelWith(() => done(inspect));
  assert.deepEqual(await vercel.linkedProject(), { id: 'prj_abc123', name: 'qatool-staging' });
  assert.deepEqual(await vercel.inspectProject(), { id: 'prj_abc123', name: 'qatool-staging' });

  const missing = vercelWith(
    () => done(''),
    async () => {
      throw new Error('ENOENT');
    }
  ).vercel;
  assert.deepEqual(await missing.linkedProject(), { id: null, name: null });
});

test('vercel: the variable rows are read for Production, with their environments', async () => {
  const { vercel, calls } = vercelWith(() => done(ENV_LIST));
  assert.deepEqual(await vercel.variableRows(), [{ environments: ['Production'] }]);
  assert.deepEqual(calls[0].args, ['env', 'list', '--environment', 'production']);

  const several = vercelWith(() =>
    done(ENV_LIST.replace('Config    Production ', 'Config    Production, Preview'))
  ).vercel;
  assert.deepEqual(await several.variableRows(), [{ environments: ['Production', 'Preview'] }]);

  const none = vercelWith(() => done(ENV_LIST.replace(/ VITE_API_BASE_URL.*\n/, ''))).vercel;
  assert.deepEqual(await none.variableRows(), []);
});

test('vercel: an existing variable is updated in place, an absent one is added; the address goes on stdin, Production only', async () => {
  const { vercel, calls } = vercelWith(() => done());
  await vercel.setVariable(TUNNEL, { exists: true });
  await vercel.setVariable(TUNNEL, { exists: false });
  assert.deepEqual(calls[0].args, [
    'env',
    'update',
    'VITE_API_BASE_URL',
    '--environment',
    'production',
    '--yes',
  ]);
  assert.deepEqual(calls[1].args, [
    'env',
    'add',
    'VITE_API_BASE_URL',
    '--environment',
    'production',
    '--no-sensitive',
    '--yes',
  ]);
  assert.equal(calls[0].input, `${TUNNEL}\n`);
  for (const call of calls) {
    assert.equal(
      call.args.some((a) => a.includes('trycloudflare')),
      false,
      'the address is never an argument'
    );
    assert.equal(
      call.args.filter((a) => a.startsWith('VITE_')).length,
      1,
      'exactly one variable is named'
    );
    assert.equal(call.args.includes('preview') || call.args.includes('development'), false);
  }
});

test('vercel: failures carry redacted output and never the stored values', async () => {
  const { vercel } = vercelWith(() =>
    done('', 1, {
      stderr:
        'Error: value eyJ2IjoidjIiLCJjIjoiYWJj… for kelvins-projects-a05ff9d4 VERCEL_TOKEN=vercel_abcdefghijklmnop123',
    })
  );
  await assert.rejects(vercel.setVariable(TUNNEL, { exists: true }), (error) => {
    assert.match(error.message, /vercel env update failed \(exit 1\)/);
    assert.doesNotMatch(error.detail, /eyJ2Ijoi|a05ff9d4|vercel_abcdef/);
    return true;
  });
});

test("vercel: the production alias is not mistaken for the deployment's own address", async () => {
  const { vercel } = vercelWith(() =>
    done('https://qatool-staging.vercel.app\n', 0, {
      stderr: 'Production: https://qatool-staging-abc123-kelvins-projects.vercel.app [20s]\n',
    })
  );
  assert.deepEqual(await vercel.deployProduction(), {
    deploymentUrl: 'https://qatool-staging-abc123-kelvins-projects.vercel.app',
  });
  const onlyAlias = vercelWith(() => done('https://qatool-staging.vercel.app\n')).vercel;
  assert.deepEqual(await onlyAlias.deployProduction(), { deploymentUrl: null });
});

test("vercel: a production deployment returns the deployment's own address", async () => {
  const { vercel, calls } = vercelWith(() =>
    done('https://qatool-staging-abc123-kelvins-projects.vercel.app\n')
  );
  assert.deepEqual(await vercel.deployProduction(), {
    deploymentUrl: 'https://qatool-staging-abc123-kelvins-projects.vercel.app',
  });
  assert.deepEqual(calls[0].args, ['deploy', '--prod', '--yes']);
});

// --- tunnel verification -----------------------------------------------------------------------------------

/** A stand-in for the tunnel: answers like the demo backend unless told otherwise. */
function tunnelFetch({
  health = 200,
  noOrigin = 403,
  evil = 403,
  frontend = 401,
  extract = 401,
  acao = FRONTEND,
  credentials = null,
  failFirst = 0,
} = {}) {
  let n = 0;
  const calls = [];
  const fn = async (url, init = {}) => {
    const u = new URL(String(url));
    const origin = init.headers?.origin ?? null;
    calls.push({ path: `${init.method ?? 'GET'} ${u.pathname}`, origin });
    if (u.pathname === '/healthz') {
      if (++n <= failFirst)
        throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } });
      return new Response(health === 200 ? '{"status":"ok"}' : 'x', { status: health });
    }
    if (u.pathname === '/api/health') {
      const status = origin === null ? noOrigin : origin === FRONTEND ? frontend : evil;
      const headers =
        origin === FRONTEND
          ? {
              'access-control-allow-origin': acao,
              ...(credentials ? { 'access-control-allow-credentials': 'true' } : {}),
            }
          : {};
      return new Response('{}', { status, headers });
    }
    if (u.pathname === '/api/extract' || u.pathname === '/api/generate')
      return new Response('{}', { status: extract });
    return new Response('{}', { status: 404 });
  };
  fn.calls = calls;
  return fn;
}

const verify = (fetchImpl, extra = {}) =>
  verifyTunnel({
    url: TUNNEL,
    fetchImpl,
    sleep: async () => {},
    now: (() => {
      let t = 0;
      return () => (t += 1000);
    })(),
    timeoutMs: 20_000,
    ...extra,
  });

test("tunnel: the real backend's behaviour is verified end to end", async () => {
  const fetchImpl = tunnelFetch();
  const verdict = await verify(fetchImpl);
  assert.equal(verdict.ok, true);
  assert.equal(verdict.kind, 'ok');
  assert.equal(verdict.checks.length, 6);
  assert.deepEqual(
    fetchImpl.calls.map((c) => c.path),
    [
      'GET /healthz',
      'GET /api/health',
      'GET /api/health',
      'GET /api/health',
      'POST /api/extract',
      'POST /api/generate',
    ]
  );
});

test('tunnel: a new name that has not resolved yet is waited for', async () => {
  const verdict = await verify(tunnelFetch({ failFirst: 3 }));
  assert.equal(verdict.ok, true);
});

test('tunnel: one that never answers is "unreachable"', async () => {
  const verdict = await verify(tunnelFetch({ failFirst: 1_000 }), { timeoutMs: 8000 });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.kind, 'unreachable');
  assert.match(verdict.checks[0].detail, /ENOTFOUND/);
});

test('tunnel: something that answers but is not behind the protections is "unsafe"', async () => {
  for (const [label, options] of [
    ['an API that needs no Origin', { noOrigin: 200 }],
    ['an API that accepts any Origin', { evil: 200 }],
    ['an API without a ticket check', { frontend: 200 }],
    ['CORS for another origin', { acao: 'https://evil.example' }],
    ['credentialed CORS', { credentials: true }],
    ['a direct model route', { extract: 200 }],
  ]) {
    const verdict = await verify(tunnelFetch(options));
    assert.equal(verdict.ok, false, label);
    assert.equal(verdict.kind, 'unsafe', label);
    assert.ok(
      verdict.checks.some((c) => !c.ok),
      label
    );
  }
});

test('tunnel: an address that is not a Quick Tunnel is never even requested', async () => {
  const fetchImpl = tunnelFetch();
  const verdict = await verifyTunnel({
    url: 'https://evil.example',
    fetchImpl,
    sleep: async () => {},
  });
  assert.equal(verdict.ok, false);
  assert.equal(fetchImpl.calls.length, 0);
});

// --- the deployed frontend ---------------------------------------------------------------------------------

function frontendFetch(bundle) {
  return async (url) => {
    const u = new URL(String(url));
    if (u.pathname === '/')
      return new Response(
        '<html><script type="module" src="/assets/index-abc.js"></script><link rel="modulepreload" href="/assets/vendor-def.js"></html>',
        { status: 200 }
      );
    if (u.pathname === '/assets/index-abc.js') return new Response(bundle, { status: 200 });
    if (u.pathname === '/assets/vendor-def.js')
      return new Response('export const a = 1;', { status: 200 });
    return new Response('', { status: 404 });
  };
}

test('frontend: the address the deployed bundle was built with is found', async () => {
  const result = await inspectFrontend({ fetchImpl: frontendFetch(`const base="${TUNNEL}";`) });
  assert.deepEqual(result, { reachable: true, bases: [TUNNEL], assets: 2 });
});

test('frontend: a bundle with no address, or an unreachable page, says so', async () => {
  assert.deepEqual(await inspectFrontend({ fetchImpl: frontendFetch('const base="";') }), {
    reachable: true,
    bases: [],
    assets: 2,
  });
  const down = await inspectFrontend({
    fetchImpl: async () => {
      throw new TypeError('fetch failed');
    },
  });
  assert.deepEqual(down, { reachable: false, bases: [], assets: 0 });
  const notFound = await inspectFrontend({
    fetchImpl: async () => new Response('', { status: 404 }),
  });
  assert.equal(notFound.reachable, false);
});

test("frontend: only the page's own scripts are fetched", async () => {
  const requested = [];
  const fetchImpl = async (url) => {
    requested.push(String(url));
    if (String(url) === `${FRONTEND}/` || String(url) === FRONTEND)
      return new Response(
        '<script src="https://evil.example/x.js"></script><script src="/assets/a.js"></script>',
        { status: 200 }
      );
    return new Response('', { status: 200 });
  };
  await inspectFrontend({ fetchImpl });
  assert.equal(
    requested.some((u) => u.includes('evil.example')),
    false
  );
});
