import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { describe, it } from 'node:test';

import { withRun } from '../lib/trace.js';
import { createModelGate } from './gate.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

const settings = (overrides = {}) => ({
  llmMaxConcurrent: 0,
  llmQueueMax: 2,
  llmQueueWaitMs: 1000,
  requestDeadlineMs: 0,
  perMinute: 0,
  ...overrides,
});

function clock(start = 1_000_000) {
  const state = { t: start };
  return Object.assign(() => state.t, {
    advance(ms) {
      state.t += ms;
    },
  });
}

const apiRequest = (overrides = {}) => ({
  method: 'POST',
  url: '/api/generate',
  identity: { owner: true, id: 'owner-a' },
  routeOptions: { config: {} },
  ...overrides,
});

const modelRoute = (kind, url = '/api/generate', identity = 'owner-a') =>
  apiRequest({
    url,
    identity: { owner: true, id: identity },
    routeOptions: { config: { model: kind } },
  });

/** Just enough request and reply for the client-disconnect watcher. */
function connection() {
  const response = Object.assign(new EventEmitter(), { writableFinished: false, destroyed: false });
  return {
    request: { raw: { socket: { destroyed: false } } },
    reply: { raw: response },
    disconnect: () => response.emit('close'),
  };
}

const rejects = (promise, code, status) =>
  assert.rejects(promise, (error) => {
    assert.equal(error.code, code);
    if (status) assert.equal(error.statusCode, status);
    return true;
  });

describe('the whole-API rate', () => {
  it('refuses the request over the limit, with a retry time, then recovers', async () => {
    const now = clock();
    const gate = createModelGate(settings({ perMinute: 3 }), { now });

    for (let i = 0; i < 3; i += 1) await gate.rateHook(apiRequest());

    await assert.rejects(gate.rateHook(apiRequest()), (error) => {
      assert.equal(error.code, 'RATE_LIMITED');
      assert.equal(error.statusCode, 429);
      assert.ok(error.retryAfterSeconds >= 1 && error.retryAfterSeconds <= 60);
      return true;
    });

    now.advance(MINUTE + 1);
    await gate.rateHook(apiRequest());
  });

  it('counts each identity separately', async () => {
    const gate = createModelGate(settings({ perMinute: 1 }), { now: clock() });
    await gate.rateHook(apiRequest({ identity: { id: 'a' } }));
    await gate.rateHook(apiRequest({ identity: { id: 'b' } }));
    await rejects(gate.rateHook(apiRequest({ identity: { id: 'a' } })), 'RATE_LIMITED');
  });

  it('does not count a preflight or a public route', async () => {
    const gate = createModelGate(settings({ perMinute: 1 }), { now: clock() });
    for (let i = 0; i < 5; i += 1) {
      await gate.rateHook(apiRequest({ method: 'OPTIONS' }));
      await gate.rateHook(apiRequest({ routeOptions: { config: { public: true } } }));
    }
    await gate.rateHook(apiRequest());
  });

  it('is off at zero', async () => {
    const gate = createModelGate(settings({ perMinute: 0 }), { now: clock() });
    for (let i = 0; i < 500; i += 1) await gate.rateHook(apiRequest());
  });
});

describe('there is no model request budget', () => {
  it('has no budget hook and no hourly or daily setting', () => {
    const gate = createModelGate(settings(), { now: clock() });
    assert.equal(gate.budgetHook, undefined);
    assert.deepEqual(
      Object.keys(settings()).filter((key) => /hour|day|budget/i.test(key)),
      []
    );
  });

  it('never refuses a model request for how many it has already made', async () => {
    const now = clock();
    const gate = createModelGate(settings({ perMinute: 0 }), { now });

    // Hundreds of model requests across several days: only the rate and concurrency limits
    // exist, and the rate is off here.
    for (let day = 0; day < 3; day += 1) {
      for (let i = 0; i < 200; i += 1) await gate.rateHook(modelRoute('always'));
      now.advance(24 * HOUR);
    }
  });
});

describe('concurrent model calls', () => {
  const deferred = () => {
    let resolve;
    const promise = new Promise((done) => (resolve = done));
    return { promise, resolve };
  };

  it('runs one at a time and queues the next in order', async () => {
    const gate = createModelGate(settings({ llmMaxConcurrent: 1, llmQueueMax: 2 }));
    const order = [];
    const first = deferred();

    const a = gate.run(connection().request, connection().reply, async () => {
      order.push('a:start');
      await first.promise;
      order.push('a:end');
    });
    const b = gate.run(connection().request, connection().reply, async () => order.push('b'));
    const c = gate.run(connection().request, connection().reply, async () => order.push('c'));

    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(order, ['a:start'], 'b and c wait');
    assert.deepEqual(gate.semaphore.state, { active: 1, queued: 2 });

    first.resolve();
    await Promise.all([a, b, c]);
    assert.deepEqual(order, ['a:start', 'a:end', 'b', 'c']);
    assert.deepEqual(gate.semaphore.state, { active: 0, queued: 0 });
  });

  it('refuses at once when the queue is full', async () => {
    const gate = createModelGate(settings({ llmMaxConcurrent: 1, llmQueueMax: 0 }));
    const hold = deferred();
    const running = gate.run(connection().request, connection().reply, () => hold.promise);

    await rejects(
      gate.run(connection().request, connection().reply, async () => 'never'),
      'SERVER_BUSY',
      429
    );
    hold.resolve();
    await running;
  });

  it('gives up on a queued request after the wait limit', async () => {
    const gate = createModelGate(
      settings({ llmMaxConcurrent: 1, llmQueueMax: 1, llmQueueWaitMs: 30 })
    );
    const hold = deferred();
    const running = gate.run(connection().request, connection().reply, () => hold.promise);

    const started = Date.now();
    await rejects(
      gate.run(connection().request, connection().reply, async () => 'never'),
      'SERVER_BUSY'
    );
    assert.ok(Date.now() - started < 500, 'the wait is bounded');
    assert.equal(gate.semaphore.state.queued, 0, 'it does not keep its place');

    hold.resolve();
    await running;
  });

  it('frees the queue place of a client that disconnects while waiting', async () => {
    const gate = createModelGate(
      settings({ llmMaxConcurrent: 1, llmQueueMax: 1, llmQueueWaitMs: 5000 })
    );
    const hold = deferred();
    const running = gate.run(connection().request, connection().reply, () => hold.promise);

    const waiter = connection();
    let ran = false;
    const queued = gate.run(waiter.request, waiter.reply, async () => {
      ran = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(gate.semaphore.state.queued, 1);

    waiter.disconnect();
    await rejects(queued, 'REQUEST_CANCELLED', 499);
    assert.equal(gate.semaphore.state.queued, 0);

    hold.resolve();
    await running;
    assert.equal(ran, false, 'the abandoned request never ran');
  });

  it('releases the slot when the work fails', async () => {
    const gate = createModelGate(settings({ llmMaxConcurrent: 1, llmQueueMax: 0 }));
    await assert.rejects(
      gate.run(connection().request, connection().reply, async () => {
        throw new Error('provider exploded');
      }),
      /provider exploded/
    );
    assert.equal(await gate.run(connection().request, connection().reply, async () => 'ok'), 'ok');
  });

  it('does not hold the ceiling for work that uses no model', async () => {
    const gate = createModelGate(settings({ llmMaxConcurrent: 1, llmQueueMax: 0 }));
    const hold = deferred();
    const running = gate.run(connection().request, connection().reply, () => hold.promise);

    const result = await gate.run(
      connection().request,
      connection().reply,
      async () => 'no model',
      {
        usesModel: false,
      }
    );
    assert.equal(result, 'no model');

    hold.resolve();
    await running;
  });

  it('is unlimited at zero', async () => {
    const gate = createModelGate(settings({ llmMaxConcurrent: 0 }));
    const hold = deferred();
    const all = Array.from({ length: 10 }, () =>
      gate.run(connection().request, connection().reply, () => hold.promise)
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    hold.resolve();
    await Promise.all(all);
  });
});

describe('the request deadline', () => {
  // A provider adapter that honours its signal, including one aborted before it started.
  const waitsForAbort = (signal) =>
    new Promise((_, reject) => {
      const fail = () => reject(new Error('the provider saw the abort'));
      if (signal.aborted) fail();
      else signal.addEventListener('abort', fail, { once: true });
    });

  it('stops the work and answers 504, whatever the provider reports', async () => {
    const gate = createModelGate(settings({ requestDeadlineMs: 40 }));
    const started = Date.now();
    await rejects(
      gate.run(connection().request, connection().reply, (signal) => waitsForAbort(signal)),
      'REQUEST_DEADLINE_EXCEEDED',
      504
    );
    assert.ok(Date.now() - started < 1000);
  });

  it('counts the time already spent receiving the request', async () => {
    const gate = createModelGate(settings({ requestDeadlineMs: 100 }));
    const spent = await withRun({}, async (run) => {
      run.startedAt = Date.now() - 85; // the upload took 85 ms of the 100
      const started = Date.now();
      await rejects(
        gate.run(connection().request, connection().reply, (signal) => waitsForAbort(signal)),
        'REQUEST_DEADLINE_EXCEEDED'
      );
      return Date.now() - started;
    });
    assert.ok(spent < 80, `only the remaining ~15 ms should be allowed, took ${spent}`);
  });

  it('applies to the wait for a slot as well', async () => {
    const gate = createModelGate(
      settings({ llmMaxConcurrent: 1, llmQueueMax: 1, llmQueueWaitMs: 5000, requestDeadlineMs: 40 })
    );
    const hold = new Promise(() => {});
    gate.run(connection().request, connection().reply, () => hold).catch(() => {});

    await rejects(
      gate.run(connection().request, connection().reply, async () => 'never'),
      'REQUEST_DEADLINE_EXCEEDED'
    );
  });

  it('lets a client who left outrank a deadline', async () => {
    const gate = createModelGate(settings({ requestDeadlineMs: 5000 }));
    const client = connection();
    const running = gate.run(client.request, client.reply, (signal) => waitsForAbort(signal));
    client.disconnect();
    await rejects(running, 'REQUEST_CANCELLED', 499);
  });

  it('does not touch work that finishes in time, and clears its timer', async () => {
    const gate = createModelGate(settings({ requestDeadlineMs: 5000 }));
    assert.equal(
      await gate.run(connection().request, connection().reply, async () => 'done'),
      'done'
    );
  });

  it('adds nothing when no deadline is set', async () => {
    const gate = createModelGate(settings({ requestDeadlineMs: 0 }));
    const result = await gate.run(connection().request, connection().reply, async (signal) => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      return signal.aborted;
    });
    assert.equal(result, false);
  });
});
