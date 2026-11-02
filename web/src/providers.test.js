import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { effectiveChoice, labelFor, startBlocker } from './providers.js';

const GEMINI = { id: 'gemini', label: 'Gemini', available: true, reason: null, code: null };
const CLAUDE_DOWN = {
  id: 'claude',
  label: 'Claude via Apayee',
  available: false,
  reason: 'Apayee is running with the mock provider, so Claude is not available.',
  code: 'provider_not_ready',
};
const CLAUDE_UP = { ...CLAUDE_DOWN, available: true, reason: null, code: null };

const list = (claude, extra = {}) => ({ default: 'gemini', providers: [GEMINI, claude], ...extra });

describe('which model is selected', () => {
  it('is Gemini until the user picks something else', () => {
    assert.equal(effectiveChoice(list(CLAUDE_DOWN), undefined), 'gemini');
  });

  it('is what the user picked, when the server still offers it', () => {
    assert.equal(effectiveChoice(list(CLAUDE_UP), 'claude'), 'claude');
    assert.equal(effectiveChoice(list(CLAUDE_UP), 'gemini'), 'gemini');
  });

  it('is the server default when there is no list to choose from', () => {
    assert.equal(effectiveChoice(null, undefined), null);
    assert.equal(
      effectiveChoice(null, 'claude'),
      null,
      'an old pick is not trusted without a list'
    );
  });

  it('ignores a pick the server does not offer, and the old id of one that went away', () => {
    assert.equal(effectiveChoice(list(CLAUDE_UP), 'mock'), 'gemini');
    assert.equal(effectiveChoice({ default: 'gemini', providers: [GEMINI] }, 'claude'), 'gemini');
  });

  it('is the server default for a server whose own provider is not in the list', () => {
    const legacy = list(CLAUDE_DOWN, { default: null });
    assert.equal(effectiveChoice(legacy, undefined), null);
    assert.equal(effectiveChoice(legacy, 'gemini'), 'gemini');
  });
});

describe('whether a run may start', () => {
  it('can with Gemini, which is available', () => {
    assert.equal(
      startBlocker({ status: 'ready', list: list(CLAUDE_DOWN), choice: 'gemini' }),
      null
    );
  });

  it('cannot with Claude while the backend says it is unavailable, and says why', () => {
    const blocker = startBlocker({ status: 'ready', list: list(CLAUDE_DOWN), choice: 'claude' });
    assert.match(blocker, /Claude via Apayee is not available/);
    assert.match(blocker, /mock provider/);
  });

  it('can with Claude the moment the backend reports it available', () => {
    assert.equal(startBlocker({ status: 'ready', list: list(CLAUDE_UP), choice: 'claude' }), null);
  });

  it('does not replace an unavailable selection with another model', () => {
    // Gemini is available, and still the pick stays Claude and the run is blocked:
    // switching is the user's call, not something the page does for them.
    const down = list(CLAUDE_DOWN);
    assert.equal(effectiveChoice(down, 'claude'), 'claude');
    assert.ok(startBlocker({ status: 'ready', list: down, choice: 'claude' }));
  });

  it('waits while the list is loading, and allows the server default if it failed', () => {
    assert.match(startBlocker({ status: 'loading', list: null, choice: null }), /Checking/);
    assert.equal(startBlocker({ status: 'error', list: null, choice: null }), null);
  });
});

describe('labels', () => {
  it('uses the backend label, and names the server default plainly', () => {
    assert.equal(labelFor(list(CLAUDE_UP), 'claude'), 'Claude via Apayee');
    assert.equal(labelFor(list(CLAUDE_UP), null), 'Server default');
  });

  it('uses the server’s own description of its default when it gives one', () => {
    const legacy = list(CLAUDE_DOWN, {
      default: null,
      default_label: 'Server default (Apayee gateway)',
    });
    assert.equal(labelFor(legacy, null), 'Server default (Apayee gateway)');
  });
});
