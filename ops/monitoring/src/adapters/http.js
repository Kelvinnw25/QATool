/**
 * One HTTP GET with a timeout. The body is never read for display: a probe cares about
 * "did something answer, how fast, with which status", and a monitored page's content is
 * not the monitor's business.
 *
 * `fetchImpl` is injected so tests never touch the network.
 *
 * @param {string} url
 * @param {{ timeoutMs: number, fetchImpl?: typeof fetch, now?: () => number, readJson?: boolean }} options
 * @returns {Promise<{ status: number, ok: boolean, latencyMs: number, json: unknown }>}
 */
export async function probe(
  url,
  { timeoutMs, fetchImpl = fetch, now = Date.now, readJson = false }
) {
  const started = now();
  // Our own timer rather than AbortSignal.timeout: it is cleared on every path below, and it
  // covers reading the body too, not just the headers.
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new DOMException('timed out', 'TimeoutError')),
    timeoutMs
  );

  let response;
  let json = null;
  try {
    try {
      response = await fetchImpl(url, {
        method: 'GET',
        redirect: 'manual',
        cache: 'no-store',
        headers: {
          accept: 'application/json, text/html;q=0.5',
          'user-agent': 'qatool-ops-monitor',
        },
        signal: controller.signal,
      });
    } catch (error) {
      const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError';
      const failure = new Error(timedOut ? 'request timed out' : 'connection failed');
      failure.code = timedOut ? 'TIMEOUT' : 'UNREACHABLE';
      throw failure;
    }

    if (readJson) {
      try {
        const text = await response.text();
        // A health body is a few bytes; refuse to parse anything large.
        json = text.length <= 4096 ? JSON.parse(text) : null;
      } catch {
        json = null;
      }
    } else {
      await response.body?.cancel().catch(() => {});
    }
  } finally {
    clearTimeout(timer);
  }

  return {
    status: response.status,
    ok: response.status >= 200 && response.status < 400,
    latencyMs: Math.max(0, now() - started),
    json,
  };
}
