import { strFromU8, unzipSync } from 'fflate';
import { SHARED_STRINGS_PART, SHEET_PART, TABLE_PART } from './template.js';

/**
 * Reads a generated workbook back.
 *
 * Used both by the exporter's own self-check and by the tests. PRD 22 forbids
 * silently producing a broken Excel file, and the only way to be sure the bytes
 * on their way out are sound is to parse them again.
 */
export function inspectWorkbook(buffer) {
  const parts = unzipSync(new Uint8Array(buffer));
  const sheetXml = strFromU8(parts[SHEET_PART]);
  const sharedStrings = readSharedStrings(strFromU8(parts[SHARED_STRINGS_PART]));

  const rows = [];
  for (const [, rowNumber, body] of sheetXml.matchAll(/<row r="(\d+)"[^>]*>(.*?)<\/row>/gs)) {
    const cells = {};
    for (const [, reference, attributes, inner] of body.matchAll(
      /<c r="([A-Z]+\d+)"([^>]*)(?:\/>|>(.*?)<\/c>)/gs
    )) {
      const column = reference.replace(/\d+/g, '');
      const value = inner ? /<v>(.*?)<\/v>/s.exec(inner) : null;

      if (!value) {
        cells[column] = '';
      } else if (/t="s"/.test(attributes)) {
        cells[column] = sharedStrings[Number.parseInt(value[1], 10)] ?? '';
      } else {
        cells[column] = value[1];
      }
    }
    rows.push({ row: Number.parseInt(rowNumber, 10), cells });
  }

  const validations = [];
  // The \s+ matters: without it this also matches the <dataValidations>
  // container, whose 's' reads as an attribute and yields a sqref-less entry.
  for (const [, attributes, body] of sheetXml.matchAll(
    /<dataValidation\s+([^>]*?)>(.*?)<\/dataValidation>/gs
  )) {
    const sqref = /sqref="([^"]*)"/.exec(attributes);
    const formula = /<formula1>(.*?)<\/formula1>/s.exec(body);
    validations.push({
      sqref: sqref ? sqref[1] : null,
      formula1: formula ? decodeXml(formula[1]) : null,
    });
  }

  const tableXml = parts[TABLE_PART] ? strFromU8(parts[TABLE_PART]) : null;
  const tableRef = tableXml ? (/\bref="([^"]*)"/.exec(tableXml)?.[1] ?? null) : null;

  return {
    partNames: Object.keys(parts).sort(),
    headerRow: rows.find((row) => row.row === 1)?.cells ?? {},
    dataRows: rows.filter((row) => row.row > 1),
    validations,
    tableRef,
    hasDrawing: /<drawing\b/.test(sheetXml),
  };
}

function decodeXml(value) {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function readSharedStrings(xml) {
  const strings = [];
  for (const [, body] of xml.matchAll(/<si>(.*?)<\/si>/gs)) {
    let text = '';
    for (const [, run] of body.matchAll(/<t[^>]*>(.*?)<\/t>/gs)) text += run;
    strings.push(decodeXml(text));
  }
  return strings;
}
