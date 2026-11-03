/**
 * Cloudflare Turnstile in the browser: load the script once, draw a widget, hand back its token.
 *
 * Only the public site key is used here. Whether a token is genuine is decided by the backend,
 * which asks Cloudflare with the secret key; this file can neither grant nor check anything.
 *
 * The script is the one Cloudflare documents, loaded on demand in explicit-render mode (so nothing
 * renders until the page asks, and a page that is not the demo never loads it).
 */

export const TURNSTILE_SCRIPT_URL =
  'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';

let pending = null;

/**
 * Resolves with the global `turnstile` object. Safe to call from many places: one script element,
 * one promise. A failed load clears the cache so a later attempt can try again.
 */
export function loadTurnstile({
  document: doc = globalThis.document,
  scriptUrl = TURNSTILE_SCRIPT_URL,
} = {}) {
  if (globalThis.turnstile?.render) return Promise.resolve(globalThis.turnstile);
  if (pending) return pending;

  pending = new Promise((resolve, reject) => {
    if (!doc) {
      reject(new Error('Turnstile needs a browser.'));
      return;
    }
    const script = doc.createElement('script');
    script.src = scriptUrl;
    script.async = true;
    script.defer = true;
    script.onload = () =>
      globalThis.turnstile?.render
        ? resolve(globalThis.turnstile)
        : reject(new Error('Turnstile loaded but did not start.'));
    script.onerror = () => reject(new Error('Turnstile could not be loaded.'));
    doc.head.appendChild(script);
  }).catch((cause) => {
    pending = null;
    throw cause;
  });

  return pending;
}

/**
 * Draws the widget into `container`.
 *
 * `onToken` is called with each token the widget produces. A token lasts about five minutes and is
 * single use: when it lapses (`onExpire`) the widget is reset so the visitor is never left holding
 * a dead one. Returns controls; `remove()` must be called when the container goes away.
 *
 * @param {HTMLElement} container
 * @param {object} options
 * @param {{ render: Function, reset: Function, remove: Function }} options.turnstile  the loaded global
 */
export function renderWidget(
  container,
  { turnstile, siteKey, action, onToken, onError, onExpire, theme = 'auto' }
) {
  let widgetId = null;

  widgetId = turnstile.render(container, {
    sitekey: siteKey,
    action,
    theme,
    callback: (token) => onToken(token),
    'expired-callback': () => {
      onExpire?.();
      if (widgetId !== null) turnstile.reset(widgetId);
    },
    'error-callback': (code) => {
      onError?.(String(code ?? ''));
      // Returning true tells Turnstile the error is handled, which stops it logging to the console.
      return true;
    },
  });

  return {
    reset: () => widgetId !== null && turnstile.reset(widgetId),
    remove() {
      if (widgetId === null) return;
      try {
        turnstile.remove(widgetId);
      } catch {
        // Already gone with its container.
      }
      widgetId = null;
    },
  };
}
