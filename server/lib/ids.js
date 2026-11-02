/**
 * Display ids - DOC-001, REQ-001, TC-001 - are the only identifiers in the
 * system. They are the traceability handles QA and the LLM both use, and with
 * nothing persisted there is no primary key for them to compete with.
 *
 * They are allocated from the highest existing number rather than from a count,
 * so deleting REQ-003 does not cause the next requirement to reuse that number.
 * Reuse would silently repoint any test case still referencing it (PRD 19:
 * traceability is never sacrificed for convenience).
 */

const SEQUENTIAL_ID_PATTERN = /^([A-Z]+)-(\d{3,})$/;

export function formatSequentialId(prefix, sequence) {
  return `${prefix}-${String(sequence).padStart(3, '0')}`;
}

export function parseSequentialId(value) {
  const match = SEQUENTIAL_ID_PATTERN.exec(String(value ?? '').trim());
  if (!match) return null;
  return { prefix: match[1], sequence: Number.parseInt(match[2], 10) };
}

/**
 * @param {string} prefix       e.g. 'REQ'
 * @param {string[]} existing   every display id already used in the project
 */
export function nextSequentialId(prefix, existing) {
  let highest = 0;
  for (const value of existing) {
    const parsed = parseSequentialId(value);
    if (parsed && parsed.prefix === prefix && parsed.sequence > highest) {
      highest = parsed.sequence;
    }
  }
  return formatSequentialId(prefix, highest + 1);
}

export const ID_PREFIX = {
  document: 'DOC',
  requirement: 'REQ',
  testCase: 'TC',
};
