import assert from 'node:assert/strict';
import { test } from 'node:test';

import { assessConcurrency, readDashboardCapacity } from './concurrency.js';

const ok = (workers, gateway) => assessConcurrency({ workers, gateway });

test('1 and 2 are valid when both ends agree; unset is the default 1', () => {
  assert.deepEqual(ok('1', '1').problems, []);
  assert.deepEqual(ok('2', '2'), { problems: [], workers: 2, gateway: 2, ceiling: 2 });
  assert.deepEqual(ok(null, null), { problems: [], workers: 1, gateway: 1, ceiling: 1 });
  assert.deepEqual(ok('', null).problems, []);
});

test('above 2, zero, negative and non-numbers are refused', () => {
  for (const bad of ['3', '0', '-1', '2.5', 'two', '1e1', '02x', ' ', '1000']) {
    const r = ok(bad, '1');
    assert.ok(r.problems.length > 0, `JOB_WORKERS=${JSON.stringify(bad)} refused`);
    assert.equal(r.ceiling, null);
    assert.ok(
      assessConcurrency({ workers: '1', gateway: bad }).problems.length > 0,
      `APAYEE_MAX_CONCURRENT=${JSON.stringify(bad)} refused`
    );
  }
  assert.match(ok('3', '3').problems.join(' '), /JOB_WORKERS must be between 1 and 2/);
});

test('a mismatch is refused in both directions, including one side unset', () => {
  for (const [w, g] of [
    ['2', '1'],
    ['1', '2'],
    ['2', null],
    [null, '2'],
  ]) {
    const r = ok(w, g);
    assert.equal(r.problems.length, 1, `${w}/${g}`);
    assert.match(r.problems[0], /differ/);
  }
});

const fakeFetch = (status, body) => async () => ({ status, json: async () => body });

test('the dashboard reading is parsed strictly', async () => {
  const body = {
    capacity: {
      qatool: { workersConfigured: 2, workersEffective: 1 },
      apayee: { maxActive: 2 },
    },
  };
  assert.deepEqual(await readDashboardCapacity({ fetchImpl: fakeFetch(200, body) }), {
    configured: 2,
    effective: 1,
    maxActive: 2,
  });
  const noGateway = { capacity: { qatool: { workersConfigured: 2, workersEffective: 1 } } };
  assert.equal(
    (await readDashboardCapacity({ fetchImpl: fakeFetch(200, noGateway) })).maxActive,
    null
  );
  for (const bad of [
    fakeFetch(500, body),
    fakeFetch(200, {}),
    fakeFetch(200, { capacity: { qatool: { workersConfigured: '2', workersEffective: 1 } } }),
    async () => {
      throw new Error('down');
    },
  ]) {
    assert.equal(await readDashboardCapacity({ fetchImpl: bad }), null);
  }
});
