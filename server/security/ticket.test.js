import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { SignJWT } from 'jose';

import { createClientAddress } from './network.js';
import { createTicketHook, createTicketService, SID_PATTERN } from './ticket.js';

const SECRET = 'ticket-signing-key-0123456789-abcdefghij';
const OTHER_SECRET = 'a-different-signing-key-0123456789-abcdef';
const ORIGIN = 'https://demo.example.com';
const encode = (text) => new TextEncoder().encode(text);

function clock(start = Date.UTC(2026, 10, 3, 12, 0, 0)) {
  const state = { t: start };
  return Object.assign(() => state.t, {
    advance(ms) {
      state.t += ms;
    },
  });
}

function service(options = {}) {
  const now = options.now ?? clock();
  return {
    now,
    tickets: createTicketService({ secret: SECRET, ttlSeconds: 1800, now, ...options }),
  };
}

/** A ticket-shaped token with one thing made wrong. */
async function forged({
  secret = SECRET,
  alg = 'HS256',
  issuer = 'qatool',
  audience = ORIGIN,
  sid = 'AAAAAAAAAAAAAAAAAAAAAA',
  expiresIn = 1800,
  claims = { sid },
  omit = [],
} = {}) {
  const issuedAt = Math.floor(Date.UTC(2026, 10, 3, 12, 0, 0) / 1000);
  let jwt = new SignJWT(claims).setProtectedHeader({ alg, typ: 'JWT' });
  if (!omit.includes('iss')) jwt = jwt.setIssuer(issuer);
  if (!omit.includes('aud')) jwt = jwt.setAudience(audience);
  if (!omit.includes('iat')) jwt = jwt.setIssuedAt(issuedAt);
  if (!omit.includes('exp')) jwt = jwt.setExpirationTime(issuedAt + expiresIn);
  return jwt.sign(encode(secret));
}

describe('minting a ticket', () => {
  it('carries a random session id, issuer, audience, issued-at and expiry', async () => {
    const { tickets, now } = service();
    const minted = await tickets.mint({ origin: ORIGIN });

    const payload = JSON.parse(Buffer.from(minted.ticket.split('.')[1], 'base64url').toString());
    assert.match(payload.sid, SID_PATTERN);
    assert.equal(payload.iss, 'qatool');
    assert.equal(payload.aud, ORIGIN);
    assert.equal(payload.iat, Math.floor(now() / 1000));
    assert.equal(payload.exp, payload.iat + 1800);
    assert.equal(minted.expiresAt, payload.exp * 1000);
    assert.equal(minted.sid, payload.sid);

    const header = JSON.parse(Buffer.from(minted.ticket.split('.')[0], 'base64url').toString());
    assert.equal(header.alg, 'HS256');
  });

  it('never repeats a session id', async () => {
    const { tickets } = service();
    const ids = new Set();
    for (let i = 0; i < 200; i += 1) ids.add((await tickets.mint({ origin: ORIGIN })).sid);
    assert.equal(ids.size, 200);
  });

  it('holds no client address: the ticket is the same whoever asks', async () => {
    const { tickets } = service();
    const minted = await tickets.mint({ origin: ORIGIN });
    const claims = Object.keys(
      JSON.parse(Buffer.from(minted.ticket.split('.')[1], 'base64url').toString())
    ).sort();
    assert.deepEqual(claims, ['aud', 'exp', 'iat', 'iss', 'sid']);
  });
});

describe('verifying a ticket', () => {
  it('accepts a ticket it minted, for the origin it was minted for', async () => {
    const { tickets } = service();
    const minted = await tickets.mint({ origin: ORIGIN });
    const verified = await tickets.verify(minted.ticket, { origin: ORIGIN });
    assert.equal(verified.sid, minted.sid);
  });

  it('refuses a ticket used from another origin', async () => {
    const { tickets } = service();
    const minted = await tickets.mint({ origin: ORIGIN });
    await assert.rejects(
      tickets.verify(minted.ticket, { origin: 'https://elsewhere.example.net' }),
      (error) => error.code === 'ERR_JWT_CLAIM_VALIDATION_FAILED' && error.claim === 'aud'
    );
  });

  it('refuses an expired ticket, and accepts it up to the moment it expires', async () => {
    const { tickets, now } = service();
    const minted = await tickets.mint({ origin: ORIGIN });

    now.advance(1800 * 1000 - 10_000);
    await tickets.verify(minted.ticket, { origin: ORIGIN });

    now.advance(20_000);
    await assert.rejects(
      tickets.verify(minted.ticket, { origin: ORIGIN }),
      (error) => error.code === 'ERR_JWT_EXPIRED'
    );
  });

  it('refuses a ticket signed with another key', async () => {
    const { tickets } = service();
    await assert.rejects(
      tickets.verify(await forged({ secret: OTHER_SECRET }), { origin: ORIGIN }),
      (error) => error.code === 'ERR_JWS_SIGNATURE_VERIFICATION_FAILED'
    );
  });

  it('refuses a tampered payload', async () => {
    const { tickets } = service();
    const minted = await tickets.mint({ origin: ORIGIN });
    const [header, payload, signature] = minted.ticket.split('.');
    const edited = JSON.parse(Buffer.from(payload, 'base64url').toString());
    edited.sid = 'BBBBBBBBBBBBBBBBBBBBBB';
    const swapped = Buffer.from(JSON.stringify(edited)).toString('base64url');

    await assert.rejects(
      tickets.verify(`${header}.${swapped}.${signature}`, { origin: ORIGIN }),
      (error) => error.code === 'ERR_JWS_SIGNATURE_VERIFICATION_FAILED'
    );
  });

  it('pins the algorithm: HS384, HS512, none and RS256 are all refused', async () => {
    const { tickets } = service();

    for (const alg of ['HS384', 'HS512']) {
      await assert.rejects(
        tickets.verify(await forged({ alg }), { origin: ORIGIN }),
        (error) => error.code === 'ERR_JOSE_ALG_NOT_ALLOWED',
        alg
      );
    }

    const none = (header) =>
      `${Buffer.from(JSON.stringify(header)).toString('base64url')}.${Buffer.from(
        JSON.stringify({
          sid: 'AAAAAAAAAAAAAAAAAAAAAA',
          iss: 'qatool',
          aud: ORIGIN,
          iat: 1,
          exp: 99999999999,
        })
      ).toString('base64url')}.`;
    await assert.rejects(tickets.verify(none({ alg: 'none', typ: 'JWT' }), { origin: ORIGIN }));
    await assert.rejects(tickets.verify(none({ alg: 'RS256', typ: 'JWT' }), { origin: ORIGIN }));
  });

  it('refuses the wrong issuer', async () => {
    const { tickets } = service();
    await assert.rejects(
      tickets.verify(await forged({ issuer: 'someone-else' }), { origin: ORIGIN }),
      (error) => error.code === 'ERR_JWT_CLAIM_VALIDATION_FAILED' && error.claim === 'iss'
    );
  });

  it('requires every claim', async () => {
    const { tickets } = service();
    for (const missing of ['iss', 'aud', 'iat', 'exp']) {
      await assert.rejects(
        tickets.verify(await forged({ omit: [missing] }), { origin: ORIGIN }),
        `${missing} missing must be refused`
      );
    }
    await assert.rejects(
      tickets.verify(await forged({ claims: {} }), { origin: ORIGIN }),
      'a ticket without a sid must be refused'
    );
  });

  it('refuses a session id that is not one this service would mint', async () => {
    const { tickets } = service();
    for (const sid of ['short', 'has spaces in it!!!!!!', 'A'.repeat(40), 42, null, '']) {
      await assert.rejects(
        tickets.verify(await forged({ claims: { sid } }), { origin: ORIGIN }),
        `${JSON.stringify(sid)} must be refused`
      );
    }
  });
});

describe('the ticket hook', () => {
  const clientAddress = createClientAddress([]);
  const logged = [];
  const request = (headers = {}, overrides = {}) => ({
    method: 'GET',
    headers,
    routeOptions: { config: {} },
    raw: { socket: { remoteAddress: '172.18.0.1' } },
    log: { warn: (entry) => logged.push(entry) },
    ...overrides,
  });

  async function setup() {
    const { tickets, now } = service();
    const touched = [];
    const counters = [];
    const hook = createTicketHook({
      tickets,
      clientAddress,
      metrics: { touchSession: (sid) => touched.push(sid), inc: (name) => counters.push(name) },
    });
    return { tickets, now, hook, touched, counters };
  }

  it('sets the visitor from a valid bearer ticket and notes the session', async () => {
    const { tickets, hook, touched } = await setup();
    const minted = await tickets.mint({ origin: ORIGIN });
    const req = request({ authorization: `Bearer ${minted.ticket}`, origin: ORIGIN });

    await hook(req);
    assert.equal(req.visitor.sid, minted.sid);
    assert.ok(Object.isFrozen(req.visitor));
    assert.deepEqual(touched, [minted.sid]);
  });

  it('refuses everything else with one identical 401', async () => {
    const { tickets, hook, counters } = await setup();
    const minted = await tickets.mint({ origin: ORIGIN });

    const cases = [
      ['no header', { origin: ORIGIN }],
      ['not a bearer scheme', { authorization: `Basic ${minted.ticket}`, origin: ORIGIN }],
      ['garbage', { authorization: 'Bearer not-a-jwt', origin: ORIGIN }],
      ['another origin', { authorization: `Bearer ${minted.ticket}`, origin: 'https://x.test' }],
      ['no origin', { authorization: `Bearer ${minted.ticket}` }],
      ['an oversized token', { authorization: `Bearer ${'a'.repeat(5000)}`, origin: ORIGIN }],
    ];

    const bodies = [];
    for (const [label, headers] of cases) {
      await assert.rejects(hook(request(headers)), (error) => {
        assert.equal(error.statusCode, 401, label);
        assert.equal(error.code, 'UNAUTHENTICATED', label);
        bodies.push(JSON.stringify(error.toJSON()));
        return true;
      });
    }
    assert.equal(new Set(bodies).size, 1, 'the caller cannot tell the reasons apart');
    assert.equal(counters.filter((name) => name === 'auth_rejected').length, cases.length);
  });

  it('records why in the log, and never the token', async () => {
    const { tickets, hook, now } = await setup();
    logged.length = 0;
    const minted = await tickets.mint({ origin: ORIGIN });
    now.advance(2 * 3600 * 1000);

    await assert.rejects(
      hook(request({ authorization: `Bearer ${minted.ticket}`, origin: ORIGIN }))
    );
    assert.equal(logged.length, 1);
    assert.equal(logged[0].reason, 'expired');
    assert.ok(!JSON.stringify(logged).includes(minted.ticket));
  });

  it('skips preflight and routes marked public, and nothing else', async () => {
    const { hook } = await setup();
    await hook(request({}, { method: 'OPTIONS' }));
    await hook(request({}, { routeOptions: { config: { public: true } } }));
    await assert.rejects(hook(request({}, { routeOptions: { config: { public: false } } })));
    await assert.rejects(hook(request({})), 'an unknown route has no config and is denied');
  });

  it('never takes identity from a header or body a caller can write', async () => {
    const { tickets, hook } = await setup();
    const minted = await tickets.mint({ origin: ORIGIN });
    const req = request({
      authorization: `Bearer ${minted.ticket}`,
      origin: ORIGIN,
      'x-sid': 'ZZZZZZZZZZZZZZZZZZZZZZ',
      'x-forwarded-for': '6.6.6.6',
    });
    req.body = { sid: 'ZZZZZZZZZZZZZZZZZZZZZZ' };

    await hook(req);
    assert.equal(req.visitor.sid, minted.sid);
  });
});
