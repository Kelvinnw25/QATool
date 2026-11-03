import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { SlidingWindowLimiter } from './limiter.js';

function clock(start = 1_000_000) {
  const state = { t: start };
  return Object.assign(() => state.t, {
    advance(ms) {
      state.t += ms;
    },
  });
}

describe('the sliding-window limiter', () => {
  it('allows up to the limit, refuses the next with a retry time, and recovers', () => {
    const now = clock();
    const limiter = new SlidingWindowLimiter({ limit: 3, windowMs: 60_000, now });

    for (let i = 0; i < 3; i += 1) assert.equal(limiter.hit('a').ok, true);
    const refused = limiter.hit('a');
    assert.equal(refused.ok, false);
    assert.ok(refused.retryAfterMs > 0 && refused.retryAfterMs <= 60_000);

    now.advance(60_001);
    assert.equal(limiter.hit('a').ok, true);
  });

  it('keeps keys apart: ten keys never use each other up', () => {
    const limiter = new SlidingWindowLimiter({ limit: 2, windowMs: 60_000, now: clock() });
    for (let key = 0; key < 10; key += 1) {
      assert.equal(limiter.hit(`sid-${key}`).ok, true);
      assert.equal(limiter.hit(`sid-${key}`).ok, true);
      assert.equal(limiter.hit(`sid-${key}`).ok, false);
    }
  });

  it('is off at zero', () => {
    const limiter = new SlidingWindowLimiter({ limit: 0, windowMs: 60_000, now: clock() });
    for (let i = 0; i < 1000; i += 1) assert.equal(limiter.hit('a').ok, true);
  });

  it('bounds its memory: the least recently used key is forgotten', () => {
    const limiter = new SlidingWindowLimiter({
      limit: 1,
      windowMs: 60_000,
      maxKeys: 3,
      now: clock(),
    });

    for (let key = 0; key < 50; key += 1) limiter.hit(`sid-${key}`);
    assert.equal(limiter.size, 3);

    // Forgetting is lenient, never stricter: an old key simply starts again.
    assert.equal(limiter.hit('sid-0').ok, true);
  });

  it('does not let a refused hit extend the wait', () => {
    const now = clock();
    const limiter = new SlidingWindowLimiter({ limit: 1, windowMs: 1000, now });
    limiter.hit('a');

    for (let i = 0; i < 20; i += 1) {
      now.advance(40);
      assert.equal(limiter.hit('a').ok, false);
    }
    now.advance(300);
    assert.equal(limiter.hit('a').ok, true, 'twenty refusals did not count as hits');
  });
});
