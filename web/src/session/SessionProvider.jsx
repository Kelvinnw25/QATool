import { createContext, useContext, useMemo, useState, useSyncExternalStore } from 'react';

import { api } from '../api.js';
import { createSessionManager } from './session.js';
import { ticketStore } from './ticket-store.js';

/**
 * What a page needs to know about the visitor's session.
 *
 * Outside the public demo there is no session and nothing to wait for, so the default value says
 * "not required, ready": every page can ask `useSession().ready` without caring which mode it is in.
 */
const LOCAL = Object.freeze({
  required: false,
  ready: true,
  state: null,
  manager: null,
  limits: null,
});

export const SessionContext = createContext(LOCAL);

export function useSession() {
  return useContext(SessionContext);
}

/** The demo's session. The ticket it manages lives in memory only (session/ticket-store.js). */
export function SessionProvider({ children }) {
  const [manager] = useState(() => createSessionManager({ api, store: ticketStore }));
  const state = useSyncExternalStore(manager.subscribe, manager.getState, manager.getState);

  const value = useMemo(
    () => ({
      required: true,
      ready: state.status === 'ready',
      state,
      manager,
      limits: state.limits,
    }),
    [state, manager]
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}
