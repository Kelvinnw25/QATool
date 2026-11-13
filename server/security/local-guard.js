import { AppError } from '../lib/errors.js';
import { currentRun, trace } from '../lib/trace.js';

/**
 * Local mode never serves traffic that came from the internet.
 *
 * Local mode (neither PUBLIC_DEMO nor PUBLIC_MODE) has no authentication: it is the owner's own tool on the
 * owner's own PC. Its safety is that nothing outside the machine can reach it. The Docker stack now includes a
 * Cloudflare Quick Tunnel service (compose.yaml, `cloudflared`), so a plain `docker compose up -d` can put a
 * tunnel in front of a backend that is in local mode. The start script refuses that combination, but a
 * command typed by hand does not, so the backend refuses it too.
 *
 * What identifies such a request is not something the sender controls: Cloudflare's edge adds
 * `CF-Connecting-IP` and `CF-Ray` to every request it forwards, and a client on the internet cannot remove
 * them. A caller on this PC can send them, and is refused as well, which costs nothing: local use never carries
 * them. Public modes are unaffected (they have their own authentication) and so is `/healthz` there.
 */

const EDGE_HEADERS = [
  'cf-connecting-ip',
  'cf-connecting-ipv6',
  'cf-ray',
  'cf-visitor',
  'cf-ipcountry',
];

/** @param {Record<string, unknown>} headers  Node's lower-cased request headers */
export function reachedThroughCloudflare(headers) {
  if (EDGE_HEADERS.some((name) => headers[name] !== undefined)) return true;
  // Cloudflare also marks a request it has already handled once.
  return /cloudflare/i.test(String(headers['cdn-loop'] ?? ''));
}

export function createLocalModeGuard() {
  return async function refuseInternetTraffic(request) {
    if (!reachedThroughCloudflare(request.headers)) return;

    const error = new AppError(
      'LOCAL_MODE_NOT_PUBLIC',
      'This server is in local mode and does not accept traffic from the internet.',
      403
    );
    if (currentRun())
      trace('request_denied', { reason: 'local_mode_via_cloudflare', status_code: 403 });
    else
      request.log.warn({
        event: 'request_denied',
        reason: 'local_mode_via_cloudflare',
        status_code: 403,
      });
    throw error;
  };
}
