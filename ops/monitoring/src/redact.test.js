import assert from 'node:assert/strict';
import { test } from 'node:test';

import { describeError, redactDeep, redactText } from './redact.js';

const SECRET_SAMPLES = [
  'Authorization: Bearer abcdefghijklmnop1234567890',
  'TICKET_SECRET=supersecretvalue123',
  'TURNSTILE_SECRET: "0x4AAAAAAAsecretsecretsecret"',
  'APAYEE_TOKEN=tok_1234567890abcdef',
  'APAYEE_AUTH_TOKEN="tok_1234567890abcdef"',
  'GEMINI_API_KEY=AIzaSyA1234567890123456789012345678901234',
  'key sk-abcdefghijklmnopqrstuvwxyz0123',
  'eyJhbGciOiJIUzI1NiJ9.eyJzaWQiOiJhYmMifQ.c2lnbmF0dXJlMTIzNDU2',
];

test('credentials of every known shape are masked', () => {
  for (const sample of SECRET_SAMPLES) {
    const out = redactText(sample);
    assert.doesNotMatch(
      out,
      /supersecretvalue|tok_1234|AIzaSy|sk-abcdef|abcdefghijklmnop12|eyJhbGci|0x4AAAAAAAsecret/,
      sample
    );
  }
});

test('user paths and quick tunnel hosts are masked', () => {
  assert.equal(redactText('at C:\\Users\\kelvi\\Desktop\\QATool\\x.js failed'), 'at [path] failed');
  assert.match(
    redactText('GET https://random-words-here.trycloudflare.com/healthz'),
    /\[tunnel-host\]/
  );
  assert.doesNotMatch(redactText('postgres://admin:hunter2@db:5432/x'), /hunter2/);
});

test('text is bounded and non-strings are dropped, not stringified', () => {
  assert.equal(redactText('x'.repeat(1000)).length, 300);
  assert.equal(redactText({ a: 1 }), null);
  assert.equal(redactText(undefined), null);
});

test('describeError keeps a code and a redacted message, never a stack', () => {
  const error = Object.assign(new Error('failed with TICKET_SECRET=hunter22222'), {
    code: 'FAILED',
  });
  const out = describeError(error);
  assert.equal(out.code, 'FAILED');
  assert.doesNotMatch(out.message, /hunter22222/);
  assert.deepEqual(Object.keys(out).sort(), ['code', 'message']);
});

test('redactDeep drops secret-looking keys and masks nested strings', () => {
  const out = redactDeep({
    ok: 'fine',
    token: 'abc',
    nested: { Authorization: 'Bearer x', ticket: 't', list: ['APAYEE_TOKEN=zzzzzzzz1', 4, null] },
  });
  assert.deepEqual(Object.keys(out), ['ok', 'nested']);
  assert.deepEqual(Object.keys(out.nested), ['list']);
  assert.doesNotMatch(JSON.stringify(out), /zzzzzzzz1/);
  assert.equal(out.nested.list[1], 4);
});
