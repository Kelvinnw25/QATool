/**
 * Redaction for everything these scripts print or store.
 *
 * The scripts never read a secret on purpose, and never print an environment. This is for the one case that
 * is not under their control: text that came from a tool (the Vercel CLI, Docker) and is shown to the owner
 * when a step fails. Public addresses (the tunnel, the Vercel page) are deliberately NOT masked: the owner
 * needs them.
 */

const RULES = [
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer [redacted]'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g, '[redacted-jwt]'],
  // Vercel prints stored values as base64 JSON starting with eyJ; they are not needed on screen.
  [/\beyJ[A-Za-z0-9_-]{12,}…?/g, '[redacted-value]'],
  [/\bvercel_[A-Za-z0-9_]{12,}/gi, '[redacted-token]'],
  [
    /\b(?:VERCEL|TICKET|TURNSTILE|APAYEE|GEMINI|ACCESS|CLOUDFLARE)[A-Z0-9_]*\s*[=:]\s*[^\s"',]+/g,
    '[redacted-setting]',
  ],
  [/\b[A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|API_?KEY)\s*[=:]\s*[^\s"',]+/g, '[redacted-setting]'],
  [/\bsk-[A-Za-z0-9_-]{16,}/g, '[redacted-key]'],
  [/\bAIza[0-9A-Za-z_-]{30,}/g, '[redacted-key]'],
  // A Vercel team slug names the owner's account.
  [/\b[a-z0-9]+(?:-[a-z0-9]+)*-projects-[a-z0-9]{6,}\b/g, '[team]'],
  [/[A-Za-z]:\\Users\\[^\s"']+/g, '[path]'],
  [/\/(?:home|Users)\/[^\s"']+/g, '[path]'],
];

/** @param {unknown} value */
export function redact(value, { max = 4000 } = {}) {
  let text =
    typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value);
  for (const [pattern, replacement] of RULES) text = text.replace(pattern, replacement);
  // The Vercel CLI prints a machine hint for editor plugins into stderr; it is noise for a person.
  text = text.replace(/<claude-code-hint\b[^>]*\/>/g, '');
  // Terminal control sequences from a tool's progress output.
  text = text.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '');
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** The last `lines` lines of some output, redacted: what a failure message may show. */
export function tail(value, lines = 12) {
  return redact(String(value ?? ''))
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '')
    .slice(-lines)
    .join('\n');
}
