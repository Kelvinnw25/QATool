import assert from 'node:assert/strict';
import { test } from 'node:test';

import { isLoopbackHost, loadConfig } from './config.js';

test('defaults bind to 127.0.0.1:3300 and poll every 4 s', () => {
  const c = loadConfig({});
  assert.equal(c.host, '127.0.0.1');
  assert.equal(c.port, 3300);
  assert.equal(c.pollMs, 4000);
  assert.equal(c.staleAfterMs, 12000);
  assert.equal(c.jobsSource, 'none');
  assert.equal(c.frontendUrl, null);
});

test('loopback names are accepted', () => {
  for (const host of ['127.0.0.1', '127.0.0.5', '::1', 'localhost', 'LOCALHOST']) {
    assert.equal(isLoopbackHost(host), true, host);
    assert.equal(loadConfig({ MONITOR_HOST: host }).host, host);
  }
});

test('any non-loopback bind address is refused, with no override', () => {
  for (const host of ['0.0.0.0', '::', '192.168.1.20', '10.0.0.4', 'example.com', '', '8.8.8.8']) {
    assert.equal(isLoopbackHost(host), false, host);
    assert.throws(() => loadConfig({ MONITOR_HOST: host }), /loopback/i, host);
  }
  // No second variable relaxes it.
  assert.throws(
    () => loadConfig({ MONITOR_HOST: '0.0.0.0', MONITOR_ALLOW_PUBLIC: '1' }),
    /loopback/i
  );
});

test('the poll interval is held to 3 to 5 seconds', () => {
  assert.equal(loadConfig({ MONITOR_POLL_MS: '3000' }).pollMs, 3000);
  assert.equal(loadConfig({ MONITOR_POLL_MS: '5000' }).pollMs, 5000);
  assert.throws(() => loadConfig({ MONITOR_POLL_MS: '500' }), /MONITOR_POLL_MS/);
  assert.throws(() => loadConfig({ MONITOR_POLL_MS: '60000' }), /MONITOR_POLL_MS/);
  assert.throws(() => loadConfig({ MONITOR_POLL_MS: 'fast' }), /MONITOR_POLL_MS/);
});

test('URLs are reduced to an origin and may not carry credentials', () => {
  const c = loadConfig({ MONITOR_FRONTEND_URL: 'https://example.vercel.app/some/path?token=abc' });
  assert.equal(c.frontendUrl, 'https://example.vercel.app');
  assert.throws(
    () => loadConfig({ MONITOR_TUNNEL_URL: 'https://user:pass@x.example' }),
    /credentials/
  );
  assert.throws(() => loadConfig({ MONITOR_TUNNEL_URL: 'ftp://x.example' }), /http/);
  assert.throws(() => loadConfig({ MONITOR_BACKEND_URL: 'not a url' }), /http/);
});

test('the jobs source is one of the two known values', () => {
  assert.equal(loadConfig({ MONITOR_JOBS_SOURCE: 'docker-exec' }).jobsSource, 'docker-exec');
  // The earlier name is still accepted and means the same thing.
  assert.equal(loadConfig({ MONITOR_JOBS_SOURCE: 'docker-socket' }).jobsSource, 'docker-exec');
  assert.throws(() => loadConfig({ MONITOR_JOBS_SOURCE: 'http' }), /MONITOR_JOBS_SOURCE/);
});

test('privileged ports are refused', () => {
  assert.throws(() => loadConfig({ MONITOR_PORT: '80' }), /MONITOR_PORT/);
});
