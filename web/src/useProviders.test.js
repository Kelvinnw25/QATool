import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { watchProviders } from './useProviders.js';

/**
 * The model picker's polling, and its absence in the public demo: the server fixes the model there,
 * so the page must not ask which models exist - no request, no timer, no focus listener.
 */

function target() {
  const listeners = new Map();
  return {
    listeners,
    addEventListener: (name, fn) => listeners.set(name, fn),
    removeEventListener: (name) => listeners.delete(name),
  };
}

describe('watching the model list', () => {
  it('disabled (the public demo): asks nothing and listens to nothing', async () => {
    let asked = 0;
    const events = target();
    const stop = watchProviders({
      load: async () => (asked += 1),
      onState: () => {},
      enabled: false,
      intervalMs: 1,
      target: events,
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    stop();

    assert.equal(asked, 0);
    assert.equal(events.listeners.size, 0);
  });

  it('enabled (the local tool): asks at once, on an interval and on focus, and stops cleanly', async () => {
    let asked = 0;
    const states = [];
    const events = target();
    const stop = watchProviders({
      load: async () => ({ providers: [], n: (asked += 1) }),
      onState: (state) => states.push(state.status),
      intervalMs: 10,
      target: events,
    });
    assert.ok(events.listeners.has('focus'));
    await new Promise((resolve) => setTimeout(resolve, 45));
    stop();
    const settled = asked;

    assert.ok(settled >= 3, `asked ${settled} times`);
    assert.equal(events.listeners.size, 0);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(asked, settled, 'nothing is asked after it stops');
    assert.ok(states.every((status) => status === 'ready'));
  });

  it('clears the list on a failure rather than keeping a stale "available"', async () => {
    const states = [];
    const stop = watchProviders({
      load: async () => {
        throw new Error('down');
      },
      onState: (state) => states.push(state),
      intervalMs: 1000,
      target: target(),
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    stop();
    assert.deepEqual(states, [{ status: 'error', list: null }]);
  });
});
