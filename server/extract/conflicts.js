/**
 * Cross-document conflict detection (PRD 8).
 *
 * The classic case is a value stated twice with two different numbers:
 *
 *   PRD -> timeout = 30 seconds
 *   RFC -> timeout = 60 seconds
 *
 * Both sides are recorded and neither is chosen. Picking a winner would be the
 * tool deciding a question that belongs to a person, and the wrong choice would
 * be invisible by the time it reached the SIT script.
 *
 * Deliberately narrow: only numeric disagreements on the same named subject
 * across *different* documents. Guessing at semantic contradiction is milestone
 * 5's job, with the LLM, and reported as a warning rather than asserted here.
 */

/**
 * Subjects worth comparing. Each is a concept that tends to be specified once
 * per document and repeated inconsistently.
 */
const SUBJECTS = [
  { key: 'timeout', pattern: /\btime[\s-]?out\b|\bbatas\s+waktu\b/i },
  { key: 'maximum transactions', pattern: /\b(max\w*|maksimal)\b.{0,30}\btransa\w+/i },
  { key: 'minimum transactions', pattern: /\b(min\w*|minimal)\b.{0,30}\btransa\w+/i },
  { key: 'maximum amount', pattern: /\b(max\w*|maksimal)\b.{0,30}\b(amount|nominal|jumlah)\b/i },
  { key: 'retry count', pattern: /\bretr(y|ies)\b|\bpengulangan\b/i },
  { key: 'batch size', pattern: /\bbatch\s+size\b|\bukuran\s+batch\b/i },
  { key: 'file size limit', pattern: /\bfile\s+size\b|\bukuran\s+file\b/i },
  { key: 'record limit', pattern: /\b(max\w*|maksimal)\b.{0,30}\b(record|baris|row)s?\b/i },
];

/** Numbers with a unit, which is what makes two statements comparable. */
const VALUE_PATTERN =
  /\b(\d[\d.,]*)\s*(seconds?|second|secs?|detik|minutes?|menit|hours?|jam|ms|milliseconds?|transactions?|transaksi|records?|baris|rows?|kb|mb|gb|times?|kali)?\b/gi;

function normalizeNumber(raw) {
  // Indonesian documents use '.' as a thousands separator; a trailing group of
  // exactly three digits after a dot is a separator, not a decimal point.
  const cleaned = raw.replace(/\.(?=\d{3}\b)/g, '').replace(/,/g, '.');
  const value = Number.parseFloat(cleaned);
  return Number.isFinite(value) ? value : null;
}

function extractValues(text) {
  const values = [];
  for (const [, number, unit] of text.matchAll(VALUE_PATTERN)) {
    const value = normalizeNumber(number);
    if (value === null) continue;
    values.push({ value, unit: (unit ?? '').toLowerCase() });
  }
  return values;
}

/**
 * Annotates requirements in place with conflict records.
 *
 * @param {object[]} requirements
 * @returns {{message: string, requirement_ids: string[]}[]} a summary for warnings
 */
export function detectConflicts(requirements) {
  const bySubject = new Map();

  for (const requirement of requirements) {
    const documentId = requirement.source_references[0]?.document_id;
    if (!documentId) continue;

    for (const subject of SUBJECTS) {
      if (!subject.pattern.test(requirement.description)) continue;

      const values = extractValues(requirement.description);
      if (values.length === 0) continue;

      if (!bySubject.has(subject.key)) bySubject.set(subject.key, []);
      bySubject.get(subject.key).push({ requirement, documentId, values });
    }
  }

  const summaries = [];

  for (const [subject, entries] of bySubject) {
    const documents = new Set(entries.map((entry) => entry.documentId));
    if (documents.size < 2) continue; // one document cannot disagree with itself

    // Compare the leading value of each statement, which is the one the
    // sentence is about.
    const byDocument = new Map();
    for (const entry of entries) {
      if (!byDocument.has(entry.documentId)) {
        byDocument.set(entry.documentId, { entry, value: entry.values[0] });
      }
    }

    const readings = [...byDocument.values()];
    const distinct = new Set(readings.map((reading) => `${reading.value.value}`));
    if (distinct.size < 2) continue;

    const description = readings
      .map(
        (reading) =>
          `${reading.entry.documentId} states ${reading.value.value}${reading.value.unit ? ` ${reading.value.unit}` : ''}`
      )
      .join('; ');

    const message = `CONFLICT DETECTED - ${subject}: ${description}. Human resolution required.`;
    const sourceReferences = readings.flatMap(
      (reading) => reading.entry.requirement.source_references
    );

    for (const reading of readings) {
      reading.entry.requirement.conflicts.push({
        message,
        source_references: sourceReferences,
        resolved: false,
        resolution_note: null,
      });
    }

    summaries.push({
      message,
      requirement_ids: readings.map((reading) => reading.entry.requirement.requirement_id),
    });
  }

  return summaries;
}
