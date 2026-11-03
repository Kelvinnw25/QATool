/**
 * What this build of the page was told about where it runs.
 *
 * Three public values, all read at build time from `VITE_*` variables. Vite copies every
 * `VITE_` variable into the bundle that anyone can download, so nothing secret may ever be
 * given one: no gateway token, no ticket secret, no Turnstile secret. The only Turnstile value
 * here is the _site_ key, which the widget needs and which is public by design.
 *
 *   VITE_PUBLIC_DEMO           "true" turns on the public demo: Turnstile session, async jobs, no
 *                              model picker. Anything else is the local tool, unchanged.
 *   VITE_API_BASE_URL          the API's origin, e.g. https://api.example.com. Empty keeps the
 *                              relative `/api/...` URLs that the Vite dev proxy (or the server that
 *                              serves this build) answers - exactly what the local tool has always done.
 *   VITE_TURNSTILE_SITE_KEY    the widget's public site key (demo only)
 *   VITE_TURNSTILE_ACTION      optional; must equal the backend's TURNSTILE_ACTION (default qatool_demo)
 *
 * Plain JavaScript, and `import.meta.env` is read defensively, so Node can load this under the
 * test runner where Vite is not present.
 */

export const DEFAULT_TURNSTILE_ACTION = 'qatool_demo';

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * The API origin, or '' for "same origin as the page".
 *
 * @returns {{ base: string, problem: string | null }}
 */
export function normalizeApiBase(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (text === '') return { base: '', problem: null };

  let url;
  try {
    url = new URL(text);
  } catch {
    return { base: '', problem: 'VITE_API_BASE_URL is not a valid URL.' };
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return { base: '', problem: 'VITE_API_BASE_URL must start with https:// (or http://).' };
  }
  if (url.username !== '' || url.password !== '') {
    return { base: '', problem: 'VITE_API_BASE_URL must not contain credentials.' };
  }
  // A page served over https may not call an http API (mixed content), and a public API without
  // TLS would carry the ticket in clear. Plain http is for a machine talking to itself.
  if (url.protocol === 'http:' && !LOOPBACK.has(url.hostname)) {
    return { base: '', problem: 'VITE_API_BASE_URL must use https:// unless it is localhost.' };
  }

  // An origin and nothing else: every path is built from it in one place (api.js).
  return { base: url.origin, problem: null };
}

/**
 * @param {Record<string, unknown>} [env]  `import.meta.env`, or a stand-in in a test
 * @returns {{ demo: boolean, apiBase: string, turnstileSiteKey: string, turnstileAction: string, problems: string[] }}
 */
export function readConfig(env = {}) {
  const demo =
    String(env.VITE_PUBLIC_DEMO ?? '')
      .trim()
      .toLowerCase() === 'true';
  const { base, problem } = normalizeApiBase(env.VITE_API_BASE_URL);
  const siteKey = String(env.VITE_TURNSTILE_SITE_KEY ?? '').trim();
  const action = String(env.VITE_TURNSTILE_ACTION ?? '').trim() || DEFAULT_TURNSTILE_ACTION;

  const problems = [];
  if (problem) problems.push(problem);
  if (demo && siteKey === '') problems.push('VITE_TURNSTILE_SITE_KEY is not set.');
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(action)) {
    problems.push('VITE_TURNSTILE_ACTION may only use letters, digits, "_" and "-" (32 at most).');
  }

  return {
    demo,
    apiBase: base,
    turnstileSiteKey: siteKey,
    turnstileAction: action,
    problems: demo || problem ? problems : [],
  };
}

export const config = Object.freeze(readConfig(import.meta.env ?? {}));
