import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildApp } from '../app.js';
import { startDemo } from '../jobs/fixtures/demo.js';
import { reachedThroughCloudflare } from './local-guard.js';
import { loadSecuritySettings } from './settings.js';

const VIA_CLOUDFLARE = { 'cf-connecting-ip': '198.51.100.7', 'cf-ray': '8a1b2c3d4e5f-SIN' };

describe('what marks a request as having come through Cloudflare', () => {
  it('any of the edge headers, or a Cloudflare CDN-Loop', () => {
    for (const headers of [
      { 'cf-connecting-ip': '198.51.100.7' },
      { 'cf-connecting-ipv6': '2001:db8::1' },
      { 'cf-ray': '8a1b2c3d4e5f-SIN' },
      { 'cf-visitor': '{"scheme":"https"}' },
      { 'cf-ipcountry': 'ID' },
      { 'cdn-loop': 'cloudflare; loops=1' },
      { 'cdn-loop': 'Cloudflare' },
    ]) {
      assert.equal(reachedThroughCloudflare(headers), true, JSON.stringify(headers));
    }
  });

  it('ordinary local requests are not marked', () => {
    for (const headers of [
      {},
      { host: '127.0.0.1:3001', accept: 'application/json' },
      { 'x-forwarded-for': '203.0.113.9' }, // not an edge header: the guard does not guess
      { 'cdn-loop': 'something-else' },
    ]) {
      assert.equal(reachedThroughCloudflare(headers), false, JSON.stringify(headers));
    }
  });
});

describe('local mode (no authentication) refuses traffic that came through the tunnel', () => {
  const local = () => buildApp({ security: loadSecuritySettings({}) });

  it('every route, including the liveness probe, answers 403 with a clear code', async () => {
    const app = local();
    try {
      for (const [method, url] of [
        ['GET', '/healthz'],
        ['GET', '/api/health'],
        ['GET', '/api/meta/enums'],
        ['POST', '/api/extract'],
        ['POST', '/api/generate?provider=claude'],
        ['POST', '/api/validate'],
        ['GET', '/'],
      ]) {
        const reply = await app.inject({ method, url, headers: VIA_CLOUDFLARE });
        assert.equal(reply.statusCode, 403, `${method} ${url}`);
        assert.equal(
          JSON.parse(reply.body).error.code,
          'LOCAL_MODE_NOT_PUBLIC',
          `${method} ${url}`
        );
      }
      // One header is enough.
      const one = await app.inject({
        method: 'GET',
        url: '/api/health',
        headers: { 'cf-ray': 'x' },
      });
      assert.equal(one.statusCode, 403);
    } finally {
      await app.close();
    }
  });

  it('the same requests without the edge headers are served as before', async () => {
    const app = local();
    try {
      assert.equal((await app.inject({ method: 'GET', url: '/healthz' })).statusCode, 200);
      assert.equal((await app.inject({ method: 'GET', url: '/api/health' })).statusCode, 200);
    } finally {
      await app.close();
    }
  });

  it('the refusal reveals nothing about the system', async () => {
    const app = local();
    try {
      const reply = await app.inject({
        method: 'GET',
        url: '/api/health',
        headers: VIA_CLOUDFLARE,
      });
      assert.doesNotMatch(reply.body, /time|stateless|provider|gemini|apayee/i);
    } finally {
      await app.close();
    }
  });
});

describe('the public demo is unaffected', () => {
  it("a request through Cloudflare is judged by the demo's own rules (no ticket: 401), not refused as local mode", async () => {
    const demo = await startDemo();
    try {
      const reply = await demo.call('GET', '/api/health', { headers: VIA_CLOUDFLARE });
      assert.equal(reply.status, 401);
      assert.notEqual(reply.body?.error?.code, 'LOCAL_MODE_NOT_PUBLIC');

      const health = await demo.call('GET', '/healthz', { headers: VIA_CLOUDFLARE });
      assert.equal(health.status, 200);
    } finally {
      await demo.close();
    }
  });
});
