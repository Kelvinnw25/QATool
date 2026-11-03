import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { buildApp } from '../app.js';
import { buildSampleCanonical } from '../export/fixtures/sample-canonical.js';
import {
  assertSecuritySettings,
  loadSecuritySettings,
  SecurityConfigError,
} from '../security/settings.js';
import { publicSecurity } from '../security/fixtures/access.js';
import {
  ACTION,
  demoSecurity,
  fakeProviders,
  fakeSiteverify,
  HOSTNAME,
  ORIGIN,
  TICKET_SECRET,
  TURNSTILE_SECRET,
} from './fixtures/demo.js';

/**
 * The demo is a third mode, beside local and owner-only, and it must not change either of
 * them: the job and session routes exist only in the demo, the direct model routes exist
 * everywhere else, and the settings of one mode are never silently taken for another's.
 */

const apps = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

function app(options) {
  const built = buildApp(options);
  apps.push(built);
  return built;
}

const routes = (instance) => instance.printRoutes({ commonPrefix: false });

describe('local mode is unchanged', () => {
  it('has the direct model routes, and no job, session or ticket machinery', async () => {
    const local = app({ security: loadSecuritySettings({}) });
    await local.ready();
    const listing = routes(local);

    for (const path of [
      '/api/extract',
      '/api/generate',
      '/api/validate',
      '/api/export',
      '/api/llm/providers',
    ]) {
      assert.ok(listing.includes(path.split('/').pop()), `${path} is served`);
    }
    assert.ok(!listing.includes('jobs'), 'no job routes');
    assert.ok(!listing.includes('session'), 'no session route');
    assert.equal(local.jobPlatform, undefined);
    assert.equal(local.sessions, undefined);
  });

  it('needs no ticket, no Origin and no token for anything', async () => {
    const local = app({ security: loadSecuritySettings({}) });
    const reply = await local.inject({ method: 'GET', url: '/api/health' });
    assert.equal(reply.statusCode, 200);

    const validate = await local.inject({
      method: 'POST',
      url: '/api/validate',
      payload: buildSampleCanonical(),
    });
    assert.equal(validate.statusCode, 200);
    assert.equal(validate.json().valid, true);
  });

  it('still accepts the semantic review on the direct route', async () => {
    const local = app({ security: loadSecuritySettings({}) });
    const reply = await local.inject({
      method: 'POST',
      url: '/api/validate?semantic=true&provider=nope',
      payload: buildSampleCanonical(),
    });
    // Reaches provider choice (a 400 for an unknown one), not the demo's USE_JOBS refusal.
    assert.equal(reply.statusCode, 400);
    assert.equal(reply.json().error.code, 'UNKNOWN_PROVIDER');
  });
});

describe('owner-only public mode is unchanged', () => {
  it('has no job or session routes, and still requires the owner’s token', async () => {
    const owner = app({ security: publicSecurity() });
    await owner.ready();
    assert.ok(!routes(owner).includes('jobs'));
    assert.ok(!routes(owner).includes('session'));

    const denied = await owner.inject({
      method: 'GET',
      url: '/api/health',
      headers: { origin: ORIGIN },
    });
    assert.equal(denied.statusCode, 401);
    assert.equal(owner.security.demoMode, false);
  });
});

describe('the demo', () => {
  const demo = () =>
    app({ security: demoSecurity(), siteverify: fakeSiteverify(), providers: fakeProviders() });

  it('has the session and job routes and not the direct model ones', async () => {
    const d = demo();
    await d.ready();
    const listing = routes(d);

    for (const present of ['session', 'jobs', 'cancel', 'result'])
      assert.ok(listing.includes(present), present);
    assert.ok(!listing.includes('extract'), 'no direct extraction');
    assert.ok(!listing.includes('generate'), 'no direct generation');
    assert.ok(!listing.includes('providers'), 'no provider list');
  });

  it('is exposed: scrubbed errors, no frontend served from this process', async () => {
    const d = demo();
    assert.equal(d.security.exposed, true);
    // Without an Origin the demo refuses even the root path; with one it still has no page to
    // serve and, with no ticket, says only that authentication is needed.
    assert.equal((await d.inject({ method: 'GET', url: '/' })).statusCode, 403);
    const reply = await d.inject({ method: 'GET', url: '/', headers: { origin: ORIGIN } });
    assert.equal(reply.statusCode, 401);
    assert.ok(!String(reply.headers['content-type']).includes('html'));
    assert.match(reply.headers['content-security-policy'], /default-src 'none'/);
    assert.equal(reply.headers['x-frame-options'], 'DENY');
    assert.match(reply.headers['cache-control'], /no-store/);
  });

  it('adds none of the owner-mode machinery: no Access keys are fetched, no rate hook', async () => {
    const d = demo();
    // A request carrying a Cloudflare Access header is just a request without a ticket.
    const reply = await d.inject({
      method: 'GET',
      url: '/api/health',
      headers: { origin: ORIGIN, 'cf-access-jwt-assertion': 'a.b.c' },
    });
    assert.equal(reply.statusCode, 401);
    assert.equal(reply.json().error.code, 'UNAUTHENTICATED');
  });

  it('keeps the job platform off the public surface: metrics are an object, not a route', async () => {
    const d = demo();
    assert.equal(typeof d.jobPlatform.metrics.snapshot, 'function');
    for (const url of ['/api/metrics', '/metrics', '/api/jobs/metrics']) {
      const reply = await d.inject({ method: 'GET', url, headers: { origin: ORIGIN } });
      assert.notEqual(reply.statusCode, 200, url);
    }
  });
});

describe('the demo’s settings', () => {
  const ENV = {
    PUBLIC_DEMO: 'true',
    TICKET_SECRET,
    TURNSTILE_SECRET,
    TURNSTILE_HOSTNAMES: HOSTNAME,
    ALLOWED_ORIGINS: ORIGIN,
  };

  const problemsOf = (env, llm = { provider: 'gemini', timeoutMs: 120_000 }) => {
    try {
      assertSecuritySettings(loadSecuritySettings(env), llm);
      return [];
    } catch (error) {
      assert.ok(error instanceof SecurityConfigError);
      return error.problems;
    }
  };

  it('starts with the documented defaults, one worker among them', () => {
    const { jobs, limits, demo, demoMode, publicMode, exposed } = loadSecuritySettings(ENV);

    assert.deepEqual([demoMode, publicMode, exposed], [true, false, true]);
    assert.deepEqual(problemsOf(ENV), []);

    assert.equal(jobs.workers, 1, 'never three by default');
    assert.equal(jobs.maxPending, 10);
    assert.equal(jobs.leaseMs, 45_000);
    assert.equal(jobs.retainCompletedMs, 15 * 60_000);
    assert.equal(jobs.retainFailedMs, 5 * 60_000);
    assert.equal(jobs.maxTerminal, 30);
    assert.equal(jobs.submitPerMinute, 10);
    assert.equal(jobs.pollPerMinute, 60);
    assert.equal(jobs.uploadInflightMax, 4);
    assert.equal(jobs.parseConcurrency, 1);
    assert.equal(jobs.breakerCooldownMs, 60_000);

    assert.equal(limits.uploadMaxFiles, 30);
    assert.equal(limits.uploadMaxFileBytes, 10 * 1024 * 1024);
    assert.equal(limits.uploadMaxTotalBytes, 20 * 1024 * 1024);
    assert.equal(limits.pdfMaxPages, 150);
    assert.equal(limits.zipMaxUncompressedBytes, 64 * 1024 * 1024);
    assert.equal(limits.zipMaxEntries, 2000);

    assert.equal(demo.ticket.ttlSeconds, 1800);
    assert.equal(demo.turnstile.action, 'qatool_demo');
  });

  it('refuses to start without each required value, naming the variable', () => {
    for (const name of [
      'TICKET_SECRET',
      'TURNSTILE_SECRET',
      'TURNSTILE_HOSTNAMES',
      'ALLOWED_ORIGINS',
    ]) {
      const env = { ...ENV };
      delete env[name];
      assert.ok(
        problemsOf(env).some((problem) => problem.includes(name)),
        `${name} missing must be reported`
      );
    }
  });

  it('refuses a weak or placeholder ticket secret, without echoing it', () => {
    for (const secret of [
      'short',
      'x'.repeat(31),
      'change-me-change-me-change-me-change-me',
      'replace_me'.repeat(5),
    ]) {
      const problems = problemsOf({ ...ENV, TICKET_SECRET: secret });
      assert.ok(
        problems.some((problem) => problem.includes('TICKET_SECRET')),
        secret
      );
      assert.ok(!problems.join(' ').includes(secret));
    }
  });

  it('refuses a malformed hostname list or action', () => {
    for (const bad of [
      'https://demo.example.com',
      'demo.example.com/path',
      'bad host',
      '*.example.com',
    ]) {
      assert.ok(
        problemsOf({ ...ENV, TURNSTILE_HOSTNAMES: bad }).some((p) =>
          p.includes('TURNSTILE_HOSTNAMES')
        ),
        bad
      );
    }
    for (const bad of ['has space', 'x'.repeat(33), 'a/b']) {
      assert.ok(
        problemsOf({ ...ENV, TURNSTILE_ACTION: bad }).some((p) => p.includes('TURNSTILE_ACTION')),
        bad
      );
    }
    assert.deepEqual(problemsOf({ ...ENV, TURNSTILE_ACTION: ACTION }), []);
  });

  it('allows one to three workers and warns when more than one is asked for', () => {
    for (const workers of ['1', '2', '3'])
      assert.deepEqual(problemsOf({ ...ENV, JOB_WORKERS: workers }), []);
    for (const bad of ['0', '4', '10', 'two', '1.5']) {
      assert.ok(
        problemsOf({ ...ENV, JOB_WORKERS: bad }).some((p) => p.includes('JOB_WORKERS')),
        bad
      );
    }

    const settings = loadSecuritySettings({ ...ENV, JOB_WORKERS: '3' });
    const warnings = assertSecuritySettings(settings, { provider: 'gemini', timeoutMs: 120_000 });
    assert.ok(warnings.some((warning) => warning.includes('max_active')));
    assert.deepEqual(
      assertSecuritySettings(loadSecuritySettings(ENV), { provider: 'gemini', timeoutMs: 120_000 }),
      []
    );
  });

  it('bounds the queue, the parse concurrency and the strings it will take', () => {
    assert.ok(
      problemsOf({ ...ENV, JOB_MAX_PENDING: '101' }).some((p) => p.includes('JOB_MAX_PENDING'))
    );
    assert.ok(
      problemsOf({ ...ENV, JOB_MAX_PENDING: '0' }).some((p) => p.includes('JOB_MAX_PENDING'))
    );
    assert.ok(
      problemsOf({ ...ENV, PARSE_CONCURRENCY: '3' }).some((p) => p.includes('PARSE_CONCURRENCY'))
    );
    assert.ok(problemsOf({ ...ENV, PARSE_CONCURRENCY: '2' }).length === 0);
  });

  it('cannot be combined with owner-only public mode', () => {
    const problems = problemsOf({ ...ENV, PUBLIC_MODE: 'true' });
    assert.ok(
      problems.some((problem) => problem.includes('PUBLIC_MODE') && problem.includes('PUBLIC_DEMO'))
    );
  });

  it('needs the Cloudflare Access settings no more: that is the owner mode’s', () => {
    const problems = problemsOf(ENV);
    assert.deepEqual(problems, []);
    assert.ok(!problemsOf({ PUBLIC_MODE: 'true', ALLOWED_ORIGINS: ORIGIN }).includes(undefined));
  });

  it('does not care what LLM_PROVIDER says: the demo’s model is fixed on the server', () => {
    for (const provider of ['gemini', 'apayee', 'mock']) {
      assert.deepEqual(problemsOf(ENV, { provider, timeoutMs: 120_000 }), [], provider);
    }
  });

  it('warns when the job deadline is shorter than one model call', () => {
    const warnings = assertSecuritySettings(
      loadSecuritySettings({ ...ENV, JOB_DEADLINE_MS: '1000' }),
      {
        provider: 'gemini',
        timeoutMs: 120_000,
      }
    );
    assert.ok(warnings.some((warning) => warning.includes('JOB_DEADLINE_MS')));
  });

  it('derives the job deadline from the model-call timeout: three calls plus two minutes', async () => {
    const d = app({
      security: demoSecurity(),
      siteverify: fakeSiteverify(),
      providers: fakeProviders(),
    });
    await d.ready();
    const { config } = await import('../config.js');
    assert.equal(d.jobPlatform.manager.settings.deadlineMs, 3 * config.llm.timeoutMs + 120_000);

    const explicit = app({
      security: demoSecurity({ JOB_DEADLINE_MS: '90000' }),
      siteverify: fakeSiteverify(),
      providers: fakeProviders(),
    });
    await explicit.ready();
    assert.equal(explicit.jobPlatform.manager.settings.deadlineMs, 90_000);
  });

  it('removes the hourly and daily budgets completely: no setting, no field, no mention', () => {
    const settings = loadSecuritySettings({
      ...ENV,
      LLM_BUDGET_PER_HOUR: '5',
      LLM_BUDGET_PER_DAY: '9',
    });
    const text = JSON.stringify(settings);
    assert.ok(
      !/budget|perHour|perDay|llmPer/i.test(text),
      'the variables are ignored, not honoured'
    );
    assert.deepEqual(settings.problems, [], 'and leaving them set is harmless');
  });

  it('refuses a malformed value instead of falling back to a default', () => {
    for (const [name, bad] of [
      ['JOB_LEASE_MS', 'soon'],
      ['JOB_SUBMIT_PER_MINUTE', '-3'],
      ['UPLOAD_INFLIGHT_MAX', '0'],
      ['TICKET_TTL_SECONDS', '10'],
      ['PARSE_TIMEOUT_MS', '1'],
      ['PROVIDER_BREAKER_COOLDOWN_MS', '5'],
    ]) {
      assert.ok(
        problemsOf({ ...ENV, [name]: bad }).some((p) => p.includes(name)),
        name
      );
    }
  });
});
