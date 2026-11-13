/**
 * What the owner's ops monitor may know about the Apayee gateway, as the QATOOL backend sees it.
 *
 * The monitor runs in its own container and must not hold `APAYEE_TOKEN`. The backend already does,
 * and already asks the gateway for its health (llm/catalog.js, `providers.capacity`), so the answer
 * is produced here, from that same call and the same short-lived cache, and passed on over the private
 * metrics socket. Nothing new asks the gateway for anything, no token or URL leaves the backend, and
 * the view is numbers, booleans and one fixed status identifier.
 *
 * What it does NOT carry: the gateway's version, provider state text and success/failure totals.
 * llm/apayee.js deliberately reduces its health reply to capacity numbers and a state, and this module
 * does not widen that. The monitor shows those fields as not available in this mode.
 */

/** The provider id the public demo is fixed to (jobs/runner.js PUBLIC_PROVIDER_ID). */
const PROVIDER_ID = 'claude';

/**
 * @param {{ capacity: (id: string) => Promise<{ status: { available: boolean, code: string | null }, capacity: object | null }> }} providers
 * @param {() => number} [now]
 * @returns {() => Promise<object>}
 */
export function createApayeeView(providers, now = Date.now) {
  const number = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : null);

  return async function apayeeView() {
    let inspected;
    try {
      inspected = await providers.capacity(PROVIDER_ID);
    } catch {
      // The catalog never throws for a down gateway (it reports a status); this is a bug or a stub.
      inspected = { status: { available: false, code: 'probe_failed' }, capacity: null };
    }

    const { status, capacity } = inspected;
    const code =
      typeof status?.code === 'string' && /^[a-z][a-z0-9_]{0,39}$/.test(status.code)
        ? status.code
        : null;

    return {
      taken_at: new Date(now()).toISOString(),
      // True only when the gateway answered and runs exactly the Claude provider.
      available: status?.available === true,
      // Why not, as a fixed identifier (gateway_offline, gateway_timeout, provider_not_ready, ...).
      code: status?.available === true ? null : (code ?? 'unknown'),
      capacity_reported: capacity?.reported === true,
      capacity_compatible: capacity?.compatible !== false,
      max_active: number(capacity?.maxActive),
      active: number(capacity?.active),
      pending: number(capacity?.pending),
      capacity: number(capacity?.capacity),
    };
  };
}
