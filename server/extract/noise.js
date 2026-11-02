/**
 * Boilerplate filtering.
 *
 * Every sample PRD opens with roughly 500 characters of approval apparatus -
 * "Created by / Name / Title / Project Role / Signature / Date" and a table of
 * people - before any content. None of it is testable, and all of it is full of
 * short table rows that would otherwise look like requirements.
 *
 * Filtering is deliberately conservative: it drops sections and lines that are
 * recognisably administrative, never anything merely short or unfamiliar. Over-
 * filtering loses a testable requirement silently, which is the worse failure.
 */

/** Section headings whose entire contents are administrative. Bilingual. */
const NOISE_SECTIONS = [
  /^(created|prepared|reviewed|approved|acknowledged)\s+by\b/i,
  /^(dibuat|disiapkan|diperiksa|disetujui|diketahui)\s+oleh\b/i,
  /^(document\s+)?(revision|version|change)\s+(history|log|control)\b/i,
  /^(riwayat|histori)\s+(revisi|perubahan|dokumen)\b/i,
  /^(document\s+)?(information|properties|metadata|control)\b/i,
  /^informasi\s+dokumen\b/i,
  /^(table\s+of\s+contents|daftar\s+isi)\b/i,
  /^(distribution\s+list|daftar\s+distribusi)\b/i,
  /^(glossary|glosarium|abbreviations|singkatan|definitions?|definisi)\b/i,
  /^(sign[\s-]?off|persetujuan|tanda\s+tangan)\b/i,
  /^(references?|referensi|appendix|lampiran)\b/i,
];

/** Lines that are administrative wherever they appear. */
const NOISE_LINES = [
  /^(name|title|project\s+role|signature|date|position|department|division)\s*:?\s*$/i,
  /^(nama|jabatan|peran|tanda\s+tangan|tanggal|divisi|departemen)\s*:?\s*$/i,
  /^(page|halaman)\s+\d+(\s*(of|dari)\s*\d+)?$/i,
  /^(document\s+status|target\s+release|epic|version|versi)\s*:?\s*/i,
  /^(confidential|internal\s+use\s+only|rahasia)\b/i,
  /^[\s|·•\-–—_=]+$/,
];

/** A table row is administrative if its headers are all people-and-dates columns. */
const PEOPLE_TABLE_HEADERS =
  /^(name|nama|title|jabatan|project\s+role|peran|signature|tanda\s+tangan|date|tanggal|position|no\.?|version|versi|author|penulis|description\s+of\s+change)$/i;

export function isNoiseSection(section) {
  if (!section) return false;

  // Any level of the heading path being administrative condemns the whole path.
  return section
    .split('>')
    .map((part) => part.trim())
    .some((part) => NOISE_SECTIONS.some((pattern) => pattern.test(part)));
}

export function isNoiseLine(text) {
  const trimmed = String(text ?? '').trim();
  if (trimmed === '') return true;
  return NOISE_LINES.some((pattern) => pattern.test(trimmed));
}

/** True when a table's headers indicate a signature or revision-history table. */
export function isPeopleTable(headers) {
  if (!headers || headers.length < 2) return false;
  const named = headers.filter(Boolean);
  if (named.length < 2) return false;
  return named.every((header) => PEOPLE_TABLE_HEADERS.test(header.trim()));
}

/** The single entry point used by the extractor. */
export function isNoise(block) {
  if (isNoiseSection(block.section)) return true;
  if (isNoiseLine(block.text)) return true;
  if (block.table && isPeopleTable(block.table.headers)) return true;
  return false;
}
