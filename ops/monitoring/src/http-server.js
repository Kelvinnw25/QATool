import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';

import { isLoopbackHost } from './config.js';
import { buildSnapshot } from './snapshot.js';

/**
 * The dashboard's HTTP server: the page, its two assets, and four small JSON routes.
 *
 * What it will never do: listen on anything but the loopback, answer a request that arrived from
 * elsewhere or under another Host name, send CORS headers, serve a path built from the URL, or
 * change anything outside this process. `POST /api/refresh` only asks the collector to poll now.
 *
 * The page is served from a fixed table, so there is no file path to traverse.
 */

const PUBLIC_DIR = new URL('../public/', import.meta.url);

const ASSETS = new Map([
  ['/', { file: 'index.html', type: 'text/html; charset=utf-8' }],
  ['/index.html', { file: 'index.html', type: 'text/html; charset=utf-8' }],
  ['/app.css', { file: 'app.css', type: 'text/css; charset=utf-8' }],
  ['/app.js', { file: 'app.js', type: 'text/javascript; charset=utf-8' }],
  ['/format.js', { file: 'format.js', type: 'text/javascript; charset=utf-8' }],
]);

const SECURITY_HEADERS = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'cross-origin-resource-policy': 'same-origin',
  'cross-origin-opener-policy': 'same-origin',
  // Everything is first-party: no remote script, style, font or image, and no inline script.
  'content-security-policy':
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; " +
    "connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, { ...SECURITY_HEADERS, ...headers });
  res.end(body);
}

const sendJson = (res, status, value, headers = {}) =>
  send(res, status, JSON.stringify(value), {
    'content-type': 'application/json; charset=utf-8',
    ...headers,
  });

/**
 * The Host values this server answers to. Anything else is a DNS-rebinding attempt or a misroute.
 * Both the port the owner browses (`publicPort`; in a container, the one Compose publishes) and the
 * port the process listens on (`port`; what the container's own health check uses) are accepted, and
 * only as a loopback name.
 */
function allowedHosts(...ports) {
  return new Set(
    [...new Set(ports)].flatMap((port) => [
      `127.0.0.1:${port}`,
      `localhost:${port}`,
      `[::1]:${port}`,
    ])
  );
}

/**
 * Who may connect, by address. On the host only the loopback. In the container the connection arrives
 * from Docker's bridge (a private address) because Compose publishes the port on the host's 127.0.0.1
 * only, so private ranges are accepted there; a public address never is.
 *
 * @param {string | undefined} address  `socket.remoteAddress`
 * @param {'host' | 'container'} mode
 */
export function isAllowedPeer(address, mode) {
  const a = (address ?? '').replace(/^::ffff:/i, '');
  if (isLoopbackHost(a)) return true;
  if (mode !== 'container') return false;
  if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(a) || /^192\.168\.\d{1,3}\.\d{1,3}$/.test(a))
    return true;
  const m = /^172\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(a);
  if (m && Number(m[1]) >= 16 && Number(m[1]) <= 31) return true;
  return /^f[cd][0-9a-f]{2}:/i.test(a); // IPv6 unique local
}

/**
 * @param {object} options
 * @param {ReturnType<import('./config.js').loadConfig>} options.config
 * @param {ReturnType<import('./collector.js').createCollector>} options.collector
 * @param {() => number} [options.now]
 */
export function createMonitorServer({ config, collector, now = Date.now }) {
  const hosts = allowedHosts(config.publicPort ?? config.port, config.port);
  const assetCache = new Map();

  async function asset(entry) {
    if (!assetCache.has(entry.file)) {
      assetCache.set(entry.file, await readFile(new URL(entry.file, PUBLIC_DIR)));
    }
    return assetCache.get(entry.file);
  }

  async function handle(req, res) {
    // Defence in depth: the listener is on the loopback (or, in a container, published on it).
    if (!isAllowedPeer(req.socket.remoteAddress, config.mode)) {
      return send(res, 403, 'Forbidden');
    }
    if (!hosts.has(String(req.headers.host ?? '').toLowerCase())) {
      return send(res, 403, 'Forbidden');
    }

    const url = new URL(req.url ?? '/', 'http://monitor.invalid');
    const path = url.pathname;
    const method = req.method ?? 'GET';

    if (method === 'GET' || method === 'HEAD') {
      const entry = ASSETS.get(path);
      if (entry) {
        const body = await asset(entry);
        return send(res, 200, method === 'HEAD' ? undefined : body, { 'content-type': entry.type });
      }

      // This process's own liveness, for the container health check. It says nothing about the system.
      if (path === '/healthz') return sendJson(res, 200, { status: 'ok' });

      if (path === '/api/status') return sendJson(res, 200, collector.view());

      if (path === '/api/snapshot') {
        const stamp = new Date(now()).toISOString().replace(/[:.]/g, '-');
        return sendJson(res, 200, buildSnapshot(collector.view(), now), {
          'content-disposition': `attachment; filename="qatool-ops-snapshot-${stamp}.json"`,
        });
      }
      return send(res, 404, 'Not found');
    }

    if (method === 'POST' && path === '/api/refresh') {
      // Browsers cannot send this custom header cross-origin without a preflight, and this
      // server answers none, so a page on another site cannot trigger a poll.
      const origin = req.headers.origin;
      const sameOrigin = origin === undefined || [...hosts].some((h) => origin === `http://${h}`);
      if (req.headers['x-ops-monitor'] !== '1' || !sameOrigin) return send(res, 403, 'Forbidden');
      if (req.headers['sec-fetch-site'] === 'cross-site') return send(res, 403, 'Forbidden');
      // No request body is read or needed.
      req.resume();
      return sendJson(res, 200, await collector.refresh());
    }

    if (ASSETS.has(path) || path === '/healthz' || path.startsWith('/api/')) {
      return send(res, 405, 'Method not allowed', { allow: 'GET, HEAD, POST' });
    }
    return send(res, 404, 'Not found');
  }

  const server = createServer((req, res) => {
    handle(req, res).catch(() => {
      // Never echo an error: it could name a path. The page shows "monitor error" for a 500.
      if (!res.headersSent) send(res, 500, 'Monitor error');
      else res.end();
    });
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 5_000;
  server.keepAliveTimeout = 5_000;

  return {
    server,
    /** Binds to the configured address (loopback; in container mode the container's own) and returns it. */
    listen() {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(config.port, config.host, () => {
          const address = server.address();
          const bound = typeof address === 'object' && address ? address.address : '';
          // The address actually bound must be the one the configuration allowed: a loopback address,
          // or in container mode the one all-interfaces address config.js accepts (never anything else).
          if (!isLoopbackHost(bound) && !(config.mode === 'container' && bound === config.host)) {
            server.close();
            reject(new Error('Refusing to run: the server is not bound to an allowed address.'));
            return;
          }
          resolve(address);
        });
      });
    },
    close() {
      return new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      });
    },
  };
}

export const PUBLIC_ASSET_PATHS = fileURLToPath(PUBLIC_DIR);
