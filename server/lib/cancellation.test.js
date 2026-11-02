import assert from 'node:assert/strict';
import http from 'node:http';
import { afterEach, describe, it } from 'node:test';
import Fastify from 'fastify';

import { AppError } from './errors.js';
import { withClientCancellation, watchClientDisconnect } from './cancellation.js';

/**
 * The helper that turns a client leaving into an AbortSignal, on a real server
 * and real sockets - a disconnect cannot be faked with inject().
 */

const stops = [];
afterEach(async () => {
  while (stops.length > 0) await stops.pop()();
});

/** A server whose one route runs `handler`, and the port to reach it on. */
async function serve(handler) {
  const app = Fastify();
  app.post('/work', handler);
  app.setErrorHandler((error, request, reply) =>
    reply.code(error.statusCode ?? 500).send({ code: error.code ?? 'ERROR' })
  );
  await app.listen({ host: '127.0.0.1', port: 0 });
  stops.push(async () => {
    app.server.closeAllConnections();
    await app.close();
  });
  return { app, port: app.server.address().port };
}

/** A real client that sends a JSON body and can walk away mid-request. */
function call(port, { leaveAfterMs = null } = {}) {
  return new Promise((resolve) => {
    const body = '{"a":1}';
    const request = http.request(
      {
        host: '127.0.0.1',
        port,
        method: 'POST',
        path: '/work',
        agent: false,
        headers: { 'content-type': 'application/json', 'content-length': body.length },
      },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () =>
          resolve({ status: response.statusCode, text: String(Buffer.concat(chunks)) })
        );
      }
    );
    request.on('error', () => resolve({ status: null, text: '' }));
    request.end(body);
    if (leaveAfterMs !== null) setTimeout(() => request.destroy(), leaveAfterMs);
  });
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

describe('watchClientDisconnect', () => {
  it('does not abort for a request that completes normally', async () => {
    let aborted = null;
    const { port } = await serve(async (request, reply) => {
      const watch = watchClientDisconnect(request, reply);
      await pause(60);
      aborted = watch.signal.aborted;
      watch.release();
      return { ok: true };
    });

    const result = await call(port);

    assert.equal(result.status, 200);
    assert.equal(aborted, false);
  });

  it('aborts when the client disconnects before the reply', async () => {
    let signal = null;
    const { port } = await serve(async (request, reply) => {
      const watch = watchClientDisconnect(request, reply);
      signal = watch.signal;
      await pause(300);
      watch.release();
      return { ok: true };
    });

    await call(port, { leaveAfterMs: 80 });
    await pause(40);

    assert.equal(signal.aborted, true);
  });

  it('does not mistake a normally finished response for a disconnect, even if never released', async () => {
    // release() normally detaches the listener before the reply is written, so the
    // writableFinished check is the second line of defence for a caller that forgets.
    let watched = null;
    const { port } = await serve(async (request, reply) => {
      watched = watchClientDisconnect(request, reply);
      return { ok: true };
    });

    const result = await call(port);
    await pause(60); // the connection closes after the reply was fully written

    assert.equal(result.status, 200);
    assert.equal(watched.signal.aborted, false);
  });

  it('removes its listener, so a finished request leaves nothing behind', async () => {
    let before = null;
    let during = null;
    let after = null;
    const { port } = await serve(async (request, reply) => {
      before = reply.raw.listenerCount('close');
      const watch = watchClientDisconnect(request, reply);
      during = reply.raw.listenerCount('close');
      watch.release();
      after = reply.raw.listenerCount('close');
      return { ok: true };
    });

    await call(port);

    assert.equal(during, before + 1);
    assert.equal(after, before);
  });

  it('is already aborted when the client left before the work began', async () => {
    let aborted = null;
    const { port } = await serve(async (request, reply) => {
      await pause(200); // the client leaves while this runs
      const watch = watchClientDisconnect(request, reply);
      aborted = watch.signal.aborted;
      watch.release();
      return { ok: true };
    });

    await call(port, { leaveAfterMs: 60 });
    await pause(250);

    assert.equal(aborted, true);
  });
});

describe('withClientCancellation', () => {
  it('returns the work’s result and passes it a live signal', async () => {
    let signal = null;
    const { port } = await serve((request, reply) =>
      withClientCancellation(request, reply, async (given) => {
        signal = given;
        return { fine: true };
      })
    );

    const result = await call(port);

    assert.equal(result.status, 200);
    assert.deepEqual(JSON.parse(result.text), { fine: true });
    assert.equal(signal.aborted, false);
  });

  it('lets the work’s own errors through unchanged when the client is still there', async () => {
    const { port } = await serve((request, reply) =>
      withClientCancellation(request, reply, async () => {
        throw new AppError('SOMETHING_ELSE', 'not a cancellation', 422);
      })
    );

    const result = await call(port);

    assert.equal(result.status, 422);
    assert.equal(JSON.parse(result.text).code, 'SOMETHING_ELSE');
  });

  it('reports one cancellation, whatever the stage underneath threw', async () => {
    const outcomes = [];
    const { port } = await serve(async (request, reply) => {
      try {
        return await withClientCancellation(request, reply, async (signal) => {
          await new Promise((resolve) => signal.addEventListener('abort', resolve));
          // A stage describing the abort in its own words, as Gemini and Apayee both do.
          throw new AppError('LLM_UNAVAILABLE', 'The request to Apayee was cancelled.', 502);
        });
      } catch (error) {
        outcomes.push({ code: error.code, status: error.statusCode });
        throw error;
      }
    });

    await call(port, { leaveAfterMs: 80 });
    await pause(60);

    assert.deepEqual(outcomes, [{ code: 'REQUEST_CANCELLED', status: 499 }]);
  });

  it('removes its listener whether the work succeeds or fails', async () => {
    const counts = [];
    const { port } = await serve(async (request, reply) => {
      const baseline = reply.raw.listenerCount('close');
      await withClientCancellation(request, reply, async () => 'ok');
      counts.push(reply.raw.listenerCount('close') - baseline);
      await withClientCancellation(request, reply, async () => {
        throw new AppError('X', 'x', 400);
      }).catch(() => {});
      counts.push(reply.raw.listenerCount('close') - baseline);
      return { ok: true };
    });

    await call(port);

    assert.deepEqual(counts, [0, 0]);
  });

  it('cancels only the request whose client left', async () => {
    const results = {};
    const { port } = await serve(async (request, reply) => {
      const id = `r${Object.keys(results).length}`;
      results[id] = 'running';
      try {
        await withClientCancellation(
          request,
          reply,
          (signal) =>
            new Promise((resolve, reject) => {
              const timer = setTimeout(resolve, 250);
              signal.addEventListener(
                'abort',
                () => (clearTimeout(timer), reject(new Error('stopped')))
              );
            })
        );
        results[id] = 'completed';
      } catch (error) {
        results[id] = error.code;
      }
      return { ok: true };
    });

    const leaving = call(port, { leaveAfterMs: 100 });
    await pause(20);
    const staying = call(port);
    await Promise.all([leaving, staying]);
    await pause(60);

    assert.deepEqual(Object.values(results).sort(), ['REQUEST_CANCELLED', 'completed']);
  });
});

describe('why Fastify’s own request.signal is not used', () => {
  // If either of these starts failing, Fastify has changed request.signal and the
  // helper in cancellation.js can be reconsidered. Until then it is wrong both ways.

  it('is aborted by a normal, completed request if it is read early', async () => {
    let atStart = null;
    let atEnd = null;
    const { port } = await serve(async (request) => {
      atStart = request.signal.aborted;
      await pause(60);
      atEnd = request.signal.aborted;
      return { ok: true };
    });

    const result = await call(port);

    assert.equal(result.status, 200);
    assert.equal(atStart, false);
    assert.equal(atEnd, true, 'it would cancel every generation once its body was read');
  });

  it('never notices a client leaving if it is read late', async () => {
    let signal = null;
    const { port } = await serve(async (request) => {
      await pause(20);
      signal = request.signal;
      await pause(300);
      return { ok: true };
    });

    await call(port, { leaveAfterMs: 120 });
    await pause(40);

    assert.equal(signal.aborted, false, 'a real disconnect went unseen');
  });
});
