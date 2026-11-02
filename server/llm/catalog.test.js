import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { RESPONSE_SCHEMA } from '../generate/contract.js';
import { ApayeeProvider, probeGateway } from './apayee.js';
import {
  PROVIDER_IDS,
  ProviderUnavailableError,
  createProviderAvailability,
  parseProviderChoice,
} from './catalog.js';
import {
  closedPort,
  generateReply,
  healthReply,
  startFakeGateway,
} from './fixtures/fake-gateway.js';
import { GeminiProvider } from './gemini.js';

/**
 * Which models a run may choose, and whether each can be used right now.
 *
 * Claude is "whatever Apayee is running", so the cases that matter are the ways
 * a gateway can look healthy without Claude being behind it. The gateway here is
 * a fake on a loopback port speaking the documented health and generate
 * contracts; nothing in this file reaches a model.
 */

const TOKEN = 'unit-test-token-Zq81Lw4Rk7Vn2Xd9Bf6Ty3';
const GEMINI_KEY = 'AIzaFAKEKEYFORCATALOGTESTS012345';

const gateways = [];
afterEach(async () => {
  await Promise.all(gateways.splice(0).map((gateway) => gateway.close()));
});

async function gateway(options) {
  const started = await startFakeGateway(options);
  gateways.push(started);
  return started;
}

function settingsFor(started, overrides = {}) {
  return {
    provider: 'gemini',
    apiKey: GEMINI_KEY,
    model: 'gemini-test',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    apayeeBaseUrl: started.baseUrl,
    apayeeToken: '',
    apayeeQueueWaitMs: 200,
    timeoutMs: 5000,
    ...overrides,
  };
}

/** A discovery service whose gateway probe gives up quickly, so a hang test is fast. */
function availability(settings, extra = {}) {
  return createProviderAvailability({
    settings: () => settings,
    probe: (current) => probeGateway(current, { timeoutMs: 150 }),
    ...extra,
  });
}

const entry = (list, id) => list.providers.find((provider) => provider.id === id);

describe('the allowlist', () => {
  it('offers exactly gemini and claude, in that order', () => {
    assert.deepEqual(PROVIDER_IDS, ['gemini', 'claude']);
  });

  it('accepts an absent parameter as "no choice" and the two ids as themselves', () => {
    assert.equal(parseProviderChoice(undefined), null);
    assert.equal(parseProviderChoice('gemini'), 'gemini');
    assert.equal(parseProviderChoice('claude'), 'claude');
  });

  it('rejects everything else, including registry names and look-alikes', () => {
    for (const value of [
      '',
      'mock',
      'apayee',
      'Claude',
      'GEMINI',
      ' claude',
      'claude ',
      '__proto__',
      'constructor',
      'toString',
      ['gemini', 'claude'],
      42,
      null,
    ]) {
      assert.throws(
        () => parseProviderChoice(value),
        (error) => error.code === 'UNKNOWN_PROVIDER' && error.statusCode === 400,
        `accepted ${JSON.stringify(value)}`
      );
    }
  });
});

describe('Gemini availability', () => {
  it('is available when the server holds a key, without calling anything', async () => {
    const g = await gateway();
    const list = await availability(settingsFor(g)).list();

    assert.deepEqual(entry(list, 'gemini'), {
      id: 'gemini',
      label: 'Gemini',
      available: true,
      reason: null,
      code: null,
    });
  });

  it('is unavailable, with a reason, when there is no key', async () => {
    const g = await gateway();

    for (const apiKey of ['', '   ', undefined]) {
      const list = await availability(settingsFor(g, { apiKey })).list();
      const gemini = entry(list, 'gemini');
      assert.equal(gemini.available, false);
      assert.equal(gemini.code, 'not_configured');
      assert.match(gemini.reason, /not configured/i);
    }
  });
});

describe('Claude availability', () => {
  it('is available only when the gateway reports the exact provider "claude"', async () => {
    const g = await gateway({ provider: 'claude' });
    const list = await availability(settingsFor(g)).list();

    const claude = entry(list, 'claude');
    assert.equal(claude.label, 'Claude via Apayee');
    assert.equal(claude.available, true);
    assert.equal(claude.reason, null);
  });

  it('is NOT available when Apayee is online but running its mock provider', async () => {
    const g = await gateway({ provider: 'mock' });
    const list = await availability(settingsFor(g)).list();

    const claude = entry(list, 'claude');
    assert.equal(claude.available, false);
    assert.equal(claude.code, 'provider_not_ready');
    assert.match(claude.reason, /mock provider/i);
    assert.match(claude.reason, /Claude is not available/);
  });

  it('is NOT available for any other provider name, or a near miss', async () => {
    for (const provider of ['gemini', 'Claude', 'claude-mock', 'claude ', 'CLAUDE', '']) {
      const g = await gateway();
      g.health = () => healthReply({ provider });
      const claude = entry(await availability(settingsFor(g)).list(), 'claude');

      assert.equal(claude.available, false, `treated ${JSON.stringify(provider)} as Claude`);
    }
  });

  it('is unavailable with a clear reason when Apayee is offline', async () => {
    const port = await closedPort();
    const list = await availability(settingsFor({ baseUrl: `http://127.0.0.1:${port}` })).list();

    const claude = entry(list, 'claude');
    assert.equal(claude.available, false);
    assert.equal(claude.code, 'gateway_offline');
    assert.match(claude.reason, /not running or not reachable/);
  });

  it('is unavailable when Apayee rejects the server credentials', async () => {
    const g = await gateway({ token: TOKEN });

    const wrong = entry(
      await availability(
        settingsFor(g, { apayeeToken: 'a-different-token-Zq81Lw4Rk7Vn2Xd9' })
      ).list(),
      'claude'
    );
    assert.equal(wrong.available, false);
    assert.equal(wrong.code, 'gateway_auth_failed');

    const none = entry(await availability(settingsFor(g)).list(), 'claude');
    assert.equal(none.code, 'gateway_auth_failed', 'a gateway that wants a token and gets none');

    const right = entry(
      await availability(settingsFor(g, { apayeeToken: TOKEN })).list(),
      'claude'
    );
    assert.equal(right.available, true);
    assert.equal(g.requests.at(-1).headers.authorization, `Bearer ${TOKEN}`);
  });

  it('is unavailable, within a bound, when the health check hangs', async () => {
    const g = await gateway();
    g.health = () => 'hang';

    const started = Date.now();
    const claude = entry(await availability(settingsFor(g)).list(), 'claude');

    assert.equal(claude.available, false);
    assert.equal(claude.code, 'gateway_timeout');
    assert.ok(Date.now() - started < 2000, 'the check gave up on its own');
  });

  it('is unavailable while Apayee is shutting down', async () => {
    const g = await gateway();
    g.health = () => healthReply({ status: 'shutting_down' });

    const claude = entry(await availability(settingsFor(g)).list(), 'claude');
    assert.equal(claude.available, false);
    assert.equal(claude.code, 'gateway_shutting_down');
  });

  it('does not trust a reply that is not Apayee’s health reply', async () => {
    const g = await gateway();

    for (const reply of [
      { status: 200, body: { status: 'ok', provider: 'claude' } },
      { status: 200, body: { status: 'ok', service: 'other', provider: 'claude' } },
      { status: 200, body: '<html>proxy error</html>' },
      { status: 200, body: { status: 'ok', service: 'apayee' } },
      { status: 200, body: { status: 'degraded', service: 'apayee', provider: 'claude' } },
      { status: 500, body: { status: 'ok', service: 'apayee', provider: 'claude' } },
    ]) {
      g.health = () => reply;
      const claude = entry(await availability(settingsFor(g)).list(), 'claude');

      assert.equal(claude.available, false, JSON.stringify(reply));
      assert.equal(claude.code, 'gateway_unexpected_reply');
    }
  });

  it('is unavailable, not a crash, when the gateway settings are invalid', async () => {
    const g = await gateway();

    for (const apayeeBaseUrl of [
      'not a url',
      'ftp://127.0.0.1:4100',
      'http://user:pw@127.0.0.1:1',
    ]) {
      const claude = entry(await availability(settingsFor(g, { apayeeBaseUrl })).list(), 'claude');
      assert.equal(claude.available, false);
      assert.equal(claude.code, 'not_configured');
    }
    assert.equal(g.requests.length, 0, 'nothing was sent');
  });
});

describe('the discovery response', () => {
  it('names gemini as the default for a gemini-configured server', async () => {
    const g = await gateway();
    const list = await availability(settingsFor(g)).list();

    assert.equal(list.default, 'gemini');
    assert.equal('default_note' in list, false);
    assert.deepEqual(
      list.providers.map((provider) => provider.id),
      ['gemini', 'claude']
    );
  });

  it('has no default for an apayee- or mock-configured server, and says so', async () => {
    const g = await gateway();

    for (const provider of ['apayee', 'mock']) {
      const list = await availability(settingsFor(g, { provider })).list();
      assert.equal(list.default, null, provider);
      assert.ok(list.default_note, provider);
    }
  });

  it('describes an apayee server default as the gateway, and says what it is running', async () => {
    for (const provider of ['mock', 'claude']) {
      const g = await gateway({ provider });
      const list = await availability(settingsFor(g, { provider: 'apayee' })).list();

      assert.equal(list.default, null);
      assert.equal(list.default_label, 'Server default (Apayee gateway)');
      assert.match(list.default_note, /answered by whatever provider it runs/);
      assert.match(list.default_note, /not necessarily Claude/);
      assert.match(list.default_note, new RegExp(`currently running the "${provider}" provider`));
    }
  });

  it('does not repeat an odd provider name from the gateway, nor guess at one it did not get', async () => {
    const odd = await gateway({ provider: '<script>alert(1)</script>' });
    const oddList = await availability(settingsFor(odd, { provider: 'apayee' })).list();
    assert.doesNotMatch(oddList.default_note, /script/);
    assert.doesNotMatch(oddList.default_note, /currently running/);

    const port = await closedPort();
    const down = await availability(
      settingsFor({ baseUrl: `http://127.0.0.1:${port}` }, { provider: 'apayee' })
    ).list();
    assert.match(down.default_note, /not answering its health check/);
  });

  it('labels a mock server default as the scripted mock, not as a model', async () => {
    const g = await gateway();
    const list = await availability(settingsFor(g, { provider: 'mock' })).list();

    assert.equal(list.default_label, 'Server default (scripted mock)');
    assert.match(list.default_note, /No model is called/);
  });

  it('never offers mock or the raw apayee entry as a choice', async () => {
    const g = await gateway({ provider: 'mock' });
    const list = await availability(settingsFor(g, { provider: 'mock' })).list();

    assert.deepEqual(
      list.providers.map((provider) => provider.id),
      ['gemini', 'claude']
    );
    assert.ok(!list.providers.some((provider) => /^mock$/i.test(provider.label)));
  });

  it('exposes no URL, token, key, port or gateway internals', async () => {
    const g = await gateway({ token: TOKEN, provider: 'mock' });
    const settings = settingsFor(g, { apayeeToken: TOKEN });

    const responses = [
      await availability(settings).list(),
      await availability({ ...settings, apayeeToken: 'wrong-token-Zq81Lw4Rk7Vn2Xd9Bf6Ty3' }).list(),
      await availability({ ...settings, apayeeBaseUrl: 'http://user:pw@127.0.0.1:1' }).list(),
      await availability(settingsFor({ baseUrl: `http://127.0.0.1:${await closedPort()}` })).list(),
    ];

    const everything = JSON.stringify(responses);
    for (const secret of [
      TOKEN,
      GEMINI_KEY,
      '127.0.0.1',
      String(g.port),
      'version',
      'queue',
      'pw',
    ]) {
      assert.ok(!everything.includes(secret), `the response contains ${secret}`);
    }
  });
});

describe('caching', () => {
  it('reuses a health answer briefly and asks again after it expires', async () => {
    const g = await gateway();
    let clock = 1_000;
    const service = availability(settingsFor(g), { now: () => clock, ttlMs: 5_000 });

    await service.list();
    await service.list();
    assert.equal(g.count('GET', '/v1/health'), 1, 'the second list came from the cache');

    clock += 4_999;
    await service.list();
    assert.equal(g.count('GET', '/v1/health'), 1);

    clock += 2;
    await service.list();
    assert.equal(g.count('GET', '/v1/health'), 2, 'an expired answer is not reused');
  });

  it('shares one health check between simultaneous requests', async () => {
    const g = await gateway();
    const service = availability(settingsFor(g));

    await Promise.all([service.list(), service.list(), service.list()]);
    assert.equal(g.count('GET', '/v1/health'), 1);
  });

  it('does not let a changed gateway answer hide behind the cache', async () => {
    const g = await gateway({ provider: 'claude' });
    let clock = 0;
    const service = availability(settingsFor(g), { now: () => clock, ttlMs: 5_000 });

    assert.equal(entry(await service.list(), 'claude').available, true);

    g.health = () => healthReply({ provider: 'mock' });
    clock += 5_001;
    assert.equal(entry(await service.list(), 'claude').available, false);
  });

  it('forgets the answer when the gateway settings change', async () => {
    const a = await gateway({ provider: 'claude' });
    const b = await gateway({ provider: 'mock' });
    let current = settingsFor(a);
    const service = createProviderAvailability({ settings: () => current, now: () => 0 });

    assert.equal(entry(await service.list(), 'claude').available, true);
    current = settingsFor(b);
    assert.equal(entry(await service.list(), 'claude').available, false);
  });
});

describe('acquiring a provider for a request', () => {
  it('builds Gemini for "gemini" and does not contact the gateway', async () => {
    const g = await gateway();
    const provider = await availability(settingsFor(g, { provider: 'apayee' })).acquire('gemini');

    assert.ok(provider instanceof GeminiProvider);
    assert.equal(g.requests.length, 0);
  });

  it('builds the Apayee adapter for "claude" when the gateway reports claude', async () => {
    const g = await gateway({ provider: 'claude' });
    const provider = await availability(settingsFor(g)).acquire('claude');

    assert.ok(provider instanceof ApayeeProvider);
    assert.equal(g.count('GET', '/v1/health'), 1);
  });

  it('always asks the gateway afresh, whatever the cache holds', async () => {
    const g = await gateway({ provider: 'claude' });
    const service = availability(settingsFor(g), { now: () => 0 });

    await service.list();
    g.health = () => healthReply({ provider: 'mock' });

    await assert.rejects(
      () => service.acquire('claude'),
      (error) =>
        error instanceof ProviderUnavailableError && error.reasonCode === 'provider_not_ready'
    );
  });

  it('refuses an unavailable choice with a 503 that names the provider and the reason', async () => {
    const g = await gateway({ provider: 'mock' });

    await assert.rejects(
      () => availability(settingsFor(g)).acquire('claude'),
      (error) => {
        assert.equal(error.code, 'PROVIDER_UNAVAILABLE');
        assert.equal(error.statusCode, 503);
        assert.match(error.message, /Claude via Apayee is not available: .*mock provider/);
        assert.deepEqual(error.toJSON(), {
          code: 'PROVIDER_UNAVAILABLE',
          message: error.message,
          provider: 'claude',
          reason_code: 'provider_not_ready',
        });
        return true;
      }
    );

    await assert.rejects(
      () => availability(settingsFor(g, { apiKey: '' })).acquire('gemini'),
      (error) => error.reasonCode === 'not_configured' && /Gemini/.test(error.message)
    );
  });
});

describe('the adapter refuses a reply from a different provider than the one selected', () => {
  const REQUEST = { system: 'S', prompt: 'P', schema: RESPONSE_SCHEMA };

  it('accepts a reply that names the expected provider', async () => {
    const g = await gateway({
      generate: (record) =>
        generateReply(record.body.request_id, { ok: true }, { provider: 'claude' }),
    });
    const adapter = new ApayeeProvider({ ...settingsFor(g), expectGatewayProvider: 'claude' });

    assert.deepEqual((await adapter.generateJson(REQUEST)).data, { ok: true });
  });

  it('rejects a reply from mock - or from nothing - when claude was expected', async () => {
    for (const provider of ['mock', null, 'Claude']) {
      const g = await gateway({
        generate: (record) => generateReply(record.body.request_id, { ok: true }, { provider }),
      });
      const adapter = new ApayeeProvider({ ...settingsFor(g), expectGatewayProvider: 'claude' });

      await assert.rejects(
        () => adapter.generateJson(REQUEST),
        (error) => error.code === 'LLM_UNAVAILABLE' && /different provider/.test(error.message),
        String(provider)
      );
    }
  });

  it('does not check at all when no provider was expected (existing behaviour)', async () => {
    const g = await gateway({
      generate: (record) =>
        generateReply(record.body.request_id, { ok: true }, { provider: 'mock' }),
    });
    const adapter = new ApayeeProvider(settingsFor(g));

    assert.deepEqual((await adapter.generateJson(REQUEST)).data, { ok: true });
  });
});
