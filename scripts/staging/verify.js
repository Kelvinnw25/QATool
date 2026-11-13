import { STAGING } from './config.js';
import { normalizeTunnelUrl } from './tunnel-url.js';

/**
 * Checks made over HTTP, with `fetch` injected so the tests never touch a network.
 *
 * The tunnel check is two questions. Is something answering at the address, and is it THIS backend with
 * its protections in place? The second is what makes the check a security gate and not only a ping: an
 * address that answers `/healthz` but lets an unauthenticated request into the API is `unsafe`, and the
 * caller shuts the tunnel instead of publishing it.
 */

const EVIL_ORIGIN = 'https://example.org';

/**
 * @typedef {{ name: string, ok: boolean, detail: string }} Check
 * @typedef {{ ok: boolean, kind: 'ok' | 'unreachable' | 'unsafe', checks: Check[] }} TunnelVerdict
 */

async function request(fetchImpl, url, { method = 'GET', origin, timeoutMs = 10_000 } = {}) {
  const response = await fetchImpl(url, {
    method,
    redirect: 'manual',
    cache: 'no-store',
    headers: { accept: 'application/json', ...(origin ? { origin } : {}) },
    signal: AbortSignal.timeout(timeoutMs),
  });
  let json = null;
  try {
    const text = await response.text();
    json = text.length <= 8192 ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: response.status, headers: response.headers, json };
}

/**
 * @param {object} options
 * @param {string} options.url  a tunnel origin
 * @param {typeof fetch} options.fetchImpl
 * @param {(ms: number) => Promise<void>} [options.sleep]
 * @param {() => number} [options.now]
 * @param {number} [options.timeoutMs]  how long to wait for the address to start answering
 * @param {number} [options.intervalMs]
 * @returns {Promise<TunnelVerdict>}
 */
export async function verifyTunnel({
  url,
  fetchImpl,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  now = Date.now,
  timeoutMs = STAGING.timeouts.tunnelReachableMs,
  intervalMs = 3000,
  frontendOrigin = STAGING.frontendOrigin,
}) {
  const origin = normalizeTunnelUrl(url);
  if (!origin)
    return {
      ok: false,
      kind: 'unreachable',
      checks: [{ name: 'address', ok: false, detail: 'not a Quick Tunnel address' }],
    };

  /** @type {Check[]} */
  const checks = [];
  const deadline = now() + timeoutMs;

  // 1. Something answers, and says what the backend's /healthz says. A new name can take a while to resolve.
  let alive = false;
  let lastProblem = 'no answer';
  for (;;) {
    try {
      const r = await request(fetchImpl, `${origin}/healthz`);
      if (r.status === 200 && r.json?.status === 'ok') {
        alive = true;
        break;
      }
      lastProblem = `HTTP ${r.status}`;
    } catch (error) {
      lastProblem = error?.cause?.code ?? error?.name ?? 'request failed';
    }
    if (now() >= deadline) break;
    await sleep(intervalMs);
  }
  checks.push({
    name: 'GET /healthz answers',
    ok: alive,
    detail: alive ? 'HTTP 200 {"status":"ok"}' : lastProblem,
  });
  if (!alive) return { ok: false, kind: 'unreachable', checks };

  // 2. It is the demo backend with its protections: the expected rejections, exactly.
  const expect = async (name, path, options, want, extra) => {
    try {
      const r = await request(fetchImpl, `${origin}${path}`, options);
      const extraProblem = extra ? extra(r) : null;
      const ok = r.status === want && extraProblem === null;
      checks.push({
        name,
        ok,
        detail: ok
          ? `HTTP ${r.status}`
          : `HTTP ${r.status}${extraProblem ? `, ${extraProblem}` : ''} (expected ${want})`,
      });
      return ok;
    } catch (error) {
      checks.push({
        name,
        ok: false,
        detail: error?.cause?.code ?? error?.name ?? 'request failed',
      });
      return false;
    }
  };

  const results = [
    await expect('no Origin is refused', '/api/health', {}, 403),
    await expect('an unlisted Origin is refused', '/api/health', { origin: EVIL_ORIGIN }, 403),
    await expect(
      'the frontend Origin needs a ticket',
      '/api/health',
      { origin: frontendOrigin },
      401,
      (r) => {
        const allowed = r.headers.get('access-control-allow-origin');
        if (allowed !== frontendOrigin) return 'CORS does not name the frontend';
        if (r.headers.get('access-control-allow-credentials')) return 'CORS allows credentials';
        return null;
      }
    ),
    await expect(
      'no direct extract route',
      '/api/extract',
      { method: 'POST', origin: frontendOrigin },
      401
    ),
    await expect(
      'no direct generate route',
      '/api/generate?provider=claude',
      { method: 'POST', origin: frontendOrigin },
      401
    ),
  ];

  const ok = results.every(Boolean);
  return { ok, kind: ok ? 'ok' : 'unsafe', checks };
}

/** The same backend, on the host loopback: the cheap "is the stack up" check. */
export async function verifyLocalBackend({ fetchImpl, url = STAGING.localBackendUrl }) {
  try {
    const r = await request(fetchImpl, `${url}/healthz`, { timeoutMs: 5000 });
    return r.status === 200 && r.json?.status === 'ok';
  } catch {
    return false;
  }
}

const SCRIPT_SRC = /<(?:script|link)\b[^>]*\b(?:src|href)=["']([^"']+\.js)["']/gi;
const TUNNEL_IN_TEXT = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/gi;

/**
 * Which Quick Tunnel addresses the deployed frontend was built with: its HTML and scripts, as a visitor
 * gets them. `VITE_API_BASE_URL` is replaced by its value at build time, so the address is in the bundle.
 *
 * @returns {Promise<{ reachable: boolean, bases: string[], assets: number }>}
 */
export async function inspectFrontend({ fetchImpl, origin = STAGING.frontendOrigin }) {
  try {
    const page = await fetchImpl(origin, {
      redirect: 'follow',
      cache: 'no-store',
      signal: AbortSignal.timeout(15_000),
    });
    if (page.status !== 200) return { reachable: false, bases: [], assets: 0 };
    const html = (await page.text()).slice(0, 200_000);

    const sources = [...new Set([...html.matchAll(SCRIPT_SRC)].map((m) => m[1]))].slice(0, 8);
    const found = new Set();
    const collect = (text) => {
      for (const match of text.matchAll(TUNNEL_IN_TEXT)) {
        const normalized = normalizeTunnelUrl(match[0]);
        if (normalized) found.add(normalized);
      }
    };
    collect(html);

    let assets = 0;
    for (const source of sources) {
      const target = new URL(source, origin);
      if (target.origin !== origin) continue; // only the frontend's own files
      const response = await fetchImpl(target, {
        cache: 'no-store',
        signal: AbortSignal.timeout(30_000),
      });
      if (response.status !== 200) continue;
      const text = await response.text();
      if (text.length > 6 * 1024 * 1024) continue;
      assets += 1;
      collect(text);
    }
    return { reachable: true, bases: [...found], assets };
  } catch {
    return { reachable: false, bases: [], assets: 0 };
  }
}
