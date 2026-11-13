import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { createAdapters } from './adapters/index.js';
import { loadConfig } from './config.js';

const compose = readFileSync(new URL('../../../compose.yaml', import.meta.url), 'utf8');

/** The text of one service in compose.yaml, comments removed. */
function service(name) {
  const start = compose.indexOf(`\n  ${name}:\n`);
  assert.ok(start >= 0, `${name} is defined`);
  const rest = compose.slice(start + 1);
  const end = rest.search(/\n(?:  [a-z][\w-]*:\n|[a-z]+:\n)/);
  return (end < 0 ? rest : rest.slice(0, end + 1)).replace(/^\s*#.*$/gm, '');
}

// --- the tunnel as a Compose service -------------------------------------------------------------------------

test('cloudflared: a pinned official image, a Quick Tunnel to the backend only, no credentials', () => {
  const block = service('cloudflared');
  assert.match(
    block,
    /image: cloudflare\/cloudflared:\d{4}\.\d+\.\d+@sha256:[0-9a-f]{64}\n/,
    'pinned by version and digest'
  );
  assert.doesNotMatch(block, /:latest/);
  // `tunnel --url <backend>`: a Quick Tunnel needs no token and no login.
  assert.match(block, /- tunnel\n/);
  assert.match(block, /- --url\n\s+- http:\/\/qatool-backend:3001\n/);
  assert.doesNotMatch(
    block,
    /TUNNEL_TOKEN|--token|credentials|cert\.pem|\.cloudflared|env_file|environment:/
  );
  // The only origin is the backend: never Apayee, the frontend container or the monitor.
  const origins = [...block.matchAll(/http:\/\/[^\s'"]+/g)].map((m) => m[0]);
  assert.deepEqual(origins, ['http://qatool-backend:3001']);
  assert.doesNotMatch(block, /4100|4101|5173|3300|apayee/i);
});

test('cloudflared: no published port, no volume, no privileges; starts after a healthy backend; restarts', () => {
  const block = service('cloudflared');
  assert.doesNotMatch(block, /^\s+ports:/m);
  assert.doesNotMatch(block, /^\s+volumes:/m);
  assert.doesNotMatch(block, /docker\.sock|privileged|cap_add|network_mode|pid:|user: *root/);
  for (const required of [
    /restart: unless-stopped/,
    /read_only: true/,
    /cap_drop: \[ALL\]/,
    /no-new-privileges:true/,
    /mem_limit: \d+m/,
    /pids_limit: \d+/,
    /qatool-backend:\n\s+condition: service_healthy/,
    /healthcheck:/,
  ]) {
    assert.match(block, required);
  }
});

test('cloudflared sits on a network of its own with the backend, and on no other', () => {
  const block = service('cloudflared');
  assert.match(block, /networks:\n\s+qatool-ingress-net:\n\s+ipv4_address: 10\.250\.250\.2\n/);
  assert.doesNotMatch(block, /qatool-net\b|qatool-monitor-net/);

  // Exactly two services are on the ingress network: the backend and the tunnel.
  const members = [
    'apayee',
    'qatool-backend',
    'qatool-frontend',
    'qatool-monitoring',
    'cloudflared',
  ].filter((name) => service(name).includes('qatool-ingress-net'));
  assert.deepEqual(members.sort(), ['cloudflared', 'qatool-backend']);

  const networks = compose
    .slice(compose.indexOf('\nnetworks:'), compose.indexOf('\nvolumes:'))
    .replace(/^\s*#.*$/gm, '');
  assert.match(
    networks,
    /qatool-ingress-net:\n\s+ipam:\n\s+config:\n\s+- subnet: 10\.250\.250\.0\/29/
  );
  assert.doesNotMatch(networks, /internal: *true/);
});

test('the tunnel changes nothing about Apayee: no new network, no port, same sign-in volume', () => {
  const apayee = service('apayee');
  assert.match(apayee, /networks: \[qatool-net\]/);
  assert.doesNotMatch(apayee, /ingress|cloudflared|ports:/);
  assert.match(apayee, /apayee-claude-config:\/home\/node\/\.claude/);
});

test('the host publishes the same ports as before the tunnel: 3001, 5173 and 3301, all on 127.0.0.1', () => {
  const published = [
    ...compose.replace(/^\s*#.*$/gm, '').matchAll(/^\s+- '([^']+:\d+:\d+)'$/gm),
  ].map((m) => m[1]);
  assert.deepEqual(published.sort(), [
    '127.0.0.1:3001:3001',
    '127.0.0.1:3301:3300',
    '127.0.0.1:5173:5173',
  ]);
});

// --- the monitor reading the address from a file ------------------------------------------------------------

const TUNNEL = 'https://lucky-oval-seeing-fabric.trycloudflare.com';
const containerEnv = {
  MONITOR_MODE: 'container',
  MONITOR_JOBS_SOURCE: 'socket',
  MONITOR_TUNNEL_URL_FILE: '/run/qatool-monitor/tunnel-url',
  MONITOR_ADAPTER_TIMEOUT_MS: '500',
};

function tunnelAdapter({ file, env = {}, healthy = true }) {
  const config = loadConfig({ ...containerEnv, ...env }, { platform: 'linux' });
  const asked = [];
  const adapters = createAdapters(config, {
    readFile: async (path) => {
      asked.push(path);
      if (file instanceof Error) throw file;
      return file;
    },
    fetchImpl: async (url) => {
      asked.push(String(url));
      return new Response(healthy ? '{"status":"ok"}' : 'bad gateway', {
        status: healthy ? 200 : 502,
      });
    },
    isProcessRunning: () => assert.fail('a container cannot see the host process list'),
    runDocker: () => assert.fail('no Docker'),
  });
  return { tunnel: adapters.find((a) => a.name === 'tunnel'), asked };
}

test('config: the tunnel address file must be an absolute path, and is optional', () => {
  assert.equal(loadConfig({}, { platform: 'linux' }).tunnelUrlFile, null);
  assert.equal(
    loadConfig(containerEnv, { platform: 'linux' }).tunnelUrlFile,
    '/run/qatool-monitor/tunnel-url'
  );
  for (const bad of ['relative/path', '/run/../etc/passwd', '/run//x', '/run/x y']) {
    assert.throws(
      () => loadConfig({ ...containerEnv, MONITOR_TUNNEL_URL_FILE: bad }, { platform: 'linux' }),
      /MONITOR_TUNNEL_URL_FILE/,
      bad
    );
  }
});

test('tunnel: the address in the file is checked through /healthz, and the file is read every time', async () => {
  const { tunnel, asked } = tunnelAdapter({ file: `${TUNNEL}\n` });
  const first = await tunnel.collect();
  assert.equal(first.healthy, true);
  assert.equal(first.publicConfigured, true);
  assert.equal(first.processRunning, null);
  assert.deepEqual(asked, ['/run/qatool-monitor/tunnel-url', `${TUNNEL}/healthz`]);
  await tunnel.collect();
  assert.equal(asked.filter((a) => a === '/run/qatool-monitor/tunnel-url').length, 2);
});

test('tunnel: a dead address reads as down, not as "not configured"', async () => {
  const { tunnel } = tunnelAdapter({ file: TUNNEL, healthy: false });
  const result = await tunnel.collect();
  assert.equal(result.healthy, false);
  assert.equal(result.public.healthy, false);
});

test('tunnel: no file, an empty file, or a file with anything but an https origin is "no address"', async () => {
  for (const file of [
    Object.assign(new Error('ENOENT'), { code: 'ENOENT' }),
    '',
    '\n',
    'http://x.trycloudflare.com',
    `${TUNNEL}/api`,
    `https://user:pass@x-y.trycloudflare.com`,
    'not a url',
    'x'.repeat(2000),
  ]) {
    const { tunnel, asked } = tunnelAdapter({ file });
    await assert.rejects(
      tunnel.collect(),
      (error) => error.code === 'NOT_CONFIGURED' && /start-qatool\.ps1/.test(error.message),
      String(file).slice(0, 30)
    );
    assert.equal(
      asked.some((a) => a.includes('/healthz')),
      false,
      'nothing is requested for an invalid address'
    );
  }
});

test('tunnel: an address set in the configuration wins over the file', async () => {
  const { tunnel, asked } = tunnelAdapter({
    file: TUNNEL,
    env: { MONITOR_TUNNEL_URL: 'https://other-fixed-name-here.trycloudflare.com' },
  });
  await tunnel.collect();
  assert.equal(
    asked.some((a) => a.startsWith('/run/')),
    false
  );
  assert.ok(asked.includes('https://other-fixed-name-here.trycloudflare.com/healthz'));
});
