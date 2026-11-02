/**
 * Choosing a model, without React.
 *
 * The backend decides what exists and what is usable (GET /api/llm/providers).
 * Nothing here knows a provider's name: the list is data, the choice is an id
 * from it, and null means "the server's own default", which is what every
 * request meant before models could be chosen.
 */

export const SERVER_DEFAULT_LABEL = 'Server default';

/** The entry for an id, or null. */
export function findProvider(list, id) {
  return list?.providers?.find((provider) => provider.id === id) ?? null;
}

/**
 * What is selected: the user's pick, else the server's default.
 *
 * With no list - still loading, or the request failed - nothing can be offered
 * but the server's default, so an earlier pick is not honoured: it could be for
 * a model that is no longer there.
 *
 * @param {object | null} list  the discovery response
 * @param {string | null | undefined} userChoice  undefined until the user picks
 * @returns {string | null}
 */
export function effectiveChoice(list, userChoice) {
  if (!list) return null;
  if (userChoice !== undefined && (userChoice === null || findProvider(list, userChoice))) {
    return userChoice;
  }
  return list.default ?? null;
}

export function labelFor(list, id) {
  if (id === null) return list?.default_label ?? SERVER_DEFAULT_LABEL;
  return findProvider(list, id)?.label ?? id;
}

/**
 * Why a run cannot start with this selection, or null if it can.
 *
 * The server checks again before every step, so this only decides what the
 * button says. A selection that is not available is reported, never replaced:
 * choosing another model is the user's decision.
 *
 * @param {{ status: 'loading' | 'ready' | 'error', list: object | null, choice: string | null }} state
 */
export function startBlocker({ status, list, choice }) {
  if (status === 'loading') return 'Checking which models are available...';
  if (choice === null) return null;

  const provider = findProvider(list, choice);
  if (!provider) return 'That model is not offered by the server.';
  if (!provider.available) return `${provider.label} is not available: ${provider.reason}`;
  return null;
}
