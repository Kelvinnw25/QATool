import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AppError } from '../lib/errors.js';
import { createSessionService } from './session.js';
import { createReplayCache, createTurnstileVerifier, TurnstileError } from './turnstile.js';

const NOW = Date.UTC(2026, 10, 3, 12, 0, 0);
const HOST = 'demo.example.com';
const ACTION = 'qatool_demo';

function clock(start = NOW) {
  const state = { t: start };
  return Object.assign(() => state.t, {
    advance(ms) {
      state.t += ms;
    },
  });
}

const good = (overrides = {}) => ({
  success: true,
  hostname: HOST,
  action: ACTION,
  challenge_ts: new Date(NOW - 5_000).toISOString(),
  ...overrides,
});

function verifier({ reply = good(), now = clock(), siteverify, ...options } = {}) {
  const calls = [];
  const verify = createTurnstileVerifier({
    secret: 'turnstile-secret',
    hostnames: [HOST],
    action: ACTION,
    now,
    siteverify:
      siteverify ??
      (async (body) => {
        calls.push(body);
        return typeof reply === 'function' ? reply(body) : reply;
      }),
    ...options,
  });
  return { verify, calls, now };
}

const failsWith = (promise, kind) =>
  assert.rejects(promise, (error) => {
    assert.ok(error instanceof TurnstileError, `expected a TurnstileError, got ${error}`);
    assert.equal(error.kind, kind);
    return true;
  });

describe('Turnstile verification', () => {
  it('passes a token Cloudflare accepts for this host and action, and sends the secret only to it', async () => {
    const { verify, calls } = verifier();
    await verify.verify('token-1');
    assert.deepEqual(calls, [{ secret: 'turnstile-secret', response: 'token-1' }]);
  });

  it('fails when Cloudflare says the token is not valid', async () => {
    const { verify } = verifier({
      reply: { success: false, 'error-codes': ['invalid-input-response'] },
    });
    await failsWith(verify.verify('token-1'), 'invalid');
  });

  it('refuses a token from the wrong hostname, case aside', async () => {
    await failsWith(
      verifier({ reply: good({ hostname: 'evil.example.net' }) }).verify.verify('t'),
      'hostname'
    );
    await failsWith(verifier({ reply: good({ hostname: '' }) }).verify.verify('t'), 'hostname');
    await failsWith(
      verifier({ reply: good({ hostname: undefined }) }).verify.verify('t'),
      'hostname'
    );
    await verifier({ reply: good({ hostname: 'DEMO.Example.COM' }) }).verify.verify('t');
  });

  it('refuses the wrong action, or none', async () => {
    await failsWith(verifier({ reply: good({ action: 'login' }) }).verify.verify('t'), 'action');
    await failsWith(verifier({ reply: good({ action: undefined }) }).verify.verify('t'), 'action');
  });

  it('refuses a stale challenge, a missing timestamp, and one from the future', async () => {
    const stale = new Date(NOW - 6 * 60_000).toISOString();
    await failsWith(verifier({ reply: good({ challenge_ts: stale }) }).verify.verify('t'), 'stale');
    await failsWith(
      verifier({ reply: good({ challenge_ts: undefined }) }).verify.verify('t'),
      'stale'
    );
    await failsWith(
      verifier({ reply: good({ challenge_ts: 'not a date' }) }).verify.verify('t'),
      'stale'
    );
    const future = new Date(NOW + 10 * 60_000).toISOString();
    await failsWith(
      verifier({ reply: good({ challenge_ts: future }) }).verify.verify('t'),
      'stale'
    );

    // Within the age allowance and the clock-skew allowance both pass.
    await verifier({
      reply: good({ challenge_ts: new Date(NOW - 4 * 60_000).toISOString() }),
    }).verify.verify('t');
    await verifier({
      reply: good({ challenge_ts: new Date(NOW + 30_000).toISOString() }),
    }).verify.verify('t');
  });

  it('refuses a token it has seen before without asking Cloudflare again', async () => {
    const { verify, calls } = verifier();
    await verify.verify('same-token');
    await failsWith(verify.verify('same-token'), 'replay');
    assert.equal(calls.length, 1, 'a replay costs no second round trip');
  });

  it('refuses concurrent uses of one token: only one wins', async () => {
    let release;
    const gate = new Promise((resolve) => (release = resolve));
    const { verify, calls } = verifier({
      siteverify: async (body) => {
        calls.push(body);
        await gate;
        return good();
      },
    });
    const first = verify.verify('race');
    const second = verify.verify('race');
    release();

    const settled = await Promise.allSettled([first, second]);
    assert.deepEqual(settled.map((r) => r.status).sort(), ['fulfilled', 'rejected']);
  });

  it('keeps a token spent when it failed on the merits, so it cannot be retried', async () => {
    const { verify } = verifier({ reply: good({ hostname: 'evil.example.net' }) });
    await failsWith(verify.verify('t'), 'hostname');
    await failsWith(verify.verify('t'), 'replay');
  });

  it('rejects tokens that are not a string, empty, or too long', async () => {
    const { verify, calls } = verifier();
    for (const bad of [undefined, null, 42, {}, [], '', 'x'.repeat(2049)]) {
      await failsWith(verify.verify(bad), 'invalid');
    }
    assert.equal(calls.length, 0, 'Cloudflare is not asked about a token that cannot be one');
  });
});

describe('Turnstile verification fails closed', () => {
  it('treats a network error as unavailable, never as a pass', async () => {
    const { verify } = verifier({
      siteverify: async () => {
        throw new TypeError('fetch failed');
      },
    });
    await failsWith(verify.verify('t'), 'unavailable');
  });

  it('treats a timeout as unavailable', async () => {
    const { verify } = verifier({
      siteverify: async () => {
        throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
      },
    });
    await failsWith(verify.verify('t'), 'unavailable');
  });

  it('treats a reply that is not the documented JSON as unavailable', async () => {
    // Through `siteverify` directly: the helper's `reply` option would turn undefined into a pass.
    for (const answer of [null, 'ok', 42, [], undefined]) {
      const { verify } = verifier({ siteverify: async () => answer });
      await failsWith(verify.verify(`t-${String(answer)}`), 'unavailable');
    }
  });

  it('treats an internal-error from Cloudflare as unavailable, not as an invalid token', async () => {
    const { verify } = verifier({ reply: { success: false, 'error-codes': ['internal-error'] } });
    await failsWith(verify.verify('t'), 'unavailable');
  });

  it('does not count a token as spent when Cloudflare could not be reached', async () => {
    let up = false;
    const { verify } = verifier({
      siteverify: async () => {
        if (!up) throw new TypeError('fetch failed');
        return good();
      },
    });
    await failsWith(verify.verify('t'), 'unavailable');
    up = true;
    await verify.verify('t');
  });

  it('only ever treats exactly success: true as a pass', async () => {
    for (const success of [false, 'true', 1, null, undefined, {}]) {
      await assert.rejects(verifier({ reply: good({ success }) }).verify.verify('t'));
    }
  });
});

describe('the replay cache', () => {
  it('forgets a token after its time, and holds a bounded number', () => {
    const now = clock();
    const cache = createReplayCache({ ttlMs: 1000, maxEntries: 3, now });

    assert.equal(cache.claim('a'), true);
    assert.equal(cache.claim('a'), false);

    now.advance(1001);
    assert.equal(cache.claim('a'), true, 'expired entries are dropped');

    for (let i = 0; i < 100; i += 1) cache.claim(`t-${i}`);
    assert.ok(cache.size <= 3);
  });

  it('stores hashes, not tokens', async () => {
    const seen = [];
    const cache = createReplayCache();
    const original = cache.claim;
    cache.claim = (hash) => {
      seen.push(hash);
      return original(hash);
    };
    await createTurnstileVerifier({
      secret: 's',
      hostnames: [HOST],
      action: ACTION,
      now: clock(),
      replay: cache,
      siteverify: async () => good(),
    }).verify('secret-looking-token-value');

    assert.equal(seen.length, 1);
    assert.match(seen[0], /^[0-9a-f]{64}$/);
    assert.ok(!seen[0].includes('secret-looking-token-value'));
  });
});

describe('the session service', () => {
  const origin = 'https://demo.example.com';
  const request = (headers = { origin }) => ({
    headers,
    raw: { socket: { remoteAddress: '172.18.0.1' } },
  });

  function service({ verify, limit = 1000 } = {}) {
    const counters = [];
    const minted = [];
    return {
      counters,
      minted,
      service: createSessionService({
        verifier: { verify: verify ?? (async () => {}) },
        tickets: {
          mint: async (options) => {
            minted.push(options);
            return { ticket: 'T', sid: 'S'.repeat(22), expiresAt: NOW + 1000 };
          },
        },
        clientAddress: () => ({ peer: '172.18.0.1', client: '203.0.113.9' }),
        mintPerMinutePerIp: limit,
        metrics: { inc: (name) => counters.push(name), touchSession: () => {} },
        now: clock(),
      }),
    };
  }

  it('mints a ticket for the request origin once Turnstile passes', async () => {
    const { service: s, minted, counters } = service();
    const reply = await s.mint(request(), 'token');
    assert.equal(reply.ticket, 'T');
    assert.deepEqual(minted, [{ origin }]);
    assert.ok(counters.includes('tickets_minted'));
  });

  it('answers every Turnstile failure with the same 400, and counts the kind', async () => {
    for (const kind of ['invalid', 'replay', 'hostname', 'action', 'stale']) {
      const { service: s, counters } = service({
        verify: async () => {
          throw new TurnstileError(kind);
        },
      });
      await assert.rejects(s.mint(request(), 't'), (error) => {
        assert.equal(error.statusCode, 400);
        assert.equal(error.code, 'TURNSTILE_FAILED');
        assert.ok(!error.message.includes(kind), 'the reason is not told to the caller');
        return true;
      });
      assert.ok(counters.includes(`ticket_failed_${kind}`));
    }
  });

  it('answers 503 and a retry time when verification cannot be completed', async () => {
    const { service: s } = service({
      verify: async () => {
        throw new TurnstileError('unavailable');
      },
    });
    await assert.rejects(s.mint(request(), 't'), (error) => {
      assert.equal(error.statusCode, 503);
      assert.equal(error.code, 'CHALLENGE_UNAVAILABLE');
      assert.ok(error.retryAfterSeconds >= 1);
      return true;
    });
  });

  it('mints nothing when verification fails', async () => {
    const { service: s, minted } = service({
      verify: async () => {
        throw new TurnstileError('invalid');
      },
    });
    await assert.rejects(s.mint(request(), 't'));
    assert.equal(minted.length, 0);
  });

  it('applies a loose backstop per client address, before spending a verification', async () => {
    let verifications = 0;
    const { service: s } = service({
      limit: 3,
      verify: async () => {
        verifications += 1;
      },
    });
    for (let i = 0; i < 3; i += 1) await s.mint(request(), `t${i}`);

    await assert.rejects(s.mint(request(), 't3'), (error) => {
      assert.equal(error.statusCode, 429);
      assert.equal(error.code, 'RATE_LIMITED');
      assert.ok(error.retryAfterSeconds >= 1);
      return true;
    });
    assert.equal(verifications, 3, 'a limited mint costs no Turnstile call');
  });

  it('refuses a request with no Origin, even though a hook should have', async () => {
    const { service: s } = service();
    await assert.rejects(s.mint(request({}), 't'), (error) => error instanceof AppError);
  });
});
