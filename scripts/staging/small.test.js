import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { isOn, peerListCovers, readSettings } from './envfile.js';
import { redact, tail } from './redact.js';
import { createRunner } from './shell.js';
import { createState } from './state.js';
import { extractTunnelUrl, normalizeTunnelUrl } from './tunnel-url.js';

// --- tunnel address ----------------------------------------------------------------------------------------

const BANNER = `
2026-11-06T00:01:02Z INF Thank you for trying Cloudflare Tunnel. Doing so, without a Cloudflare account, is a quick way to experiment and try it out.
2026-11-06T00:01:02Z INF Requesting new quick Tunnel on trycloudflare.com...
2026-11-06T00:01:05Z INF +--------------------------------------------------------------------------------------------+
2026-11-06T00:01:05Z INF |  Your quick Tunnel has been created! Visit it at (it may take some time to be reachable):  |
2026-11-06T00:01:05Z INF |  https://lucky-oval-seeing-fabric.trycloudflare.com                                        |
2026-11-06T00:01:05Z INF +--------------------------------------------------------------------------------------------+
2026-11-06T00:01:06Z INF Registered tunnel connection connIndex=0
`;

test('the tunnel address is read from the banner, as an origin', () => {
  assert.equal(extractTunnelUrl(BANNER), 'https://lucky-oval-seeing-fabric.trycloudflare.com');
});

test('the newest address wins when a restarted container logged several', () => {
  const log = `${BANNER}\nINF |  https://old-name-from-before-reboot.trycloudflare.com |\n${BANNER.replace('lucky-oval-seeing-fabric', 'brand-new-quick-tunnel')}`;
  assert.equal(extractTunnelUrl(log), 'https://brand-new-quick-tunnel.trycloudflare.com');
});

test("Cloudflare's own hosts and error lines are not tunnel addresses", () => {
  const failed =
    'ERR failed to request quick Tunnel: Post "https://api.trycloudflare.com/tunnel": dial tcp: lookup api.trycloudflare.com';
  assert.equal(extractTunnelUrl(failed), null);
  assert.equal(
    extractTunnelUrl('see https://www.trycloudflare.com and https://dash.trycloudflare.com'),
    null
  );
  assert.equal(extractTunnelUrl(''), null);
  assert.equal(extractTunnelUrl(undefined), null);
  assert.equal(extractTunnelUrl('no address here'), null);
});

test('only an exact https origin on trycloudflare.com validates', () => {
  const good = 'https://lucky-oval-seeing-fabric.trycloudflare.com';
  assert.equal(normalizeTunnelUrl(good), good);
  assert.equal(normalizeTunnelUrl(`${good}/`), good);
  assert.equal(normalizeTunnelUrl('HTTPS://Lucky-Oval-Seeing-Fabric.TryCloudflare.com'), good);
  for (const bad of [
    'http://lucky-oval-seeing-fabric.trycloudflare.com',
    'https://lucky-oval-seeing-fabric.trycloudflare.com/api',
    'https://lucky-oval-seeing-fabric.trycloudflare.com/?x=1',
    'https://user:pass@lucky-oval-seeing-fabric.trycloudflare.com',
    'https://lucky-oval-seeing-fabric.trycloudflare.com:8443',
    'https://lucky-oval-seeing-fabric.trycloudflare.com.evil.example',
    'https://evil.example/https://lucky-oval-seeing-fabric.trycloudflare.com',
    'https://trycloudflare.com',
    'https://api.trycloudflare.com',
    'https://nohyphen.trycloudflare.com',
    '',
    null,
    42,
  ]) {
    assert.equal(normalizeTunnelUrl(bad), null, String(bad));
  }
});

// --- .env reading --------------------------------------------------------------------------------------------

test('only the asked-for, uncommented keys come back; no other line is ever exposed', () => {
  const text = [
    '# PUBLIC_DEMO=false',
    'TICKET_SECRET=never-return-this-value-0123456789',
    'PUBLIC_DEMO=true  # staging',
    "ALLOWED_ORIGINS='https://qatool-staging.vercel.app'",
    'TRUSTED_PROXY_PEERS = 172.18.0.1, 10.250.250.2',
  ].join('\n');
  const settings = readSettings(text, [
    'PUBLIC_DEMO',
    'PUBLIC_MODE',
    'ALLOWED_ORIGINS',
    'TRUSTED_PROXY_PEERS',
  ]);
  assert.deepEqual(settings, {
    PUBLIC_DEMO: 'true',
    PUBLIC_MODE: null,
    ALLOWED_ORIGINS: 'https://qatool-staging.vercel.app',
    TRUSTED_PROXY_PEERS: '172.18.0.1, 10.250.250.2',
  });
  assert.doesNotMatch(JSON.stringify(settings), /never-return-this-value/);
  assert.equal(isOn('true'), true);
  assert.equal(isOn('False'), false);
  assert.equal(isOn(null), false);
});

test('peer lists: an address, a CIDR range, or neither', () => {
  assert.equal(peerListCovers('172.18.0.1,10.250.250.2', '10.250.250.2'), true);
  assert.equal(peerListCovers('10.250.250.0/29', '10.250.250.2'), true);
  assert.equal(peerListCovers('10.250.250.0/30', '10.250.250.2'), true);
  assert.equal(peerListCovers('10.250.250.0/31', '10.250.250.2'), false);
  assert.equal(peerListCovers('172.18.0.1', '10.250.250.2'), false);
  assert.equal(peerListCovers('', '10.250.250.2'), false);
  assert.equal(peerListCovers(null, '10.250.250.2'), false);
  assert.equal(peerListCovers('garbage, 10.250.250.0/99', '10.250.250.2'), false);
  assert.equal(
    peerListCovers('0.0.0.0/0', '10.250.250.2'),
    true,
    'a catch-all does cover it (the script does not judge breadth)'
  );
});

// --- redaction -----------------------------------------------------------------------------------------------

test('secrets and account names are masked; public addresses are kept', () => {
  const dirty = [
    'Authorization: Bearer abcdefghijklmnop1234567890',
    'VERCEL_TOKEN=vercel_abcdefghijklmnop123456',
    'TICKET_SECRET=hunter22222',
    'value eyJ2IjoidjIiLCJjIjoiYWJjZGVm…',
    'project kelvins-projects-a05ff9d4/qatool-staging',
    'C:\\Users\\kelvi\\AppData\\Local\\Temp\\x',
    'visit https://lucky-oval-seeing-fabric.trycloudflare.com and https://qatool-staging.vercel.app',
  ].join('\n');
  const out = redact(dirty);
  for (const leaked of [
    'abcdefghijklmnop12',
    'vercel_abcdef',
    'hunter22222',
    'eyJ2Ijoi',
    'a05ff9d4',
    'kelvi',
  ]) {
    assert.equal(out.includes(leaked), false, leaked);
  }
  assert.match(out, /https:\/\/lucky-oval-seeing-fabric\.trycloudflare\.com/);
  assert.match(out, /https:\/\/qatool-staging\.vercel\.app/);
  assert.equal(redact('\u001b[32mready\u001b[0m'), 'ready');
});

test('tail keeps the last lines, redacted', () => {
  const text = Array.from({ length: 30 }, (_, i) => `line ${i} TICKET_SECRET=zzzzzzzz${i}`).join(
    '\n'
  );
  const out = tail(text, 3);
  assert.equal(out.split('\n').length, 3);
  assert.doesNotMatch(out, /zzzzzzzz/);
  assert.match(out, /line 29/);
});

// --- the local state -----------------------------------------------------------------------------------------

async function withState(fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'qatool-state-'));
  try {
    await fn(createState({ dir, now: () => Date.parse('2026-11-06T01:02:03Z') }), dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('state: starts empty, stores only validated public values, and survives a re-read', async () => {
  await withState(async (state) => {
    assert.equal((await state.read()).tunnelUrl, null);
    await state.update({
      tunnelUrl: 'https://lucky-oval-seeing-fabric.trycloudflare.com',
      tunnelVerifiedAt: '2026-11-06T01:00:00.000Z',
    });
    const again = await state.read();
    assert.equal(again.tunnelUrl, 'https://lucky-oval-seeing-fabric.trycloudflare.com');
    assert.equal(again.lastDeployedUrl, null);
  });
});

test('state: an unknown field or an invalid value is refused, not stored', async () => {
  await withState(async (state, dir) => {
    await assert.rejects(state.update({ token: 'abc' }), /unknown state field/);
    await assert.rejects(state.update({ tunnelUrl: 'http://evil.example' }), /invalid value/);
    await assert.rejects(
      state.update({ lastDeploymentUrl: 'https://evil.example' }),
      /invalid value/
    );
    assert.equal((await state.read()).tunnelUrl, null);
    // A hand-edited file cannot smuggle anything in either: unknown keys are dropped on read.
    await writeFile(
      state.file,
      JSON.stringify({
        tunnelUrl: 'https://lucky-oval-seeing-fabric.trycloudflare.com',
        password: 'x',
      })
    );
    const read = await state.read();
    assert.deepEqual(Object.keys(read).sort(), [
      'lastDeployedAt',
      'lastDeployedUrl',
      'lastDeploymentUrl',
      'tunnelUrl',
      'tunnelVerifiedAt',
    ]);
    assert.ok(dir);
  });
});

test('state: a damaged file is "no memory", not a crash', async () => {
  await withState(async (state) => {
    await writeFile(state.file, '{not json', 'utf8').catch(async () => {
      await state.update({ tunnelUrl: null });
      await writeFile(state.file, '{not json', 'utf8');
    });
    assert.equal((await state.read()).lastDeployedUrl, null);
  });
});

test('state: the file on disk holds no secret-shaped content', async () => {
  await withState(async (state) => {
    await state.update({
      tunnelUrl: 'https://lucky-oval-seeing-fabric.trycloudflare.com',
      lastDeployedUrl: 'https://lucky-oval-seeing-fabric.trycloudflare.com',
      lastDeployedAt: '2026-11-06T01:00:00.000Z',
      lastDeploymentUrl: 'https://qatool-staging-abc123.vercel.app',
    });
    const text = await readFile(state.file, 'utf8');
    assert.doesNotMatch(text, /secret|token|password|bearer|eyJ/i);
    assert.equal(JSON.parse(text).version, 1);
  });
});

test('state: the monitor file holds the verified address alone, and only a tunnel address', async () => {
  await withState(async (state) => {
    await state.writeMonitorUrl('https://lucky-oval-seeing-fabric.trycloudflare.com');
    assert.equal(
      await readFile(state.monitorFile, 'utf8'),
      'https://lucky-oval-seeing-fabric.trycloudflare.com\n'
    );
    await assert.rejects(state.writeMonitorUrl('https://evil.example'), /not a tunnel address/);
    assert.equal(
      (await readFile(state.monitorFile, 'utf8')).trim(),
      'https://lucky-oval-seeing-fabric.trycloudflare.com'
    );
    await state.writeMonitorUrl(null);
    assert.equal(await readFile(state.monitorFile, 'utf8'), '');
    await assert.rejects(
      stat(`${state.monitorFile}.${process.pid}.tmp`),
      { code: 'ENOENT' },
      'no temporary file is left'
    );
  });
});

// --- running programs ----------------------------------------------------------------------------------------

test('the runner starts only docker and vercel', () => {
  const run = createRunner({ platform: 'linux' });
  for (const program of ['powershell', 'cmd', 'node', 'curl', 'sh', 'rm', 'cloudflared']) {
    assert.throws(() => run(program, ['x']), /refusing to run/, program);
  }
});

test('through the Windows shell, an argument that a shell could interpret is refused', () => {
  const run = createRunner({ platform: 'win32' });
  for (const arg of [
    'a b',
    'a;b',
    'a&b',
    'a|b',
    '$(x)',
    '`x`',
    'a>b',
    'a"b',
    "a'b",
    '%PATH%',
    'a\nb',
  ]) {
    assert.throws(
      () => run('vercel', ['env', arg]),
      /not safe to pass through a shell/,
      JSON.stringify(arg)
    );
  }
  assert.throws(() => run('vercel', ['']), /non-empty/);
});

test('a missing program is a result, not an exception', async () => {
  const run = createRunner({ platform: 'linux' });
  // `docker` with an impossible subcommand fails quickly whether or not Docker is installed.
  const result = await run('docker', ['this-subcommand-does-not-exist'], { timeoutMs: 20_000 });
  assert.equal(typeof result.code === 'number' || result.missing === true, true);
});
