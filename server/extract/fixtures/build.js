import { strToU8, zipSync } from 'fflate';

/**
 * Synthetic document builders for the extraction tests.
 *
 * Built in memory rather than committed as binary fixtures for two reasons: the
 * real source documents are confidential bank material and must never enter the
 * repository, and a fixture whose content is visible in the test file is far
 * easier to reason about than an opaque blob.
 */

const FIXED_MTIME = new Date('2020-01-01T00:00:00Z');

function zip(files) {
  const entries = Object.fromEntries(
    Object.entries(files).map(([name, content]) => [name, strToU8(content)])
  );
  const options = Object.fromEntries(
    Object.keys(entries).map((name) => [name, { mtime: FIXED_MTIME }])
  );
  return Buffer.from(zipSync(entries, options));
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/* -------------------------------------------------------------- PDF ----- */

function escapePdfText(value) {
  return String(value).replace(/([()\\])/g, '\\$1');
}

/**
 * A minimal but structurally valid PDF with one text block per line.
 *
 * A line is a string, drawn 20pt below the one before it, or {text, x, y} to
 * place it - the content stream is written in array order either way, which is
 * how a test reproduces a PDF whose stream order differs from its reading order.
 * An optional `size` sets that line's font size (12 otherwise), for text set
 * smaller than the body, such as an inline label. {border: [x, bottom, top]} draws
 * a table's vertical cell border there instead: a 1pt-wide filled rule, painted
 * before the text, as a Confluence export paints its table grid. {rect: [x0,
 * bottom, x1, top], op} draws any other rectangle, filled ('f', the default) or
 * as a clipping path ('W n').
 *
 * @param {Array<Array<string | {text: string, x: number, y: number, size?: number} | {border: [number, number, number]} | {rect: [number, number, number, number], op?: string}>>} pages  lines, one array per page
 */
export function buildPdf(pages) {
  const objects = [];
  const add = (body) => {
    objects.push(body);
    return objects.length;
  };

  const contentIds = pages.map((page) => {
    const lines = page.filter((line) => !line.border && !line.rect);
    const graphics = page
      .filter((line) => line.border || line.rect)
      .map(({ border, rect, op = 'f' }) => {
        const [x0, bottom, x1, top] = border
          ? [border[0] - 0.5, border[1], border[0] + 0.5, border[2]]
          : rect;
        const path = `${x0} ${bottom} ${x1 - x0} ${top - bottom} re`;
        return border ? `${path} f ` : `q ${path} ${op} Q `;
      })
      .join('');
    const stream =
      graphics +
      'BT /F1 12 Tf ' +
      lines
        .map((line, index) => {
          const {
            text,
            x = 50,
            y = 720 - index * 20,
            size,
          } = typeof line === 'string' ? { text: line } : line;
          const drawn = `1 0 0 1 ${x} ${y} Tm (${escapePdfText(text)}) Tj`;
          return size === undefined ? drawn : `/F1 ${size} Tf ${drawn} /F1 12 Tf`;
        })
        .join(' ') +
      ' ET';
    return add(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  });

  const fontId = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');

  // The Pages object is written after the Page objects, so its id has to be
  // known in advance for each page's /Parent back-reference.
  const pagesId = objects.length + pages.length + 1;
  const kidIds = pages.map((unused, index) =>
    add(
      `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 612 792] ` +
        `/Contents ${contentIds[index]} 0 R ` +
        `/Resources << /Font << /F1 ${fontId} 0 R >> >> >>`
    )
  );

  const realPagesId = add(
    `<< /Type /Pages /Kids [${kidIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${kidIds.length} >>`
  );
  const catalogId = add(`<< /Type /Catalog /Pages ${realPagesId} 0 R >>`);

  let out = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((body, index) => {
    offsets.push(out.length);
    out += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });

  const xrefOffset = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objects.length; i += 1) {
    out += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  }
  out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R >>\n`;
  out += `startxref\n${xrefOffset}\n%%EOF`;

  return Buffer.from(out, 'latin1');
}

/* ------------------------------------------------------------- DOCX ----- */

/**
 * @param {Array<{heading?: string, level?: number, text?: string, table?: string[][]}>} blocks
 */
export function buildDocx(blocks) {
  const body = blocks
    .map((block) => {
      if (block.heading !== undefined) {
        const level = block.level ?? 1;
        return (
          `<w:p><w:pPr><w:pStyle w:val="Heading${level}"/></w:pPr>` +
          `<w:r><w:t xml:space="preserve">${escapeXml(block.heading)}</w:t></w:r></w:p>`
        );
      }

      if (block.table) {
        const rows = block.table
          .map(
            (row) =>
              '<w:tr>' +
              row
                .map(
                  (cell) =>
                    `<w:tc><w:p><w:r><w:t xml:space="preserve">${escapeXml(cell)}</w:t></w:r></w:p></w:tc>`
                )
                .join('') +
              '</w:tr>'
          )
          .join('');
        return `<w:tbl>${rows}</w:tbl>`;
      }

      return `<w:p><w:r><w:t xml:space="preserve">${escapeXml(block.text ?? '')}</w:t></w:r></w:p>`;
    })
    .join('');

  return zip({
    '[Content_Types].xml':
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
      '</Types>',
    '_rels/.rels':
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
      '</Relationships>',
    'word/document.xml':
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
      `<w:body>${body}</w:body></w:document>`,
  });
}

/* ------------------------------------------------------------- XLSX ----- */

/**
 * @param {Array<{name: string, rows: string[][]}>} sheets
 */
export function buildXlsx(sheets) {
  const strings = [];
  const indexOf = (text) => {
    const existing = strings.indexOf(text);
    if (existing !== -1) return existing;
    strings.push(text);
    return strings.length - 1;
  };

  const columnLetter = (index) => {
    let result = '';
    let remaining = index;
    while (remaining > 0) {
      const modulo = (remaining - 1) % 26;
      result = String.fromCharCode(65 + modulo) + result;
      remaining = Math.floor((remaining - modulo) / 26);
    }
    return result;
  };

  const sheetFiles = {};
  sheets.forEach((sheet, sheetIndex) => {
    const rows = sheet.rows
      .map((cells, rowIndex) => {
        const rowNumber = rowIndex + 1;
        const cellXml = cells
          .map((value, columnIndex) => {
            if (value === '' || value === null || value === undefined) return '';
            const ref = `${columnLetter(columnIndex + 1)}${rowNumber}`;
            if (typeof value === 'number') return `<c r="${ref}"><v>${value}</v></c>`;
            return `<c r="${ref}" t="s"><v>${indexOf(String(value))}</v></c>`;
          })
          .join('');
        return `<row r="${rowNumber}">${cellXml}</row>`;
      })
      .join('');

    sheetFiles[`xl/worksheets/sheet${sheetIndex + 1}.xml`] =
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      `<sheetData>${rows}</sheetData></worksheet>`;
  });

  const sheetEntries = sheets
    .map(
      (sheet, index) =>
        `<sheet name="${escapeXml(sheet.name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`
    )
    .join('');

  const relationships = sheets
    .map(
      (unused, index) =>
        `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`
    )
    .join('');

  return zip({
    '[Content_Types].xml':
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      '</Types>',
    '_rels/.rels':
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
      '</Relationships>',
    'xl/workbook.xml':
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
      'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
      `<sheets>${sheetEntries}</sheets></workbook>`,
    'xl/_rels/workbook.xml.rels':
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      `${relationships}</Relationships>`,
    'xl/sharedStrings.xml':
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      `<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${strings.length}" uniqueCount="${strings.length}">` +
      strings.map((text) => `<si><t xml:space="preserve">${escapeXml(text)}</t></si>`).join('') +
      '</sst>',
    ...sheetFiles,
  });
}
