import { strFromU8 } from 'fflate';
import { AppError } from '../../lib/errors.js';
import { config } from '../../config.js';
import { safeUnzip } from '../zip.js';

/**
 * XLSX extraction, reusing the OOXML approach already proven in the export
 * component rather than adding a spreadsheet library for reading.
 *
 * A spreadsheet's meaning is positional, so every row keeps its sheet name,
 * row number, cell range and - where the sheet has one - its header row. A test
 * case matrix pasted into Excel survives as rows, not as a wall of words.
 */

export function parseXlsx(buffer, documentId, limits = config.security.limits) {
  let parts;
  try {
    parts = safeUnzip(new Uint8Array(buffer), limits);
  } catch (cause) {
    if (cause instanceof AppError) throw cause;
    throw new AppError('CORRUPT_DOCUMENT', `The XLSX could not be opened: ${cause.message}`, 422);
  }

  if (!parts['xl/workbook.xml']) {
    throw new AppError('CORRUPT_DOCUMENT', 'The XLSX has no xl/workbook.xml part.', 422);
  }

  // Every XML part is read as text and walked with regular expressions, so each one's
  // size is bounded first, and the sheet, row and cell counts are bounded as they are read.
  for (const [name, part] of Object.entries(parts)) {
    if (name.endsWith('.xml') && part.length > limits.xmlPartMaxBytes) throw tooComplex();
  }

  const sharedStrings = parts['xl/sharedStrings.xml']
    ? readSharedStrings(strFromU8(parts['xl/sharedStrings.xml']), limits.xlsxMaxCells)
    : [];

  const sheets = readSheetIndex(parts);
  if (sheets.length > limits.xlsxMaxSheets) throw tooComplex();

  // Shared across the workbook: the ceilings are on the whole file, not per sheet.
  const budget = { rows: 0, cells: 0, maxRows: limits.xlsxMaxRows, maxCells: limits.xlsxMaxCells };

  const blocks = [];
  let characterCount = 0;

  for (const sheet of sheets) {
    const sheetPart = parts[sheet.path];
    if (!sheetPart) continue;

    const rows = readRows(strFromU8(sheetPart), sharedStrings, budget);
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

function tooComplex() {
  return new AppError(
    'DOCUMENT_TOO_COMPLEX',
    'The XLSX holds more content than this service can process.',
    422
  );
}

function readSharedStrings(xml, maxStrings) {
  const strings = [];
  for (const [, body] of xml.matchAll(/<si>([\s\S]*?)<\/si>/g)) {
    if (strings.length >= maxStrings) throw tooComplex();
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

function readRows(sheetXml, sharedStrings, budget) {
  const rows = [];

  for (const [, rowNumber, body] of sheetXml.matchAll(
    /<row[^>]*\br="(\d+)"[^>]*>([\s\S]*?)<\/row>/g
  )) {
    budget.rows += 1;
    if (budget.rows > budget.maxRows) throw tooComplex();
    const cells = [];

    for (const [, ref, attributes, inner] of body.matchAll(
      /<c[^>]*\br="([A-Z]+\d+)"([^>]*)(?:\/>|>([\s\S]*?)<\/c>)/g
    )) {
      budget.cells += 1;
      if (budget.cells > budget.maxCells) throw tooComplex();

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
