import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildApp } from '../app.js';
import {
  assertSecuritySettings,
  loadSecuritySettings,
  MAX_PUBLIC_DEADLINE_MS,
  SecurityConfigError,
} from './settings.js';

const MiB = 1024 * 1024;

const PUBLIC = {
  PUBLIC_MODE: 'true',
  ACCESS_TEAM_DOMAIN: 'team.cloudflareaccess.com',
  ACCESS_AUD: 'aud0123456789abcdef',
  OWNER_EMAILS: 'owner@example.com',
  ALLOWED_ORIGINS: 'https://demo.example.com',
};

const problemsOf = (env, llm = { provider: 'gemini' }) => {
  try {
    assertSecuritySettings(loadSecuritySettings(env), llm);
    return [];
  } catch (error) {
    assert.ok(error instanceof SecurityConfigError, 'only SecurityConfigError is expected');
    return error.problems;
  }
};

describe('local mode (PUBLIC_MODE unset)', () => {
  it('is off, and every limit keeps the pre-hardening behaviour', () => {
    const settings = loadSecuritySettings({}, { maxBodyBytes: 25 * MiB });

    assert.equal(settings.publicMode, false);
    assert.deepEqual(settings.problems, []);
    assert.equal(settings.limits.uploadMaxFiles, 20);
    assert.equal(settings.limits.uploadMaxFileBytes, 25 * MiB, 'the old per-file limit');
    assert.equal(settings.limits.requestTimeoutMs, 0, "Node's own default");
    assert.deepEqual(settings.gate, {
      llmMaxConcurrent: 0,
      llmQueueMax: 2,
      llmQueueWaitMs: 20_000,
      requestDeadlineMs: 0,
      perMinute: 0,
    });
    assert.equal(settings.demoMode, false);
    assert.equal(settings.exposed, false);
    assert.doesNotThrow(() => assertSecuritySettings(settings, { provider: 'apayee' }));
  });

  it('still applies the always-on archive protections', () => {
    const { limits } = loadSecuritySettings({});
    assert.equal(limits.zipMaxEntries, 2000);
    assert.equal(limits.zipMaxUncompressedBytes, 64 * MiB);
    assert.ok(limits.uploadMaxTotalBytes < 20 * 25 * MiB, 'the 500 MB worst case is gone');
  });
});

describe('public mode', () => {
  it('is strict by default', () => {
    const settings = loadSecuritySettings(PUBLIC);
    assert.equal(settings.publicMode, true);
    assert.deepEqual(settings.problems, []);
    assert.equal(settings.limits.uploadMaxFiles, 30, 'a technical ceiling, not a product rule');
    assert.equal(settings.limits.uploadMaxFileBytes, 10 * MiB);
    assert.equal(settings.limits.uploadMaxTotalBytes, 20 * MiB);
    assert.equal(settings.limits.pdfMaxPages, 150);
    assert.equal(settings.limits.jsonBodyMaxBytes, 5 * MiB);
    assert.equal(settings.gate.llmMaxConcurrent, 1);
    assert.equal(settings.gate.requestDeadlineMs, 110_000);
    assert.ok(settings.gate.requestDeadlineMs <= MAX_PUBLIC_DEADLINE_MS);
    assert.equal('llmPerHour' in settings.gate, false, 'there is no hourly model budget');
    assert.equal('llmPerDay' in settings.gate, false, 'there is no daily model budget');
    assert.deepEqual(problemsOf(PUBLIC), []);
  });

  it('lets every limit be overridden by environment', () => {
    const { limits, gate } = loadSecuritySettings({
      ...PUBLIC,
      UPLOAD_MAX_FILES: '2',
      UPLOAD_MAX_FILE_BYTES: '1000',
      UPLOAD_MAX_TOTAL_BYTES: '1500',
      PDF_MAX_PAGES: '7',
      ZIP_MAX_ENTRIES: '9',
      ZIP_MAX_UNCOMPRESSED_BYTES: '4096',
      LLM_MAX_CONCURRENT: '2',
      RATE_LIMIT_PER_MINUTE: '5',
      REQUEST_DEADLINE_MS: '60000',
    });
    assert.equal(limits.uploadMaxFiles, 2);
    assert.equal(limits.uploadMaxFileBytes, 1000);
    assert.equal(limits.uploadMaxTotalBytes, 1500);
    assert.equal(limits.pdfMaxPages, 7);
    assert.equal(limits.zipMaxEntries, 9);
    assert.equal(limits.zipMaxUncompressedBytes, 4096);
    assert.equal(gate.llmMaxConcurrent, 2);
    assert.equal(gate.perMinute, 5);
    assert.equal(gate.requestDeadlineMs, 60_000);
  });

  it('refuses to start without each required Access setting, naming the variable', () => {
    for (const name of ['ACCESS_TEAM_DOMAIN', 'ACCESS_AUD', 'OWNER_EMAILS', 'ALLOWED_ORIGINS']) {
      const env = { ...PUBLIC };
      delete env[name];
      const problems = problemsOf(env);
      assert.ok(
        problems.some((problem) => problem.includes(name)),
        `${name} missing should be reported, got: ${problems}`
      );
    }
  });

  it('accepts only a cloudflareaccess.com team domain', () => {
    for (const bad of [
      'example.com',
      'https://team.cloudflareaccess.com',
      'team.cloudflareaccess.com/x',
      'evil.com#.cloudflareaccess.com',
      '.cloudflareaccess.com',
    ]) {
      assert.ok(
        problemsOf({ ...PUBLIC, ACCESS_TEAM_DOMAIN: bad }).some((p) =>
          p.includes('ACCESS_TEAM_DOMAIN')
        ),
        `${bad} must be refused`
      );
    }
  });

  it('refuses an invalid owner email without echoing it', () => {
    const secret = 'not-an-email-SECRETVALUE';
    const problems = problemsOf({ ...PUBLIC, OWNER_EMAILS: `owner@example.com,${secret}` });
    assert.ok(problems.some((problem) => problem.includes('OWNER_EMAILS')));
    assert.ok(!problems.join(' ').includes(secret), 'a value must never appear in a message');
  });

  it('normalises owner emails to lower case and removes duplicates', () => {
    const { access } = loadSecuritySettings({
      ...PUBLIC,
      OWNER_EMAILS: 'Owner@Example.COM, owner@example.com',
    });
    assert.deepEqual(access.ownerEmails, ['owner@example.com']);
  });

  it('accepts only exact origins', () => {
    for (const bad of [
      '*',
      'https://*.example.com',
      'https://demo.example.com/',
      'https://demo.example.com/app',
      'demo.example.com',
      'ftp://demo.example.com',
      'null',
      'https://demo.example.com?x=1',
    ]) {
      assert.ok(
        problemsOf({ ...PUBLIC, ALLOWED_ORIGINS: bad }).some((p) => p.includes('ALLOWED_ORIGINS')),
        `${bad} must be refused`
      );
    }
    assert.deepEqual(
      loadSecuritySettings({
        ...PUBLIC,
        ALLOWED_ORIGINS: 'https://a.example.com, https://b.example.com:8443',
      }).allowedOrigins,
      ['https://a.example.com', 'https://b.example.com:8443']
    );
  });

  it('requires https for a non-local origin but allows localhost for local testing', () => {
    assert.ok(problemsOf({ ...PUBLIC, ALLOWED_ORIGINS: 'http://demo.example.com' }).length > 0);
    assert.deepEqual(problemsOf({ ...PUBLIC, ALLOWED_ORIGINS: 'http://localhost:5173' }), []);
  });

  it('refuses Apayee or Claude as the implicit server default', () => {
    for (const provider of ['apayee', 'claude', 'APAYEE']) {
      assert.ok(
        problemsOf(PUBLIC, { provider }).some((p) => p.includes('LLM_PROVIDER')),
        `${provider} must be refused`
      );
    }
    assert.deepEqual(problemsOf(PUBLIC, { provider: 'gemini' }), []);
    assert.deepEqual(problemsOf(PUBLIC, { provider: 'mock' }), []);
    assert.ok(problemsOf(PUBLIC, { provider: 'something-else' }).length > 0);
  });

  it("keeps the request deadline inside Cloudflare's read timeout", () => {
    assert.ok(
      problemsOf({ ...PUBLIC, REQUEST_DEADLINE_MS: '0' }).length > 0,
      'a deadline is required'
    );
    assert.ok(
      problemsOf({ ...PUBLIC, REQUEST_DEADLINE_MS: String(MAX_PUBLIC_DEADLINE_MS + 1) }).length > 0
    );
    assert.deepEqual(
      problemsOf({ ...PUBLIC, REQUEST_DEADLINE_MS: String(MAX_PUBLIC_DEADLINE_MS) }),
      []
    );
  });

  it('warns when the model timeout outlives the request deadline', () => {
    const settings = loadSecuritySettings({ ...PUBLIC, REQUEST_DEADLINE_MS: '60000' });
    const warnings = assertSecuritySettings(settings, { provider: 'gemini', timeoutMs: 120_000 });
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /LLM_TIMEOUT_MS/);

    const quiet = loadSecuritySettings(PUBLIC);
    assert.deepEqual(assertSecuritySettings(quiet, { provider: 'gemini', timeoutMs: 100_000 }), []);
  });
});

describe('malformed values are startup errors, not silent defaults', () => {
  it('rejects a PUBLIC_MODE that is not clearly true or false', () => {
    for (const value of ['yes', 'on', 'TRUE!', 'enabled']) {
      assert.ok(
        problemsOf({ PUBLIC_MODE: value }).some((p) => p.includes('PUBLIC_MODE')),
        `${value} must not silently mean off`
      );
    }
    for (const value of ['true', 'TRUE', '1'])
      assert.equal(loadSecuritySettings({ ...PUBLIC, PUBLIC_MODE: value }).publicMode, true);
    for (const value of ['false', '0', ''])
      assert.equal(loadSecuritySettings({ PUBLIC_MODE: value }).publicMode, false);
  });

  it('rejects limits that are not whole numbers', () => {
    for (const value of ['abc', '-1', '1.5', '10MB']) {
      assert.ok(
        problemsOf({ UPLOAD_MAX_FILES: value }).some((p) => p.includes('UPLOAD_MAX_FILES')),
        `${value} must be refused`
      );
    }
    assert.ok(problemsOf({ UPLOAD_MAX_FILES: '0' }).length > 0, 'zero files is not a limit');
  });

  it('rejects an invalid trusted proxy peer', () => {
    assert.ok(problemsOf({ TRUSTED_PROXY_PEERS: 'not-an-ip' }).length > 0);
    assert.ok(problemsOf({ TRUSTED_PROXY_PEERS: '10.0.0.0/40' }).length > 0);
    assert.deepEqual(problemsOf({ TRUSTED_PROXY_PEERS: '172.18.0.1, 10.0.0.0/8, ::1' }), []);
  });
});

describe('buildApp enforces the settings', () => {
  it('refuses to build in public mode without the Access configuration', () => {
    assert.throws(
      () => buildApp({ security: loadSecuritySettings({ PUBLIC_MODE: 'true' }) }),
      (error) => error instanceof SecurityConfigError && /ACCESS_TEAM_DOMAIN/.test(error.message)
    );
  });

  it('builds in local mode with the defaults', async () => {
    const app = buildApp({ security: loadSecuritySettings({}) });
    await app.close();
  });
});
