import assert from 'node:assert/strict';
import { test } from 'node:test';

import { MAX_SOCKET_PATH_BYTES, validateSocketPath } from './socket-path.js';

test('the documented path is accepted on Linux', () => {
  assert.deepEqual(validateSocketPath('/tmp/qatool-ops-metrics.sock', 'linux'), {
    ok: true,
    path: '/tmp/qatool-ops-metrics.sock',
  });
});

test('anything that is not an absolute, normalised *.sock path is refused, not corrected', () => {
  const refused = [
    undefined,
    null,
    '',
    42,
    'relative.sock',
    './x.sock',
    '/tmp/../etc/x.sock',
    '/tmp//x.sock',
    '/tmp/x.sock/',
    '/tmp/x.sock\0',
    '/tmp/x',
    '/tmp/x.txt',
    '/etc/passwd',
    '/tmp/a b.sock',
    '/tmp/$(id).sock',
    '/tmp/x.sock;rm',
    `/tmp/${'a'.repeat(MAX_SOCKET_PATH_BYTES)}.sock`,
    'C:\\temp\\x.sock',
  ];
  for (const value of refused) {
    const result = validateSocketPath(value, 'linux');
    assert.equal(result.ok, false, String(value));
    assert.ok(result.reason.length > 0);
  }
});

test('Windows is refused with a reason, because Node would create a named pipe there', () => {
  const result = validateSocketPath('/tmp/qatool-ops-metrics.sock', 'win32');
  assert.equal(result.ok, false);
  assert.match(result.reason, /Windows/);
});
