/**
 * Redaction for everything the monitor stores, shows or exports.
 *
 * Adapters already copy only fields they know (see each `parse*`), so this is the second
 * line: anything free-form that does get through, such as an error message from a failed
 * command, passes here before it is kept.
 */

const MAX_TEXT = 300;

const PATTERNS = [
  // Authorization headers and bearer tokens.
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer [redacted]'],
  // JSON Web Tokens (visitor tickets, Access tokens).
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g, '[redacted-jwt]'],
  // Known secret variables, in `NAME=value` and `"NAME":"value"` shapes.
  [
    /\b((?:TICKET_SECRET|TURNSTILE_SECRET|APAYEE_TOKEN|APAYEE_AUTH_TOKEN|GEMINI_API_KEY|[A-Z0-9_]*(?:SECRET|TOKEN|API_?KEY|PASSWORD))["']?\s*[:=]\s*)["']?[^\s"',}]+["']?/gi,
    '$1[redacted]',
  ],
  // Provider key shapes.
  [/\bsk-[A-Za-z0-9_-]{16,}/g, '[redacted-key]'],
  [/\bAIza[0-9A-Za-z_-]{30,}/g, '[redacted-key]'],
  [/\bgh[pousr]_[A-Za-z0-9]{30,}/g, '[redacted-key]'],
  // Windows and POSIX user paths: they name the owner and say nothing a dashboard needs.
  [/[A-Za-z]:\\Users\\[^\s"']+/g, '[path]'],
  [/\/(?:home|Users)\/[^\s"']+/g, '[path]'],
  // Quick Tunnel hostnames change every restart and are not worth keeping in an export.
  [/\b[a-z0-9-]+(?:-[a-z0-9]+)*\.trycloudflare\.com\b/gi, '[tunnel-host]'],
  // Credentials inside a URL.
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, '$1[redacted]@'],
];

/** Redacts and bounds one string. Non-strings become `null`: nothing else is kept. */
export function redactText(value, { max = MAX_TEXT } = {}) {
  if (typeof value !== 'string') return null;
  let text = value;
  for (const [pattern, replacement] of PATTERNS) text = text.replace(pattern, replacement);
  text = text.replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** A short, safe description of a thrown value. Never the stack, never the cause chain. */
export function describeError(error) {
  const code = typeof error?.code === 'string' ? error.code : null;
  const message = redactText(error?.message ?? String(error));
  return { code, message };
}

/**
 * Deep-copies a value, redacting every string and dropping keys that look like secrets.
 * Used on the export, so a field added carelessly later cannot leak through it.
 */
export function redactDeep(value, depth = 0) {
  if (depth > 12) return null;
  if (typeof value === 'string') return redactText(value);
  if (Array.isArray(value)) return value.map((item) => redactDeep(item, depth + 1));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      if (/secret|token|password|authorization|api_?key|cookie|ticket/i.test(key)) continue;
      out[key] = redactDeep(item, depth + 1);
    }
    return out;
  }
  return value;
}
