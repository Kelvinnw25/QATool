/**
 * Reading a few named, non-secret settings out of the backend's `.env` text.
 *
 * The file holds secrets, so this never returns it, never iterates it for the caller, and never reports
 * a key it was not asked for. Only the keys in `wanted` come back, and only if they are plain
 * `KEY=value` lines (a commented line is not a setting).
 *
 * @param {string} text
 * @param {readonly string[]} wanted
 * @returns {Record<string, string | null>}
 */
export function readSettings(text, wanted) {
  const out = Object.fromEntries(wanted.map((key) => [key, null]));
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line);
    if (!match || !wanted.includes(match[1])) continue;
    let value = match[2].trim();
    if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1);
    // A trailing comment is not part of the value.
    value = value.replace(/\s+#.*$/, '').trim();
    out[match[1]] = value;
  }
  return out;
}

const truthy = (value) =>
  ['1', 'true', 'yes', 'on'].includes(
    String(value ?? '')
      .trim()
      .toLowerCase()
  );

export const isOn = truthy;

/** @param {string} list comma-separated addresses and CIDR ranges */
export function peerListCovers(list, address) {
  const toInt = (ip) => {
    const parts = ip.split('.').map(Number);
    if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255))
      return null;
    return parts.reduce((n, p) => n * 256 + p, 0);
  };
  const target = toInt(address);
  if (target === null) return false;

  for (const entry of String(list ?? '').split(',')) {
    const [base, bitsText] = entry.trim().split('/');
    const start = toInt(base ?? '');
    if (start === null) continue;
    const bits = bitsText === undefined ? 32 : Number(bitsText);
    if (!Number.isInteger(bits) || bits < 0 || bits > 32) continue;
    const size = 2 ** (32 - bits);
    if (Math.floor(target / size) === Math.floor(start / size)) return true;
  }
  return false;
}
