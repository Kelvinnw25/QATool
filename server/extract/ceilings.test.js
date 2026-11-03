import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { strToU8, zipSync } from 'fflate';

import { loadSecuritySettings } from '../security/settings.js';
import { parseDocx } from './parsers/docx.js';
import { parseXlsx } from './parsers/xlsx.js';

/**
 * The ceilings on spreadsheet and Word documents: sheets, rows, cells, and the size of any
 * one XML part. They are technical limits on how much a regular-expression reader walks,
 * not product rules, and every one is enforced as the data is read.
 */

const strict = loadSecuritySettings({ PUBLIC_DEMO: 'true' }).limits;
const local = loadSecuritySettings({}).limits;

const workbook = (sheets) =>
  `<workbook><sheets>${sheets
    .map((_, i) => `<sheet name="S${i + 1}" r:id="rId${i + 1}"/>`)
    .join('')}</sheets></workbook>`;
const rels = (sheets) =>
  `<Relationships>${sheets
    .map((_, i) => `<Relationship Id="rId${i + 1}" Target="worksheets/sheet${i + 1}.xml"/>`)
    .join('')}</Relationships>`;

/** An .xlsx whose sheets are `{ rows, cols }`. */
function xlsx(sheets, extra = {}) {
  const parts = {
    'xl/workbook.xml': strToU8(workbook(sheets)),
    'xl/_rels/workbook.xml.rels': strToU8(rels(sheets)),
    ...extra,
  };
  sheets.forEach(({ rows, cols }, index) => {
    let body = '';
    for (let r = 1; r <= rows; r += 1) {
      body += `<row r="${r}">`;
      for (let c = 0; c < cols; c += 1) {
        body += `<c r="${String.fromCharCode(65 + (c % 26))}${r}" t="inlineStr"><is><t>v${r}-${c}</t></is></c>`;
      }
      body += '</row>';
    }
    parts[`xl/worksheets/sheet${index + 1}.xml`] = strToU8(
      `<worksheet><sheetData>${body}</sheetData></worksheet>`
    );
  });
  return Buffer.from(zipSync(parts));
}

const docx = (xml) => Buffer.from(zipSync({ 'word/document.xml': strToU8(xml) }));

const tooComplex = (run) =>
  assert.throws(run, (error) => {
    assert.equal(error.code, 'DOCUMENT_TOO_COMPLEX');
    assert.equal(error.statusCode, 422);
    return true;
  });

const small = {
  ...strict,
  xlsxMaxSheets: 2,
  xlsxMaxRows: 10,
  xlsxMaxCells: 30,
  xmlPartMaxBytes: 4000,
};

describe('spreadsheet ceilings', () => {
  it('reads a workbook that is within every ceiling', () => {
    const parsed = parseXlsx(xlsx([{ rows: 5, cols: 3 }]), 'DOC-001', small);
    assert.ok(parsed.blocks.length > 0);
  });

  it('refuses more sheets than the ceiling', () => {
    const three = xlsx([1, 2, 3].map(() => ({ rows: 1, cols: 1 })));
    tooComplex(() => parseXlsx(three, 'DOC-001', small));
    parseXlsx(xlsx([1, 2].map(() => ({ rows: 1, cols: 1 }))), 'DOC-001', small);
  });

  it('refuses more rows than the ceiling, counted across all sheets', () => {
    tooComplex(() => parseXlsx(xlsx([{ rows: 11, cols: 1 }]), 'DOC-001', small));
    tooComplex(() =>
      parseXlsx(
        xlsx([
          { rows: 6, cols: 1 },
          { rows: 5, cols: 1 },
        ]),
        'DOC-001',
        small
      )
    );
    parseXlsx(
      xlsx([
        { rows: 5, cols: 1 },
        { rows: 5, cols: 1 },
      ]),
      'DOC-001',
      small
    );
  });

  it('refuses more cells than the ceiling, to the cell', () => {
    parseXlsx(xlsx([{ rows: 10, cols: 3 }]), 'DOC-001', small); // exactly 30
    tooComplex(() => parseXlsx(xlsx([{ rows: 5, cols: 7 }]), 'DOC-001', small)); // 35
  });

  it('refuses an XML part larger than the ceiling, however few cells it holds', () => {
    const padded = xlsx([{ rows: 1, cols: 1 }], {
      'xl/sharedStrings.xml': strToU8(
        `<sst>${'<si><t>x</t></si>'.repeat(1)}${' '.repeat(5000)}</sst>`
      ),
    });
    tooComplex(() => parseXlsx(padded, 'DOC-001', small));
  });

  it('refuses a shared-strings table with more entries than there may be cells', () => {
    const strings = Array.from({ length: 40 }, (_, i) => `<si><t>s${i}</t></si>`).join('');
    const many = xlsx([{ rows: 1, cols: 1 }], {
      'xl/sharedStrings.xml': strToU8(`<sst>${strings}</sst>`),
    });
    tooComplex(() => parseXlsx(many, 'DOC-001', small));
  });

  it('stops counting as soon as a ceiling is crossed, not after reading the rest', () => {
    // Fifty thousand rows against a ceiling of ten: refused without walking them all.
    const huge = xlsx([{ rows: 50_000, cols: 1 }]);
    const started = performance.now();
    tooComplex(() => parseXlsx(huge, 'DOC-001', { ...small, xmlPartMaxBytes: 64 * 1024 * 1024 }));
    assert.ok(performance.now() - started < 1000);
  });

  it('has an exact boundary at the demo defaults: 200,000 cells pass, one more does not', () => {
    const atLimit = xlsx([{ rows: 20_000, cols: 10 }]);
    assert.doesNotThrow(() => parseXlsx(atLimit, 'DOC-001', strict));

    const over = xlsx([{ rows: 20_001, cols: 10 }]);
    tooComplex(() => parseXlsx(over, 'DOC-001', strict));
  });

  it('is generous locally: the same workbook is fine with the local defaults', () => {
    assert.doesNotThrow(() => parseXlsx(xlsx([{ rows: 21_000, cols: 10 }]), 'DOC-001', local));
    assert.ok(local.xlsxMaxCells > strict.xlsxMaxCells);
    assert.ok(local.xmlPartMaxBytes > strict.xmlPartMaxBytes);
  });

  it('still reports a file that is not a spreadsheet as corrupt, not as too complex', () => {
    assert.throws(
      () => parseXlsx(Buffer.from('not a zip'), 'DOC-001', small),
      (error) => error.code === 'CORRUPT_DOCUMENT'
    );
    assert.throws(
      () => parseXlsx(Buffer.from(zipSync({ 'a.txt': strToU8('x') })), 'DOC-001', small),
      (error) => error.code === 'CORRUPT_DOCUMENT'
    );
  });
});

describe('Word document ceilings', () => {
  const body = (paragraphs) =>
    `<w:document><w:body>${Array.from({ length: paragraphs }, (_, i) => `<w:p><w:r><w:t>Paragraph ${i} must hold.</w:t></w:r></w:p>`).join('')}</w:body></w:document>`;

  it('reads a document within the ceiling and refuses one over it, by size of document.xml', () => {
    const limits = { ...strict, xmlPartMaxBytes: 5000 };
    assert.ok(parseDocx(docx(body(10)), 'DOC-001', limits).blocks.length === 10);
    tooComplex(() => parseDocx(docx(body(500)), 'DOC-001', limits));
  });

  it('applies the size check to the inflated part, not the file: a small file can hold a large part', () => {
    const inflated = docx(`<w:document><w:body>${' '.repeat(200_000)}</w:body></w:document>`);
    assert.ok(inflated.length < 2000, 'a few hundred bytes on the wire');
    tooComplex(() => parseDocx(inflated, 'DOC-001', { ...strict, xmlPartMaxBytes: 100_000 }));
  });

  it('has a demo default of 16 MiB and a local one of 64 MiB', () => {
    assert.equal(strict.xmlPartMaxBytes, 16 * 1024 * 1024);
    assert.equal(local.xmlPartMaxBytes, 64 * 1024 * 1024);
  });
});

describe('the ceilings can be set', () => {
  it('from the environment, each by its own name', () => {
    const { limits } = loadSecuritySettings({
      PUBLIC_DEMO: 'true',
      XLSX_MAX_SHEETS: '3',
      XLSX_MAX_ROWS: '40',
      XLSX_MAX_CELLS: '500',
      XML_PART_MAX_BYTES: '1000000',
      PDF_MAX_PAGES: '90',
    });
    assert.deepEqual(
      [
        limits.xlsxMaxSheets,
        limits.xlsxMaxRows,
        limits.xlsxMaxCells,
        limits.xmlPartMaxBytes,
        limits.pdfMaxPages,
      ],
      [3, 40, 500, 1_000_000, 90]
    );
  });

  it('and a malformed one is a startup problem that names the variable, not a silent default', () => {
    const settings = loadSecuritySettings({
      PUBLIC_DEMO: 'true',
      XLSX_MAX_ROWS: 'lots',
      PDF_MAX_PAGES: '-5',
    });
    assert.ok(settings.problems.some((problem) => problem.includes('XLSX_MAX_ROWS')));
    assert.ok(settings.problems.some((problem) => problem.includes('PDF_MAX_PAGES')));
    assert.ok(!settings.problems.join(' ').includes('lots'));
  });
});
