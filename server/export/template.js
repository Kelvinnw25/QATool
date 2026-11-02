import fs from 'node:fs';
import { strFromU8, unzipSync } from 'fflate';

export const SHEET_PART = 'xl/worksheets/sheet1.xml';
export const SHARED_STRINGS_PART = 'xl/sharedStrings.xml';
export const TABLE_PART = 'xl/tables/table1.xml';

/**
 * Style indices into the template's own cellXfs, chosen from its data rows:
 *
 *   2 - border, no fill, centred, wrapped   (short columns)
 *   4 - border, no fill, left,    wrapped   (long text columns)
 *
 * The template's sample rows also use indices 3, 5, 6 and 9, which carry
 * background fills. Those are leftover manual highlighting from the previous
 * BI-FAST project, not meaningful formatting, so exported rows use the two
 * unfilled styles consistently. assertTemplateStyles() pins the assumption.
 */
export const STYLE_CENTERED = 2;
export const STYLE_LEFT = 4;

/** Which of the two styles each of the nine columns uses. */
export const COLUMN_STYLES = [
  STYLE_CENTERED, // A Case ID
  STYLE_CENTERED, // B Section
  STYLE_LEFT, // C Test Case
  STYLE_CENTERED, // D Case Type
  STYLE_CENTERED, // E Priority
  STYLE_CENTERED, // F Type
  STYLE_LEFT, // G Exected Result
  STYLE_CENTERED, // H Status
  STYLE_CENTERED, // I Tested By
];

function readSharedStrings(xml) {
  const strings = [];
  for (const [, siBody] of xml.matchAll(/<si>(.*?)<\/si>/gs)) {
    let text = '';
    for (const [, run] of siBody.matchAll(/<t[^>]*>(.*?)<\/t>/gs)) {
      text += run;
    }
    strings.push(
      text
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&amp;/g, '&')
    );
  }
  return strings;
}

/**
 * Reads the office template and pulls out everything the writer needs.
 *
 * The file is read into memory and never written to. Whatever the template
 * says wins: header labels (including the 'Exected Result' typo), dropdown
 * formulas and the table definition are all taken from it rather than restated
 * here, so a revised template flows through without a code change.
 */
export function loadTemplate(templatePath) {
  let bytes;
  try {
    bytes = fs.readFileSync(templatePath);
  } catch (cause) {
    throw new Error(`Cannot read the SIT template at '${templatePath}': ${cause.message}`, {
      cause,
    });
  }

  let parts;
  try {
    parts = unzipSync(new Uint8Array(bytes));
  } catch (cause) {
    throw new Error(`The SIT template at '${templatePath}' is not a readable .xlsx file.`, {
      cause,
    });
  }

  for (const required of [SHEET_PART, SHARED_STRINGS_PART]) {
    if (!parts[required]) {
      throw new Error(`The SIT template is missing '${required}'.`);
    }
  }

  const sheetXml = strFromU8(parts[SHEET_PART]);
  const sharedStrings = readSharedStrings(strFromU8(parts[SHARED_STRINGS_PART]));

  const sheetDataStart = sheetXml.indexOf('<sheetData>');
  const sheetDataEnd = sheetXml.indexOf('</sheetData>');
  if (sheetDataStart === -1 || sheetDataEnd === -1) {
    throw new Error('The SIT template worksheet has no <sheetData> section.');
  }

  return {
    parts,
    sheetXml,

    /** Everything up to <sheetData>: namespaces, sheetPr, views, column widths. */
    prefix: sheetXml.slice(0, sheetDataStart),

    /** Everything after </sheetData>: validations, drawing, tableParts. */
    suffix: sheetXml.slice(sheetDataEnd + '</sheetData>'.length),

    headers: readHeaderRow(sheetXml, sharedStrings),
    headerStyleId: readHeaderStyleId(sheetXml),
    dataValidations: readDataValidations(sheetXml),
    tableRef: parts[TABLE_PART] ? readTableRef(strFromU8(parts[TABLE_PART])) : null,
  };
}

/** Header labels, in column order, exactly as the template spells them. */
function readHeaderRow(sheetXml, sharedStrings) {
  const row = /<row r="1"[^>]*>(.*?)<\/row>/s.exec(sheetXml);
  if (!row) throw new Error('The SIT template worksheet has no header row.');

  // Attributes and body are captured separately. Folding t="s" into an optional
  // group inside the cell pattern lets the engine skip it and silently report
  // every header as its shared-string index instead of its text.
  const headers = [];
  for (const [, attributes, inner] of row[1].matchAll(
    /<c r="[A-Z]+\d+"([^>]*)(?:\/>|>(.*?)<\/c>)/gs
  )) {
    const value = inner ? /<v>(.*?)<\/v>/s.exec(inner) : null;

    if (!value) {
      headers.push('');
    } else if (/\bt="s"/.test(attributes)) {
      headers.push(sharedStrings[Number.parseInt(value[1], 10)] ?? '');
    } else {
      headers.push(value[1]);
    }
  }
  return headers;
}

function readHeaderStyleId(sheetXml) {
  const match = /<row r="1"[^>]*>\s*<c[^>]*\bs="(\d+)"/s.exec(sheetXml);
  return match ? Number.parseInt(match[1], 10) : 0;
}

/**
 * Dropdown definitions, with formula1 kept verbatim. The Case Type, Priority,
 * Status and Tested By lists are the office template's business vocabulary, not
 * ours - reproducing them exactly is the point.
 */
function readDataValidations(sheetXml) {
  const block = /<dataValidations[^>]*>(.*?)<\/dataValidations>/s.exec(sheetXml);
  if (!block) return [];

  const validations = [];
  // \s+ so this cannot also match a <dataValidations> container.
  for (const [, attributes, body] of block[1].matchAll(
    /<dataValidation\s+([^>]*?)>(.*?)<\/dataValidation>/gs
  )) {
    const sqref = /sqref="([^"]*)"/.exec(attributes);
    if (!sqref) continue;
    validations.push({
      attributes: attributes.trim(),
      sqref: sqref[1],
      body,
    });
  }
  return validations;
}

function readTableRef(tableXml) {
  const match = /\bref="([^"]*)"/.exec(tableXml);
  return match ? match[1] : null;
}

/**
 * Confirms the two style indices the writer relies on still mean what the
 * comment above says. Called by the export tests; a revised template that
 * reorders cellXfs fails here rather than producing a silently ugly workbook.
 */
export function assertTemplateStyles(parts) {
  const styles = strFromU8(parts['xl/styles.xml']);
  const cellXfs = /<cellXfs[^>]*>(.*?)<\/cellXfs>/s.exec(styles);
  if (!cellXfs) return { ok: false, reason: 'no cellXfs in styles.xml' };

  const entries = [...cellXfs[1].matchAll(/<xf\b([^>]*)(?:\/>|>.*?<\/xf>)/gs)].map((m) => m[1]);

  for (const index of [STYLE_CENTERED, STYLE_LEFT]) {
    const entry = entries[index];
    if (!entry) return { ok: false, reason: `cellXfs has no index ${index}` };
    if (!/borderId="1"/.test(entry) || !/fillId="0"/.test(entry)) {
      return { ok: false, reason: `cellXfs index ${index} is no longer bordered and unfilled` };
    }
  }

  return { ok: true, count: entries.length };
}
