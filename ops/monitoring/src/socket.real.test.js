import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';

import { createJobMetrics } from '../../../server/jobs/metrics.js';
import { startMetricsSocket } from '../../../server/ops/metrics-socket.js';
import { readSocket } from './adapters/socket.js';

/**
 * The monitor's socket client against the backend's real socket server, over a real Unix socket file.
 * Needs Unix sockets, so it is skipped on Windows and runs on Linux (and in CI or WSL).
 */
const skip = process.platform === 'win32' ? 'Unix socket files do not exist on Windows' : false;

describe('readSocket against the real socket server', { skip }, () => {
  const dir = skip ? null : mkdtempSync(path.join(os.tmpdir(), 'qatool-mon-'));
  after(() => dir && rmSync(dir, { recursive: true, force: true }));

  test('reads /snapshot and /apayee, and nothing else is served', async () => {
    const socketPath = path.join(dir, 'metrics.sock');
    const metrics = createJobMetrics();
    metrics.inc('jobs_submitted', 6);
    const handle = await startMetricsSocket({
      socketPath,
      snapshot: () => metrics.snapshot(),
      apayee: async () => ({
        available: true,
        code: null,
        max_active: 1,
        active: 0,
        pending: 0,
        capacity: 16,
      }),
    });
    try {
      const snap = JSON.parse(await readSocket(socketPath, '/snapshot', { timeoutMs: 2000 }));
      assert.equal(snap.jobs.submitted, 6);

      const apayee = JSON.parse(await readSocket(socketPath, '/apayee', { timeoutMs: 2000 }));
      assert.equal(apayee.capacity, 16);

      await assert.rejects(
        readSocket(socketPath, '/metrics', { timeoutMs: 2000 }),
        (error) => error.code === 'BAD_SNAPSHOT'
      );
    } finally {
      await handle.close();
    }
  });

  test('a missing socket is SOCKET_UNREACHABLE and names no path', async () => {
    await assert.rejects(
      readSocket(path.join(dir, 'absent.sock'), '/snapshot', { timeoutMs: 2000 }),
      (error) => error.code === 'SOCKET_UNREACHABLE' && !error.message.includes(dir)
    );
  });
});
