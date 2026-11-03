import { useEffect, useState } from 'react';
import { api } from './api.js';

/** The server caches a health answer for a few seconds; asking more often gains nothing. */
export const PROVIDER_POLL_MS = 10_000;

/**
 * Keeps asking `load` for the discovery list and reports each answer through `onState`.
 *
 * Re-asked on an interval and when the window regains focus, so a model that
 * becomes available - or stops being - shows up without a reload. Answers can
 * arrive out of order; only the newest request is allowed to update the state.
 * A failed request clears the list instead of keeping the last good one: an old
 * "available" is worse than no answer.
 *
 * Disabled (the public demo, which has no model to choose) it does nothing at all: no request, no
 * timer, no focus listener. Returns the function that stops it.
 *
 * Separate from the hook so it can be tested without React.
 */
export function watchProviders({
  load,
  onState,
  intervalMs = PROVIDER_POLL_MS,
  enabled = true,
  target = globalThis.window,
}) {
  if (!enabled) return () => {};

  let mounted = true;
  let newest = 0;

  async function refresh() {
    const ticket = (newest += 1);
    try {
      const list = await load();
      if (mounted && ticket === newest) onState({ status: 'ready', list });
    } catch {
      if (mounted && ticket === newest) onState({ status: 'error', list: null });
    }
  }

  refresh();
  const timer = setInterval(refresh, intervalMs);
  target?.addEventListener?.('focus', refresh);

  return () => {
    mounted = false;
    clearInterval(timer);
    target?.removeEventListener?.('focus', refresh);
  };
}

/**
 * The discovery list, kept fresh while the component is on screen.
 *
 * @returns {{ status: 'loading' | 'ready' | 'error', list: object | null }}
 */
export function useProviders({ intervalMs = PROVIDER_POLL_MS, enabled = true } = {}) {
  const [state, setState] = useState({ status: 'loading', list: null });

  useEffect(
    () => watchProviders({ load: () => api.providers(), onState: setState, intervalMs, enabled }),
    [intervalMs, enabled]
  );

  return state;
}
