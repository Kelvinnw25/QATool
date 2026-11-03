import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { normalizeApiBase, readConfig } from './config.js';

describe('API base URL', () => {
  it('empty keeps relative URLs, which is the local Vite proxy behaviour', () => {
    for (const value of [undefined, '', '   ']) {
      assert.deepEqual(normalizeApiBase(value), { base: '', problem: null });
    }
  });

  it('keeps an origin and drops a trailing slash or path', () => {
    assert.equal(normalizeApiBase('https://api.example.com/').base, 'https://api.example.com');
    assert.equal(normalizeApiBase('https://api.example.com/api').base, 'https://api.example.com');
  });

  it('refuses anything that is not a safe API origin', () => {
    for (const bad of [
      'api.example.com',
      'ftp://api.example.com',
      'javascript:alert(1)',
      'https://user:pass@api.example.com',
      'http://api.example.com', // plain http to a public host
    ]) {
      const { base, problem } = normalizeApiBase(bad);
      assert.equal(base, '', bad);
      assert.ok(problem, bad);
    }
  });

  it('allows plain http to the machine itself', () => {
    assert.equal(normalizeApiBase('http://localhost:3001').base, 'http://localhost:3001');
    assert.equal(normalizeApiBase('http://127.0.0.1:3001').base, 'http://127.0.0.1:3001');
  });
});

describe('the frontend mode', () => {
  it('is the local tool unless VITE_PUBLIC_DEMO is "true"', () => {
    assert.equal(readConfig({}).demo, false);
    assert.equal(readConfig({ VITE_PUBLIC_DEMO: 'false' }).demo, false);
    assert.equal(readConfig({ VITE_PUBLIC_DEMO: '1' }).demo, false);
    assert.equal(readConfig({ VITE_PUBLIC_DEMO: ' TRUE ' }).demo, true);
  });

  it('reports no problems for the local tool', () => {
    assert.deepEqual(readConfig({}).problems, []);
  });

  it('a demo build without a site key says so, rather than failing silently', () => {
    const config = readConfig({ VITE_PUBLIC_DEMO: 'true' });
    assert.ok(config.problems.some((p) => /VITE_TURNSTILE_SITE_KEY/.test(p)));
  });

  it('a complete demo build has no problems and carries the public values', () => {
    const config = readConfig({
      VITE_PUBLIC_DEMO: 'true',
      VITE_API_BASE_URL: 'https://api.example.com',
      VITE_TURNSTILE_SITE_KEY: '0x4AAAA',
    });
    assert.deepEqual(config.problems, []);
    assert.equal(config.apiBase, 'https://api.example.com');
    assert.equal(config.turnstileSiteKey, '0x4AAAA');
    assert.equal(config.turnstileAction, 'qatool_demo');
  });

  it('exposes nothing but the public settings, whatever else is in the environment', () => {
    const config = readConfig({
      VITE_PUBLIC_DEMO: 'true',
      VITE_TURNSTILE_SITE_KEY: 'k',
      SOME_SECRET: 'must-never-appear',
    });
    assert.deepEqual(Object.keys(config).sort(), [
      'apiBase',
      'demo',
      'problems',
      'turnstileAction',
      'turnstileSiteKey',
    ]);
    assert.doesNotMatch(JSON.stringify(config), /must-never-appear/);
  });
});
