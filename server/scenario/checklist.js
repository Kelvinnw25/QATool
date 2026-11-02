import { REQUIREMENT_CATEGORIES } from '../schema/enums.js';

/**
 * The scenario checklist: what a requirement's own wording says is worth testing.
 *
 * Derived by pattern matching over the requirement text, deterministically and
 * for free. It exists because a synthetic evaluation showed the generator
 * testing one end of a two-sided limit and stopping - the maximum was never
 * written, nothing downstream could tell, and the workbook claimed to cover the
 * rule. Handing the model the bounds the document actually states costs no
 * extra call and makes that omission visible to it.
 *
 * Two consumers, one derivation, on purpose:
 *
 *   generation  the checklist is rendered into the prompt as guidance
 *   coverage    server/semantic/heuristics.js reports bounds nothing tested
 *
 * Keeping both on this module is what stops the two from drifting into
 * disagreeing about what a bound is.
 *
 * It is a HINT, never an invariant. Nothing here is canonical: the checklist is
 * never stored in the canonical project, never posted by the browser, never
 * validated as truth and never exported. It may be imperfect, and the prompt
 * says so - a list of numbers must not become permission to invent a rule for
 * each one.
 */

/**
 * Requirement wording that implies a failure path worth testing. "Required"
 * alone is left out: "approval is required before posting" is common and
 * says nothing about rejection.
 */
export const REJECTION_PATH =
  /\b(?:ditolak|tolak|reject\w*|decline\w*|gagal|error|kesalahan|invalid|tidak\s+valid|tidak\s+boleh|dilarang|not\s+allowed|prohibited|must\s+not|wajib\s+diisi|mandatory)\b/i;

/**
 * 'maximum' was missing here while 'minimum', 'maksimum' and 'max' were all
 * present - an omission rather than a decision, and one that made an English
 * "the maximum is 500" invisible to both consumers.
 */
export const NUMERIC_LIMIT =
  /\b(?:maksimal|maksimum|maximum|minimal|minimum|max|min|batas|limit|paling\s+(?:banyak|sedikit)|at\s+(?:most|least)|up\s+to|tidak\s+melebihi|melebihi|exceed\w*)\b[^.]{0,40}?\d/i;

export const REJECTION_CATEGORIES = new Set(['Input Validation', 'Error Handling']);

/**
 * Phrases that introduce what the system does TODAY, not what it must do.
 *
 * A requirement often names the behaviour it replaces so a reader can see the
 * change: "Display the navigation buttons as Prev 10 and Next 10 (current
 * condition: Prev 100 and Next 100)". Both numbers were being read as stated
 * values, so 100 - the number being removed - became a coverage obligation and
 * a reviewer finding asking why nobody tested it.
 *
 * Deliberately a short, explicit list. Guessing which numbers are aspirational
 * from prose would silently drop real bounds, and a missed bound is the failure
 * this module exists to prevent.
 */
const STATUS_QUO_LEAD_IN =
  'current\\s+condition|currently|current\\s+state|existing\\s+(?:condition|behaviou?r)|as[- ]is|' +
  'previously|before\\s+this\\s+change|kondisi\\s+saat\\s+ini|saat\\s+ini|sebelumnya';

/** Parenthesised aside, or a clause running to the end of its sentence. */
const STATUS_QUO_SPANS = [
  new RegExp(`\\([^()]*\\b(?:${STATUS_QUO_LEAD_IN})\\b[^()]*\\)`, 'gi'),
  new RegExp(`\\b(?:${STATUS_QUO_LEAD_IN})\\b\\s*[:-][^.;)]*`, 'gi'),
];

/** Removes status-quo asides so their numbers are never read as targets. */
function withoutStatusQuo(text) {
  let result = text;
  for (const span of STATUS_QUO_SPANS) result = result.replace(span, ' ');
  return result;
}

/**
 * The values a requirement states as limits.
 *
 * Numbers that belong to an identifier are removed first - ADMI 002, U253,
 * HTTP 400, REQ-001 - because those are names, not bounds, and testing "400"
 * is not a coverage question. Thousands separators are normalised so that
 * "IDR 50,000,000", "50.000.000" and "50000000" are one value.
 *
 * @returns {Map<string, string>} normalised value -> the form the text used
 */
export function statedValues(text) {
  const values = new Map();

  // Identifier shapes only. A currency prefix must NOT match: stripping
  // "IDR 10" out of "IDR 10,000" would leave "000" and report a limit of zero.
  const cleaned = withoutStatusQuo(String(text ?? ''))
    .replace(/\bHTTP\s?\d{3}\b/gi, ' ')
    // REQ-001, KLR-01, E-1001, and ticket keys whose project code carries a
    // digit. SDE4-17394 used to survive this and be reported as "a limit of
    // 17394", because the prefix was required to be letters only - and a Jira
    // link sits in almost every acceptance-criteria block these documents have.
    // Whole keys go first: run after the code shape below, NPWOW31-650 lost
    // only "NPWOW31" to it, and the "-650" left behind became "Boundary 650".
    .replace(/\b[A-Z][A-Z0-9]{0,7}-\d+\b/g, ' ')
    .replace(/\b[A-Z]{4,6}[ -]?\d{2,4}\b/g, ' ') // ADMI 002, HTTP 400
    .replace(/\b[A-Z]{1,3}\d{2,4}\b/g, ' ') // U253
    // Positions in the document, not values it states. A page footer the parser
    // kept - "Page 12" - became "Boundary 12 is exercised", and a section's own
    // number - "7. Tick All QR Transaction Release Settlement" - became
    // "Boundary 7": both passed the limit gate only because a real limit ("up
    // to 10 rows") sat elsewhere in the same requirement. Only the ordinal at
    // the start of a line is removed, so "1. The amount must not exceed
    // 50,000,000" still states 50,000,000.
    .replace(/\b(?:page|halaman|hal\.)\s*\d+(?:\s*(?:of|dari|\/)\s*\d+)?\b/gi, ' ')
    .replace(/^[ \t]*\d{1,2}[.)](?=[ \t]+\p{Lu})/gmu, ' ');

  for (const [, raw] of cleaned.matchAll(/\b(\d[\d.,]*)\b/g)) {
    const normalized = raw.replace(/[.,](?=\d{3}\b)/g, '');
    if (!/^\d+$/.test(normalized)) continue; // version numbers and decimals
    if (!values.has(normalized)) values.set(normalized, raw);
  }

  return values;
}

/**
 * Which side of a range a stated value is.
 *
 * Read from the words immediately before the number, because that is where the
 * document puts them: "at most IDR 50,000,000". Anything else is left
 * 'unclassified' rather than guessed - a wrong label would tell the generator
 * to test the wrong end.
 */
const BOUND_KINDS = [
  { kind: 'minimum', pattern: /\b(?:at\s+least|minimum|minimal|min|paling\s+sedikit|sekurang)\b/i },
  {
    kind: 'maximum',
    pattern:
      /\b(?:at\s+most|maximum|maksimum|maksimal|max|up\s+to|tidak\s+melebihi|paling\s+banyak|not\s+exceed|does\s+not\s+exceed|sampai\s+dengan)\b/i,
  },
  { kind: 'exact', pattern: /\b(?:exactly|tepat|persis)\b/i },
];

/** How far back to look for the keyword that qualifies a number. */
const KIND_WINDOW = 40;

function kindFor(text, raw) {
  const at = text.indexOf(raw);
  if (at === -1) return 'unclassified';

  const before = text.slice(Math.max(0, at - KIND_WINDOW), at);

  // Last keyword wins: in "at least X and at most Y", the words nearest the
  // number are the ones describing it.
  let winner = 'unclassified';
  let winnerAt = -1;

  for (const { kind, pattern } of BOUND_KINDS) {
    const match = pattern.exec(before);
    if (match && match.index > winnerAt) {
      winner = kind;
      winnerAt = match.index;
    }
  }

  return winner;
}

/**
 * Exported so the obligation layer can ask the same question and get the same
 * answer. Two definitions of "what counts as a bound" would eventually
 * disagree, and the disagreement would surface as an obligation the generator
 * was never told about.
 */
export function boundsFor(text) {
  if (!NUMERIC_LIMIT.test(text)) return [];

  return [...statedValues(text)].map(([normalized, raw]) => ({
    raw,
    normalized,
    kind: kindFor(text, raw),
  }));
}

/**
 * Conditions a requirement enumerates explicitly.
 *
 * Only extracted behind an explicit lead-in. Splitting arbitrary prose on
 * conjunctions produces confident nonsense, and the generator would then be
 * handed invented conditions to cover - the exact failure this module exists
 * to avoid. No lead-in means no conditions, which is a correct answer.
 */
export const ENUMERATION_LEAD_IN =
  /\b(?:all\s+of\s+the\s+following(?:\s+conditions)?(?:\s+are\s+met)?|semua\s+kondisi\s+berikut|only\s+if|hanya\s+jika)\b[^:]*:?/i;

const MAX_CONDITIONS = 8;

/** Exported for the same reason as boundsFor: one definition, two consumers. */
export function conditionsFor(text) {
  const lead = ENUMERATION_LEAD_IN.exec(text);
  if (!lead) return [];

  const remainder = text.slice(lead.index + lead[0].length).split(/(?<=[.!?])\s/)[0] ?? '';

  // A comma followed by a digit is a thousands separator, not a clause break -
  // splitting on it turns "IDR 100,000,000" into a condition about "IDR 100".
  return remainder
    .split(/,(?!\d)\s*(?:and\s+|dan\s+)?|\s+(?:and|dan)\s+/i)
    .map((clause) => clause.replace(/^[\s:;-]+|[\s.;]+$/g, ''))
    .filter((clause) => clause.length > 3)
    .slice(0, MAX_CONDITIONS);
}

/**
 * Review flags already recorded on the requirement by extraction. Repeated here
 * so the generator sees, next to a bound, that the requirement carrying it is
 * disputed or incomplete.
 */
function reviewFlagsFor(requirement) {
  const flags = [];

  if (requirement.ambiguities?.some((note) => /may be missing/i.test(note))) flags.push('fragment');
  if (requirement.ambiguities?.length > 0) flags.push('ambiguous');
  if (requirement.conflicts?.some((conflict) => !conflict.resolved)) flags.push('conflicted');

  return [...new Set(flags)];
}

/**
 * @param {object[]} requirements  canonical requirements, already schema-valid
 * @returns {object[]} one entry per requirement that has something to test
 */
export function deriveChecklist(requirements) {
  const entries = [];

  for (const requirement of requirements ?? []) {
    const text = `${requirement.title} ${requirement.description}`;

    const bounds = boundsFor(text);
    const conditions = conditionsFor(requirement.description);
    const rejectionPath =
      REJECTION_CATEGORIES.has(requirement.category) || REJECTION_PATH.test(text);

    // An entry with nothing testable in it is noise in the prompt, and noise in
    // a prompt is not free.
    if (bounds.length === 0 && conditions.length === 0 && !rejectionPath) continue;

    entries.push({
      requirement_id: requirement.requirement_id,
      category: REQUIREMENT_CATEGORIES.includes(requirement.category) ? requirement.category : null,
      bounds,
      rejection_path: rejectionPath,
      conditions,
      review_flags: reviewFlagsFor(requirement),
    });
  }

  return entries;
}

/**
 * Renders the checklist for the generation prompt.
 *
 * Compact on purpose: this is added to every generation call, so each entry
 * costs tokens on a free tier metered at twenty requests a day.
 *
 * @returns {string} '' when there is nothing worth saying
 */
export function checklistForPrompt(entries) {
  if (!entries || entries.length === 0) return '';

  const lines = entries.map((entry) => {
    const parts = [];

    if (entry.bounds.length > 0) {
      parts.push(
        `bounds to test: ${entry.bounds
          .map((bound) => `${bound.raw}${bound.kind === 'unclassified' ? '' : ` (${bound.kind})`}`)
          .join(', ')}`
      );
    }

    if (entry.rejection_path) parts.push('states a rejection path');
    if (entry.conditions.length > 0) {
      parts.push(`conditions: ${entry.conditions.map((clause) => `"${clause}"`).join('; ')}`);
    }
    if (entry.review_flags.length > 0) parts.push(`flagged: ${entry.review_flags.join(', ')}`);

    return `- ${entry.requirement_id}: ${parts.join('. ')}.`;
  });

  return lines.join('\n');
}
