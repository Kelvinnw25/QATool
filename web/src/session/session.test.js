import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { createApi } from '../api.js';
import { fakeBackend, fakeClock, GOOD_TOKEN } from '../jobs/fixtures/fake-backend.js';
import { createSessionManager } from './session.js';
import { loadTurnstile, renderWidget } from './turnstile.js';
import { createTicketStore } from './ticket-store.js';

/**
 * The visitor's session and the Turnstile widget, against the stand-in backend and a fake clock.
 */

function setup({ lifetimeMs = 30 * 60_000 } = {}) {
  const clock = fakeClock();
  const backend = fakeBackend({ now: clock.now, ticketLifetimeMs: lifetimeMs });
  const store = createTicketStore({ now: clock.now });
  const api = createApi({
    demo: true,
    fetchImpl: backend.fetch,
    getTicket: () => store.get(),
    onUnauthorized: () => store.clear('rejected'),
  });
  const timers = [];
  const session = createSessionManager({
    api,
    store,
    now: clock.now,
    setTimer: (fn, ms) => timers.push({ fn, ms }) && timers.length,
    clearTimer: () => {},
  });
  return { clock, backend, store, api, session, timers };
}

describe('creating a session', () => {
  it('trades a Turnstile token for a ticket held in memory', async () => {
    const { session, store, backend, clock } = setup();
    assert.equal(session.getState().status, 'unverified');

    assert.equal(await session.start(GOOD_TOKEN), true);

    const state = session.getState();
    assert.equal(state.status, 'ready');
    assert.equal(store.get(), 'ticket-1');
    assert.equal(session.ticket(), 'ticket-1');
    assert.equal(state.expiresAt, clock.now() + 30 * 60_000);
    assert.equal(state.limits.max_files, 30);
    assert.equal(state.pollIntervalMs, 2500);
    assert.equal(backend.state.mintCount, 1);
  });

  it('mints exactly once however often it is asked: concurrent and repeated starts are ignored', async () => {
    const { session, backend } = setup();
    await Promise.all([
      session.start(GOOD_TOKEN),
      session.start(GOOD_TOKEN),
      session.start(GOOD_TOKEN),
    ]);
    await session.start(GOOD_TOKEN);
    assert.equal(backend.state.mintCount, 1);
  });

  it('does not mint again during normal use: the ticket is simply used', async () => {
    const { session, api, backend } = setup();
    await session.start(GOOD_TOKEN);
    for (let i = 0; i < 20; i += 1) await api.validate({});
    assert.equal(backend.state.mintCount, 1);
    assert.equal(backend.calls.filter((c) => c.path === '/api/session').length, 1);
  });

  it('reports a failed verification and asks for a fresh widget', async () => {
    const { session, store } = setup();
    const before = session.getState().challenge;
    assert.equal(await session.start('bad-token'), false);

    const state = session.getState();
    assert.equal(state.status, 'failed');
    assert.equal(state.error.code, 'TURNSTILE_FAILED');
    assert.match(state.error.message, /did not pass/);
    assert.equal(store.get(), null);
    assert.equal(state.challenge, before + 1, 'the spent token is replaced, not reused');

    // A fresh token then works.
    assert.equal(await session.start(GOOD_TOKEN), true);
  });

  it('turns a network failure into a message, not a thrown error', async () => {
    const clock = fakeClock();
    const store = createTicketStore({ now: clock.now });
    const api = createApi({
      demo: true,
      fetchImpl: () => {
        throw new TypeError('Failed to fetch');
      },
    });
    const session = createSessionManager({
      api,
      store,
      now: clock.now,
      setTimer: () => 0,
      clearTimer: () => {},
    });
    assert.equal(await session.start('tok'), false);
    assert.equal(session.getState().error.code, 'NETWORK_ERROR');
    assert.match(session.getState().error.message, /cannot be reached/);
  });

  it('ignores an empty token', async () => {
    const { session, backend } = setup();
    assert.equal(await session.start(''), false);
    assert.equal(await session.start(undefined), false);
    assert.equal(backend.state.mintCount, 0);
    assert.equal(session.getState().status, 'unverified');
  });
});

describe('ticket expiry', () => {
  it('ends the session at expiry and requires a fresh verification', async () => {
    const { session, store, clock, timers } = setup({ lifetimeMs: 60_000 });
    await session.start(GOOD_TOKEN);
    const challenge = session.getState().challenge;

    // The expiry timer is armed for the ticket's lifetime.
    assert.equal(timers.length, 1);
    assert.ok(timers[0].ms >= 60_000 && timers[0].ms < 61_000);

    clock.advance(60_001);
    timers[0].fn();

    const state = session.getState();
    assert.equal(state.status, 'expired');
    assert.equal(state.reason, 'expired');
    assert.equal(store.get(), null);
    assert.equal(state.challenge, challenge + 1);

    // A new widget token then starts a new session (a new ticket).
    assert.equal(await session.start(GOOD_TOKEN), true);
    assert.equal(session.ticket(), 'ticket-2');
  });

  it('notices expiry even if the timer never fired (a throttled tab)', async () => {
    const { session, clock } = setup({ lifetimeMs: 60_000 });
    await session.start(GOOD_TOKEN);
    clock.advance(61_000);
    assert.equal(session.ticket(), null, 'asking for the ticket is enough');
    assert.equal(session.getState().status, 'expired');
  });

  it('sends no Authorization header once the ticket has expired', async () => {
    const { session, api, backend, clock } = setup({ lifetimeMs: 60_000 });
    await session.start(GOOD_TOKEN);
    clock.advance(61_000);
    await api.validate({}).catch(() => {});
    const last = backend.calls.at(-1).request;
    assert.equal(last.headers.get('authorization'), null);
  });

  it('a 401 from the backend ends the session too', async () => {
    const { session, api, backend } = setup();
    await session.start(GOOD_TOKEN);
    backend.override('POST /api/validate', () =>
      backend.fail(401, 'UNAUTHENTICATED', 'Authentication is required.')
    );
    await assert.rejects(api.validate({}), { status: 401 });

    assert.equal(session.getState().status, 'expired');
    assert.equal(session.getState().reason, 'rejected');
    assert.equal(session.ticket(), null);
  });

  it('notifies subscribers of every change and lets them unsubscribe', async () => {
    const { session } = setup();
    let notified = 0;
    const stop = session.subscribe(() => (notified += 1));
    await session.start(GOOD_TOKEN);
    assert.ok(notified >= 2, 'verifying, then ready');
    stop();
    const seen = notified;
    session.dispose();
    assert.equal(notified, seen);
  });
});

describe('where the ticket is kept', () => {
  const real = {
    local: Object.getOwnPropertyDescriptor(globalThis, 'localStorage'),
    session: Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage'),
    cookie: Object.getOwnPropertyDescriptor(globalThis, 'document'),
  };
  afterEach(() => {
    for (const [name, descriptor] of [
      ['localStorage', real.local],
      ['sessionStorage', real.session],
      ['document', real.cookie],
    ]) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  });

  it('never touches localStorage, sessionStorage or cookies', async () => {
    const touched = [];
    const trap = (name) => ({
      configurable: true,
      get() {
        touched.push(name);
        return { getItem() {}, setItem() {}, removeItem() {}, clear() {} };
      },
    });
    Object.defineProperty(globalThis, 'localStorage', trap('localStorage'));
    Object.defineProperty(globalThis, 'sessionStorage', trap('sessionStorage'));
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      get() {
        touched.push('document');
        return { cookie: '' };
      },
    });

    const { session, api } = setup();
    await session.start(GOOD_TOKEN);
    await api.validate({});
    session.dispose();

    assert.deepEqual(touched, []);
  });
});

describe('the ticket store', () => {
  it('forgets a ticket at its expiry time and says why', () => {
    const clock = fakeClock();
    const store = createTicketStore({ now: clock.now });
    const events = [];
    store.subscribe((event) => events.push(event));

    store.set('abc', clock.now() + 1000);
    assert.equal(store.get(), 'abc');
    clock.advance(1000);
    assert.equal(store.get(), null);
    assert.equal(store.expiresAt(), null);
    assert.deepEqual(events.at(-1), { type: 'cleared', reason: 'expired' });
  });
});

describe('the Turnstile widget', () => {
  function fakeTurnstile() {
    const calls = { render: [], reset: [], remove: [] };
    return {
      calls,
      render(container, options) {
        calls.render.push({ container, options });
        return 'w1';
      },
      reset: (id) => calls.reset.push(id),
      remove: (id) => calls.remove.push(id),
    };
  }

  it('renders with the public site key and the expected action, and hands over each token', () => {
    const turnstile = fakeTurnstile();
    const tokens = [];
    renderWidget('container', {
      turnstile,
      siteKey: 'site-key',
      action: 'qatool_demo',
      onToken: (token) => tokens.push(token),
    });

    const { options } = turnstile.calls.render[0];
    assert.equal(options.sitekey, 'site-key');
    assert.equal(options.action, 'qatool_demo');
    options.callback('tok-1');
    assert.deepEqual(tokens, ['tok-1']);
  });

  it('resets itself when its token lapses, so a dead token is never held', () => {
    const turnstile = fakeTurnstile();
    let expired = 0;
    renderWidget('c', {
      turnstile,
      siteKey: 'k',
      action: 'a',
      onToken() {},
      onExpire: () => (expired += 1),
    });
    turnstile.calls.render[0].options['expired-callback']();
    assert.equal(expired, 1);
    assert.deepEqual(turnstile.calls.reset, ['w1']);
  });

  it('reports a widget error and says it is handled', () => {
    const turnstile = fakeTurnstile();
    const errors = [];
    renderWidget('c', {
      turnstile,
      siteKey: 'k',
      action: 'a',
      onToken() {},
      onError: (c) => errors.push(c),
    });
    assert.equal(turnstile.calls.render[0].options['error-callback']('110200'), true);
    assert.deepEqual(errors, ['110200']);
  });

  it('removes the widget once, and survives a second remove', () => {
    const turnstile = fakeTurnstile();
    const widget = renderWidget('c', { turnstile, siteKey: 'k', action: 'a', onToken() {} });
    widget.remove();
    widget.remove();
    assert.deepEqual(turnstile.calls.remove, ['w1']);
  });

  it('loads the script once, however many widgets ask', async () => {
    const appended = [];
    const doc = {
      createElement: () => ({}),
      head: { appendChild: (script) => appended.push(script) },
    };
    const first = loadTurnstile({ document: doc });
    const second = loadTurnstile({ document: doc });
    assert.equal(appended.length, 1);
    assert.match(appended[0].src, /^https:\/\/challenges\.cloudflare\.com\/turnstile\/v0\/api\.js/);

    globalThis.turnstile = fakeTurnstile();
    try {
      appended[0].onload();
      assert.equal(await first, globalThis.turnstile);
      assert.equal(await second, globalThis.turnstile);
    } finally {
      delete globalThis.turnstile;
    }
  });
});
