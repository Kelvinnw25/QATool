import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  DASH,
  formatAge,
  formatBytes,
  formatDuration,
  formatNumber,
  formatPercent,
  sparkPaths,
} from './format.js';

test('unavailable values are a dash, never zero', () => {
  for (const f of [formatDuration, formatBytes, formatPercent, formatNumber, formatAge]) {
    assert.equal(f(null), DASH);
    assert.equal(f(undefined), DASH);
    assert.equal(f(NaN), DASH);
  }
  assert.equal(formatNumber(0), '0');
  assert.equal(formatPercent(0), '0%');
});

test('durations', () => {
  assert.equal(formatDuration(450), '450 ms');
  assert.equal(formatDuration(4200), '4.2 s');
  assert.equal(formatDuration(42_000), '42 s');
  assert.equal(formatDuration(125_000), '2 m 5 s');
  assert.equal(formatDuration(2 * 3600_000 + 5 * 60_000), '2 h 5 m');
  assert.equal(formatDuration(3 * 86_400_000), '3 d 0 h');
  assert.equal(formatDuration(-1), DASH);
  assert.equal(formatAge(500), 'just now');
  assert.equal(formatAge(8000), '8.0 s ago');
  assert.equal(formatAge(42_000), '42 s ago');
});

test('bytes and percentages', () => {
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(1536), '1.5 KiB');
  assert.equal(formatBytes(512 * 1024 ** 2), '512 MiB');
  assert.equal(formatBytes(2 * 1024 ** 3), '2.0 GiB');
  assert.equal(formatPercent(0.9, 1), '90.0%');
});

test('sparkline paths break at missing samples and stay inside the box', () => {
  const paths = sparkPaths([1, 2, null, 3, 4], 100, 50);
  assert.equal(paths.length, 2);
  for (const path of paths) {
    for (const point of path.split(' ')) {
      const [x, y] = point.split(',').map(Number);
      assert.ok(x >= 0 && x <= 100 && y >= 0 && y <= 50, point);
    }
  }
  assert.deepEqual(sparkPaths([null, null], 100, 50), []);
  assert.deepEqual(sparkPaths([5], 100, 50), []);
  // A fixed ceiling keeps a CPU chart honest: 10% looks small next to 100%.
  const [flat] = sparkPaths([10, 10], 100, 50, { max: 100 });
  assert.ok(Number(flat.split(' ')[0].split(',')[1]) > 40);
});
