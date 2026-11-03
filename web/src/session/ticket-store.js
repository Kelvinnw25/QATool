/**
 * Where the visitor's ticket lives: one variable, in this page's memory.
 *
 * Not localStorage, not sessionStorage, not a cookie, not IndexedDB. A reload or a closed tab
 * forgets it, and that is intended: the ticket is a bearer credential for a short-lived session,
 * and the backend's jobs belong to it. The page says plainly that a reload resets the session.
 *
 * It is a small store rather than a module variable so that the API client (which attaches the
 * ticket) and the session manager (which decides what the page shows) can both reach it without
 * importing each other.
 */
export function createTicketStore({ now = Date.now } = {}) {
  let ticket = null;
  let expiresAt = 0;
  const listeners = new Set();

  const notify = (event) => {
    for (const listener of [...listeners]) listener(event);
  };

  return {
    /** The ticket if there is one and it has not run out; otherwise null. */
    get() {
      if (ticket !== null && now() >= expiresAt) {
        ticket = null;
        notify({ type: 'cleared', reason: 'expired' });
      }
      return ticket;
    },

    expiresAt: () => (ticket === null ? null : expiresAt),

    set(next, expiry) {
      ticket = next;
      expiresAt = expiry;
      notify({ type: 'set', expiresAt: expiry });
    },

    /** @param {'expired' | 'rejected' | 'reset'} reason */
    clear(reason = 'reset') {
      if (ticket === null) return;
      ticket = null;
      expiresAt = 0;
      notify({ type: 'cleared', reason });
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** The page's one store. Tests make their own with createTicketStore(). */
export const ticketStore = createTicketStore();
