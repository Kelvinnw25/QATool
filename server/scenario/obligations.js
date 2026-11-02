import { z } from 'zod';

import { formatSequentialId } from '../lib/ids.js';
import { contentWords, mentions, mentionsLocally, quotes } from '../lib/text.js';
import {
  ENUMERATION_LEAD_IN,
  REJECTION_PATH,
  boundsFor,
  conditionsFor,
  statedValues,
} from './checklist.js';

/**
 * Coverage obligations: the behavioural units inside a requirement.
 *
 * The problem this solves is a coverage report that lies by being too coarse.
 * "REQ-005 is covered" meant one test case cited it, and a requirement that
 * says six things - a timeout is detected, the status becomes PENDING, the item
 * routes to a queue, a retry runs at most three times, the third failure ends
 * in FAILED - was reported as fully covered by a single case testing the
 * timeout. Nothing downstream could tell, and the workbook went to SIT claiming
 * coverage nobody had.
 *
 *   Requirement -> Obligations -> Test cases -> Obligation coverage
 *
 * Derived, never authored. Every obligation is pattern-matched out of the
 * requirement's own wording, and `source_basis` is a verbatim slice of that
 * wording, so an obligation can always be traced to the sentence that produced
 * it. The model is never asked to invent obligations: a model that decides what
 * must be tested and then reports whether it tested it is grading its own
 * homework, and coverage truth is the one thing that has to stay with the
 * system.
 *
 * This is the same bargain the scenario checklist makes, one level deeper, and
 * it shares that module's primitives rather than restating them - boundsFor,
 * conditionsFor, statedValues and REJECTION_PATH all come from checklist.js so
 * that "what counts as a bound" has exactly one definition.
 *
 * What it deliberately is NOT:
 *
 *   not canonical   never in canonicalProjectSchema, never posted by the
 *                   browser, never exported to the workbook
 *   not complete    prose that states an obligation in a shape no pattern here
 *                   recognises yields no obligation, and that is the correct
 *                   answer. A missed obligation is a coverage figure that is
 *                   silent; an invented one is a coverage figure that is wrong,
 *                   and the second is much worse.
 *   not a verdict   an unmatched obligation is reported, never "fixed", and the
 *                   semantic reviewer gets the ones deterministic matching
 *                   cannot settle.
 */

/** The behaviours that can be read out of source text reliably enough to count. */
export const OBLIGATION_TYPES = [
  'bound',
  'rejection',
  'condition',
  'branch',
  'transition',
  'mapping',
  'retry',
  'schedule',
  'ui_action',
  'side_effect',
  // A detail the source states in brackets that narrows how a behaviour must be
  // exercised: a named component, a named field, a stated mode.
  'qualifier',
  // A bullet under a GIVEN/WHEN/THEN lead-in: the document's own statement of
  // what the system must do or keep true when the condition holds.
  'criterion',
];

/**
 * A self-check on our own derivation, not a trust boundary.
 *
 * Nothing external produces an obligation, so this cannot catch bad input - it
 * catches a detector of ours emitting something malformed, before it reaches a
 * prompt or a coverage percentage. An obligation that fails it is dropped, and
 * a test asserts that across every fixture nothing ever is.
 */
export const obligationSchema = z
  .object({
    requirement_id: z.string().regex(/^REQ-\d{3,}$/),
    obligation_id: z.string().regex(/^OB-\d{3,}$/),
    type: z.enum(OBLIGATION_TYPES),
    statement: z.string().trim().min(3).max(300),
    source_basis: z.string().trim().min(1).max(1000),
    expected_behavior: z.string().trim().min(1).max(300).nullable(),
    metadata: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();

/**
 * Enough to make coverage meaningful, few enough to keep the prompt affordable.
 *
 * Set by measurement, not taste. A dense error-handling requirement - timeout,
 * status change, queue routing, a scheduled retry, a retry limit, a final
 * failure state - derives fourteen, and a lower ceiling cut the last few off:
 * the retry limit and the final state, which are the obligations most likely to
 * be the untested ones. Truncation drops from the end, so the cap silently
 * excuses whatever a requirement says last.
 */
const MAX_OBLIGATIONS_PER_REQUIREMENT = 16;

// --- Reading the requirement ------------------------------------------------

/**
 * Splits a requirement into the units a behaviour is usually stated in: one
 * bullet, one table row, one sentence.
 *
 * Every segment is a contiguous slice of the original text - only leading
 * bullet marks and surrounding whitespace are removed - which is what lets
 * source_basis be verbatim.
 */
function segmentsOf(text) {
  return String(text ?? '')
    .split(/\n+|(?<=[.!?;])\s+/)
    .map((segment) => segment.replace(/^[\s•*–—-]+/, '').trim())
    .flatMap(splitJoinedRows)
    .filter((segment) => segment.length > 2);
}

/**
 * Two rows the extractor joined on one line without punctuation. The real PRD's
 * file-name row and its delimiter row arrive as one:
 *
 *   "Use ... as file name format (Date using Transaction Date) Generate the final report ..."
 *
 * and read as one, the delimiter row - the tilde - had no obligation of its own: the
 * qualifier detector took the whole line and the criterion beside it was reconciled away.
 *
 * A capital after a bracket is not evidence on its own: "One-time password (OTP)
 * Verification is required" and "Funds Transfer (FT) Success message" are one sentence
 * each. A cut is made only when the bracket is not an abbreviation gloss for the name before
 * it, and when the text on each side carries words of its own (lowercase content words),
 * so neither side is the tail of a name.
 */
const JOINED_ROW = /\)\s+(?=\p{Lu}\p{Ll}+\s+\p{Ll})/gu;
const ABBREVIATION_GLOSS = /^[\p{Lu}\p{N}][\p{Lu}\p{N}&./-]{0,11}$/u;
const MIN_SIDE_WORDS = 2;

function lowercaseContentWords(text) {
  return (String(text).match(/(?<![\p{L}\p{N}_])\p{Ll}[\p{L}\p{N}_]*/gu) ?? []).filter(
    (word) => contentWords(word).size > 0
  ).length;
}

function splitJoinedRows(segment) {
  const parts = [];
  let from = 0;
  for (const match of segment.matchAll(JOINED_ROW)) {
    const close = match.index;
    const open = segment.lastIndexOf('(', close);
    if (open < from) continue;
    if (ABBREVIATION_GLOSS.test(segment.slice(open + 1, close).trim())) continue;
    if (lowercaseContentWords(segment.slice(from, open)) < MIN_SIDE_WORDS) continue;
    if (lowercaseContentWords(segment.slice(close + 1)) < MIN_SIDE_WORDS) continue;
    parts.push(segment.slice(from, close + 1).trim());
    from = close + 1;
  }
  parts.push(segment.slice(from).trim());
  return parts;
}

function segmentContaining(segments, needle, fallback) {
  return segments.find((segment) => segment.includes(needle)) ?? fallback;
}

/** Trims a derived statement to something a prompt line can carry. */
function short(text, limit = 160) {
  const collapsed = String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return collapsed.length > limit ? `${collapsed.slice(0, limit - 1)}…` : collapsed;
}

// --- Detectors ---------------------------------------------------------------

/**
 * Bounds, from the checklist's own reader.
 *
 * The checklist already tells the generator which limits to test; this turns
 * each one into something coverage can be measured against, so that a
 * requirement stating two limits cannot be "fully covered" by a case exercising
 * one of them.
 */
function boundObligations(text, segments) {
  return boundsFor(text).map((bound) => ({
    type: 'bound',
    statement: `Boundary ${bound.raw}${bound.kind === 'unclassified' ? '' : ` (${bound.kind})`} is exercised`,
    source_basis: segmentContaining(segments, bound.raw, text),
    expected_behavior: null,
    metadata: { value: bound.normalized, raw: bound.raw, kind: bound.kind },
  }));
}

/**
 * A rejection path, when the wording states one.
 *
 * Category alone is deliberately not enough here, although it is enough for the
 * checklist. The checklist is a hint to a model that can read the requirement
 * and disagree; an obligation is an input to a coverage percentage, and a
 * percentage computed from "this is categorised Input Validation, so something
 * must be rejected somewhere" is a number with no sentence behind it.
 */
function rejectionObligations(segments) {
  const basis = segments.find((segment) => REJECTION_PATH.test(segment));
  if (!basis) return [];

  return [
    {
      type: 'rejection',
      statement: 'The rejection or failure path is exercised',
      source_basis: basis,
      expected_behavior: 'The operation is refused rather than completed',
      metadata: {},
    },
  ];
}

function conditionObligations(description) {
  return conditionsFor(description).map((clause) => ({
    type: 'condition',
    statement: `Condition holds: ${short(clause)}`,
    source_basis: clause,
    expected_behavior: null,
    metadata: { clause },
  }));
}

/**
 * IF/THEN and ELSE branches.
 *
 * Both halves must be present. A bare "if" opens half the sentences in a
 * specification and marks nothing; it is the arrow, the "then" or the "maka"
 * that says a distinct outcome follows, and without one there is no second
 * branch to be missing.
 */
const BRANCH_RULE =
  /\b(?:if|when|jika|apabila|bila|ketika)\b\s*(.{3,140}?)\s*,?\s*(?:then\b|maka\b|->|→|=>)\s*(.{3,180}?)(?=[.;\n]|$)/gi;

const ELSE_RULE =
  /\b(?:else|otherwise|if\s+not|jika\s+tidak|apabila\s+tidak|selain\s+itu|sebaliknya)\b\s*,?\s*(?:then\b|maka\b|->|→|=>)?\s*(.{3,180}?)(?=[.;\n]|$)/gi;

/**
 * The block form, where GIVEN, WHEN and THEN are separate lines.
 *
 * The inline rule cannot see this: it needs the condition and the outcome in
 * one segment, and acceptance criteria are written one clause per line. The
 * continuation lines are where the coverage goes missing - a WHEN with four
 * THENs under it is four obligations, and a test case that verifies the first
 * has historically been read as testing all of them.
 *
 * AND only continues a block that has already reached a THEN, so a sentence
 * that happens to begin with "and" cannot attach itself to an earlier WHEN.
 */
const GWT_WHEN = /^(?:when|ketika|saat|apabila|jika)\b\s*(.{3,160})$/i;
const GWT_THEN = /^(?:then|maka)\b\s*(.{3,180})$/i;
const GWT_AND = /^(?:and|dan|serta)\b\s*(.{3,180})$/i;

/** An inline "if X then Y" is the other rule's; this one wants standalone lines. */
const INLINE_THEN = /\b(?:then|maka)\b|->|→|=>/i;

/**
 * Verbs that state a required behaviour rather than describe one.
 *
 * This is what separates an acceptance criterion from the wreckage around it. A
 * criterion tells the system to do something or to keep something true; a
 * heading, a table row and a wrapped fragment do not. Measured against the real
 * PRD's own bullets:
 *
 *   "Add and display new data column for RELEASE"          add, display   kept
 *   "DATE AND TIME to the table"                           none           dropped
 *   "Maintain the Export to TXT button status as active"    maintain       kept
 *   "Name Title Project Role Signature"                    none           dropped
 *
 * Deliberately a vocabulary of verbs rather than of subjects, so it carries to
 * any document: nothing here names a field, a screen or a system.
 */
const CRITERION_VERB =
  /\b(?:add|display|show|render|load|list|maintain|keep|retain|preserve|remain\w*|stay\w*|trigger\w*|generate\w*|produce|create|include|save|store|write|send|transfer|update|set|remove|delete|clear|enable\w*|disable\w*|activate|deactivate|ensure|provide|apply|perform|execute|run|allow|permit|prevent|block|reject|return|export|download|upload|process|validate|verify|calculate|sort|filter|paginate|refresh|tambah\w*|tampil\w*|muat|simpan|kirim|ubah|hapus|aktif\w*|nonaktif\w*|pastikan|proses|hasilkan|sediakan|tolak|cegah|hitung|urutkan|saring)\b/i;

/**
 * Whether a line inside a THEN list states a behaviour that can be tested.
 *
 * Three guards, all of which a real criterion passes and the surrounding noise
 * does not: it must not be another lead-in, it must carry enough words to be a
 * sentence rather than a title, and it must state an action or a state to hold.
 */
/**
 * Whether a line is text the parser broke rather than a sentence.
 *
 * PDFs with letter-spaced headings come out of extraction shattered, and the
 * real document's Jira issue titles land like this:
 *
 *   "Report] Make t he Export Butto n Always Activ e Done"
 *   "Report] Set Def ault View, Impl ement Paginati on and Add Ne w Column"
 *
 * They carry "Make", "Set" and "Add", so a verb vocabulary cannot tell them
 * apart from a criterion - four of them became obligations, each demanding that
 * QA test a ticket title. Stray single letters are the signal: English uses "a"
 * and "I" as words and nothing else, so two or more others mean the spacing is
 * wrong, not the sentence.
 */
function isBrokenText(segment) {
  const strays = (String(segment).match(/(?<![\p{L}\p{N}])[\p{L}](?![\p{L}\p{N}])/gu) ?? []).filter(
    (letter) => !/^[aAiI]$/.test(letter)
  );

  return strays.length >= 2;
}

/**
 * A row from the issue tracker the document was exported with.
 *
 * Two signals, both structural rather than about wording. A trailing workflow
 * status is what a tracker appends and a specification never writes; and a
 * closing bracket with no opening one is the tail of a project prefix - the real
 * document's titles begin "[QR Manager Settlement Report]" and the parser breaks
 * the line inside it, leaving "Report] ...".
 *
 * Needed beyond the stray-letter test because one of these titles came through
 * with only a single letter broken off, which is under that threshold.
 */
const TRACKER_STATUS =
  /\b(?:done|closed|resolved|in\s+progress|to\s+do|ready\s+to\s+sit|backlog|cancelled|selesai)\s*$/i;

const ORPHAN_BRACKET = /^[^[]*\]/;

/**
 * A link to the issue tracker as a "Jira Link" column writes it: the key, a
 * colon, and the ticket's title - "QRM-17394: Pagination update".
 *
 * TRACKER_STATUS used to catch these only because the real PRD's links ended in
 * a workflow state ("... Done"). The sanitised copy dropped the states, and
 * every link came through bare: three became acceptance criteria ("Acceptance
 * criterion - QRM-17394: Pagination update") and one a response code ("Code
 * QRM-17521 is returned", cued by "Check Status"). Each was a permanent coverage
 * gap and a line in the prompt asking the model to test a ticket number. The
 * golden oracle files all of them as DOCUMENT_METADATA (GO-065).
 *
 * The shape alone cannot tell a ticket from a code table - "QRIS-1001: Invalid
 * QR" reads the same - so two things narrow it. Issue numbers are integers and
 * are never zero-padded, where response codes very often are (KLR-01, ERR-001,
 * ADMI 002). And it applies only to a document that names its tracker at all,
 * which is what a column headed "Jira Link" does.
 */
const TRACKER_LINK = /^[A-Z][A-Z0-9]{1,9}-[1-9]\d{2,}\s*:/;

/** How a document that carries tracker links says so. */
const TRACKER_NAMED = /\bjira\b/i;

/**
 * The scenario table's header row - "Scenario Acceptance Criteria Jira Link" -
 * which the parser often fuses with the first cell beneath it, the scenario's
 * title. Column names and a title are structure, never behaviour, but the fused
 * line can still look like one: "... Jira Link Tick All QR Transaction Release"
 * has a UI verb and a UI noun, and became "UI behaviour: Scenario Acceptance
 * Criteria Jira Link Tick All QR Transaction Release".
 */
const TRACKER_HEADER = /\bjira\s+link\b/i;

/**
 * The second line of a ticket title that wrapped in its cell.
 *
 * Dropping the link was not enough on its own. "QRM-19347: Add New" wraps onto
 * "Advance Search Filter", and that line, read alone inside a THEN block, is
 * three capitalised words that pass for an imperative criterion - it became
 * "Acceptance criterion - Advance Search Filter". Every tail on the real PRD is
 * a title fragment: "Daily Settlement Report", "Export", "Transaction Logic",
 * "Release Settlement", "Report - Default View". A criterion is a sentence, so
 * only a short line with no closing punctuation, directly after a link, counts.
 */
const MAX_TITLE_TAIL_WORDS = 4;

function isTitleTail(segment) {
  if (/[.!?:;]$/.test(segment)) return false;
  const words = segment.split(/\s+/).filter((word) => /\p{L}/u.test(word));
  return words.length <= MAX_TITLE_TAIL_WORDS;
}

/**
 * The table furniture of a tracker-linked document - the header row, and the
 * wrapped tail of a ticket title - removed before any detector reads it rather
 * than taught to each of them. The link itself stays: the criterion and code
 * detectors skip it, and its presence is what closes a criterion the page cut,
 * so nothing is ever joined across the gap a removed line leaves.
 */
function withoutTrackerFurniture(segments, tracksIssues) {
  if (!tracksIssues) return segments;

  return segments.filter((segment, index) => {
    if (TRACKER_HEADER.test(segment)) return false;
    const previous = segments[index - 1];
    return !(previous && TRACKER_LINK.test(previous) && isTitleTail(segment));
  });
}

function isTrackerLink(segment, tracksIssues) {
  return Boolean(tracksIssues) && TRACKER_LINK.test(segment);
}

function isTrackerRow(segment, tracksIssues) {
  return (
    TRACKER_STATUS.test(segment) ||
    ORPHAN_BRACKET.test(segment) ||
    isTrackerLink(segment, tracksIssues)
  );
}

function isAcceptanceCriterion(segment, tracksIssues, structural = false) {
  if (isListLeadIn(segment)) return false;
  if (isBrokenText(segment) || isTrackerRow(segment, tracksIssues)) return false;
  if (contentWords(segment).size < MIN_BEHAVIOUR_WORDS) return false;

  // An IF/THEN bullet is a branch, and branchObligations already states it with
  // its condition and its outcome separated. Reading it as a criterion as well
  // charges the same clause twice - REQ-009's three filter rules each derived
  // both, doubling that requirement's denominator without adding a check.
  BRANCH_RULE.lastIndex = 0;
  if (BRANCH_RULE.test(segment)) {
    BRANCH_RULE.lastIndex = 0;
    return false;
  }

  if (CRITERION_VERB.test(segment)) return true;
  if (!structural) return false;

  // A row of a THEN list is a criterion by its place in the block, unless it is one of the
  // things that sit in a list without stating behaviour. A verb list cannot be the only
  // test: "Read SETTLEMENT_STATUS ... from source table ...", "Key join : ..." and
  // "Select all transaction rows ..." name no verb on it and are requirements all the same.
  const row = String(segment).trim();
  if (
    NOTE_LEAD.test(row) ||
    STATUS_QUO_ROW.test(row) ||
    ANNOTATION_LEAD.test(row) ||
    COMMENTARY.test(row) ||
    PURPOSE_LEAD.test(row) ||
    EXCLUSION_LABEL.test(row)
  ) {
    return false;
  }
  if (!/^\p{Lu}\p{Ll}/u.test(row)) return false;
  // A heading or a name row is Title Case: its lowercase words are only function words.
  if (lowercaseWordsWithContent(row) < 2) return false;
  ELSE_RULE.lastIndex = 0;
  const otherwise = ELSE_RULE.test(row);
  ELSE_RULE.lastIndex = 0;
  return !otherwise;
}

function lowercaseWordsWithContent(text) {
  return (String(text).match(/(?<![\p{L}\p{N}_])\p{Ll}[\p{L}\p{N}_]*/gu) ?? []).filter(
    (word) => contentWords(word).size > 0
  ).length;
}

/**
 * Phrases that open a statement of what the system does TODAY - "Current condition in
 * production when opening" - rather than what it must do. The same list checklist.js uses
 * to keep status-quo numbers out of the bounds.
 */
const STATUS_QUO_ROW =
  /^(?:current\s+condition|currently|current\s+state|existing\s+(?:condition|behaviou?r)|as[- ]is|previously|before\s+this\s+change|kondisi\s+saat\s+ini|saat\s+ini|sebelumnya)\b/i;

/** Document annotation inside a list - scope, assumptions, background, captions. */
const ANNOTATION_LEAD =
  /^(?:out[\s-]+of[\s-]+scope|not\s+in\s+scope|in[\s-]+scope|di\s+luar\s+(?:cakupan|lingkup|scope)|tidak\s+termasuk|(?:assumptions?|asumsi|dependenc(?:y|ies)|dependensi|rationale|alasan|background|latar\s+belakang|objectives?|purpose|tujuan|references?|referensi)\s*:|(?:figure|fig\.|table|image|gambar|tabel)\s*\d+[a-z]?\s*[:.\-–])/i;

/**
 * A bare demonstrative subject - "This reduces drop-off during onboarding." - is
 * a comment on the rows above. A determiner followed by its predicate ("This field is
 * mandatory") is a row and is kept.
 */
const COMMENTARY =
  /^(?:this|that|these|those|ini|hal\s+ini)\s+(?!\S+\s+(?:is|are|must|should|shall|will|can|cannot|may|has|have|harus|wajib|akan|dapat|tidak)\b)/i;

/**
 * A statement of why, not what - "The goal is to reduce manual effort." The
 * copula must be followed by to / that / because / so, so a field such as "The reason code is
 * shown on the receipt" is still a row.
 */
const PURPOSE_LEAD =
  /^(?:(?:the|our|this|its)\s+)?(?:main\s+|primary\s+)?(?:goal|purpose|objective|aim|intent(?:ion)?|reason|benefit|motivation)s?\b(?:\s+\S+){0,4}?\s+(?:is|are|was|were)\s+(?:to|that|because|so)\b|^(?:tujuan|manfaat|sasaran)(?:nya)?\b(?:\s+\S+){0,4}?\s+(?:adalah|yaitu|ialah)\b/i;

/** A label that excludes something - "Not included in this release: ..." */
const EXCLUSION_LABEL =
  /^(?:not\s+(?:included|in\s+scope|covered|supported|part\s+of)|excluded|exclusions?|tidak\s+(?:termasuk|dicakup|didukung))\b[^:]{0,60}:/i;

/**
 * How many wrapped lines one criterion may be rebuilt from.
 *
 * Three, because the criterion this was measured on takes three:
 *
 *   Add a new dropdown field named Settlement
 *   Status: placed directly below the existing
 *   Settlement Type: dropdown: Settled ,
 *   Unsettled , and Settled & Unsettled
 *
 * A cap at all because the rule reads what a line is NOT, and a run of lines
 * nothing else claims is exactly where that reasoning is weakest.
 */
const MAX_CRITERION_WRAP = 3;

/** And a ceiling on the rebuilt text, matching what a criterion statement carries. */
const MAX_CRITERION_BASIS = 320;

/**
 * The room a criterion statement has: the whole 300 characters obligationSchema allows,
 * after its prefix. Cut at 140, the real PRD's 17-column row told the generator six of its
 * columns, and the dropdown criterion lost the option it ended on. Past 300 the obligation
 * would fail the schema and be dropped, which is worse than a cut.
 */
const CRITERION_STATEMENT_ROOM = 300 - 'Acceptance criterion - '.length;

/**
 * Whether a criterion stops mid-phrase, which is the only reason to look below
 * it at all.
 *
 * This is the whole gate, and it is deliberately at the OPENING of a run rather
 * than on each line taken. Whether the lines underneath look like a
 * continuation turns out not to separate anything - REQ-005's "Current
 * condition in production when opening" is every bit as wrapped as REQ-010's
 * "Status: placed directly below the existing". What separates them is the
 * criterion itself:
 *
 *   Add a new dropdown field named Settlement      cut - the name is half-typed
 *   Load and display the transaction data grid quickly    a finished sentence
 *   Display a Select All checkbox on the page near the transaction list table
 *
 * An imperative bullet ends on a lowercase word, a number or a full stop. One
 * ending on a capitalised word ended inside a name, and one ending on a comma
 * or a conjunction ended inside a list. Everything else is left alone, which is
 * why the two criteria above keep the neighbours that were wrongly absorbed
 * when this rule was tried without the gate.
 */
const CUT_TAIL =
  /(?:[,;]|\b(?:and|or|dan|atau|serta|the|of|to|for|with|in|on|at|by)|\p{Lu}\p{Ll}+)$/u;

/**
 * A capitalised word here means INITIAL upper and at least one lower -
 * "Settlement", not "NUMBER".
 *
 * A shouted artifact name is how these documents write a field, and a criterion
 * routinely ends on one having said everything it had to say: "update the DB
 * status to SUCCESS and save the FT NUMBER" is finished, and reading its last
 * letter as a cut name let it swallow the rule below it.
 *
 * The cost of the narrower reading is that "Add and display new data column for
 * RELEASE" / "DATE AND TIME to the table" is not rejoined either - it stays as
 * it was, and it was covered as it was. A shouted name cut in half and a
 * shouted name ending a sentence are indistinguishable from the line above, so
 * the safe reading leaves both alone.
 */
const FINISHED = /[.!?]$/;

/**
 * Whether a line inside an open criteria block is the tail of the criterion
 * above it rather than something of its own.
 *
 * Every test here is a claim that some OTHER reader owns the line, and the
 * answer is only "continuation" once they have all declined it. That ordering
 * is the whole safety argument: a line this appends to a criterion is a line
 * that would otherwise have been discarded, so the rule can lose nothing, but
 * it could still corrupt a criterion by swallowing a neighbour - and the
 * neighbours worth worrying about are all claimed.
 *
 *   an acceptance criterion   the caller checked before asking
 *   a list lead-in            "Process and render the data ...:" introduces the
 *                             IF rules under it and is not part of the bullet above
 *   a branch                  "IF the User pick Settled filter, then ..."
 *   a Notes line              the guard, qualifier and bound detectors read it;
 *                             "Notes: Select All only applies to ..." carries no
 *                             criterion verb and would otherwise look exactly
 *                             like a wrapped tail
 *   a GIVEN/WHEN/THEN line    structure, not prose
 *   tracker junk              "SDE4-19347:", "R] [Settlement", "... Done"
 */
function isWrapContinuation(segment, tracksIssues) {
  if (isListLeadIn(segment) || isTrackerRow(segment, tracksIssues) || isBrokenText(segment)) {
    return false;
  }
  if (NOTE_LEAD.test(segment)) return false;
  if (GWT_WHEN.test(segment) || GWT_THEN.test(segment) || GWT_AND.test(segment)) return false;

  BRANCH_RULE.lastIndex = 0;
  const branch = BRANCH_RULE.test(segment);
  BRANCH_RULE.lastIndex = 0;

  return !branch;
}

/**
 * Rebuilds a criterion the page layout cut in half.
 *
 * The basis is taken as one contiguous slice of the requirement text, never by
 * joining segments, so it stays verbatim - the same guarantee every other
 * source_basis carries, and the reason this reads indices rather than strings.
 */
function extendCriterion(open, segment, text) {
  const at = typeof text === 'string' ? text.indexOf(segment, open.cursor) : -1;
  if (at === -1) return false;

  const basis = text.slice(open.start, at + segment.length);
  if (basis.length > MAX_CRITERION_BASIS) return false;

  const flat = basis.replace(/\s+/g, ' ').trim();
  open.obligation.source_basis = basis;
  open.obligation.statement = `Acceptance criterion - ${short(flat, CRITERION_STATEMENT_ROOM)}`;
  open.obligation.expected_behavior = short(flat);
  open.obligation.metadata.criterion = flat;
  open.cursor = at + segment.length;
  open.taken += 1;

  return true;
}

/** The GIVEN line of a scenario. */
const GWT_GIVEN = /^(?:given|diberikan)\b\s*(.{3,160})$/i;

/**
 * Whether a GIVEN line opens a scenario, rather than a row of a THEN list that happens to
 * begin "Given ..." as prose. The keyword written as a keyword is enough; otherwise a WHEN or
 * THEN line must follow within two lines.
 *
 * Read as one more line of the block above it, "GIVEN the daily settlement report is
 * generated" became an acceptance criterion of the previous scenario - "generated" is a
 * criterion verb - and a GIVEN -> THEN scenario with no WHEN inherited the previous
 * scenario's condition.
 */
function opensWithGiven(segments, index) {
  const segment = segments[index] ?? '';
  if (!GWT_GIVEN.test(segment)) return false;
  if (/^(?:GIVEN|DIBERIKAN)\b/.test(segment)) return true;
  return segments
    .slice(index + 1, index + 3)
    .some((next) => (GWT_WHEN.test(next) && !INLINE_THEN.test(next)) || GWT_THEN.test(next));
}

/**
 * The first line of a lead-in the page wrapped across two lines. The lead-in
 * below is a continuation only when it cannot stand as a row of its own - it starts
 * lowercase, is at most two words, or this line stops on a cut tail - so a finished row that
 * happens to sit above a lead-in row is not mistaken for half of it.
 */
function wrapsIntoLeadIn(segment, next) {
  const line = String(segment).trim();
  const below = String(next ?? '').trim();
  if (!below || !isListLeadIn(below) || /[.!?]$/.test(line)) return false;
  return (
    /^\p{Ll}/u.test(below) ||
    below.replace(/:$/, '').trim().split(/\s+/).length <= 2 ||
    CUT_TAIL.test(line)
  );
}

/** Words that make a line a statement rather than a title. */
const PREDICATE_MARK =
  /\b(?:is|are|was|were|be|been|must|should|shall|will|can|cannot|may|not|has|have|had|does|do|harus|wajib|akan|dapat|bisa|tidak)\b/i;
const MAX_SUBHEADING_WORDS = 8;

/**
 * The title of the scenario below - "Handling of failed postings" directly above
 * its GIVEN. Short, unpunctuated, no predicate, no artifact name or number.
 */
function headsNextScenario(segments, index) {
  const next = segments[index + 1];
  if (!next) return false;
  if (!opensWithGiven(segments, index + 1) && !(GWT_WHEN.test(next) && !INLINE_THEN.test(next)))
    return false;
  const line = String(segments[index]).trim();
  if (/[.!?:;,]$/.test(line)) return false;
  if (/\p{Lu}{2,}|\p{N}|_/u.test(line)) return false;
  if (PREDICATE_MARK.test(line) || /\bdi\p{Ll}{3,}/u.test(line)) return false;
  return line.split(/\s+/).length <= MAX_SUBHEADING_WORDS;
}

function criteriaBlockObligations(segments, text, tracksIssues) {
  const obligations = [];

  let condition = null;
  let sawThen = false;
  // Whether a row may be read as a criterion by its place alone: open from a THEN line until
  // a lead-in that introduces something other than conditional rows, or tracker furniture.
  let clean = false;

  // The criterion most recently emitted, while it can still be continued.
  let open = null;

  for (const [index, segment] of segments.entries()) {
    // A GIVEN that opens a scenario starts a new block, and its clause is the condition
    // until a WHEN replaces it - so GIVEN -> THEN without a WHEN keeps its rows.
    if (opensWithGiven(segments, index)) {
      condition = GWT_GIVEN.exec(segment)[1].trim();
      sawThen = false;
      clean = false;
      open = null;
      continue;
    }

    const when = GWT_WHEN.exec(segment);
    if (when && !INLINE_THEN.test(segment)) {
      condition = when[1].trim();
      sawThen = false;
      continue;
    }

    const then = GWT_THEN.exec(segment);
    const and = sawThen ? GWT_AND.exec(segment) : null;
    const outcome = (then ?? and)?.[1]?.trim();

    if (condition && outcome) {
      // The block form is where a colon lead-in is the norm rather than the
      // exception: "THEN the system must fulfill:" on its own line, with the
      // actual outcomes as bullets beneath it. Emitting a branch for the
      // lead-in produced five permanently uncovered obligations on one PRD,
      // each demanding that a test case prove "the system must fulfill:".
      //
      // The condition and sawThen still advance, so the lines that follow are
      // read exactly as before - only the meaningless obligation is dropped.
      sawThen = true;
      if (then) clean = true;
      if (isListLeadIn(outcome)) continue;

      obligations.push({
        type: 'branch',
        statement: `Branch - when ${short(condition, 60)}: ${short(outcome, 80)}`,
        source_basis: segment,
        expected_behavior: short(outcome),
        metadata: { condition: short(condition), outcome: short(outcome) },
      });
      continue;
    }

    // The bullets the lead-in introduced. Four requirements on the real PRD
    // derived NOTHING because of this: their acceptance criteria are imperative
    // sentences under "THEN the system must fulfill:", and no other detector
    // reads that shape - uiObligations wants an interaction verb (click, press),
    // branchObligations wants an IF, and sideEffectObligations wants a shouted
    // artifact name. So "Maintain the Export to TXT button as active and enabled
    // under all data states" was a stated, testable requirement that left no
    // trace in the coverage denominator at all.
    //
    // Being inside a GIVEN/WHEN/THEN block is half the guard and the verb is the
    // other half: background prose and objective bullets are never inside one,
    // so they cannot reach here however they are worded. A row with no listed verb
    // is read by its place instead, while the list is open (`clean`), and only past
    // the exclusions isAcceptanceCriterion applies to that reading.
    // Tracker furniture ends the list's own rows.
    if (condition && sawThen && isTrackerRow(segment, tracksIssues)) clean = false;

    // A lead-in inside the list.
    if (condition && sawThen && isListLeadIn(segment)) {
      const next = segments[index + 1] ?? '';
      BRANCH_RULE.lastIndex = 0;
      const introducesConditions = CONDITIONAL_LEAD.test(next) || BRANCH_RULE.test(next);
      BRANCH_RULE.lastIndex = 0;
      // A lead-in introducing IF rows keeps the list open but is not itself a criterion:
      // the repository documents and tests that ("reads nothing from another lead-in").
      if (!introducesConditions) clean = false;
    }

    const continues =
      open && open.taken < MAX_CRITERION_WRAP && isWrapContinuation(segment, tracksIssues);
    if (
      condition &&
      sawThen &&
      (isAcceptanceCriterion(segment, tracksIssues) ||
        (clean &&
          !continues &&
          !wrapsIntoLeadIn(segment, segments[index + 1]) &&
          !headsNextScenario(segments, index) &&
          isAcceptanceCriterion(segment, tracksIssues, true)))
    ) {
      const obligation = {
        type: 'criterion',
        statement: `Acceptance criterion - ${short(segment, CRITERION_STATEMENT_ROOM)}`,
        source_basis: segment,
        expected_behavior: short(segment),
        metadata: { criterion: segment, condition: short(condition) },
      };
      obligations.push(obligation);

      // A criterion that ends in a full stop said everything it had to say. One
      // that stops mid-phrase was cut by the page, so it stays open for the
      // lines below it.
      const start = typeof text === 'string' ? text.indexOf(segment) : -1;
      open =
        start === -1 || FINISHED.test(segment.trim()) || !CUT_TAIL.test(segment.trim())
          ? null
          : { obligation, start, cursor: start + segment.length, taken: 0 };
      continue;
    }

    // A line that is not a criterion does NOT close the list. PDF wrapping
    // leaves fragments between real bullets - "DATE AND TIME to the table" sits
    // between two of them - and closing on the fragment would discard every
    // criterion after it. Only a new GIVEN or WHEN starts a new block.
    //
    // The same applies before the THEN arrives: REQ-005's condition wraps across
    // two lines ("WHEN QR Manager User opens the Settlement" / "Report menu"),
    // and treating the second line as the end of the block meant its THEN never
    // had a condition, so both of its criteria were lost. Nothing is emitted
    // while sawThen is false, so holding the condition open cannot invent
    // anything - it only survives the line break.
    //
    // A fragment is no longer merely skipped. Discarding it lost the half of a
    // criterion the page break took: REQ-010's "Add a new dropdown field named
    // Settlement" is where the line ended, and "Status: placed directly below
    // the existing Settlement Type: dropdown: Settled, Unsettled, and Settled &
    // Unsettled" - the field's own name, its position and its three options -
    // was on the three lines below. The obligation demanded the first seven
    // words and the test case that covered all of it was reported as missing.
    if (condition) {
      if (open && open.taken < MAX_CRITERION_WRAP && isWrapContinuation(segment, tracksIssues)) {
        if (!extendCriterion(open, segment, text)) open = null;
        else if (/[.!?]$/.test(segment)) open = null;
      } else {
        open = null;
      }
      continue;
    }

    condition = null;
    sawThen = false;
    open = null;
  }

  return obligations;
}

/**
 * Whether a captured consequent is only announcing a list.
 *
 * A trailing colon is the whole test, and it is reliable in both directions: a
 * real consequent that happens to contain a colon does not END with one
 * ("display the following: all settled transactions"), while a lead-in always
 * does. The items it introduces are separate lines, so nothing is lost by
 * declining here - they are segments in their own right.
 */
function isListLeadIn(outcome) {
  return /:$/.test(String(outcome ?? '').trim());
}

/**
 * A conditional that opens its sentence. WHEN is left out on purpose: in these
 * documents a line opening with WHEN is GIVEN/WHEN/THEN block structure, which
 * criteriaBlockObligations reads, not a sentence-level rule.
 */
const CONDITIONAL_LEAD = /^(?:if|jika|apabila|bila)\b\s*/i;

/** How many wrapped lines one conditional may be rebuilt from. */
const MAX_CONDITIONAL_WRAP = 3;

/** Ceiling on a rebuilt conditional, so a run of lines cannot become a paragraph. */
const MAX_CONDITIONAL_BASIS = 400;

const flat = (text) => text.replace(/\s+/g, ' ').trim();

/** Top-level commas, and whether a bracket or a quote is still open at the end. */
function topLevel(sentence) {
  const commas = [];
  let depth = 0;
  let quoted = false;

  for (let index = 0; index < sentence.length; index += 1) {
    const char = sentence[index];
    if (char === '"') quoted = !quoted;
    else if (quoted) continue;
    else if (char === '(') depth += 1;
    else if (char === ')') depth = Math.max(0, depth - 1);
    else if (char === ',' && depth === 0) commas.push(index);
  }

  return { commas, open: depth > 0 || quoted };
}

/**
 * "IF <condition>, <consequent>" - the consequent introduced by a comma, not THEN.
 *
 * BRANCH_RULE reads only the THEN form, and these documents use both: the same
 * requirement writes "IF FAILED ... or NOT FOUND, then trigger retry" and "IF
 * after Release Settlement 1 and/or 2 retries attempt the transaction still
 * Timeout, perform Check Status again". The second was read as nothing.
 *
 * A comma is a weak marker - conditions carry lists ("IF A, B or C, reject") -
 * so the consequent is taken only after a top-level comma that is followed by
 * an action verb from the same list a criterion is recognised by, optionally
 * after an adverb. Where no comma is followed by one, there is no reading, and
 * that is the conservative answer.
 */
function commaConsequent(sentence) {
  const lead = CONDITIONAL_LEAD.exec(sentence);
  if (!lead) return null;
  if (/\b(?:then|maka)\b|->|→|=>/i.test(sentence)) return null; // BRANCH_RULE's form

  for (const at of topLevel(sentence).commas) {
    const consequent = sentence
      .slice(at + 1)
      .trim()
      .replace(/[.;]+$/, '');
    const words = consequent.split(/\s+/);
    const verb = /^\p{L}+ly$/iu.test(words[0] ?? '') ? words[1] : words[0];

    if (verb && CRITERION_VERB.test(verb)) {
      return { condition: sentence.slice(lead[0].length, at).trim(), outcome: consequent };
    }
  }

  return null;
}

/** The consequent a conditional states, in either form, or null. */
function consequentOf(sentence) {
  BRANCH_RULE.lastIndex = 0;
  const then = BRANCH_RULE.exec(sentence);
  BRANCH_RULE.lastIndex = 0;

  if (then) return { condition: then[1], outcome: then[2], match: then[0] };
  return commaConsequent(sentence);
}

/**
 * Whether a conditional sentence stops before it has said what happens.
 *
 * Reported structurally, never by guessing at words: a bracket or quote still
 * open, no consequent at all, or a consequent too short to be a behaviour - the
 * same three-content-word floor a criterion has to clear. "... still Timeout,
 * perform" ends on a verb with no object, which is where the PDF line ended.
 */
function isIncompleteConditional(sentence) {
  if (FINISHED.test(sentence)) return false;
  if (topLevel(sentence).open) return true;

  const consequent = consequentOf(sentence);
  return !consequent || contentWords(consequent.outcome).size < MIN_BEHAVIOUR_WORDS;
}

/**
 * A conditional sentence the page wrapped, read back whole.
 *
 * The parser yields one block per printed line and segmentsOf cuts on every
 * line break, so a rule the PDF wrapped arrives as two halves neither of which
 * is a rule: "IF after Release Settlement 1 and/or 2 retries attempt the
 * transaction still Timeout, perform" and "Check Status again." The text was
 * never lost - the requirement holds it verbatim, and Gemini #1 named it as a
 * test point - but no obligation was derived from it, so Gemini #2's plan never
 * had to account for it and it was dropped in four runs of ten.
 *
 * Joined only while the sentence is demonstrably incomplete, and only across
 * lines that read as its tail - never a new IF, a GIVEN/WHEN/THEN line, a note,
 * a list lead-in or a tracker row. The basis is one contiguous slice of the
 * requirement text, so it stays verbatim, exactly as a rebuilt criterion does.
 *
 * @returns {{basis: string, sentence: string, used: number[]} | null}
 */
function wholeConditional(segments, index, positions, text, tracksIssues) {
  const start = positions[index];
  if (start < 0 || typeof text !== 'string') return null;

  let end = start + segments[index].length;
  const used = [];

  for (
    let next = index + 1;
    next < segments.length && used.length < MAX_CONDITIONAL_WRAP;
    next += 1
  ) {
    if (!isIncompleteConditional(flat(text.slice(start, end)))) break;

    const segment = segments[next];
    if (positions[next] < 0 || CONDITIONAL_LEAD.test(segment)) break;
    if (!isWrapContinuation(segment, tracksIssues)) break;

    end = positions[next] + segment.length;
    used.push(next);
  }

  const basis = text.slice(start, end);
  if (used.length === 0 || basis.length > MAX_CONDITIONAL_BASIS) return null;

  const sentence = flat(basis);
  if (isIncompleteConditional(sentence)) return null;

  return { basis, sentence, used };
}

function branchObligations(segments, text, tracksIssues) {
  const obligations = [];

  // Where each segment sits in the text, so a rebuilt sentence can be cut from
  // it verbatim. Searched forward, so a repeated line is found in order.
  const positions = [];
  let from = 0;
  for (const segment of segments) {
    const at = typeof text === 'string' ? text.indexOf(segment, from) : -1;
    positions.push(at);
    if (at >= 0) from = at + segment.length;
  }

  const consumed = new Set();

  for (const [index, segment] of segments.entries()) {
    if (consumed.has(index)) continue;

    // An enumerated condition list is the checklist's territory; reading "only
    // if X" as a branch as well would count one clause twice.
    if (ENUMERATION_LEAD_IN.test(segment)) continue;

    // A conditional the page cut short, or one written with a comma rather than
    // THEN: read whole, with the condition kept in full. The condition is what
    // the reconstruction recovered - "still Timeout" after the first and second
    // retry - and cutting it at sixty characters would throw that away again.
    if (CONDITIONAL_LEAD.test(segment)) {
      const whole = isIncompleteConditional(flat(segment))
        ? wholeConditional(segments, index, positions, text, tracksIssues)
        : null;
      const sentence = whole?.sentence ?? flat(segment);
      const consequent = whole ? consequentOf(sentence) : commaConsequent(sentence);

      if (consequent && !isListLeadIn(consequent.outcome)) {
        for (const used of whole?.used ?? []) consumed.add(used);
        obligations.push({
          type: 'branch',
          statement: `Branch - when ${short(consequent.condition, 140)}: ${short(consequent.outcome, 120)}`,
          source_basis: (whole?.basis ?? segment).trim(),
          expected_behavior: short(consequent.outcome),
          metadata: { condition: short(consequent.condition), outcome: short(consequent.outcome) },
        });
        continue;
      }
    }

    for (const [match, condition, outcome] of segment.matchAll(BRANCH_RULE)) {
      // "WHEN the user opens the menu THEN the system must fulfill:" states no
      // outcome. The outcome is the bullets on the lines below, which are their
      // own segments and derive their own obligations - so this yielded a
      // branch demanding "the system must fulfill:", which nothing can satisfy
      // and no test case can ever be matched against.
      //
      // On the real PRD eight of thirty obligations were this, every one
      // permanently uncovered. They did not merely pad the denominator: they
      // pushed the behaviours that ARE testable out of a reviewer's attention.
      if (isListLeadIn(outcome)) continue;

      obligations.push({
        type: 'branch',
        statement: `Branch - when ${short(condition, 60)}: ${short(outcome, 80)}`,
        source_basis: match.trim(),
        expected_behavior: short(outcome),
        metadata: { condition: short(condition), outcome: short(outcome) },
      });
    }

    for (const [match, outcome] of segment.matchAll(ELSE_RULE)) {
      if (isListLeadIn(outcome)) continue;

      // "otherwise" names no condition; the clause before it is the condition, so the
      // obligation carries the source sentence. Without it, "[Validation] Data only contains
      // with FT_NUMBER, otherwise the data is not streamed" told the generator only
      // "otherwise: the data is not streamed".
      const sentence = segment.replace(/\s+/g, ' ').trim();
      const before = sentence.slice(0, sentence.indexOf(match.replace(/\s+/g, ' ').trim())).trim();
      const stated =
        contentWords(before).size >= MIN_BEHAVIOUR_WORDS ? `, as stated: ${sentence}` : '';

      obligations.push({
        type: 'branch',
        statement: short(`Branch - otherwise: ${short(outcome, 100)}${stated}`, 300),
        source_basis: match.trim(),
        expected_behavior: short(outcome),
        metadata: { condition: 'otherwise', outcome: short(outcome) },
      });
    }
  }

  return obligations;
}

/**
 * Status and state transitions.
 *
 * A state name is recognised by its shape - SHOUTED or Capitalised - because
 * that is how specifications write them, and because a lowercase word after
 * "becomes" is usually prose ("the balance becomes negative") rather than a
 * state the system moves into.
 */
const TRANSITION_VERBS =
  /becomes?|change[sd]?\s+to|changing\s+to|is\s+set\s+to|set\s+to|updated?\s+to|turns?\s+to|moves?\s+to|marked\s+as|flagged\s+as|berubah\s+menjadi|diubah\s+menjadi|diset\s+(?:ke|menjadi)|ditandai\s+sebagai|menjadi/;

const TRANSITION_RULE = new RegExp(
  String.raw`\b(?:status|state|kondisi|stage|tahap)\b[^.\n]{0,50}?\b(?:${TRANSITION_VERBS.source})\s+(["'\w][\w"'-]{1,39})`,
  'gi'
);

const MARKED_AS_RULE = new RegExp(
  String.raw`\b(?:marked\s+as|flagged\s+as|ditandai\s+sebagai)\s+(["'\w][\w"'-]{1,39})`,
  'gi'
);

/**
 * The same transition written as an instruction: "Mark the transaction as
 * PENDING", "permanently mark the transaction status as FAILED". The two rules
 * above read the result ("is marked as", "status ... becomes"); an acceptance
 * criterion more often states the action, and measured on the Settlement PRD
 * both of its state changes were written that way - the move into PENDING on a
 * timeout and the final FAILED after the third retry. Neither was an
 * obligation, so whether a run tested the end of the retry path was not
 * measured at all.
 *
 * The object is a few words and no more, so the verb and the state stay in one
 * clause; the state passes the same shape test as everywhere else, which keeps
 * "mark the box as checked" out.
 */
const MARK_AS_RULE = new RegExp(
  String.raw`\b(?:mark|marks|tandai|menandai)\s+(?:[\w-]+\s+){1,4}?(?:as|sebagai)\s+(["'\w][\w"'-]{1,39})`,
  'gi'
);

/** Words that pass the shape test but name nothing. */
const NOT_A_STATE = new Set([
  'the',
  'a',
  'an',
  'that',
  'this',
  'its',
  'their',
  'and',
  'or',
  'not',
  'dan',
  'atau',
  'tidak',
  'yang',
  'akan',
  'harus',
  'wajib',
]);

function asStateName(raw) {
  const token = String(raw ?? '').replace(/^["']|["']$/g, '');
  if (token.length < 3 || NOT_A_STATE.has(token.toLowerCase())) return null;

  const shouted = /^[A-Z][A-Z0-9_]{2,}$/.test(token);
  const capitalised = /^[A-Z][A-Za-z0-9_-]{2,}$/.test(token);

  return shouted || capitalised ? token : null;
}

/**
 * The IF-clause that gates an imperative mark-as sentence in the same segment:
 *
 *   IF the status remains unresolved (FAILED) after 3rd retry attempt,
 *   permanently mark the transaction status as FAILED.
 *
 * The rules above match only their own clause, which is correct for a bare
 * instruction ("Mark the transaction as PENDING") and wrong for one a
 * condition gates: without this, "after the third retry" was never read, and
 * a test case that proved only the mid-retry branch sets FAILED was
 * indistinguishable from one that proved the terminal state actually gets
 * there - the same half-guard failure guardObligations exists to avoid, one
 * detector over.
 *
 * Read only when the WHOLE segment opens on IF/WHEN and a top-level comma
 * (outside brackets and quotes) sits before the match - the same two-sided
 * check the comma form of a branch uses - so a bare "mark the box as checked"
 * elsewhere in a conditional paragraph is never credited with a condition it
 * does not carry.
 */
function governingCondition(segment, matchIndex) {
  if (!CONDITIONAL_LEAD.test(segment)) return null;

  const { commas, open } = topLevel(segment.slice(0, matchIndex));
  if (open || commas.length === 0) return null;

  const lead = CONDITIONAL_LEAD.exec(segment)[0];
  const at = commas[commas.length - 1];
  if (at <= lead.length) return null;

  return segment.slice(lead.length, at).trim();
}

function transitionObligations(segments) {
  const obligations = [];

  for (const segment of segments) {
    for (const rule of [TRANSITION_RULE, MARKED_AS_RULE, MARK_AS_RULE]) {
      for (const match of segment.matchAll(rule)) {
        const state = asStateName(match[1]);
        if (!state) continue;

        const condition = governingCondition(segment, match.index);

        obligations.push({
          type: 'transition',
          statement: `State transition to ${state} is exercised`,
          // A gated instruction keeps its governing condition in the basis,
          // verbatim and in full - the same guarantee a rebuilt criterion or a
          // rejoined guard carries - rather than only the imperative clause.
          source_basis: (condition ? segment : match[0]).trim(),
          expected_behavior: `The state becomes ${state}`,
          metadata: condition ? { state, condition } : { state },
        });
      }
    }
  }

  return obligations;
}

/**
 * Response and error code mappings.
 *
 * The code shapes are the same family statedValues() strips out when reading
 * limits - ADMI 002, KLR-01, HTTP 400, U253 - which is not a coincidence: a
 * token is either a name or a number, and the two modules have to agree on
 * which. Kept as one alternation here rather than four replaces there because
 * this module wants the match, not its removal.
 */
const RESPONSE_CODE =
  /\bHTTP\s?\d{3}\b|\b[A-Z]{4,6}[ -]?\d{2,4}\b|\b[A-Z]{1,6}-\d+\b|\b[A-Z]{1,3}\d{2,4}\b/g;

/** QATOOL's own handles are not response codes. */
const OWN_IDENTIFIER = /^(?:REQ|TC|DOC|OB)[ -]?\d+$/i;

/**
 * Wording that makes a code a response to something, rather than a mention.
 *
 * "status" is deliberately not on the list. On its own it names a column or a
 * screen far more often than it introduces a code: it was the only cue behind
 * "Code QRM-17521 is returned" (a ticket titled "Check Status") and "Code
 * QRDEMO001 is returned" (a sample row under a table header reading "Status").
 * A sentence that really states a status code says so another way as well -
 * "status code 68", "returns status U253" - and those cues are kept. Measured
 * across every requirement set this project holds, removing it lost exactly
 * those two and nothing else.
 */
const MAPPING_CUE =
  /\b(?:reject\w*|ditolak|tolak|error|kesalahan|kode|code|response|respon|return\w*|dikembalikan|mengembalikan|message|pesan|dengan|with|maps?\s+to)\b|->|→/i;

/** How much of the wording before a code is kept as what triggers it. */
const TRIGGER_WINDOW = 70;

/**
 * A preposition immediately before the token means it names a system, not a code.
 *
 * "to T24", "from T24", "via mscore", "ke T24" - you call a system and receive a
 * response from it. A code is never introduced this way.
 */
const NAMED_ENDPOINT = /\b(?:to|from|via|into|through|on|at|by|ke|dari|melalui|pada)\s+$/i;

function mappingObligations(segments, tracksIssues) {
  const obligations = [];

  for (const segment of segments) {
    if (!MAPPING_CUE.test(segment)) continue;

    // A ticket key in a tracker link has exactly the shape of a code, and the
    // link's title supplies the cue: "QRM-17521: Check Status". Only the link
    // form is skipped - not every tracker row - because a real code sentence can
    // end in a word TRACKER_STATUS reads as a workflow state ("... is closed").
    if (isTrackerLink(segment, tracksIssues)) continue;

    for (const match of segment.matchAll(RESPONSE_CODE)) {
      const code = match[0].trim();
      if (OWN_IDENTIFIER.test(code)) continue;

      // A core banking system called T24 has exactly the shape of a response
      // code, and the real PRD names it three times: "Check Status to T24",
      // "response from T24", "the Response from T24 via mscore". Each produced
      // "Code T24 is returned for: check status response from" - a truncated
      // sentence about a system, presented to QA as a code to test.
      //
      // What separates them is the preposition. A code is returned, carried or
      // equal to something; a system is what you call, or what a response comes
      // FROM. Three obligations on one requirement were this.
      if (NAMED_ENDPOINT.test(segment.slice(Math.max(0, match.index - 12), match.index))) {
        continue;
      }

      // Dropped back to a word boundary: a fixed-width window cuts mid-word and
      // puts "ksi Sistem: Instruksi ditolak" in front of the model, which reads
      // as a typo in our own output rather than a quote from the document.
      const trigger = segment
        .slice(Math.max(0, match.index - TRIGGER_WINDOW), match.index)
        .replace(/^\S*\s+/, '')
        .trim();

      obligations.push({
        type: 'mapping',
        statement: trigger
          ? `Code ${code} is returned for: ${short(trigger, 90)}`
          : `Code ${code} is returned`,
        source_basis: segment,
        expected_behavior: `The response carries ${code}`,
        metadata: { code },
      });
    }
  }

  return obligations;
}

/**
 * Mapping tables: a stated value and what the system must read it as.
 *
 * Distinct from mappingObligations above, which reads a code out of prose. A
 * specification also carries tables - a response field, the value it holds, and
 * the meaning that value has - and the meaning is the testable part. A run that
 * proves the field was read has not proved "01" was understood as a failure.
 *
 * Deliberately narrow, because a two-column table of anything would otherwise
 * become obligations. Three things must all be present in one segment:
 *
 *   an assignment    FIELD="value" or FIELD=value, which is what makes this a
 *                    stated value rather than a number in a sentence
 *   a relation       -> | => | maps to | means | berarti | indicates | :
 *   a meaning        words after the relation, which is the outcome tested
 *
 * The values are never interpreted. "00" is carried through as the document
 * wrote it, and the meaning beside it likewise, so nothing here decides what a
 * code signifies - it only records that the document said so.
 */
/** A quoted value may contain spaces - "Transaction Failed!" - an unquoted one may not. */
const VALUE_ASSIGNMENT = /([A-Za-z][\w.:$-]{1,40})\s*=\s*(?:"([^"]{1,60})"|([^\s,;]{1,40}))/g;

/**
 * An explicit relation only. A bare colon was tried and removed: field names in
 * these documents contain colons - Y.ISO.RESPONSE:1:1 - so it matched inside
 * the value being mapped and left nothing on the left-hand side.
 */
const MEANING_RELATION =
  /\s*(?:->|=>|→|\bmaps?\s+to\b|\bmeans\b|\bindicates\b|\bberarti\b|\bdiartikan\s+sebagai\b)\s*/i;

/** Long enough to be a meaning, short enough not to swallow a paragraph. */
const MAX_MEANING = 120;

/**
 * The same mapping written the other way round: meaning first, value in brackets.
 *
 * The detector above wants `value -> meaning`. Real specifications routinely
 * invert it, and the PRD this was measured on states BOTH of its core banking
 * response rules that way:
 *
 *   IF check status response from T24 is Success (Y.ISO.RESPONSE:1:1="00" and
 *   Y.MSG.RES:1:1="...") , update the DB status to SUCCESS and save the FT NUMBER
 *   IF FAILED (Y.ISO.RESPONSE:1:1="01") or NOT FOUND, then trigger retry ...
 *
 * Neither produced a mapping obligation, so the two response rules the whole
 * feature turns on were absent from the coverage denominator entirely. A test
 * case happened to cover them, which is worse than a gap: it looked fine and
 * nothing guaranteed the next run would do the same.
 *
 * The meaning is the word immediately before the bracket, and the requirement
 * is that the system reads the stated value AS that meaning. Nothing is
 * interpreted here - both halves are the document's own words.
 */
/**
 * The closing bracket is optional, because the PRD's success row does not have
 * one on the same line - the assignment list wraps and the `)` lands on the
 * next. Requiring it lost exactly the row that matters most:
 *
 *   IF check status response from T24 is Success (Y.ISO.RESPONSE:1:1="00" and
 *   Y.MSG.RES:1:1="..." ), update the DB status to SUCCESS ...
 *
 * Safe to open up, because the bracket was never the evidence: what makes this
 * a mapping is a FIELD="value" assignment inside it, which is checked below.
 */
const PARENTHESISED_VALUE =
  /\b(?:is|as|adalah|yaitu)?\s*([A-Z][\w /-]{1,40}?)\s*\(\s*([^()]{3,160}?)\s*(?:\)|$)/g;

function parentheticalMappings(segments) {
  const obligations = [];

  for (const segment of segments) {
    for (const [, rawMeaning, inside] of segment.matchAll(PARENTHESISED_VALUE)) {
      // The bracket must hold a stated value, which is what makes this a
      // mapping rather than an aside. A parenthesis of prose is skipped.
      const assignments = [...inside.matchAll(VALUE_ASSIGNMENT)];
      if (assignments.length === 0) continue;

      // The capture starts at the earliest capitalised word, which drags in the
      // clause that introduced the meaning: "T24 is Success", "IF FAILED". The
      // meaning is what follows the connective, so the connective goes.
      const meaning = short(
        String(rawMeaning)
          .replace(/^(?:IF|JIKA|APABILA|BILA|WHEN|KETIKA)\s+/i, '')
          .replace(/^.*?\b(?:is|are|adalah|yaitu)\s+/i, '')
          .trim(),
        60
      );
      if (meaning.length < 3) continue;

      const stated = assignments
        .map(([, field, quoted, bare]) => `${field}=${quoted ?? bare}`)
        .slice(0, 4)
        .join(' AND ');

      // A placeholder is not a value: "{{ada isi FT Number nya}}" says a field
      // is populated, not what it equals.
      if (/\{\{|\$\{|^<.*>$/.test(stated)) continue;

      obligations.push({
        type: 'mapping',
        statement: `Response ${short(stated, 90)} is treated as: ${meaning}`,
        source_basis: segment,
        expected_behavior: meaning,
        metadata: { stated, meaning },
      });
    }
  }

  return obligations;
}

/**
 * Qualifiers the source states in brackets.
 *
 * These decide whether a test passes for the right reason, and they were being
 * lost with nothing to notice. Measured on the real PRD, three of them:
 *
 *   Call Check Status to T24 via MW (mscore*)
 *   Use SETTLEMENT_QRMANAGER_DDMMYYYY.txt as file name format
 *                                            (Date using Transaction Date)
 *   ... clicks the Release action button (Settlement Type: HOLD)
 *
 * "Calls the core system" and "calls it through mscore" are different tests; so
 * are "named with the date" and "named with the Transaction Date". None of the
 * three was an obligation, so no coverage figure could ever say they had gone -
 * and across three identical runs, mscore was absent every time and Transaction
 * Date survived in one.
 *
 * Deliberately narrow, because a parenthesis is also how documents gloss things.
 * A bracket qualifies only when it says so: an explicit lead word, a stated
 * type, or a single technical token. "(transaction not completed)" and "(FT is
 * not recorded)" are asides and derive nothing, which is the correct answer -
 * they add no condition a tester could check separately.
 */
const QUALIFIER_LEAD = /\b(?:using|via|per|with|mode|type|format|berdasarkan|sesuai|melalui)\b/i;

/**
 * A starred component name, which is how these documents mark one: "(mscore*)"
 * carries a footnote elsewhere in the page.
 *
 * A BARE name in brackets is deliberately not accepted. "the Core Banking system
 * (T24)" is an apposition - the bracket renames the noun before it rather than
 * narrowing the behaviour - and treating it as a qualifier produced an
 * obligation demanding that prose from a background paragraph be tested.
 */
const STARRED_COMPONENT = /^[A-Za-z][\w.$-]{2,30}\*$/;

/**
 * The part of a qualifier a test case would actually repeat.
 *
 * "(Date using Transaction Date)" is matched against a case that says "using
 * Transaction Date" - so the whole bracket is the wrong needle, and the stated
 * term inside it is the right one. Capitalised terms are how a document names a
 * field, a mode or a component, so the longest one is the key; wording with no
 * capitalised term falls back to a tolerant match on its content words.
 */
function qualifierKey(inside) {
  const terms = String(inside).match(/\b[A-Z][\w.$-]*(?:\s+[A-Z][\w.$-]*)*\b/g) ?? [];
  const longest = terms
    .map((term) => term.trim())
    .filter((term) => term.length >= 3)
    .sort((left, right) => right.length - left.length)[0];

  if (longest) return longest;

  // A lowercase component name has no capitalised term to find, and falling
  // through to the tolerant matcher made it unmatchable: mentions() requires two
  // words before it will answer true, and "mscore*" is one. So the qualifier the
  // real PRD states about its integration path could not be covered by any test
  // case, however faithfully written. A lone token is matched on itself.
  const bare = String(inside).trim().replace(/\*$/, '');
  return /^[\w.$-]{3,40}$/.test(bare) ? bare : null;
}

const QUALIFIER_PARENTHETICAL = /\(\s*([^()\n]{3,80}?)\s*\)/g;

function qualifierObligations(segments) {
  const obligations = [];

  for (const segment of segments) {
    for (const match of segment.matchAll(QUALIFIER_PARENTHETICAL)) {
      const inside = match[1].trim();

      // A stated value in brackets is a mapping, and parentheticalMappings owns
      // it. Counting it here as well would charge one clause twice.
      if (VALUE_ASSIGNMENT.test(inside)) {
        VALUE_ASSIGNMENT.lastIndex = 0;
        continue;
      }
      VALUE_ASSIGNMENT.lastIndex = 0;

      if (/\{\{|\$\{/.test(inside)) continue;
      if (!QUALIFIER_LEAD.test(inside) && !STARRED_COMPONENT.test(inside)) continue;

      // What the qualifier narrows: the wording it trails.
      const action = short(
        segment
          .slice(0, match.index)
          .replace(/[\s:,-]+$/, '')
          .split(/(?<=[.;])\s+/)
          .pop() ?? '',
        80
      );
      if (action.length < 4) continue;

      obligations.push({
        type: 'qualifier',
        statement: `Qualifier - ${action} must be exercised with: ${inside}`,
        source_basis: segment,
        expected_behavior: `The stated qualifier ${inside} is used, not a generalisation of it`,
        metadata: { qualifier: inside, key: qualifierKey(inside), action },
      });
    }
  }

  return obligations;
}

function mappingTableObligations(segments) {
  const obligations = [];

  for (const segment of segments) {
    const relation = MEANING_RELATION.exec(segment);
    if (!relation) continue;

    const left = segment.slice(0, relation.index);
    const meaning = short(segment.slice(relation.index + relation[0].length), MAX_MEANING);

    // A relation with nothing after it is a heading, not a mapping.
    if (meaning.length < 3) continue;

    const assignments = [...left.matchAll(VALUE_ASSIGNMENT)];
    if (assignments.length === 0) continue;

    const stated = assignments
      .map(([, field, quoted, bare]) => `${field}=${quoted ?? bare}`)
      .slice(0, 4)
      .join(' AND ');

    obligations.push({
      type: 'mapping',
      statement: `Response ${short(stated, 90)} is treated as: ${meaning}`,
      source_basis: segment,
      expected_behavior: meaning,
      metadata: { stated, meaning },
    });
  }

  obligations.push(...mappingTableRows(segments));
  obligations.push(...parentheticalMappings(segments));

  return obligations;
}

/**
 * A mapping table read row by row, where the relation is the column heading.
 *
 * The detector above needs the relation in the row itself - "->", "means".
 * A table states it once, in the header, and its rows are only values and
 * meanings side by side. The Settlement PRD's core banking table reads, once
 * its cells are joined into one line:
 *
 *   Core Banking Response Values Transaction Meaning / Mapping
 *   Y.ISO.RESPONSE:1:1="00" AND Y.MSG.RES:1:1="..." Funds Transfer (FT) Success (...)
 *   Y.ISO.RESPONSE:1:1="01" AND Y.MSG.RES:1:1="Transaction Failed!" Transaction
 *   Not Found / Failed (FT is not recorded)
 *
 * and derived nothing at all, so "01 means the FT is not recorded" was in no
 * coverage figure. A row here is a run of FIELD="value" assignments (joined by
 * AND) and the words up to the next run are what the table says it means - both
 * halves the document's own. Only where the same requirement carries a header
 * naming a meaning or mapping column, so a value followed by prose elsewhere is
 * not read as a table; a placeholder is not a value, and a "meaning" that opens
 * on punctuation is the tail of a sentence, not a cell.
 */
const MAPPING_HEADER = /\b(?:meaning|mapping|arti|makna|pemetaan)\b/i;
const ROW_JOINER = /^\s*(?:and|dan|&)?\s*$/i;

function mappingTableRows(segments) {
  const assigns = (segment) => [...segment.matchAll(VALUE_ASSIGNMENT)];
  if (!segments.some((segment) => MAPPING_HEADER.test(segment) && assigns(segment).length === 0)) {
    return [];
  }

  const obligations = [];
  for (const segment of segments) {
    if (MEANING_RELATION.test(segment)) continue;

    // Runs of assignments with nothing but AND between them: one row's key.
    const rows = [];
    for (const match of assigns(segment)) {
      const last = rows.at(-1);
      const between = last ? segment.slice(last.end, match.index) : null;
      if (last && ROW_JOINER.test(between)) {
        last.pairs.push(match);
        last.end = match.index + match[0].length;
      } else {
        rows.push({ start: match.index, end: match.index + match[0].length, pairs: [match] });
      }
    }

    rows.forEach((row, index) => {
      const until = rows[index + 1]?.start ?? segment.length;
      // A cell holding only "...="00" AND" is half a key whose row continues on
      // the next line, not a row with the meaning "AND".
      const rest = segment.slice(row.end, until);
      if (ROW_JOINER.test(rest)) return;
      const meaning = short(rest.trim(), MAX_MEANING);
      if (meaning.length < 3 || !/^[\p{L}(]/u.test(meaning)) return;

      const stated = row.pairs
        .map(([, field, quoted, bare]) => `${field}=${quoted ?? bare}`)
        .slice(0, 4)
        .join(' AND ');
      if (/\{\{|\$\{|^<.*>$/.test(stated)) return;

      obligations.push({
        type: 'mapping',
        statement: `Response ${short(stated, 90)} is treated as: ${meaning}`,
        source_basis: segment.slice(row.start, until).trim(),
        expected_behavior: meaning,
        metadata: { stated, meaning },
      });
    });
  }

  return obligations;
}

/**
 * Guard conditions: when an action is permitted at all.
 *
 * Specifications put these in a Notes line, and a note is easy to read as
 * commentary. It is not: "retry is only performed when the response is FAILED
 * and the attempt has not reached 3 times" states two preconditions, and a
 * system that retries outside them is wrong in a way no happy-path test sees.
 *
 * conditionsFor() already reads enumerated conditions behind an explicit
 * lead-in. This reads the other shape - a restriction on an action - and is
 * held to the same standard: an explicit marker, or nothing. Ordinary prose
 * that happens to contain "when" produces no obligation, which is the correct
 * answer rather than a gap.
 */
const GUARD_MARKER =
  /\b(?:only\s+(?:performed|allowed|applies|applicable|done|executed|triggered|valid)?\s*(?:when|if|after|while)|only\s+(?:when|if)|must\s+only|may\s+only|can\s+only|cannot\s+(?:when|if|be)|not\s+allowed\s+(?:when|if|after)|hanya\s+(?:dilakukan|boleh|berlaku|dapat)?\s*(?:jika|ketika|apabila|bila)|tidak\s+boleh\s+(?:jika|ketika|apabila))\b/i;

/**
 * Rejoins a guard sentence that a PDF line-wrapped.
 *
 * Segments break on newlines, which is right for bullets and table rows and
 * wrong for a sentence the layout happened to split. The consequence was
 * measured on the real PRD, on the one obligation that matters most here:
 *
 *   Notes: Retry for Settlement Release is only performed when the status
 *   check response is                                    <- segment ends
 *   FAILED (transaction not completed) and the retry attempt has not reached 3 times
 *
 * The guard derived from the first line alone, so the obligation read "... only
 * performed when the status check response is" - it named the restriction and
 * then omitted what the restriction actually was. Both halves of the condition
 * QA has to prove, FAILED and attempts-below-three, were simply gone.
 *
 * The basis is taken from the full requirement text rather than by joining
 * segments, so it stays a contiguous verbatim slice - newline included - and
 * every guarantee source_basis carries elsewhere still holds.
 */
const MAX_GUARD_BASIS = 400;

function wholeGuardSentence(segment, text) {
  // Already a whole sentence: nothing was wrapped, so nothing is missing.
  if (typeof text !== 'string' || /[.!?]$/.test(segment)) return segment;

  const at = text.indexOf(segment);
  if (at === -1) return segment;

  const after = text.slice(at + segment.length);
  const wrapped = /^\n([^\n]{1,200})/.exec(after);
  if (!wrapped) return segment;

  // Exactly one line, and no further. The PRD's guard has no full stop at all,
  // so searching forward for a terminator ran on into the next paragraph and
  // pulled "Below is the Request OFS Message via mscore" into the guard - an
  // obligation that then claimed to be about two unrelated things. One line is
  // what a wrap costs; more than that is a different statement.
  const continuation = wrapped[1].trimEnd();
  const stop = /[.!?]/.exec(continuation);
  const joined = `${segment}\n${stop ? continuation.slice(0, stop.index + 1) : continuation}`;

  return joined.length > MAX_GUARD_BASIS ? segment : joined;
}

/**
 * A conjunction joining two conditions, not two words inside one.
 *
 * Bracketed text is skipped, because "FAILED (transaction not completed) and
 * the retry attempt has not reached 3 times" joins two conditions while
 * "(transaction not completed)" contains none.
 */
const CONJUNCTION = /\s+(?:and|dan|serta)\s+/gi;

/** A conjunct shorter than this is a word, not a condition. */
const MIN_CONJUNCT = 8;

/**
 * Splits a restriction into the conditions it actually states.
 *
 * Presentation only: metadata.guard keeps the whole restriction and matching is
 * untouched. What changes is the line Gemini #2 reads, and it changes because
 * the compound guard was the obligation it most reliably half-covered. Written
 * as one 140-character clause, "only performed when the status check response
 * is FAILED (transaction not completed) and the retry attempt has not reached 3
 * times" reads as one condition with a trailing detail, and six runs out of
 * seven kept the FAILED half and dropped the attempt-count half. Numbering the
 * parts states what the sentence already said: there are two of them, and both
 * have to hold.
 *
 * Nothing is added - the conjuncts are the source's own words, in order.
 */
function conjuncts(restriction) {
  const masked = restriction.replace(/\([^()]*\)/g, (match) => '\u0000'.repeat(match.length));

  const cuts = [];
  for (const match of masked.matchAll(CONJUNCTION)) {
    cuts.push([match.index, match.index + match[0].length]);
  }
  if (cuts.length === 0) return [];

  const parts = [];
  let from = 0;
  for (const [start, end] of cuts) {
    parts.push(restriction.slice(from, start).trim());
    from = end;
  }
  parts.push(restriction.slice(from).trim());

  return parts.every((part) => part.length >= MIN_CONJUNCT) ? parts : [];
}

/** The source's own framing word for a note, which is not part of the behaviour. */
const NOTE_LEAD = /^(?:notes?|catatan|nb)\s*[:.-]\s*/i;

function guardObligations(segments, text) {
  const obligations = [];

  for (const segment of segments) {
    const marker = GUARD_MARKER.exec(segment);
    if (!marker) continue;

    const basis = wholeGuardSentence(segment, text);

    // Everything from the marker on is the restriction; what precedes it names
    // the action being restricted.
    const action = short(
      basis
        .slice(0, marker.index)
        .replace(NOTE_LEAD, '')
        .replace(/[\s:,-]+$/, ''),
      70
    );
    const restriction = short(basis.slice(marker.index).replace(/\s+/g, ' '), 140);
    if (restriction.length < 8) continue;

    // The marker introduces the restriction; the conditions are what follows
    // it, and they are what gets numbered.
    const head = restriction.slice(0, marker[0].length).trim();
    const parts = conjuncts(restriction.slice(marker[0].length).trim());
    const spelled =
      parts.length > 1
        ? `${head} ALL of these hold: ${parts.map((part, index) => `(${index + 1}) ${part}`).join('; ')}`
        : restriction;

    obligations.push({
      type: 'condition',
      statement: action ? `Guard - ${action} ${spelled}` : `Guard condition: ${spelled}`,
      source_basis: basis,
      expected_behavior: `The action is refused when the stated condition does not hold`,
      metadata: { guard: restriction, conditions: parts },
    });
  }

  return obligations;
}

/**
 * Retry behaviour, and separately the limit on it.
 *
 * Two obligations on purpose. A run that proves the system retries has not
 * proved it stops at three, and those are the two different ways a retry rule
 * goes wrong in production.
 */
/**
 * Bare `ulang` belongs here alongside its inflections. Indonesian specifications
 * say "pengiriman ulang", "kirim ulang", "proses ulang" - the retry is the
 * separate word, and a vocabulary holding only diulang/mengulang/pengulangan
 * misses the form the documents actually use.
 */
const RETRY_CUE =
  /\b(?:retry|retries|retried|re-?try|re-?tries|attempts?|percobaan|ulang|diulang|mengulang|pengulangan|coba\s+lagi)\b/i;

/**
 * What makes a number a cap rather than a position in a sequence.
 *
 * The count used to be read with the cap word optional, so any "<n> retries"
 * became a limit. On a real PRD that turned "after Release Settlement 1 and/or
 * 2 retries attempt" into "retry limit of 2", sitting beside the genuine limit
 * of 3 - two contradictory limits derived from one requirement, and the wrong
 * one tells QA to test that the system stops after two.
 *
 * An ordinal says WHICH attempt; a cap says HOW MANY are allowed. Only the
 * second is a limit, so a cap cue is now required and the number it governs is
 * the one taken.
 */
const RETRY_CAP_CUE =
  /\b(?:max(?:imum)?|maksimal|maksimum|up\s+to|paling\s+banyak|no\s+more\s+than|not\s+more\s+than|has\s+not\s+reached|have\s+not\s+reached|belum\s+mencapai|tidak\s+lebih\s+dari|limited\s+to|limit\s+of|batas(?:an)?)\b/i;

/** How far after the cap word its number may sit: one clause, not one paragraph. */
const RETRY_CAP_WINDOW = 70;

/**
 * The cap's own number, or null when the segment only counts attempts.
 *
 * Read forward from the cap word rather than by a fixed shape, because the
 * document writes it both ways: "maximum 3 retries" and "the maximum number of
 * settlement release retries is 3".
 */
function retryLimitIn(segment) {
  const cap = RETRY_CAP_CUE.exec(segment);
  if (!cap) return null;

  const window = segment.slice(cap.index, cap.index + RETRY_CAP_WINDOW);
  const number = /\b(\d{1,3})\b/.exec(window);

  return number ? number[1] : null;
}

/**
 * A cue word alone is a heading, not a behaviour.
 *
 * The real PRD has a section title that the parser split across two lines,
 * leaving "Retry" as a segment of its own. It matched the retry vocabulary and
 * became the obligation "Retry behaviour is exercised", with the single word
 * "Retry" as its evidence - a coverage gap derived from a heading.
 *
 * Three content words is the floor: enough to reject a title, low enough that
 * "the system retries up to 3 times" is untouched.
 */
const MIN_BEHAVIOUR_WORDS = 3;

function retryObligations(segments) {
  const obligations = [];

  for (const segment of segments) {
    if (contentWords(segment).size < MIN_BEHAVIOUR_WORDS) continue;

    if (!RETRY_CUE.test(segment)) continue;

    obligations.push({
      type: 'retry',
      statement: 'Retry behaviour is exercised',
      source_basis: segment,
      expected_behavior: 'The operation is attempted again after failure',
      metadata: { limit: null },
    });

    const limit = retryLimitIn(segment);
    if (limit) {
      obligations.push({
        type: 'retry',
        statement: `Retry limit of ${limit} is enforced`,
        source_basis: segment,
        expected_behavior: `No more than ${limit} attempts are made`,
        metadata: { limit },
      });
    }
  }

  return obligations;
}

/** Scheduler and timing conditions: a duration, next to a word that schedules it. */
const SCHEDULE_CUE =
  /\b(?:wait\w*|delay\w*|after|every|setiap|tunggu|menunggu|selang|within|dalam\s+waktu|time\s?out|timeout|batas\s+waktu|schedul\w*|dijadwalkan|berkala|interval|expire\w*|kadaluarsa|kedaluwarsa)\b/i;

const DURATION =
  /\b(\d{1,4})\s*(seconds?|secs?|detik|minutes?|mins?|menit|hours?|jam|days?|hari|weeks?|minggu)\b/gi;

/** Every spelling of a unit maps to one family, so matching is language-blind. */
const UNIT_FAMILIES = [
  { family: 'second', pattern: /^(?:seconds?|secs?|detik)$/i },
  { family: 'minute', pattern: /^(?:minutes?|mins?|menit)$/i },
  { family: 'hour', pattern: /^(?:hours?|jam)$/i },
  { family: 'day', pattern: /^(?:days?|hari)$/i },
  { family: 'week', pattern: /^(?:weeks?|minggu)$/i },
];

const UNIT_MENTIONS = {
  second: /\b(?:seconds?|secs?|detik)\b/i,
  minute: /\b(?:minutes?|mins?|menit)\b/i,
  hour: /\b(?:hours?|jam)\b/i,
  day: /\b(?:days?|hari)\b/i,
  week: /\b(?:weeks?|minggu)\b/i,
};

function familyOf(unit) {
  return UNIT_FAMILIES.find((entry) => entry.pattern.test(unit))?.family ?? null;
}

function scheduleObligations(segments) {
  const obligations = [];

  for (const segment of segments) {
    if (!SCHEDULE_CUE.test(segment)) continue;

    for (const match of segment.matchAll(DURATION)) {
      const family = familyOf(match[2]);
      if (!family) continue;

      // The clause, not just the number and the unit.
      //
      // "Timing condition of 1 hour is exercised" is what this used to say, and
      // it is nearly content-free: the source said "Enforce a strict 1 hour
      // delay FROM THE ORIGINAL TIMEOUT TIMESTAMP before allowing the scheduler
      // to process the record", and every word that decides whether a test
      // passes for the right reason was dropped before the generator saw it. A
      // case measuring any hour-long wait satisfies the old statement; only one
      // measuring from the original timeout satisfies the requirement.
      //
      // The rationale in brackets goes - "(giving the Core Banking system a
      // cool-down period)" is why, not what - and metadata is untouched, so
      // coverage arithmetic is unchanged.
      const clause = short(
        segment
          .replace(/\s*\([^()]*\)\s*/g, ' ')
          .replace(/\s+/g, ' ')
          .trim(),
        140
      );

      obligations.push({
        type: 'schedule',
        statement:
          clause.length > 12
            ? `Timing condition of ${match[1]} ${match[2]} is exercised, as stated: ${clause}`
            : `Timing condition of ${match[1]} ${match[2]} is exercised`,
        source_basis: segment,
        expected_behavior: `The behaviour occurs after ${match[1]} ${match[2]}`,
        metadata: { amount: match[1], unit: family },
      });
    }
  }

  return obligations;
}

/**
 * UI actions, where the wording names both the action and the thing acted on.
 *
 * Both halves are required. "Select" on its own is how specifications talk
 * about database reads and menu choices alike, and "field" appears in every
 * other sentence of a data mapping - it is the pair that makes it an interface
 * behaviour somebody has to click through.
 *
 * "Submit" is deliberately absent from the verbs. It is the most common word in
 * a payments specification - a transfer is submitted, an instruction is
 * submitted, a batch is submitted - and almost none of those are somebody
 * pressing a button. It matched the sentence introducing a list of conditions
 * in the fund-transfer fixture and turned a heading into a UI obligation.
 */
const UI_VERB =
  /\b(?:click\w*|klik|select\w*|pilih|memilih|unselect\w*|deselect\w*|uncheck\w*|centang|tick\w*|tap\w*|press\w*|tekan|upload\w*|unggah|drag\w*|scroll\w*|navigat\w*|buka|tutup)\b/i;

const UI_NOUN =
  /\b(?:button|tombol|checkbox|check\s?box|radio|dropdown|drop-?down|menu|icon|ikon|link|tab|screen|layar|halaman|page|form|formulir|field|kolom|list|daftar|row|baris|pop-?up|modal|dialog|toggle|slider|calendar|kalender)\b/i;

/**
 * Whether the requirement states its outcomes on their own THEN lines.
 *
 * When it does, a standalone WHEN line is the trigger and nothing else: the
 * behaviours are below it. "WHEN moves the cursor over or clicks Export button"
 * is not something a tester can pass or fail - what can be checked is that the
 * button stays enabled and that clicking it downloads the file, and the document
 * says both on the next two lines, where they derive their own obligations.
 *
 * Two of the six gaps on the real PRD were exactly this, and a third was covered
 * only because a test case happened to quote the trigger back.
 */
function statesOutcomesSeparately(segments) {
  return segments.some((segment) => GWT_THEN.test(segment));
}

/** A line that only sets the scene: a GIVEN or WHEN with no consequent on it. */
const GWT_TRIGGER = /^(?:when|given|ketika|saat|apabila|diberikan)\b/i;

function uiObligations(segments) {
  const separate = statesOutcomesSeparately(segments);

  return (
    segments
      .filter((segment) => UI_VERB.test(segment) && UI_NOUN.test(segment))
      // An enumerated condition list is already several obligations of its own;
      // reading the sentence that introduces it as a UI action as well counts the
      // same clause twice and puts a heading in the coverage report.
      .filter((segment) => !ENUMERATION_LEAD_IN.test(segment))
      // A trigger, when the outcomes are stated separately. The INLINE_THEN test
      // is the safety valve: "WHEN the user clicks Export then the file
      // downloads" carries its own outcome and is kept, as is any document that
      // never writes a standalone THEN at all.
      .filter((segment) => !(separate && GWT_TRIGGER.test(segment) && !INLINE_THEN.test(segment)))
      .map((segment) => ({
        type: 'ui_action',
        statement: `UI behaviour: ${short(segment, 120)}`,
        source_basis: segment,
        expected_behavior: null,
        metadata: { clause: segment },
      }))
  );
}

/**
 * Side effects and outputs: something is saved, recorded, logged or sent.
 *
 * A named object is required, not just the verb. "The result is recorded" is
 * untestable as written and becomes no obligation; "save FT Number" names the
 * artifact a tester can go and look at, and that name is also what makes the
 * obligation matchable against a test case later.
 */
const SIDE_EFFECT_VERB =
  /\b(?:save[sd]?|saving|simpan|disimpan|menyimpan|store[sd]?|stored|record(?:s|ed)?|dicatat|mencatat|tercatat|log(?:s|ged)?|dilog|insert(?:s|ed)?|write[s]?|written|ditulis|generate[sd]?|dibuat|create[sd]?|send[s]?|sent|dikirim|mengirim|notif\w*|publish\w*|trigger\w*|memicu)\b/i;

/**
 * Shapes that name a concrete artifact: a SHOUTED name, possibly two words
 * (FT NUMBER, DB SUCCESS), camelCase, snake_case, or something quoted. A
 * different question from server/semantic/heuristics.js's technicalTokens,
 * which asks whether a token looks invented rather than whether it names
 * something.
 */
const NAMED_OBJECT =
  /\b[A-Z]{2,}(?:\s+[A-Z][A-Za-z0-9]+)?\b|\b[a-z]+(?:[A-Z][a-z0-9]*)+\b|\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b|"[^"]{3,60}"/g;

/** SHOUTED words that are grammar, not artifacts. */
const NOT_AN_OBJECT = new Set([
  'IF',
  'ELSE',
  'THEN',
  'AND',
  'OR',
  'NOT',
  'TO',
  'THE',
  'DAN',
  'ATAU',
  'JIKA',
  'MAKA',
  'TIDAK',
  'HARUS',
  'WAJIB',
  'AKAN',
]);

/**
 * A lone SHOUTED acronym does not name an artifact.
 *
 * Measured on the synthetic fixtures, which is where this rule came from: the
 * bare-acronym form produced "side effect on API", "on HTTP", "on IDR" and "on
 * KLR" - a protocol, a format, a currency and the front half of a response code
 * that was already a mapping obligation. None is a thing a tester can go and
 * look at, and all four inflate the denominator of a coverage percentage.
 *
 * What survives is what carries a real name: two shouted words (FT NUMBER, DB
 * SUCCESS), camelCase, snake_case, or a quoted string. Blacklisting acronyms
 * one at a time would have worked for these four and failed on the fifth.
 */
function namesAnArtifact(object) {
  const hasLowercase = /[a-z]/.test(object);
  const isMultiWord = /\s/.test(object);

  return hasLowercase || isMultiWord;
}

/**
 * Template placeholders, which name nothing.
 *
 * A specification shows the shape of a payload with the value left blank:
 * Y.MSG.RES:1:1="{{ada isi FT Number nya}}". That is an instruction to the
 * reader, not an artifact the system writes, and it was becoming "Side effect
 * on {{ada isi FT Number nya}} is observable" - an obligation no test can ever
 * cover, sitting in the coverage denominator.
 *
 * Masked rather than removed, so every index still lines up with the original
 * and source_basis stays verbatim.
 */
const PLACEHOLDER = /\{\{[^}]{0,80}\}\}|\$\{[^}]{0,80}\}|<[^<>\n]{1,60}>/g;

function maskPlaceholders(segment) {
  return segment.replace(PLACEHOLDER, (match) => ' '.repeat(match.length));
}

function sideEffectObligations(segments) {
  const obligations = [];

  for (const segment of segments) {
    if (!SIDE_EFFECT_VERB.test(segment)) continue;

    const seen = new Set();
    const searchable = maskPlaceholders(segment);

    for (const match of searchable.matchAll(NAMED_OBJECT)) {
      const object = match[0].replace(/^"|"$/g, '').trim();

      // Part of a longer token, not a token: "KLR" sits inside "KLR-01", which
      // is a response code the mapping detector has already claimed.
      if (/[-\d]/.test(searchable[match.index + match[0].length] ?? '')) continue;

      // The first word is checked as well as the whole match: the two-word
      // shape happily reads "IF Check Status" as an artifact called "IF Check",
      // and a grammar word cannot begin the name of anything.
      const lead = object.split(/\s+/)[0].toUpperCase();
      if (object.length < 3 || NOT_AN_OBJECT.has(object.toUpperCase())) continue;
      if (NOT_AN_OBJECT.has(lead) || !namesAnArtifact(object)) continue;
      if (OWN_IDENTIFIER.test(object) || seen.has(object)) continue;
      seen.add(object);

      // The sentence, beside the object.
      //
      // "Side effect on QR Manager is observable" is what this used to say for
      // "Save the final .txt file into a designated directory path on QR
      // Manager server so its ready to be fetched by Reconciliation team." The
      // object is the only part that survived, and it is the least informative
      // part: the directory, the server and who collects the file - everything
      // that makes the obligation checkable - were gone before the generator
      // read it. An obligation the model cannot act on is a gap the model will
      // be blamed for.
      //
      // metadata.object is unchanged, so matching behaves exactly as before.
      const stated = short(segment.replace(/\s+/g, ' ').trim(), 140);

      obligations.push({
        type: 'side_effect',
        statement: `Side effect on ${object} is observable, as stated: ${stated}`,
        source_basis: segment,
        expected_behavior: `${object} is written, recorded or sent as stated`,
        metadata: { object },
      });
    }
  }

  return obligations;
}

// --- Derivation ---------------------------------------------------------------

/** Run in this order; the result is then sorted by where it occurs in the text. */
const DETECTORS = [
  ({ text, segments }) => boundObligations(text, segments),
  ({ segments }) => rejectionObligations(segments),
  ({ description }) => conditionObligations(description),
  // Given the whole text as well: a guard sentence that the PDF line-wrapped
  // has to be rejoined, and only the original text can do that verbatim.
  ({ segments, text }) => guardObligations(segments, text),
  // Given the whole text as well: a conditional the PDF line-wrapped is read
  // back whole, and only the original text can supply it verbatim.
  ({ segments, text, tracksIssues }) => branchObligations(segments, text, tracksIssues),
  ({ segments, text, tracksIssues }) => criteriaBlockObligations(segments, text, tracksIssues),
  ({ segments }) => transitionObligations(segments),
  ({ segments, tracksIssues }) => mappingObligations(segments, tracksIssues),
  ({ segments }) => mappingTableObligations(segments),
  ({ segments }) => qualifierObligations(segments),
  ({ segments }) => retryObligations(segments),
  ({ segments }) => scheduleObligations(segments),
  ({ segments }) => uiObligations(segments),
  ({ segments }) => sideEffectObligations(segments),
];

/**
 * The two types that restate a whole sentence rather than name one thing in it.
 *
 * Both are catch-alls by design - a bullet under a THEN lead-in, a line with a
 * UI verb and a UI noun - so where a specific detector has read the SAME line,
 * its reading is the better one and this one is a second charge for the same
 * clause. Measured on the real PRD: the Select All note
 *
 *   "Notes: Select All only applies to transactions on the current active page
 *    (up to 10 rows per page) and will not select items on other pages"
 *
 * yielded three obligations - a bound on 10, a qualifier on the page size, and
 * a ui_action quoting the whole sentence. The first two were covered by one
 * test case and the third was reported as a gap, which told a reviewer to write
 * a test for something already tested.
 */
const COARSE_TYPES = new Set(['criterion', 'ui_action']);

/**
 * How specific a reading of one line is; lower wins.
 *
 * Three levels, because two coarse types can land on the same line as well. A
 * ui_action at least names the control it is about, while a criterion is the
 * catch-all for any bullet under a THEN - so between those two the ui_action is
 * the better reading, and against any named detector both lose.
 */
const specificity = (type) => (COARSE_TYPES.has(type) ? (type === 'ui_action' ? 1 : 2) : 0);

/** Two obligations saying the same thing about the same requirement are one. */
function dedupeKey(obligation) {
  return `${obligation.type}::${obligation.statement.toLowerCase().replace(/\s+/g, ' ')}`;
}

/**
 * Removes obligations a more specific one already covers.
 *
 * The detectors run independently and read overlapping wording, so one clause
 * can arrive as two obligations that a tester would satisfy with one action.
 * Left alone they inflate the denominator, and a coverage percentage with a
 * padded denominator is as misleading as the coarse figure this layer replaced.
 *
 * Two overlaps are worth reconciling, both where one obligation is strictly
 * more specific than the other:
 *
 *   "wait 1 hour" also yields the bound 1, and "up to 3 times" the bound 3.
 *   The schedule and retry obligations say what the number is for and demand
 *   the unit or the retry vocabulary as evidence; the bare bound does not.
 *
 *   "updated to SUCCESS" is a state transition, and SUCCESS also looks like a
 *   named artifact to the side-effect detector. Moving to a state and writing
 *   something down are the same event here, tested once.
 *
 * Nothing is reconciled away silently in the other direction: the checklist
 * still hands the generator every bound, and checkUntestedBounds still reports
 * every stated limit no case mentions, so a dropped bound obligation is not a
 * dropped check.
 */
function reconcile(candidates) {
  const explained = new Set(
    candidates
      .filter((candidate) => candidate.type === 'schedule' || candidate.type === 'retry')
      .map((candidate) => String(candidate.metadata.amount ?? candidate.metadata.limit ?? ''))
      .filter(Boolean)
  );

  const states = new Set(
    candidates
      .filter((candidate) => candidate.type === 'transition')
      .map((candidate) => candidate.metadata.state.toUpperCase())
  );

  // A criterion is the catch-all for a bullet under a THEN lead-in, so where a
  // specific detector already read the same line, that reading is the better
  // one: it names the control, the qualifier or the artifact instead of quoting
  // the whole sentence. Measured: "Display a Select All checkbox on the page
  // near the transaction list table" derived both a ui_action and a criterion,
  // and the file-name bullet derived both a qualifier and a criterion.
  const bestReading = new Map();
  for (const candidate of candidates) {
    const rank = specificity(candidate.type);
    const seen = bestReading.get(candidate.source_basis);
    if (seen === undefined || rank < seen) bestReading.set(candidate.source_basis, rank);
  }

  return candidates.filter((candidate) => {
    if (candidate.type === 'bound' && explained.has(candidate.metadata.value)) return false;
    if (candidate.type === 'side_effect' && states.has(candidate.metadata.object.toUpperCase())) {
      return false;
    }
    if (
      COARSE_TYPES.has(candidate.type) &&
      specificity(candidate.type) > bestReading.get(candidate.source_basis)
    ) {
      return false;
    }
    return true;
  });
}

/**
 * Derives the coverage obligations of one project's requirements.
 *
 * Ephemeral by construction: nothing here is written anywhere, the result is
 * held for the length of one request, and the obligation ids are minted fresh
 * each time. They are a way to talk about the same clause twice in one
 * response, not identifiers anything may store or cite later.
 *
 * @param {object[]} requirements  canonical requirements, already schema-valid
 * @param {object} [options]
 * @param {(report: {requirement_id: string, dropped: number}) => void} [options.onTruncate]
 *   called when the per-requirement ceiling drops obligations. Optional so every
 *   existing caller is unchanged, and supplied by generation so the loss is
 *   reported rather than silent.
 * @returns {object[]} obligations, OB-001 upwards, in requirement order
 */
export function deriveCoverageObligations(requirements, { onTruncate } = {}) {
  const derived = [];
  let sequence = 0;

  // Read once for the whole document. Requirements are split out of shared
  // tables, so one whose own text never says "Jira" can still carry a link
  // from the column it shares with one that does - REQ-002 is a second row of
  // REQ-001's table and only REQ-001 kept the header.
  const tracksIssues = (requirements ?? []).some((requirement) =>
    TRACKER_NAMED.test(requirement.description ?? '')
  );

  for (const requirement of requirements ?? []) {
    const description = requirement.description ?? '';
    // The description only. A title is the one part of a requirement the
    // structuring model writes rather than rebuilds from source, so reading
    // obligations out of it lets that model define what coverage is measured
    // against - and its phrasing changes between runs over one document, which
    // made the obligation universe move with it. Whatever a title says about
    // behaviour is stated in the blocks underneath it anyway.
    const text = description;
    const segments = withoutTrackerFurniture(segmentsOf(text), tracksIssues);
    const context = { text, description, segments, tracksIssues };

    const candidates = [];

    DETECTORS.forEach((detect, order) => {
      for (const obligation of detect(context)) {
        candidates.push({ ...obligation, at: text.indexOf(obligation.source_basis), order });
      }
    });

    // Text order, so the obligations of a requirement read in the order the
    // requirement states them. Detector order breaks ties, which keeps the
    // output stable rather than dependent on where a slice happened to land.
    candidates.sort((left, right) => left.at - right.at || left.order - right.order);

    const seen = new Set();
    let dropped = 0;

    for (const candidate of reconcile(candidates)) {
      const key = dedupeKey(candidate);
      if (seen.has(key)) continue;
      seen.add(key);

      // Truncation drops from the end, so the ceiling silently excuses whatever
      // a requirement states last - and how many obligations one requirement
      // carries depends on how many blocks the grouping merged into it. Counted
      // and handed back, so a coverage figure can never be short by a number
      // nobody was told about.
      if (seen.size > MAX_OBLIGATIONS_PER_REQUIREMENT) {
        dropped += 1;
        continue;
      }

      sequence += 1;
      const { at, order, ...obligation } = candidate;
      const parsed = obligationSchema.safeParse({
        requirement_id: requirement.requirement_id,
        obligation_id: formatSequentialId('OB', sequence),
        ...obligation,
      });

      // Our own output failing our own shape is a bug in a detector above.
      // Dropping it keeps a malformed line out of the prompt and out of the
      // coverage arithmetic; a test asserts this never fires across fixtures.
      if (parsed.success) derived.push(parsed.data);
      else sequence -= 1;
    }

    if (dropped > 0) onTruncate?.({ requirement_id: requirement.requirement_id, dropped });
  }

  return derived;
}

// --- Matching -----------------------------------------------------------------

/**
 * Everything about a test case that evidence can be read from, computed once.
 */
function prepare(testCase) {
  const text = `${testCase.test_case ?? ''} ${testCase.expected_result ?? ''}`;

  return {
    case_id: testCase.case_id,
    case_type: testCase.case_type,
    edge_polarity: testCase.edge_polarity ?? null,
    text,
    words: contentWords(text),
    values: new Set(statedValues(text).keys()),
    squashed: text.toLowerCase().replace(/[^\p{L}\p{N}]/gu, ''),
    sentences: [
      ...sentencesOf(testCase.test_case, true),
      ...sentencesOf(testCase.expected_result, false),
    ],
    clauses: [...clausesOf(testCase.test_case), ...clausesOf(testCase.expected_result)],
  };
}

const squash = (text) =>
  String(text ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, '');

/**
 * Whether a test case names one FIELD="value" pair the source states.
 *
 * Glued first, which is how these are usually written: squash removes the
 * punctuation, so `Y.ISO.RESPONSE:1:1="00"` and `Y.ISO.RESPONSE:1:1 = 00` are
 * the same string by the time they are compared.
 *
 * Then the halves separately, because a prose field name is routinely split by
 * the sentence around it - a row reading `status=ACTIVE` is tested by a case
 * saying "the account status is ACTIVE", and demanding the glued form would
 * report that uncovered. The value is matched on word boundaries rather than as
 * a substring: "00" occurs inside "1000", and a mapping is told apart from its
 * neighbour by exactly that value.
 */
function namesPair(pair, candidate) {
  const at = pair.indexOf('=');
  if (at === -1) return candidate.squashed.includes(squash(pair));

  if (candidate.squashed.includes(squash(pair))) return true;

  const field = pair.slice(0, at);
  const value = pair.slice(at + 1);
  if (!field || !value || !candidate.squashed.includes(squash(field))) return false;

  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'iu').test(candidate.text);
}

/**
 * Whether a test case says what a mapped value MEANS.
 *
 * The meanings a mapping table assigns come in two sizes and neither reader
 * handles both. "Success" and "FAILED" are single words, which mentions()
 * refuses outright - it needs two to avoid being satisfied by an incidental
 * one - so those are matched as the literal status names they are. "Funds
 * Transfer (FT) Success (Transaction successfully processed in core)" is a
 * phrase a test case will rephrase, so that gets the same tolerant reading
 * every other prose obligation gets.
 */
function statesMeaning(meaning, candidate) {
  const text = String(meaning ?? '').trim();
  if (text.length < 3) return false;

  return (
    candidate.squashed.includes(squash(text)) ||
    mentions(candidate.words, text) ||
    quotes(candidate.text, text)
  );
}

// --- Conditional evidence -----------------------------------------------------

/**
 * Branches, guards and schedules each say what happens UNDER something, and
 * reading them as a bag of words credited cases that never stated the
 * something. Measured over 40 saved runs of one PRD:
 *
 *   branch    "perform Check Status again" has three content words and two
 *             sufficed, so a case marking the transaction FAILED that "does not
 *             perform further retries" was credited with the re-check after a
 *             timed-out retry. The condition was never read at all.
 *   guard     "has not reached 3 times" was satisfied by "has reached 3 times":
 *             the "not" was borrowed from "(transaction not completed)", or not
 *             needed at all, five words of seven being enough. And no case ever
 *             had to say whether the retry happens.
 *   schedule  "1" from anywhere - Y.ISO.RESPONSE:1:1 supplies one - and "hour"
 *             from anywhere, and never the point the hour is measured from.
 *
 * So these three are read statement by statement: which words share a clause,
 * whether that clause is negated, which values it states. Nothing here is a
 * similarity score. Each rule asks for something the source sentence itself
 * states - its numbers, the state its condition names, its negation, its
 * reference point - and asks for it in the same place in the case.
 */

/** A case's words, lowercased, with "times out" / "timed out" / "time-out" read as one word. */
function wordsOf(text) {
  return (
    String(text ?? '')
      .toLowerCase()
      .replace(/\btim(?:e|es|ed|ing)[\s-]+out\b(?!\s+of\b)/g, 'timeout')
      .match(/[\p{L}\p{N}]+(?:'\p{L}+)?/gu) ?? []
  );
}

const ORDINAL_WORDS = {
  first: '1',
  second: '2',
  third: '3',
  fourth: '4',
  fifth: '5',
  pertama: '1',
  kedua: '2',
  ketiga: '3',
};

/**
 * One form per word, so "retries", "retried" and "retry" are one word, and
 * "1st", "first" and "1" are one number. Crude on purpose and applied to both
 * sides: it decides only which words are the same word, never whether a case
 * is close enough.
 */
function stem(word) {
  if (/^\d+(?:st|nd|rd|th)$/.test(word)) return word.replace(/\D+$/, '');
  if (ORDINAL_WORDS[word]) return ORDINAL_WORDS[word];

  let w = word;
  if (w.length > 4 && /ie[sd]$/.test(w)) w = `${w.slice(0, -3)}y`;
  else if (/(?:ch|sh|x|ss|zz)es$/.test(w)) w = w.slice(0, -2);
  else if (w.length > 5 && w.endsWith('ing')) w = w.slice(0, -3);
  else if (w.length > 4 && w.endsWith('ed')) w = w.slice(0, -2);
  else if (w.length > 3 && /[^su]s$/.test(w)) w = w.slice(0, -1);
  if (w.length > 3 && w.endsWith('e')) w = w.slice(0, -1);
  return w;
}

/** "1 second" is a duration, not the second of anything. */
const stemmed = (words) =>
  words.map((word, at) =>
    word === 'second' && /^\d/.test(words[at - 1] ?? '') ? word : stem(word)
  );

const NEGATOR =
  /^(?:not|no|never|without|cannot|nor|neither|non|except|tidak|bukan|belum|tanpa|selain)$|n't$/;

const isNegator = (words, at) =>
  NEGATOR.test(words[at]) || (words[at] === 'other' && words[at + 1] === 'than');

const negates = (words) => words.some((_, at) => isNegator(words, at));

const isContent = (word) => word.length > 1 && contentWords(word).size > 0;

const withoutAsides = (text) => String(text ?? '').replace(/\([^()]*\)/g, ' ');

/**
 * Where one statement ends and the next begins.
 *
 * A bracket is read on its own and lifted out of the clause around it -
 * "(transaction not completed)" explains FAILED and must not negate it, while
 * "Check Status call via MW (mscore*) returning FAILED" stays one statement.
 * Everything after a comma, a full stop or a word that opens a condition is a
 * new clause. "And" and "or" break too, because that is what joins the parts of
 * a guard: "FAILED and the attempt has not reached 3" is two statements, and
 * only the second is negated.
 */
const CLAUSE_BREAK =
  /\b(?:when|whenever|if|where|while|unless|provided|because|since|but|and|or|nor|then|jika|ketika|apabila|bila|saat|dan|atau|namun|tetapi)\b/gi;

function clausesOf(text) {
  const asides = [];
  const main = String(text ?? '').replace(/\(([^()]*)\)/g, (_, inside) => {
    asides.push(inside);
    return ' ';
  });

  return [main, ...asides]
    .flatMap((part) => part.split(/[,;:!?](?:\s|$)|\.(?:\s|$)|\s[-–]\s/))
    .flatMap((part) => part.split(CLAUSE_BREAK))
    .map(wordsOf)
    .filter((words) => words.length > 0)
    .map((words) => ({ words, stems: new Set(stemmed(words)), negated: negates(words) }));
}

/** Sentences, each field on its own, so the title's framing stays the title's. */
function sentencesOf(text, title) {
  return String(text ?? '')
    .split(/(?<=[.;!?])\s+/)
    .filter((sentence) => sentence.trim())
    .map((sentence) => ({
      text: sentence,
      title,
      words: contentWords(sentence),
      stems: new Set(stemmed(wordsOf(sentence))),
      sequence: stemmed(wordsOf(sentence)),
      clauses: clausesOf(sentence),
      chunks: sentence.split(/[,;:](?:\s|$)/).map(clausesOf),
    }));
}

/** The content words of a phrase, one form each, its negation and its asides left out. */
function keysOf(phrase) {
  const words = wordsOf(withoutAsides(phrase));
  const stems = stemmed(words);
  return [...new Set(stems.filter((_, at) => isContent(words[at]) && !isNegator(words, at)))];
}

/**
 * The numbers a phrase states, grouped by how it joins them: "1 and/or 2" asks
 * for either, "1 and 2" for both. A number inside an identifier ("T24") or an
 * aside is not one of them.
 */
function numberGroupsOf(phrase) {
  const stems = stemmed(wordsOf(withoutAsides(phrase)));
  const groups = [];
  let gap = null;

  for (const word of stems) {
    if (!/^\d+$/.test(word)) {
      if (gap) gap.push(word);
      continue;
    }
    const either =
      gap !== null &&
      gap.length > 0 &&
      gap.length <= 3 &&
      gap.every((between) => /^(?:and|or|dan|atau)$/.test(between)) &&
      gap.some((between) => between === 'or' || between === 'atau');
    if (either) groups.at(-1).push(word);
    else groups.push([word]);
    gap = [];
  }

  return groups;
}

const COPULA =
  /^(?:is|are|was|were|be|remains?|still|becomes?|equals?|adalah|masih|tetap|menjadi)$/;

/**
 * The state a condition names, when it ends on one: "the transaction still
 * Timeout", "the response is FAILED", "the response from T24 is Success". It is
 * what separates the condition from every other sentence about the same
 * transaction, so a case has to name it. A condition that does not end on a
 * single stated word names no state, and asks for none.
 */
function stateOf(phrase) {
  const words = wordsOf(withoutAsides(phrase));
  const at = words.findLastIndex((word) => COPULA.test(word));
  if (at === -1) return null;

  const rest = words
    .slice(at + 1)
    .filter((word, offset) => !/^(?:a|an|the)$/.test(word) && !isNegator(words, at + 1 + offset));
  return rest.length === 1 ? stem(rest[0]) : null;
}

/** Enough of a phrase's own words in one place: the same 60% and floor of two as mentions(). */
function holds(stems, keys) {
  if (keys.length === 0) return false;
  const needed = Math.max(Math.min(2, keys.length), Math.ceil(keys.length * 0.6));
  let found = 0;
  for (const key of keys) if (stems.has(key)) found += 1;
  return found >= needed;
}

/** Every number group and the named state, if any. */
const statesValues = (stems, numbers, state) =>
  numbers.every((group) => group.some((number) => stems.has(number))) &&
  (!state || stems.has(state));

/** "Again" is part of an outcome that says it. A re-check is not the first check. */
const REPETITION = /\b(?:again|once\s+more|kembali|lagi)\b/i;

/**
 * Names the source capitalises as one thing - "Check Status", "Release
 * Settlement", "FT NUMBER". Content words lose them: "check" is a stopword, so
 * "perform Check Status again" was evidenced by any status performed again. A
 * name's words must stand together, in either order - the PRD itself writes
 * "Release Settlement" and "Settlement Release", "Check Status" and "status
 * check" - so the name is required without its spelling being.
 */
const NAMED = /\b\p{Lu}[\p{L}\p{N}]*(?:\s+\p{Lu}[\p{L}\p{N}]*)+/gu;

const namesIn = (text) => (String(text ?? '').match(NAMED) ?? []).map(wordsOf);

function names(words, name) {
  const wanted = [...name].sort().join(' ');
  for (let at = 0; at + name.length <= words.length; at += 1) {
    if ([...words.slice(at, at + name.length)].sort().join(' ') === wanted) return true;
  }
  return false;
}

/**
 * A branch: its outcome, in the polarity the source states it, AND what its
 * condition states.
 *
 * Read per sentence, over the clauses that share the outcome's polarity. The
 * outcome was matched as a bag of the case's words, so "no settlement release
 * retry is performed" stated "trigger retry Release Settlement to MW" - three
 * words of five, the negation unread - and eleven saved cases that withhold the
 * retry were credited with triggering it. A "not" in another clause ("FAILED or
 * NOT FOUND") is not the outcome's, and does not count against it.
 *
 * Then what ties the outcome to its condition:
 *
 *   values   the condition's numbers and the state it names ("still Timeout"),
 *            in the outcome's sentence or in the title framing the case.
 *   literals a condition made only of status literals - "FAILED or NOT FOUND" -
 *            asks for one of them, in the same places.
 *   state    a word the condition and the outcome share - "Settled" in "pick
 *            Settled filter ... display all of the settled transaction" - is
 *            the branch's state. The ratio let it be the word dropped: "displays
 *            all of the unsettled transactions" kept three words of four and
 *            proved the Settled branch, as did every "settled and unsettled"
 *            case. The state must be stated, in the same part of the sentence as
 *            the outcome, and its opposite ("unsettled" for "settled") must not
 *            be - unless the branch itself names both.
 *
 * A branch whose condition states none of these is matched on its outcome
 * alone, as before, with the polarity read.
 */
function branchEvidence(metadata, candidate) {
  const { condition, outcome } = metadata;

  if (REPETITION.test(outcome) && !REPETITION.test(candidate.text)) return false;
  const spoken = wordsOf(candidate.text);
  if (!namesIn(outcome).every((name) => names(spoken, name))) return false;

  const negated = withholds(wordsOf(withoutAsides(outcome)));
  const numbers = numberGroupsOf(condition);
  const state = stateOf(condition);
  const literals = literalsOf(condition);
  const own = sharedStates(condition, outcome);
  const outcomeKeys = keysOf(outcome);

  const titles = candidate.sentences.filter((sentence) => sentence.title);
  const framed = (test) => titles.some(test);

  const opposite = own.flatMap(oppositesOf).filter((word) => !own.includes(word));
  const clean = (stems) => !opposite.some((word) => stems.has(word));
  const polarStems = (clauses) =>
    new Set(
      clauses
        .filter((clause) => withholds(clause.words) === negated)
        .flatMap((clause) => [...clause.stems])
    );

  const polarOf = (sentence) =>
    sentence.clauses.filter((clause) => withholds(clause.words) === negated);
  const framing = titles.flatMap(polarOf);

  return candidate.sentences.some((sentence) => {
    // One sentence, plus the title that frames it - never a second sentence.
    const polar = sentence.title ? polarOf(sentence) : [...polarOf(sentence), ...framing];
    const text = polar.map((clause) => clause.words.join(' ')).join(' ');
    const stems = new Set(polar.flatMap((clause) => [...clause.stems]));
    if (!(
      mentions(contentWords(text), outcome) ||
      quotes(text, outcome) ||
      holds(stems, outcomeKeys)
    ))
      return false;

    if (numbers.length > 0 || state) {
      const valued = (s) => statesValues(s.stems, numbers, state);
      if (!valued(sentence) && !framed(valued)) return false;
    }

    if (literals) {
      const named = (s) => literals.some((literal) => names(s.sequence, literal));
      if (!named(sentence) && !framed(named)) return false;
    }

    if (own.length === 0) return true;
    const tied = sentence.chunks.some((chunk) => {
      const stems = polarStems(chunk);
      return (
        own.every((word) => stems.has(word)) &&
        clean(stems) &&
        outcomeKeys.some((key) => !own.includes(key) && stems.has(key))
      );
    });
    if (tied) return true;

    // The title may frame the state - "Verify the Settled filter" - when the
    // outcome sentence does not contradict it.
    return (
      clean(polarStems(sentence.clauses)) &&
      framed((title) =>
        title.chunks.some((chunk) => {
          const stems = polarStems(chunk);
          return own.every((word) => stems.has(word)) && clean(stems);
        })
      )
    );
  });
}

/**
 * A clause that withholds what it names: negated, or governed by a verb that
 * stops it - "preventing settlement release retry" triggers no retry. Branch
 * outcomes only; the guard reads negation alone.
 */
const PREVENTIVE =
  /^(?:prevent|prevents|prevented|preventing|block|blocks|blocked|blocking|skip|skips|skipped|skipping|mencegah)$/;

const withholds = (words) => negates(words) || words.some((word) => PREVENTIVE.test(word));

/** Words a branch's condition and outcome share: the state that ties them. */
function sharedStates(condition, outcome) {
  const said = new Set(keysOf(condition));
  return keysOf(outcome).filter((key) => said.has(key));
}

/**
 * The same word with its polarity prefix turned round: "unsettled" for
 * "settled", "settled" for "unsettled", "invalid" for "valid". Only where the
 * rest is a word of four letters or more, so "unit" is not "it".
 */
const POLARITY_PREFIX = /^(?:un|non|in|im|dis)(?=\p{L}{4})/u;

function oppositesOf(word) {
  const base = word.replace(POLARITY_PREFIX, '');
  return base !== word
    ? [base]
    : ['un', 'non', 'in', 'im', 'dis'].map((prefix) => `${prefix}${word}`);
}

/**
 * A condition made of nothing but status literals - "FAILED or NOT FOUND" -
 * asks for one of them. Anything else (a sentence, a value with prose around
 * it) names no literal and asks for none.
 */
function literalsOf(condition) {
  const parts = withoutAsides(condition)
    .trim()
    .split(/\s*(?:,|\band\/or\b|\bor\b|\batau\b)\s*/)
    .filter(Boolean);
  if (parts.length === 0) return null;
  if (!parts.every((part) => /^\p{Lu}[\p{Lu}\p{N}_]*(?:\s+\p{Lu}[\p{Lu}\p{N}_]*)*$/u.test(part)))
    return null;
  return parts.map((part) => stemmed(wordsOf(part)));
}

/**
 * A guard, in either of the two statements that mean it.
 *
 *   permitted  the action happens, and every condition holds as stated:
 *              "a retry is triggered when the response is FAILED and the
 *              attempt has not reached 3 times"
 *   forbidden  the action is withheld, and EVERY condition is stated failing:
 *              "no retry when the response is not FAILED or the attempt has
 *              reached 3 times"
 *
 * Each condition is read inside one clause, with that clause's own negation,
 * so a "not" elsewhere in the case - "(transaction not completed)", "NOT
 * FOUND" - cannot lend its polarity. A clause stating a condition is not also
 * the action, even when it shares a word with it ("the retry attempt has not
 * reached 3"); a negated clause naming the action AND a condition is not read
 * as either, because whose "not" it is cannot be told. A case withholding the
 * action for one failing condition has stated half the guard.
 */
function guardShape(obligation) {
  const basis = String(obligation.source_basis ?? '');
  const marker = GUARD_MARKER.exec(basis);
  const action = marker ? basis.slice(0, marker.index).replace(NOTE_LEAD, '') : '';
  const parts = obligation.metadata.conditions?.length
    ? obligation.metadata.conditions
    : [marker ? basis.slice(marker.index + marker[0].length) : obligation.metadata.guard];

  return {
    action: keysOf(action),
    conditions: parts.map((part) => ({
      keys: keysOf(part),
      numbers: numberGroupsOf(part),
      state: stateOf(part),
      negated: negates(wordsOf(withoutAsides(part))),
    })),
  };
}

function guardEvidence(obligation, candidate) {
  const { action, conditions } = guardShape(obligation);

  const states = (clause, condition) =>
    holds(clause.stems, condition.keys) &&
    statesValues(clause.stems, condition.numbers, condition.state);
  const namesAction = (clause, besides = []) =>
    action.some((key) => clause.stems.has(key) && !besides.includes(key));

  const shown = (condition, negated) =>
    candidate.clauses.some(
      (clause) =>
        clause.negated === negated &&
        states(clause, condition) &&
        !(clause.negated && namesAction(clause, condition.keys))
    );
  const acted = (negated) =>
    action.length === 0
      ? !negated
      : candidate.clauses.some(
          (clause) =>
            clause.negated === negated &&
            namesAction(clause) &&
            !conditions.some((condition) => states(clause, condition))
        );

  const permitted = acted(false) && conditions.every((c) => shown(c, c.negated));
  const forbidden =
    action.length > 0 && acted(true) && conditions.every((c) => shown(c, !c.negated));

  return permitted || forbidden;
}

/**
 * Where a stated duration is measured from - "1 hour delay FROM THE ORIGINAL
 * TIMEOUT TIMESTAMP before ..." - read from the source sentence right after the
 * duration. None stated, none asked for.
 */
function referenceOf(obligation) {
  const { amount } = obligation.metadata;
  const spelled = UNIT_MENTIONS[obligation.metadata.unit]?.source.replace(/^\\b|\\b$/g, '');
  if (!spelled) return [];

  const basis = String(obligation.source_basis ?? '');
  const duration = new RegExp(`(?<![\\p{N}.,:])${amount}[\\s-]*${spelled}`, 'iu').exec(basis);
  if (!duration) return [];

  const after = basis.slice(duration.index + duration[0].length);
  const reference =
    /^\s*(?:[\p{L}-]+\s+){0,3}?(?:from|since|after|sejak|dari|setelah)\s+([^.;,(]+?)(?=\s+(?:before|until|then|and|sebelum|hingga|sampai)\b|[.;,(]|$)/iu.exec(
      after
    );
  return reference ? keysOf(reference[1]) : [];
}

/**
 * A schedule: the duration written as a duration - "1 hour", "1-hour", never a
 * "1" from one place and an "hour" from another - and, where the source states
 * one, the point it is measured from, in the same sentence.
 */
function scheduleEvidence(obligation, candidate) {
  const { amount, unit } = obligation.metadata;
  const spelled = UNIT_MENTIONS[unit]?.source.replace(/^\\b|\\b$/g, '');
  if (!spelled) return false;

  const duration = new RegExp(
    `(?<![\\p{N}.,:])${amount}\\s*(?:-\\s*|\\(\\s*\\p{L}+\\s*\\)\\s*)?${spelled}`,
    'iu'
  );
  const reference = referenceOf(obligation);

  return candidate.sentences.some(
    (sentence) =>
      duration.test(sentence.text) && (reference.length === 0 || holds(sentence.stems, reference))
  );
}

/**
 * Whether one test case demonstrably exercises one obligation.
 *
 * Every rule here asks for explicit evidence in the case's own words - the
 * value, the code, the state name, the clause. None of them infers. An
 * obligation whose evidence is a judgement call ("does this case really test
 * the retry limit?") returns false and is reported as uncovered, which is the
 * conservative direction: the semantic reviewer sees the gap and can say it is
 * not one, whereas a false match is a coverage claim nobody ever revisits.
 */
function evidence(obligation, candidate) {
  const { metadata } = obligation;

  switch (obligation.type) {
    case 'bound':
      return candidate.values.has(metadata.value);

    case 'rejection':
      return (
        candidate.case_type === 'Negative' ||
        (candidate.case_type === 'Edge' && candidate.edge_polarity === 'invalid') ||
        REJECTION_PATH.test(candidate.text)
      );

    case 'transition':
      // A transition gated by a condition (governingCondition, above) is only
      // exercised once a case states BOTH halves: the state name alone is also
      // what the mid-path branch that leads to it mentions, and "the status is
      // marked FAILED" is not evidence that a run ever got as far as the third
      // retry. The same locality check a guard is read by, so the condition's
      // words have to sit together rather than merely appear somewhere in the
      // case.
      return (
        candidate.squashed.includes(squash(metadata.state)) &&
        (!metadata.condition ||
          mentionsLocally(candidate.text, metadata.condition) ||
          quotes(candidate.text, metadata.condition))
      );

    case 'mapping': {
      // Two detectors emit this type and they describe the mapping differently.
      // mappingObligations reads a bare code out of prose and stores `code`;
      // mappingTableObligations and parentheticalMappings read a FIELD="value"
      // row and store `stated` plus the `meaning` the row assigns it.
      //
      // Only `code` was read here, so every obligation of the second kind was
      // compared against undefined - and squash(undefined) is '', which every
      // string contains. `Response Y.ISO.RESPONSE:1:1="00" is treated as:
      // Success` was therefore reported COVERED by any case citing the
      // requirement, including one about nothing of the sort. The two response
      // rules this feature turns on could not be reported uncovered at all,
      // which is why whether a run tested them looked like luck: nothing was
      // checking.
      //
      // Both halves are now required, because both are the obligation: the
      // stated value, matched literally as the code it is, and the meaning the
      // source assigns it. A case naming the field without saying what the
      // value means has not tested the mapping.
      if (metadata.code) return candidate.squashed.includes(squash(metadata.code));

      const stated = String(metadata.stated ?? '')
        .split(' AND ')
        .filter(Boolean);
      if (stated.length === 0) return false;

      return (
        stated.every((pair) => namesPair(pair, candidate)) &&
        statesMeaning(metadata.meaning, candidate)
      );
    }

    case 'retry':
      // The limit is only exercised if the number itself is in play; retrying
      // at all is evidence of the behaviour but not of where it stops.
      return metadata.limit
        ? RETRY_CUE.test(candidate.text) && candidate.values.has(String(metadata.limit))
        : RETRY_CUE.test(candidate.text);

    case 'schedule':
      return scheduleEvidence(obligation, candidate);

    case 'side_effect':
      return candidate.squashed.includes(squash(metadata.object));

    case 'qualifier':
      // The stated term, not a paraphrase of it: that is the whole point of the
      // obligation. Squashed, so punctuation and a footnote star cannot decide
      // it. Wording with no named term is matched tolerantly instead - it has no
      // single token to insist on, and insisting on the whole bracket would
      // report a gap for a case that covered it in the source's other words.
      return metadata.key
        ? candidate.squashed.includes(squash(metadata.key))
        : mentions(candidate.words, metadata.qualifier) ||
            quotes(candidate.text, metadata.qualifier);

    case 'criterion':
      // A test case rephrases a criterion rather than quoting it, so this is the
      // same tolerant containment the other prose types use.
      return (
        mentions(candidate.words, metadata.criterion) || quotes(candidate.text, metadata.criterion)
      );

    case 'condition':
      // Two detectors emit this type and they name the clause differently:
      // conditionObligations stores `clause`, guardObligations stores `guard`.
      // Reading only `clause` meant every guard was matched against undefined,
      // which mentions() answers false for - so a guard could not be covered by
      // ANY test case, including one quoting the restriction word for word.
      // Every "the retry guard is uncovered" report in this project was that,
      // not the generator: the obligation was unreachable by construction.
      //
      // Read LOCALLY and CONDITION BY CONDITION, unlike the other prose types,
      // because a guard fails differently from every other obligation.
      //
      // Locally, because a restriction is made of the same words as the
      // behaviour it restricts: a case describing the retry supplies "status",
      // "response", "failed", "retry", "attempt", "not", "times" and
      // "performed" on its own - eight of the guard's thirteen words, exactly
      // the eight a 60% ratio needs - while the words that made it a guard were
      // the missing ones. Requiring the words to sit together does not demand a
      // quotation; it demands that they be one statement.
      //
      // Condition by condition, because half a guard is not a guard. "only when
      // the response is FAILED and the attempt has not reached 3" is two things
      // a tester must set up, and a case stating the first at length clears any
      // whole-clause bar on the strength of that half alone. Measured over
      // seven runs of one PRD, the first half survived six times and the second
      // once, which is precisely the failure a whole-clause reading cannot see.
      if (metadata.guard) return guardEvidence(obligation, candidate);

      const clause = metadata.clause ?? metadata.guard;
      const stated = metadata.conditions?.length > 1 ? metadata.conditions : [clause];

      return stated.every(
        (part) => mentionsLocally(candidate.text, part) || quotes(candidate.text, part)
      );

    case 'ui_action':
      return mentions(candidate.words, metadata.clause) || quotes(candidate.text, metadata.clause);

    case 'branch':
      return branchEvidence(metadata, candidate);

    default:
      return false;
  }
}

/**
 * Matches obligations against the test cases that cite their requirement.
 *
 * A test case can satisfy several obligations and an obligation can be
 * satisfied by several cases - neither is padded to the other. Nothing here
 * counts a case that does not cite the requirement: coverage of REQ-005 is
 * what the cases claiming REQ-005 do, which is the same rule the requirement
 * -level report has always used, one level down.
 *
 * @param {object[]} obligations  from deriveCoverageObligations
 * @param {object[]} testCases    canonical test cases
 * @returns {object[]} each obligation with `covered` and the `case_ids` proving it
 */
export function matchObligations(obligations, testCases) {
  const citing = new Map();

  for (const testCase of testCases ?? []) {
    const candidate = prepare(testCase);
    for (const requirementId of testCase.requirement_ids ?? []) {
      if (!citing.has(requirementId)) citing.set(requirementId, []);
      citing.get(requirementId).push(candidate);
    }
  }

  return (obligations ?? []).map((obligation) => {
    const caseIds = (citing.get(obligation.requirement_id) ?? [])
      .filter((candidate) => evidence(obligation, candidate))
      .map((candidate) => candidate.case_id);

    return { ...obligation, covered: caseIds.length > 0, case_ids: caseIds };
  });
}

// --- Rendering ----------------------------------------------------------------

/** Ceiling on what one prompt carries; a free-tier call is metered. */
const MAX_PROMPT_OBLIGATIONS = 120;

/**
 * The obligations one generation prompt actually lists.
 *
 * The plan the model returns is checked against exactly this list, so it has
 * one definition: the response schema's id enum, the prompt's lines and the
 * audit of the reply all read it from here. A cap applied in one place and not
 * the others would ask the model to account for ids it was never shown.
 */
export function promptedObligations(obligations) {
  return (obligations ?? []).slice(0, MAX_PROMPT_OBLIGATIONS);
}

/**
 * Renders obligations for the generation prompt, grouped by requirement.
 *
 * Grouped rather than listed flat because the model reads it next to the
 * requirements and has to know which one each line belongs to, and because a
 * flat list of 120 lines reads as a demand for 120 test cases - which is
 * exactly the padding the instruction around it forbids.
 *
 * @returns {string} '' when there is nothing worth saying
 */
export function obligationsForPrompt(obligations) {
  const prompted = promptedObligations(obligations);
  if (prompted.length === 0) return '';

  const grouped = new Map();
  for (const obligation of prompted) {
    if (!grouped.has(obligation.requirement_id)) grouped.set(obligation.requirement_id, []);
    grouped.get(obligation.requirement_id).push(obligation);
  }

  const lines = [];
  for (const [requirementId, entries] of grouped) {
    lines.push(`${requirementId}:`);
    for (const entry of entries) {
      lines.push(`  - [${entry.obligation_id}] ${entry.statement}`);
    }
  }

  return lines.join('\n');
}

/** Obligation types whose gaps a deterministic check already reports in full. */
const REPORTED_DETERMINISTICALLY = new Set(['bound']);

/** How many gaps the reviewer is asked about; beyond this it stops reading. */
const MAX_REVIEW_GAPS = 25;

/**
 * The uncovered obligations worth a reviewer's attention.
 *
 * Bounds are filtered out: checkUntestedBounds already names every stated limit
 * no case mentions, the reviewer is explicitly told not to repeat that, and
 * sending the numbers anyway would spend its attention re-deriving a finding it
 * has been forbidden to report.
 *
 * @param {object[]} matched  from matchObligations
 */
export function reviewableGaps(matched) {
  return (matched ?? [])
    .filter((obligation) => !obligation.covered && !REPORTED_DETERMINISTICALLY.has(obligation.type))
    .slice(0, MAX_REVIEW_GAPS)
    .map((obligation) => ({
      requirement_id: obligation.requirement_id,
      obligation: obligation.statement,
      source_basis: short(obligation.source_basis, 200),
    }));
}
