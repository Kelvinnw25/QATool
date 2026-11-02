import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { RunLedger, withActivity } from './run.js';

/**
 * A run's model is chosen once, when it begins, and must not change under it.
 * The ledger is where that is enforced, so these are the properties the rest of
 * the interface leans on.
 */

describe('beginning a run', () => {
  it('records the model and marks the run active', () => {
    const run = new RunLedger().begin({ provider: 'claude', label: 'Claude via Apayee' });

    assert.equal(run.provider, 'claude');
    assert.equal(run.label, 'Claude via Apayee');
    assert.equal(run.active, true);
  });

  it('freezes the record, so nothing can switch a run to another model', () => {
    const run = new RunLedger().begin({ provider: 'gemini', label: 'Gemini' });

    assert.throws(() => {
      run.provider = 'claude';
    }, TypeError);
    assert.equal(run.provider, 'gemini');
    assert.ok(Object.isFrozen(run));
  });

  it('keeps the model when only the activity changes', () => {
    const run = new RunLedger().begin({ provider: 'claude', label: 'Claude via Apayee' });
    const ended = withActivity(run, false);

    assert.equal(ended.active, false);
    assert.equal(ended.provider, 'claude');
    assert.equal(ended.id, run.id);
    assert.ok(Object.isFrozen(ended));
    assert.equal(run.active, true, 'the original is untouched');
  });

  it('accepts null as "the server decides"', () => {
    const run = new RunLedger().begin({ provider: null, label: 'Server default' });
    assert.equal(run.provider, null);
  });
});

describe('replacing a run', () => {
  it('makes only the newest run current', () => {
    const ledger = new RunLedger();
    const first = ledger.begin({ provider: 'gemini', label: 'Gemini' });
    assert.equal(ledger.isCurrent(first.id), true);

    const second = ledger.begin({ provider: 'claude', label: 'Claude via Apayee' });

    assert.equal(ledger.isCurrent(first.id), false, 'a replaced run is stale');
    assert.equal(ledger.isCurrent(second.id), true);
    assert.notEqual(first.id, second.id);
  });

  it('retires the current run when the workflow is abandoned', () => {
    const ledger = new RunLedger();
    const run = ledger.begin({ provider: 'gemini', label: 'Gemini' });

    ledger.retire();

    assert.equal(ledger.isCurrent(run.id), false);
  });

  it('never reports an id it did not issue as current', () => {
    const ledger = new RunLedger();
    assert.equal(ledger.isCurrent(0), false);
    assert.equal(ledger.isCurrent(1), false);
    assert.equal(ledger.isCurrent(undefined), false);
  });
});
