import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { ApayeeProvider, probeGateway, readQueue } from './apayee.js';
import { createProviderAvailability } from './catalog.js';
import { healthReply, startFakeGateway } from './fixtures/fake-gateway.js';

/**
 * What QATOOL learns from Apayee about how much it can run at once, and the two errors
 * the provider breaker listens for. The gateway is a fake on a loopback port speaking the
 * documented health contract, including the capacity fields (`active`, `max_active`,
 * `pending`, `capacity`) beside the older `length` and `running`.
 */

const gateways = [];
afterEach(async () => {
  await Promise.all(gateways.splice(0).map((gateway) => gateway.close()));
});

async function gateway(options) {
  const started = await startFakeGateway(options);
  gateways.push(started);
  return started;
}

const settingsFor = (started, overrides = {}) => ({
  provider: 'gemini',
  apiKey: '',
  apayeeBaseUrl: started.baseUrl,
  apayeeToken: '',
  apayeeQueueWaitMs: 200,
  timeoutMs: 5000,
  ...overrides,
});

describe('reading the gateway’s queue block', () => {
  it('takes the capacity fields as numbers', () => {
    assert.deepEqual(
      readQueue({ length: 1, running: true, active: 2, max_active: 3, pending: 1, capacity: 16 }),
      {
        reported: true,
        compatible: true,
        maxActive: 3,
        active: 2,
        pending: 1,
        capacity: 16,
        running: true,
      }
    );
  });

  it('assumes ONE when the gateway does not say how many it runs', () => {
    // An Apayee from before max_active existed: the older fields only.
    const old = readQueue({ length: 0, running: false, capacity: 16, abandoned: 0, totals: {} });
    assert.equal(old.maxActive, 1);
    assert.equal(old.reported, false);
    assert.equal(old.compatible, true, 'an older gateway is not an incompatible one');
    assert.equal(old.active, 0, 'derived from the older running flag');
    assert.equal(old.pending, 0, 'and from length');
  });

  it('assumes one for a block that is missing or not an object', () => {
    for (const queue of [undefined, null, 'x', 7, [], true]) {
      const read = readQueue(queue);
      assert.equal(read.maxActive, 1);
      assert.equal(read.reported, false);
      assert.equal(read.compatible, true);
    }
  });

  it('calls the gateway incompatible when max_active is present but not a positive whole number', () => {
    for (const bad of [0, -1, 1.5, '3', null, NaN, Infinity, {}, [], true]) {
      const read = readQueue({ max_active: bad, active: 0 });
      assert.equal(read.compatible, false, `max_active ${JSON.stringify(bad)}`);
      assert.equal(read.reported, false);
      assert.equal(read.maxActive, 1, 'and still never above one');
    }
  });

  it('turns anything that is not a count into null, and carries nothing else', () => {
    const read = readQueue({
      max_active: 2,
      active: -4,
      pending: 'many',
      capacity: 2.5,
      secret: 'must not travel',
      totals: { succeeded: 9 },
    });
    assert.deepEqual(Object.keys(read).sort(), [
      'active',
      'capacity',
      'compatible',
      'maxActive',
      'pending',
      'reported',
      'running',
    ]);
    assert.equal(read.active, null);
    assert.equal(read.pending, null);
    assert.equal(read.capacity, null);
  });
});

describe('the health probe', () => {
  it('returns the capacity with a ready gateway', async () => {
    const fake = await gateway();
    fake.health = () =>
      healthReply({
        queue: { length: 1, running: true, active: 2, max_active: 3, pending: 1, capacity: 16 },
      });

    const outcome = await probeGateway(settingsFor(fake));
    assert.equal(outcome.state, 'ready');
    assert.equal(outcome.provider, 'claude');
    assert.equal(outcome.queue.maxActive, 3);
    assert.equal(outcome.queue.active, 2);
  });

  it('reports one, unreported, for a gateway that predates max_active', async () => {
    const fake = await gateway();
    const outcome = await probeGateway(settingsFor(fake));
    assert.equal(outcome.queue.maxActive, 1);
    assert.equal(outcome.queue.reported, false);
  });

  it('carries no capacity for a gateway that is not ready', async () => {
    const fake = await gateway();
    fake.health = () => healthReply({ status: 'shutting_down' });
    assert.deepEqual(await probeGateway(settingsFor(fake)), { state: 'shutting_down' });
  });
});

describe('the catalog’s view of capacity', () => {
  function availability(started, extra = {}) {
    return createProviderAvailability({
      settings: () => settingsFor(started),
      probe: (current) => probeGateway(current, { timeoutMs: 500 }),
      ...extra,
    });
  }

  it('answers from the same cached health answer as the status, in one request', async () => {
    const fake = await gateway();
    fake.health = () =>
      healthReply({ queue: { max_active: 2, active: 0, pending: 0, capacity: 8 } });
    const catalog = availability(fake);

    const first = await catalog.capacity('claude');
    const second = await catalog.capacity('claude');

    assert.equal(first.status.available, true);
    assert.equal(first.capacity.maxActive, 2);
    assert.deepEqual(second, first);
    assert.equal(fake.count('GET', '/v1/health'), 1, 'two reads, one health request');
  });

  it('reports no capacity, and an unavailable status, when Apayee runs its mock provider', async () => {
    const fake = await gateway({ provider: 'mock' });
    const { status, capacity } = await availability(fake).capacity('claude');
    assert.equal(status.available, false);
    assert.equal(status.code, 'provider_not_ready');
    assert.equal(capacity?.maxActive ?? 1, 1);
  });

  it('hands the capacity to acquire’s callback from the fresh answer it rests on', async () => {
    const fake = await gateway();
    fake.health = () => healthReply({ queue: { max_active: 3, active: 1 } });
    const catalog = availability(fake);

    const seen = [];
    const provider = await catalog.acquire('claude', { onCapacity: (c) => seen.push(c) });

    assert.ok(provider instanceof ApayeeProvider);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].maxActive, 3);
    assert.equal(fake.count('GET', '/v1/health'), 1);
  });

  it('still reports the capacity when acquire refuses, so the caller learns even from a refusal', async () => {
    const fake = await gateway();
    fake.health = () =>
      healthReply({ provider: 'claude_not_ready', queue: { max_active: 3, active: 0 } });
    const seen = [];
    await assert.rejects(
      availability(fake).acquire('claude', { onCapacity: (c) => seen.push(c) }),
      (error) => error.code === 'PROVIDER_UNAVAILABLE'
    );
    assert.equal(seen.length, 1);
  });

  it('has no capacity for a provider that is not behind the gateway', async () => {
    const fake = await gateway();
    const catalog = createProviderAvailability({
      settings: () => settingsFor(fake, { apiKey: 'AIzaFAKEKEYFORCAPACITYTESTS0123456' }),
      probe: probeGateway,
    });
    assert.equal((await catalog.capacity('gemini')).capacity, null);
  });
});

describe('the two errors the provider breaker listens for', () => {
  async function failureFrom(code) {
    const fake = await gateway();
    fake.generate = (record) => ({
      status: 503,
      body: {
        request_id: record.body.request_id,
        status: 'error',
        error: { code, message: 'whatever the gateway says', retryable: false },
      },
    });
    const provider = new ApayeeProvider({
      apayeeBaseUrl: fake.baseUrl,
      apayeeToken: '',
      apayeeQueueWaitMs: 200,
      timeoutMs: 5000,
    });
    return provider.generateJson({ system: 's', prompt: 'p', schema: {} }).catch((error) => error);
  }

  it('tags a not-ready and a rate-limited provider with the code Apayee used', async () => {
    assert.equal((await failureFrom('PROVIDER_NOT_READY')).upstreamCode, 'PROVIDER_NOT_READY');
    assert.equal(
      (await failureFrom('PROVIDER_RATE_LIMITED')).upstreamCode,
      'PROVIDER_RATE_LIMITED'
    );
  });

  it('leaves every other failure untagged, so one bad call does not open the breaker', async () => {
    for (const code of [
      'QUEUE_FULL',
      'PROVIDER_TIMEOUT',
      'QUEUE_TIMEOUT',
      'INVALID_PROVIDER_RESPONSE',
      'PROVIDER_UNAVAILABLE',
      'INTERNAL_ERROR',
    ]) {
      assert.equal((await failureFrom(code)).upstreamCode, undefined, code);
    }
  });

  it('keeps the tag out of the error’s message and its JSON', async () => {
    const error = await failureFrom('PROVIDER_RATE_LIMITED');
    assert.ok(!JSON.stringify(error.toJSON()).includes('PROVIDER_RATE_LIMITED'));
    assert.ok(!error.message.includes('upstream'));
  });
});
