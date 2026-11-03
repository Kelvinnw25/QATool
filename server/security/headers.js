/**
 * Response headers for a backend that only ever answers with JSON or a download.
 *
 *  - nosniff and no-referrer apply everywhere.
 *  - `no-store` applies to the API (and to everything in public mode): a reply can
 *    carry a project, a validation result or a workbook, and none of it belongs
 *    in a browser or proxy cache.
 *  - In public mode the policy also forbids framing and any active content, which
 *    a JSON reply never needs.
 *
 * HSTS is deliberately absent: the origin speaks plain HTTP on the PC and the
 * TLS edge (Cloudflare) is where it belongs.
 */
export function createSecurityHeaders({ publicMode }) {
  return async function addSecurityHeaders(request, reply, payload) {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');

    if (publicMode || request.url.startsWith('/api/')) {
      reply.header('Cache-Control', 'no-store');
    }
    if (publicMode) {
      reply.header('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
      reply.header('X-Frame-Options', 'DENY');
    }
    return payload;
  };
}
