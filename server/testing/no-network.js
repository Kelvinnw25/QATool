/**
 * Loaded into every `npm test` run with --import.
 *
 * The automated suite must never reach a real LLM provider: it would spend
 * quota, need a key, fail offline, and - with a real key - send data somewhere.
 * A test once did exactly that by accident, with a fake key, and nothing
 * noticed. This makes it impossible rather than merely discouraged: any
 * request to a host other than this machine throws, loudly, naming the host.
 *
 * Tests that stub fetch themselves are unaffected - they replace this guard for
 * their duration and put it back. The opt-in live test runs through its own
 * npm script, which does not load this file.
 */
import http from 'node:http';
import https from 'node:https';

const realFetch = globalThis.fetch;
const LOCAL = /^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?\//i;
const LOCAL_HOST = /^(?:127\.0\.0\.1|localhost|\[::1\]|::1)$/i;

/**
 * node:http and node:https are a second way out. The Apayee adapter uses them
 * because fetch's header timeout cannot be raised, so the guard has to cover
 * them or "never leaves this machine" stops being true for that provider.
 *
 * The request is refused before any socket exists. Callers pass either a URL or
 * an options object, with the host in different places.
 */
function guardTransport(transport, scheme) {
  for (const method of ['request', 'get']) {
    const real = transport[method];
    transport[method] = function guardedRequest(first, ...rest) {
      let host;
      if (typeof first === 'string' || first instanceof URL) {
        host = new URL(first).hostname;
      } else {
        host = first?.hostname ?? first?.host ?? rest[0]?.hostname ?? rest[0]?.host ?? 'localhost';
      }
      host = String(host).replace(/:\d+$/, '');

      if (!LOCAL_HOST.test(host)) {
        throw new Error(
          `Automated tests must not make network calls (attempted ${scheme}://${host}). Stub the transport, or use the opt-in live test.`
        );
      }
      return real.call(this, first, ...rest);
    };
  }
}

guardTransport(http, 'http');
guardTransport(https, 'https');

globalThis.fetch = async function guardedFetch(input, init) {
  const url = String(input?.url ?? input);
  if (LOCAL.test(url)) return realFetch(input, init);

  let host = url;
  try {
    host = new URL(url).host;
  } catch {
    // not a URL; report it as given
  }
  throw new Error(
    `Automated tests must not make network calls (attempted ${host}). Stub fetch, or use the opt-in live test.`
  );
};
