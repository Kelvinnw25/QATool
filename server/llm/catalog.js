import { config } from '../config.js';
import { AppError } from '../lib/errors.js';
import { createProvider } from './provider.js';
import { probeGateway } from './apayee.js';

/**
 * The models a user may choose between for one generation run.
 *
 * A fixed list, written here. A client-supplied id is only ever used as a key
 * into it: never as a module path, a URL, a header or a field sent to a gateway.
 * `mock` and the raw `apayee` registry key are deliberately absent - they are
 * operator and test settings (LLM_PROVIDER), not choices a user makes.
 *
 * `claude` is "whatever Apayee runs", and only when Apayee says that is Claude.
 * An Apayee that is up but running its mock provider is not Claude, however
 * healthy it looks.
 */
export const PROVIDER_CHOICES = Object.freeze({
  gemini: Object.freeze({ label: 'Gemini', registryKey: 'gemini' }),
  claude: Object.freeze({
    label: 'Claude via Apayee',
    registryKey: 'apayee',
    /** The exact name Apayee's health reply must report. */
    gatewayProvider: 'claude',
  }),
});

export const PROVIDER_IDS = Object.freeze(Object.keys(PROVIDER_CHOICES));

/** How long a health answer may be reused. Short on purpose: it must not outlive a restart for long. */
export const AVAILABILITY_TTL_MS = 5_000;

/**
 * Reads the `provider` query parameter.
 *
 * Absent means "no choice": the stage then builds the server's configured
 * provider exactly as it did before this parameter existed. Anything else must
 * be one of the ids above, exactly - an empty value, a repeated parameter, a
 * different case or a registry name is a 400, never a guess.
 *
 * @returns {string | null} a catalog id, or null when the caller made no choice
 * @throws {AppError} UNKNOWN_PROVIDER
 */
export function parseProviderChoice(value) {
  if (value === undefined) return null;

  if (typeof value === 'string' && Object.hasOwn(PROVIDER_CHOICES, value)) return value;

  throw new AppError(
    'UNKNOWN_PROVIDER',
    `Unknown provider. Choose one of: ${PROVIDER_IDS.join(', ')}.`,
    400
  );
}

/**
 * A chosen provider that cannot be used right now.
 *
 * Its own class so the response can say which provider and why in a form a
 * client can branch on, without those fields leaking into every AppError.
 */
export class ProviderUnavailableError extends AppError {
  constructor(id, status) {
    super(
      'PROVIDER_UNAVAILABLE',
      `${PROVIDER_CHOICES[id].label} is not available: ${status.reason}`,
      503
    );
    this.name = 'ProviderUnavailableError';
    this.providerId = id;
    this.reasonCode = status.code;
  }

  toJSON() {
    return { ...super.toJSON(), provider: this.providerId, reason_code: this.reasonCode };
  }
}

const AVAILABLE = Object.freeze({ available: true, reason: null, code: null });

/**
 * What a run that makes no choice will use, when that is not one of the models
 * above. This is how Apayee is exercised end to end without being offered as
 * Claude: the operator sets LLM_PROVIDER=apayee, and the picker's "Server
 * default" says plainly that it is the gateway and what the gateway reports.
 *
 * The gateway's provider name is shown only when it looks like a name; it comes
 * from the health reply and nothing else in that reply is passed on.
 */
function describeServerDefault(settings, outcome) {
  if (settings.provider === 'apayee') {
    const reported =
      outcome.state === 'ready' && /^[a-z0-9][a-z0-9._-]{0,31}$/i.test(outcome.provider)
        ? ` It is currently running the "${outcome.provider}" provider.`
        : outcome.state === 'ready'
          ? ''
          : ' It is not answering its health check right now.';

    return {
      default_label: 'Server default (Apayee gateway)',
      default_note: `Every call goes to the Apayee gateway (LLM_PROVIDER=apayee) and is answered by whatever provider it runs, which is not necessarily Claude.${reported}`,
    };
  }

  if (settings.provider === 'mock') {
    return {
      default_label: 'Server default (scripted mock)',
      default_note:
        'Answers come from the built-in scripted mock provider (LLM_PROVIDER=mock). No model is called.',
    };
  }

  return {
    default_label: 'Server default',
    default_note:
      'This server is set to a provider outside this list. A run that does not choose one uses it.',
  };
}

function unavailable(code, reason) {
  return { available: false, reason, code };
}

/** Gemini is available when the server holds a key; nothing is called to find out. */
function geminiStatus(settings) {
  return String(settings.apiKey ?? '').trim() === ''
    ? unavailable('not_configured', 'Gemini is not configured on the server.')
    : AVAILABLE;
}

/** Turns what the gateway said into a status. Only an exact `claude` is available. */
function claudeStatus(outcome, expected) {
  switch (outcome.state) {
    case 'ready':
      if (outcome.provider === expected) return AVAILABLE;
      return outcome.provider === 'mock'
        ? unavailable(
            'provider_not_ready',
            'Apayee is running with the mock provider, so Claude is not available.'
          )
        : unavailable('provider_not_ready', 'Apayee is running, but its provider is not Claude.');
    case 'offline':
      return unavailable('gateway_offline', 'Apayee is not running or not reachable.');
    case 'timeout':
      return unavailable('gateway_timeout', 'Apayee did not answer the health check in time.');
    case 'unauthorized':
      return unavailable('gateway_auth_failed', 'Apayee rejected the server’s credentials.');
    case 'shutting_down':
      return unavailable('gateway_shutting_down', 'Apayee is shutting down.');
    case 'misconfigured':
      return unavailable('not_configured', 'Apayee is not configured correctly on the server.');
    default:
      return unavailable('gateway_unexpected_reply', 'Apayee returned an unexpected health reply.');
  }
}

/**
 * Which of the catalog's providers can be used right now, and the way to build
 * one for a request.
 *
 * Holds one thing, a few seconds of the gateway's last answer. That is not
 * session state: it is keyed to the gateway settings, expires on its own, and
 * deciding availability never depends on it being there.
 *
 * @param {object} [options]
 * @param {() => object} [options.settings]  read on every call, never captured
 * @param {typeof probeGateway} [options.probe]
 * @param {() => number} [options.now]
 * @param {number} [options.ttlMs]
 */
export function createProviderAvailability({
  settings = () => config.llm,
  probe = probeGateway,
  now = Date.now,
  ttlMs = AVAILABILITY_TTL_MS,
} = {}) {
  /** @type {{ key: string, at: number, outcome: object } | null} */
  let cached = null;
  /** @type {{ key: string, promise: Promise<object> } | null} */
  let inFlight = null;

  const gatewayKey = (current) => `${current.apayeeBaseUrl}\n${current.apayeeToken}`;

  /** One health check at a time; concurrent callers share its answer. */
  function check(current) {
    const key = gatewayKey(current);

    if (inFlight?.key === key) return inFlight.promise;

    const promise = probe(current)
      .then((outcome) => {
        cached = { key, at: now(), outcome };
        return outcome;
      })
      .finally(() => {
        if (inFlight?.promise === promise) inFlight = null;
      });

    inFlight = { key, promise };
    return promise;
  }

  async function gatewayOutcome(current, { fresh }) {
    const key = gatewayKey(current);
    if (!fresh && cached?.key === key && now() - cached.at < ttlMs) return cached.outcome;
    return check(current);
  }

  /** @param {'gemini' | 'claude'} id */
  async function statusOf(id, { fresh = false } = {}) {
    const current = settings();

    if (id === 'gemini') return geminiStatus(current);

    const outcome = await gatewayOutcome(current, { fresh });
    return claudeStatus(outcome, PROVIDER_CHOICES.claude.gatewayProvider);
  }

  return {
    /**
     * The discovery response. `default` names a catalog entry only when the
     * server's configured provider is one; for LLM_PROVIDER=apayee or mock it is
     * null, and requests that make no choice keep using that configuration.
     */
    async list() {
      const current = settings();
      const outcome = await gatewayOutcome(current, { fresh: false });
      const statuses = {
        gemini: geminiStatus(current),
        claude: claudeStatus(outcome, PROVIDER_CHOICES.claude.gatewayProvider),
      };

      const isGemini = current.provider === 'gemini';

      return {
        default: isGemini ? 'gemini' : null,
        ...(isGemini ? {} : describeServerDefault(current, outcome)),
        providers: PROVIDER_IDS.map((id) => ({
          id,
          label: PROVIDER_CHOICES[id].label,
          ...statuses[id],
        })),
      };
    },

    /**
     * Checks the choice now and builds the provider for it.
     *
     * Always asks the gateway afresh: the cached answer is for the picker, but a
     * stage is about to send a document, and a gateway that was restarted with a
     * different provider a moment ago must not receive it.
     *
     * @param {'gemini' | 'claude'} id a value parseProviderChoice returned
     * @throws {ProviderUnavailableError}
     */
    async acquire(id) {
      const status = await statusOf(id, { fresh: true });
      if (!status.available) throw new ProviderUnavailableError(id, status);

      const choice = PROVIDER_CHOICES[id];
      return createProvider({
        ...settings(),
        provider: choice.registryKey,
        // The adapter refuses a reply from any other provider than this one.
        ...(choice.gatewayProvider ? { expectGatewayProvider: choice.gatewayProvider } : {}),
      });
    },

    /** Forgets the gateway's last answer. For tests; nothing in the app calls it. */
    forget() {
      cached = null;
      inFlight = null;
    },
  };
}

/** The one instance the app uses. Reads config.llm on every call. */
export const providerAvailability = createProviderAvailability();
