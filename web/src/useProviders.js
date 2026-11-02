import { useEffect, useState } from 'react';
import { api } from './api.js';

/** The server caches a health answer for a few seconds; asking more often gains nothing. */
export const PROVIDER_POLL_MS = 10_000;

/**
 * The discovery list, kept fresh while the component is on screen.
 *
 * Re-asked on an interval and when the window regains focus, so a model that
 * becomes available - or stops being - shows up without a reload. Answers can
 * arrive out of order; only the newest request is allowed to update the state.
 * A failed request clears the list instead of keeping the last good one: an old
 * "available" is worse than no answer.
 *
 * @returns {{ status: 'loading' | 'ready' | 'error', list: object | null }}
 */
export function useProviders({ intervalMs = PROVIDER_POLL_MS } = {}) {
  const [state, setState] = useState({ status: 'loading', list: null });

  useEffect(() => {
    let mounted = true;
    let newest = 0;

    async function refresh() {
      const ticket = (newest += 1);
      try {
        const list = await api.providers();
        if (mounted && ticket === newest) setState({ status: 'ready', list });
      } catch {
        if (mounted && ticket === newest) setState({ status: 'error', list: null });
      }
    }

    refresh();
    const timer = setInterval(refresh, intervalMs);
    window.addEventListener('focus', refresh);

    return () => {
      mounted = false;
      clearInterval(timer);
      window.removeEventListener('focus', refresh);
    };
  }, [intervalMs]);

  return state;
}
