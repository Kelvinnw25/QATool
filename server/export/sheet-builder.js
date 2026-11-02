import { escapeXml, retargetRange, stripInvalidXmlChars } from './xml.js';
import { COLUMN_STYLES } from './template.js';

/** Sheet column letters, in template order. */
export const COLUMN_LETTERS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I'];

/** Row 1 is the header, so data begins at row 2. */
export const FIRST_DATA_ROW = 2;

/**
 * Collects every distinct string and hands back sharedStrings indices, the way
 * Excel itself stores text. Section values repeat heavily across a SIT script,
 * so deduplicating is worth the small amount of bookkeeping.
 */
function createStringTable() {
  const indices = new Map();
  const order = [];
  let references = 0;

  return {
    intern(value) {
      const text = stripInvalidXmlChars(value);
      references += 1;
      if (!indices.has(text)) {
        indices.set(text, order.length);
        order.push(text);
      }
      return indices.get(text);
    },
    toXml() {
      const items = order
        .map((text) => `<si><t xml:space="preserve">${escapeXml(text)}</t></si>`)
        .join('');
      return (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
        `count="${references}" uniqueCount="${order.length}">${items}</sst>`
      );
    },
  };
}

function cell(reference, styleId, stringIndex) {
  // An empty value still gets a styled cell so borders stay continuous and the
  // Status / Tested By dropdowns have somewhere to attach.
  if (stringIndex === null) {
    return `<c r="${reference}" s="${styleId}"/>`;
  }
  return `<c r="${reference}" s="${styleId}" t="s"><v>${stringIndex}</v></c>`;
}

function buildRow(rowNumber, values, strings) {
  const cells = values
    .map((value, column) => {
      const reference = `${COLUMN_LETTERS[column]}${rowNumber}`;
      const styleId = COLUMN_STYLES[column];
      const text = value ?? '';
      return cell(reference, styleId, text === '' ? null : strings.intern(text));
    })
    .join('');

  return `<row r="${rowNumber}">${cells}</row>`;
}

/**
 * Rewrites the dropdown ranges to span the rows actually written.
 *
 * The template pins every validation to rows 2:20 because it shipped with 19
 * sample rows. Leaving that untouched would mean a 40-case export loses its
 * dropdowns from row 21 down, and a 5-case export offers them on empty rows.
 * formula1 is copied verbatim - only the row span moves.
 */
function buildDataValidations(validations, lastRow) {
  if (validations.length === 0) return '';

  const rewritten = validations
    .map(({ attributes, sqref, body }) => {
      const retargeted = retargetRange(sqref, FIRST_DATA_ROW, lastRow);
      const updated = attributes.replace(/sqref="[^"]*"/, `sqref="${retargeted}"`);
      return `<dataValidation ${updated}>${body}</dataValidation>`;
    })
    .join('');

  return `<dataValidations>${rewritten}</dataValidations>`;
}

/**
 * Builds the three parts that change. Everything else in the workbook - styles,
 * theme, drawing, persons, workbook, relationships, content types - is copied
 * across untouched by the caller.
 *
 * @param {object}   template  from loadTemplate()
 * @param {object[]} rows      mapped rows, in export order
 */
export function buildSheetParts(template, rows) {
  const strings = createStringTable();

  const headerCells = template.headers
    .map((label, column) =>
      cell(`${COLUMN_LETTERS[column]}1`, template.headerStyleId, strings.intern(label))
    )
    .join('');

  const dataRows = rows.map((row, index) =>
    buildRow(
      FIRST_DATA_ROW + index,
      [
        row.case_id,
        row.section,
        row.test_case,
        row.case_type,
        row.priority,
        row.type,
        row.expected_result,
        row.status,
        row.tested_by,
      ],
      strings
    )
  );

  // With no data rows there is no row 2 to point at, but the dropdowns and the
  // table still need a legal one-row range, so they collapse onto row 2.
  const lastRow = Math.max(FIRST_DATA_ROW, FIRST_DATA_ROW + rows.length - 1);

  const sheetXml =
    template.prefix +
    `<sheetData><row r="1">${headerCells}</row>${dataRows.join('')}</sheetData>` +
    template.suffix.replace(
      /<dataValidations[^>]*>.*?<\/dataValidations>/s,
      buildDataValidations(template.dataValidations, lastRow)
    );

  return {
    sheetXml,
    sharedStringsXml: strings.toXml(),
    tableRef: template.tableRef ? retargetRange(template.tableRef, FIRST_DATA_ROW, lastRow) : null,
    lastRow,
  };
}

/** Retargets the table definition without disturbing its style or columns. */
export function buildTableXml(tableXml, newRef) {
  return tableXml.replace(/\bref="[^"]*"/, `ref="${newRef}"`);
}
