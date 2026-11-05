import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { buildApp } from '../app.js';
import { fakeProviders } from '../jobs/fixtures/demo.js';
import { assertSecuritySettings, loadSecuritySettings, SecurityConfigError } from './settings.js';

/**
 * The staging templates (deploy/staging.*.env.example), held to the real settings parser. They are
 * checklists to copy lines from, so what matters is that the names are the ones the backend reads,
 * that the shipped values are accepted once the owner fills in the two secrets, and that the file
 * as shipped can neither switch the demo on nor carry a secret.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** Active `NAME=value` lines only; comments and blank lines are skipped. */
function parseEnvFile(relative) {
  const env = {};
  for (const line of readFileSync(path.join(root, relative), 'utf8').split('\n')) {
    const text = line.trim();
    if (text === '' || text.startsWith('#')) continue;
    const at = text.indexOf('=');
    assert.ok(at > 0, `not NAME=value: ${text}`);
    env[text.slice(0, at)] = text.slice(at + 1);
  }
  return env;
}

const template = parseEnvFile('deploy/staging.backend.env.example');

/** Random stand-ins made for this test run. They are not real credentials and are never printed. */
const filledIn = () => ({
  ...template,
  PUBLIC_DEMO: 'true',
  TICKET_SECRET: randomBytes(48).toString('base64'),
  TURNSTILE_SECRET: `0x${randomBytes(20).toString('hex')}`,
});

const problemsOf = (env) => {
  try {
    assertSecuritySettings(loadSecuritySettings(env));
    return [];
  } catch (error) {
    assert.ok(error instanceof SecurityConfigError);
    return error.problems;
  }
};

describe('the backend staging template', () => {
  it('uses only setting names the backend actually reads', () => {
    const readBySettings = readFileSync(path.join(root, 'server/security/settings.js'), 'utf8');
    for (const name of Object.keys(template)) {
      assert.ok(
        readBySettings.includes(`'${name}'`) || readBySettings.includes(`env.${name}`),
        name
      );
    }
  });

  it('is the staging origin, hostname and action, and nothing broader', () => {
    assert.equal(template.ALLOWED_ORIGINS, 'https://qatool-staging.vercel.app');
    assert.equal(template.TURNSTILE_HOSTNAMES, 'qatool-staging.vercel.app');
    assert.equal(template.TURNSTILE_ACTION, 'qatool_demo');
    assert.equal(template.TRUSTED_PROXY_PEERS, '172.18.0.1');
    assert.doesNotMatch(Object.values(template).join(' '), /\*|localhost|trycloudflare|:\/\/.*\//);
  });

  it('ships with the demo OFF and both secrets blank, so copying it cannot go live by accident', () => {
    assert.equal(template.PUBLIC_DEMO, 'false');
    assert.equal(template.TICKET_SECRET, '');
    assert.equal(template.TURNSTILE_SECRET, '');
    assert.deepEqual(problemsOf(template), [], 'demo off: valid as it stands');
  });

  it('sets neither concurrency nor the owner mode, so the defaults (1 worker) stand', () => {
    for (const name of ['PUBLIC_MODE', 'JOB_WORKERS', 'JOB_MAX_PENDING', 'APAYEE_MAX_CONCURRENT']) {
      assert.equal(template[name], undefined, name);
    }
    assert.equal(loadSecuritySettings(filledIn()).jobs.workers, 1);
  });

  it('is accepted once the two secrets are filled in and the demo switched on', () => {
    const settings = loadSecuritySettings(filledIn());
    assert.deepEqual(problemsOf(filledIn()), []);
    assert.equal(settings.demoMode, true);
    assert.equal(settings.publicMode, false);
    assert.deepEqual(settings.allowedOrigins, ['https://qatool-staging.vercel.app']);
    assert.deepEqual(settings.demo.turnstile.hostnames, ['qatool-staging.vercel.app']);
    assert.deepEqual(settings.trustedProxyPeers, ['172.18.0.1']);
  });

  it('fails closed without either secret, naming the variable and never a value', () => {
    for (const missing of ['TICKET_SECRET', 'TURNSTILE_SECRET']) {
      const problems = problemsOf({ ...filledIn(), [missing]: '' });
      assert.ok(
        problems.some((problem) => problem.includes(missing)),
        missing
      );
    }
    const short = problemsOf({ ...filledIn(), TICKET_SECRET: 'short' }).join(' ');
    assert.match(short, /TICKET_SECRET/);
    assert.doesNotMatch(short, /short$/);
  });

  it('refuses the origin spellings that would silently not match the browser', () => {
    for (const bad of [
      'https://qatool-staging.vercel.app/',
      'qatool-staging.vercel.app',
      'http://qatool-staging.vercel.app',
      'https://*.vercel.app',
    ]) {
      assert.ok(problemsOf({ ...filledIn(), ALLOWED_ORIGINS: bad }).length > 0, bad);
    }
    assert.ok(
      problemsOf({ ...filledIn(), TURNSTILE_HOSTNAMES: 'https://qatool-staging.vercel.app' })
        .length > 0
    );
    assert.ok(problemsOf({ ...filledIn(), ALLOWED_ORIGINS: '' }).length > 0, 'no origin');
  });

  it('cannot be combined with the owner mode', () => {
    const problems = problemsOf({ ...filledIn(), PUBLIC_MODE: 'true' });
    assert.ok(problems.some((problem) => /cannot both be on/.test(problem)));
  });

  it('serves the staging origin and no other, and registers no direct model route', async () => {
    const env = filledIn();
    const security = loadSecuritySettings(env);
    assertSecuritySettings(security);
    // A stand-in gateway: nothing here may reach Apayee or Cloudflare.
    const app = buildApp({ logger: false, security, providers: fakeProviders() });
    try {
      await app.ready();
      const call = (url, headers, method = 'GET') => app.inject({ method, url, headers });

      assert.equal((await call('/healthz')).statusCode, 200, 'liveness stays open');
      const noOrigin = await call('/api/health');
      assert.equal(noOrigin.statusCode, 403);
      const stranger = await call('/api/health', { origin: 'https://example.org' });
      assert.equal(stranger.statusCode, 403);
      const preview = await call('/api/health', {
        origin: 'https://qatool-staging-abc123xyz-example-team.vercel.app',
      });
      assert.equal(preview.statusCode, 403, 'a preview URL is a different origin');
      const noTicket = await call('/api/health', { origin: template.ALLOWED_ORIGINS });
      assert.equal(noTicket.statusCode, 401);

      for (const url of ['/api/extract', '/api/generate']) {
        const direct = await call(url, { origin: template.ALLOWED_ORIGINS }, 'POST');
        assert.equal(direct.statusCode, 401, `${url}: refused for want of a ticket`);
      }
      const sessionPreflight = await call(
        '/api/session',
        {
          origin: template.ALLOWED_ORIGINS,
          'access-control-request-method': 'POST',
          'access-control-request-headers': 'content-type',
        },
        'OPTIONS'
      );
      assert.equal(sessionPreflight.statusCode, 204);
      assert.equal(
        sessionPreflight.headers['access-control-allow-origin'],
        template.ALLOWED_ORIGINS
      );
      assert.equal(sessionPreflight.headers['access-control-allow-credentials'], undefined);
    } finally {
      await app.close();
    }
  });
});
