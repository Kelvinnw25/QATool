import { strFromU8, unzipSync } from 'fflate';
import { AppError } from '../../lib/errors.js';

/**
 * XLSX extraction, reusing the OOXML approach already proven in the export
 * component rather than adding a spreadsheet library for reading.
 *
 * A spreadsheet's meaning is positional, so every row keeps its sheet name,
 * row number, cell range and - where the sheet has one - its header row. A test
 * case matrix pasted into Excel survives as rows, not as a wall of words.
 */

export function parseXlsx(buffer, documentId) {
  let parts;
  try {
    parts = unzipSync(new Uint8Array(buffer));
  } catch (cause) {
    throw new AppError('CORRUPT_DOCUMENT', `The XLSX could not be opened: ${cause.message}`, 422);
  }

  if (!parts['xl/workbook.xml']) {
    throw new AppError('CORRUPT_DOCUMENT', 'The XLSX has no xl/workbook.xml part.', 422);
  }

  const sharedStrings = parts['xl/sharedStrings.xml']
    ? readSharedStrings(strFromU8(parts['xl/sharedStrings.xml']))
    : [];

  const sheets = readSheetIndex(parts);

  const blocks = [];
  let characterCount = 0;

  for (const sheet of sheets) {
    const sheetPart = parts[sheet.path];
    if (!sheetPart) continue;

    const rows = readRows(strFromU8(sheetPart), sharedStrings);
    if (rows.length === 0) continue;

    // The first non-empty row is treated as headers when every cell is short
    // and populated - the usual shape of a spreadsheet header.
    const [first, ...rest] = rows;
    const looksHeadered =
      first.cells.length > 1 &&
      first.cells.every((cell) => cell.value !== '' && cell.value.length < 60);

    const headers = looksHeadered ? first.cells.map((cell) => cell.value) : [];
    const dataRows = looksHeadered ? rest : rows;

    for (const row of dataRows) {
      const text = renderRow(headers, row.cells);
      if (text === '') continue;
      characterCount += text.length;

      const refs = row.cells.map((cell) => cell.ref);
      blocks.push({
        kind: 'table-row',
        text,
        level: null,
        page: null,
        section: sheet.name,
        sheet: sheet.name,
        cell: refs.length > 1 ? `${refs[0]}:${refs.at(-1)}` : (refs[0] ?? null),
        table: { headers, cells: row.cells.map((cell) => cell.value) },
      });
    }
  }

  return {
    blocks,
    metrics: {
      page_count: null,
      extracted_char_count: characterCount,
      sheet_count: sheets.length,
    },
    documentId,
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
  for (const [, body] of xml.matchAll(/<si>([\s\S]*?)<\/si>/g)) {
    let text = '';
    for (const [, run] of body.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)) text += run;
    strings.push(decodeXml(text));
  }
  return strings;
}

/** Resolves sheet names to their part paths through the workbook relationships. */
function readSheetIndex(parts) {
  const workbook = strFromU8(parts['xl/workbook.xml']);
  const rels = parts['xl/_rels/workbook.xml.rels']
    ? strFromU8(parts['xl/_rels/workbook.xml.rels'])
    : '';

  const targets = new Map();
  for (const [, id, target] of rels.matchAll(
    /<Relationship[^>]*Id="([^"]+)"[^>]*Target="([^"]+)"/g
  )) {
    targets.set(id, target.replace(/^\/?xl\//, '').replace(/^\//, ''));
  }

  const sheets = [];
  let fallbackIndex = 0;

  for (const [, attributes] of workbook.matchAll(/<sheet\b([^>]*)\/?>/g)) {
    fallbackIndex += 1;
    const name = decodeXml(/name="([^"]*)"/.exec(attributes)?.[1] ?? `Sheet${fallbackIndex}`);
    const relId = /r:id="([^"]*)"/.exec(attributes)?.[1];
    const target = relId ? targets.get(relId) : null;

    sheets.push({
      name,
      path: `xl/${target ?? `worksheets/sheet${fallbackIndex}.xml`}`,
    });
  }

  return sheets;
}

function readRows(sheetXml, sharedStrings) {
  const rows = [];

  for (const [, rowNumber, body] of sheetXml.matchAll(
    /<row[^>]*\br="(\d+)"[^>]*>([\s\S]*?)<\/row>/g
  )) {
    const cells = [];

    for (const [, ref, attributes, inner] of body.matchAll(
      /<c[^>]*\br="([A-Z]+\d+)"([^>]*)(?:\/>|>([\s\S]*?)<\/c>)/g
    )) {
      let value = '';

      if (inner) {
        if (/\bt="inlineStr"/.test(attributes)) {
          for (const [, run] of inner.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)) value += run;
          value = decodeXml(value);
        } else {
          const raw = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1];
          if (raw !== undefined) {
            value = /\bt="s"/.test(attributes)
              ? (sharedStrings[Number.parseInt(raw, 10)] ?? '')
              : decodeXml(raw);
          }
        }
      }

      value = value.replace(/\s+/g, ' ').trim();
      if (value !== '') cells.push({ ref, value });
    }

    if (cells.length > 0) rows.push({ row: Number.parseInt(rowNumber, 10), cells });
  }

  return rows;
}

function renderRow(headers, cells) {
  if (headers.length === 0) {
    return cells
      .map((cell) => cell.value)
      .filter(Boolean)
      .join(' | ')
      .trim();
  }

  return cells
    .map((cell, index) => {
      const header = headers[index];
      if (!cell.value) return '';
      return header ? `${header}: ${cell.value}` : cell.value;
    })
    .filter(Boolean)
    .join(' | ')
    .trim();
}
