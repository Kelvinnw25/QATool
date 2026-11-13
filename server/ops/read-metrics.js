import { request } from 'node:http';

import { MAX_SNAPSHOT_BYTES, SnapshotInvalidError, serializeSnapshot } from './snapshot-guard.js';
import { validateSocketPath } from './socket-path.js';

/**
 * The reader the ops monitor runs inside the backend container:
 *
 *   docker compose exec -T qatool-backend node /app/server/ops/read-metrics.js
 *
 * It connects to the socket named by `OPS_METRICS_SOCKET`, sends one `GET /snapshot`, checks the answer,
 * and prints it as JSON on stdout. Nothing else. It takes no arguments, reads no other setting, writes no
 * file, and never prints the environment: on failure it prints one fixed sentence to stderr.
 *
 * Exit codes (the monitor tells them apart):
 *   0  the snapshot was printed
 *   2  not configured: OPS_METRICS_SOCKET is unset or not a usable path (the feature is off)
 *   3  could not connect: the socket is missing, refused, or not accessible
 *   4  the answer was not a valid snapshot
 *   5  no answer in time
 */

const TIMEOUT_MS = 2_500;

let finished = false;
const fail = (code, message) => {
  // One outcome only: a timeout followed by the error its own destroy() raises must not race.
  if (finished) return;
  finished = true;
  process.stderr.write(`${message}\n`, () => process.exit(code));
};

const configured = process.env.OPS_METRICS_SOCKET;
if (configured === undefined || configured === '') {
  fail(2, 'metrics socket is not configured');
} else {
  const checked = validateSocketPath(configured);
  if (!checked.ok) {
    fail(2, 'metrics socket path is not usable');
  } else {
    const req = request({
      socketPath: checked.path,
      path: '/snapshot',
      method: 'GET',
      headers: { accept: 'application/json' },
      timeout: TIMEOUT_MS,
    });

    req.on('timeout', () => {
      req.destroy();
      fail(5, 'metrics socket did not answer in time');
    });
    req.on('error', () => fail(3, 'metrics socket is not reachable'));

    req.on('response', (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_SNAPSHOT_BYTES) {
          res.destroy();
          fail(4, 'metrics answer was not a valid snapshot');
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => {
        if (res.statusCode !== 200) return fail(4, 'metrics answer was not a valid snapshot');
        try {
          // Parsed and checked again here, so what is printed is what the guard admits, whatever answered.
          const out = serializeSnapshot(JSON.parse(Buffer.concat(chunks).toString('utf8')));
          process.stdout.write(out, () => process.exit(0));
        } catch (error) {
          fail(
            4,
            error instanceof SnapshotInvalidError
              ? 'metrics answer was refused'
              : 'metrics answer was not a valid snapshot'
          );
        }
      });
    });

    req.end();
  }
}
