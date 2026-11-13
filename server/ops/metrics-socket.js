import { createServer } from 'node:http';
import { chmod, lstat, unlink } from 'node:fs/promises';
import net from 'node:net';

import { SnapshotInvalidError, serializeSnapshot } from './snapshot-guard.js';
import { validateSocketPath } from './socket-path.js';

/**
 * An optional, private, read-only channel for the in-process job metrics.
 *
 * WHY IT EXISTS. `metrics.snapshot()` (jobs/metrics.js) is internal on purpose: the numbers describe
 * every visitor at once and must never be public. The owner's local monitoring dashboard still needs
 * them. A route on the public API is the wrong place, so this is a Unix domain socket, a file inside the
 * container that no network can reach and that the Cloudflare Tunnel, Compose and Vercel know nothing of.
 * The dashboard runs `docker compose exec` to run `read-metrics.js` inside the container, which connects
 * to this socket. See `ops/monitoring/README.md`.
 *
 * WHAT IT DOES. It answers exactly one request, `GET /snapshot`, with the sanitized snapshot as JSON.
 * Every other method and path is refused. It has no TCP listener, no authentication to bypass, no CORS and
 * no body parsing. The only data source is the `snapshot` function it is given.
 *
 * WHEN IT RUNS. Only when `OPS_METRICS_SOCKET` is set (server/index.js). Unset is the default, and then
 * none of this code is loaded.
 *
 * THE FILE. The socket file is the only thing here that touches the filesystem, and it holds no data: it
 * is created owner-only (0600), and removed again on graceful shutdown. An old file left by a crash is
 * removed only if it is a socket, owned by this user, and nothing answers on it. A symlink, a regular
 * file, a directory, another user's socket or a live socket is never touched, and then the feature is off.
 */

const REQUEST_TIMEOUT_MS = 2_000;

export class MetricsSocketError extends Error {
  constructor(message) {
    super(message);
    this.name = 'MetricsSocketError';
  }
}

/**
 * What to do about a file that is already at the socket path.
 * Pure, so the safety rule is testable on any platform.
 *
 * @param {{ isSymbolicLink(): boolean, isSocket(): boolean, uid: number } | null} stat  lstat result, or null if absent
 * @param {number | undefined} uid  this process's user id
 * @returns {'absent' | 'probe' | 'refuse-symlink' | 'refuse-not-a-socket' | 'refuse-other-owner'}
 */
export function classifyExisting(stat, uid) {
  if (stat === null) return 'absent';
  if (stat.isSymbolicLink()) return 'refuse-symlink';
  if (!stat.isSocket()) return 'refuse-not-a-socket';
  if (uid !== undefined && stat.uid !== uid) return 'refuse-other-owner';
  return 'probe';
}

/**
 * Is anything listening on this socket file? `true` also for "cannot tell": when in doubt the file is
 * left alone.
 */
export function isSocketLive(socketPath, { timeoutMs = 500 } = {}) {
  return new Promise((resolve) => {
    const client = net.connect(socketPath);
    const finish = (live) => {
      client.destroy();
      resolve(live);
    };
    client.setTimeout(timeoutMs, () => finish(true));
    client.once('connect', () => finish(true));
    client.once('error', (error) =>
      finish(error.code !== 'ECONNREFUSED' && error.code !== 'ENOENT')
    );
  });
}

const lstatOrNull = async (target) => {
  try {
    return await lstat(target);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
};

/**
 * The HTTP server, not yet listening. Separate from `startMetricsSocket` so the request rules can be
 * tested on any platform (over a loopback port in tests), and so there is exactly one place they live.
 *
 * Two exact paths and no others: `GET /snapshot` (the job metrics) and, when a view is supplied,
 * `GET /apayee` (the gateway view from apayee-view.js). Each is produced by a function handed in, and
 * each answer passes the structural guard before it is sent.
 *
 * @param {object} options
 * @param {() => unknown} options.snapshot  `metrics.snapshot`
 * @param {() => Promise<unknown> | unknown} [options.apayee]  `createApayeeView(...)`
 * @param {{ warn?: Function }} [options.logger]
 */
export function createMetricsServer({ snapshot, apayee, logger }) {
  /** @type {Map<string, { produce: Function, options: object }>} */
  const routes = new Map([['/snapshot', { produce: snapshot, options: {} }]]);
  if (apayee) routes.set('/apayee', { produce: apayee, options: { identifiers: true } });

  /** Why each route last refused, so the same reason is logged once rather than on every poll. */
  const lastRefusal = new Map();

  const server = createServer(
    { maxHeaderSize: 2048, requestTimeout: REQUEST_TIMEOUT_MS, headersTimeout: REQUEST_TIMEOUT_MS },
    async (req, res) => {
      // Nothing is ever read from a request body.
      req.resume();

      const send = (status, body, extra = {}) => {
        res.writeHead(status, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
          connection: 'close',
          ...extra,
        });
        res.end(body);
      };

      if (req.method !== 'GET') {
        return send(405, '{"error":"method_not_allowed"}', { allow: 'GET' });
      }
      // Exact match: no query string, no trailing slash, no other path.
      const route = routes.get(req.url);
      if (!route) return send(404, '{"error":"not_found"}');

      let body;
      try {
        body = serializeSnapshot(await route.produce(), route.options);
      } catch (error) {
        // Say why, once per reason, with no value from the answer. The caller gets a fixed reply.
        const reason = error instanceof SnapshotInvalidError ? error.reason : 'the source failed';
        if (lastRefusal.get(req.url) !== reason) {
          lastRefusal.set(req.url, reason);
          logger?.warn?.(
            { event: 'ops_metrics_refused', route: req.url, reason },
            'A metrics answer was not served.'
          );
        }
        return send(500, '{"error":"snapshot_unavailable"}');
      }
      lastRefusal.delete(req.url);
      return send(200, body);
    }
  );

  server.maxConnections = 8;
  server.keepAliveTimeout = 1;
  return server;
}

/**
 * Creates the socket and starts answering. Resolves with a handle whose `close()` stops it and removes
 * the file. Throws `MetricsSocketError` (never anything with a path's contents) if it cannot do so
 * safely; the caller treats that as "feature off", not as a reason to stop the backend.
 *
 * @param {object} options
 * @param {string} options.socketPath
 * @param {() => unknown} options.snapshot
 * @param {() => Promise<unknown> | unknown} [options.apayee]
 * @param {{ info?: Function, warn?: Function }} [options.logger]
 * @param {number | undefined} [options.uid]
 */
export async function startMetricsSocket({
  socketPath,
  snapshot,
  apayee,
  logger,
  uid = process.getuid?.(),
}) {
  const checked = validateSocketPath(socketPath);
  if (!checked.ok)
    throw new MetricsSocketError(`OPS_METRICS_SOCKET is not usable: ${checked.reason}`);

  // 1. Whatever is there already.
  const before = await lstatOrNull(socketPath);
  const verdict = classifyExisting(before, uid);
  if (verdict.startsWith('refuse')) {
    throw new MetricsSocketError(
      `Something else is at the socket path (${verdict.slice(7)}); left untouched.`
    );
  }
  if (verdict === 'probe') {
    if (await isSocketLive(socketPath)) {
      throw new MetricsSocketError('The socket path is in use by a live listener; left untouched.');
    }
    // Stale. Remove it only if it is still the very same file we examined.
    const again = await lstatOrNull(socketPath);
    if (again && (again.ino !== before.ino || again.dev !== before.dev || !again.isSocket())) {
      throw new MetricsSocketError(
        'The socket path changed while it was being checked; left untouched.'
      );
    }
    if (again) await unlink(socketPath);
  }

  // 2. Create it owner-only from the start. The umask closes the window in which a looser file could be
  //    connected to; the chmod and the check below confirm the result either way.
  const server = createMetricsServer({ snapshot, apayee, logger });
  const previousUmask = process.umask(0o177);
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, () => {
        server.off('error', reject);
        resolve();
      });
    });
  } catch (error) {
    server.close();
    throw new MetricsSocketError(
      `Could not listen on the metrics socket (${error.code ?? 'error'}).`
    );
  } finally {
    process.umask(previousUmask);
  }

  const made = await lstatOrNull(socketPath);
  const abort = async (message) => {
    await new Promise((resolve) => server.close(resolve));
    throw new MetricsSocketError(message);
  };
  if (!made || !made.isSocket()) return abort('The metrics socket file is missing after start.');
  if ((made.mode & 0o077) !== 0) await chmod(socketPath, 0o600);
  const checkedMode = await lstatOrNull(socketPath);
  if (!checkedMode || (checkedMode.mode & 0o077) !== 0) {
    return abort('The metrics socket could not be restricted to its owner.');
  }

  logger?.info?.(
    { event: 'ops_metrics_socket', mode: '0600' },
    'The private metrics socket is listening.'
  );

  let closed = false;
  return {
    path: socketPath,
    async close() {
      if (closed) return;
      closed = true;
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
      // Node removes the file when it closes the server. Verify, and remove only our own leftover.
      const left = await lstatOrNull(socketPath);
      if (left && left.isSocket() && left.ino === made.ino && left.dev === made.dev) {
        await unlink(socketPath).catch(() => {});
      }
    },
  };
}
