/**
 * Finding and validating the Quick Tunnel address.
 *
 * The address is read from cloudflared's own log, never guessed. The log also names other hosts
 * (`api.trycloudflare.com`, which cloudflared contacts to create the tunnel, appears in error lines), so a
 * match is accepted only when it has the shape of a Quick Tunnel name: several lowercase words joined by
 * hyphens. The result is always an origin (`https://<words>.trycloudflare.com`), never a path.
 */

const NAME = /^[a-z0-9]+(?:-[a-z0-9]+){1,}$/;
const CANDIDATE = /https:\/\/([a-z0-9-]+)\.trycloudflare\.com(?![a-z0-9.-])/gi;

/** Names that belong to Cloudflare itself, whatever their shape. */
const RESERVED = new Set(['api', 'www', 'dash', 'one']);

/**
 * @param {unknown} value
 * @returns {string | null} the origin if `value` is exactly a Quick Tunnel origin, else null
 */
export function normalizeTunnelUrl(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  let url;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
  if (url.pathname !== '/' || url.search || url.hash) return null;
  const host = url.hostname.toLowerCase();
  const label = host.endsWith('.trycloudflare.com')
    ? host.slice(0, -'.trycloudflare.com'.length)
    : '';
  if (!NAME.test(label) || RESERVED.has(label)) return null;
  return `https://${host}`;
}

/**
 * The newest Quick Tunnel address in some log text, or null when there is none.
 * The log of a container that restarted holds earlier addresses too; the last one is the current one.
 *
 * @param {string} logText
 * @returns {string | null}
 */
export function extractTunnelUrl(logText) {
  let found = null;
  for (const match of String(logText ?? '').matchAll(CANDIDATE)) {
    const origin = normalizeTunnelUrl(`https://${match[1]}.trycloudflare.com`);
    if (origin) found = origin;
  }
  return found;
}
