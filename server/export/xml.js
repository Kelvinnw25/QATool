/**
 * Minimal XML helpers for writing SpreadsheetML by hand.
 *
 * Hand-written rather than templated through a spreadsheet library on purpose:
 * the office template is a Google Sheets export carrying a theme, a drawing, a
 * persons part and per-row style quirks, and no library round-trips all of that
 * intact. Rewriting three parts and copying the rest byte-for-byte is the only
 * way to guarantee nothing else changes.
 */

/**
 * XML 1.0 forbids most control characters outright - Excel reports a corrupt
 * file rather than ignoring them. LLM-generated text is the likely source, so
 * they are stripped before they ever reach a cell.
 */
// eslint-disable-next-line no-control-regex
const INVALID_XML_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g;

export function stripInvalidXmlChars(value) {
  return String(value ?? '').replace(INVALID_XML_CHARS, '');
}

export function escapeXml(value) {
  return stripInvalidXmlChars(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Column number (1-based) to spreadsheet letter: 1 -> A, 27 -> AA. */
export function columnLetter(index) {
  let result = '';
  let remaining = index;
  while (remaining > 0) {
    const modulo = (remaining - 1) % 26;
    result = String.fromCharCode(65 + modulo) + result;
    remaining = Math.floor((remaining - modulo) / 26);
  }
  return result;
}

const RANGE_PATTERN = /^([A-Z]+)(\d+):([A-Z]+)(\d+)$/;

/**
 * Rewrites the row numbers of an A1-style range, keeping its columns.
 * 'E2:E20' with lastRow 7 becomes 'E2:E7'.
 */
export function retargetRange(range, firstRow, lastRow) {
  const match = RANGE_PATTERN.exec(range.trim());
  if (!match) {
    throw new Error(`Cannot retarget malformed range '${range}'.`);
  }
  const [, startColumn, , endColumn] = match;
  return `${startColumn}${firstRow}:${endColumn}${lastRow}`;
}
