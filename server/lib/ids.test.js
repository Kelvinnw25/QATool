import test from 'node:test';
import assert from 'node:assert/strict';
import { formatSequentialId, nextSequentialId, parseSequentialId } from './ids.js';

test('formats sequential ids with three-digit padding', () => {
  assert.equal(formatSequentialId('TC', 1), 'TC-001');
  assert.equal(formatSequentialId('REQ', 42), 'REQ-042');
  assert.equal(formatSequentialId('DOC', 7), 'DOC-007');
});

test('keeps widening past 999 instead of wrapping', () => {
  assert.equal(formatSequentialId('TC', 1000), 'TC-1000');
});

test('parses sequential ids and rejects malformed ones', () => {
  assert.deepEqual(parseSequentialId('REQ-012'), { prefix: 'REQ', sequence: 12 });
  assert.equal(parseSequentialId('REQ-12'), null, 'requires at least three digits');
  assert.equal(parseSequentialId('req-012'), null, 'prefix is case sensitive');
  assert.equal(parseSequentialId(''), null);
  assert.equal(parseSequentialId(null), null);
});

test('allocates the first id when a project is empty', () => {
  assert.equal(nextSequentialId('TC', []), 'TC-001');
});

test('allocates from the highest existing number, not the count', () => {
  // The gap matters: if TC-002 was deleted, the next id must still be TC-004.
  // Reusing TC-002 would silently repoint anything still referencing it.
  assert.equal(nextSequentialId('TC', ['TC-001', 'TC-003']), 'TC-004');
});

test('ignores ids belonging to a different prefix', () => {
  assert.equal(nextSequentialId('TC', ['REQ-009', 'DOC-004', 'TC-002']), 'TC-003');
});

test('ignores unparseable ids rather than throwing', () => {
  assert.equal(nextSequentialId('TC', ['TC-001', 'rubbish', '']), 'TC-002');
});
