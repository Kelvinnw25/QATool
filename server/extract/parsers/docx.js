import { strFromU8, unzipSync } from 'fflate';
import { AppError } from '../../lib/errors.js';

/**
 * DOCX text and table extraction, straight from WordprocessingML.
 *
 * Written against the XML rather than through a converter because tables are
 * the point. The sample PRDs carry most of their requirements in tables - one
 * 4,800-character document held eleven of them - and flattening a table to
 * prose destroys the row/column relationship that carries the meaning. Here a
 * table row stays a row, with its header row attached.
 *
 * `page` is always null. DOCX has no fixed pagination; a page number would have
 * to be invented, and PRD 7 would rather record the shortfall than fabricate.
 */

const HEADING_STYLE = /^heading\s*([1-9])$/i;

export function parseDocx(buffer, documentId) {
  let parts;
  try {
    parts = unzipSync(new Uint8Array(buffer));
  } catch (cause) {
    throw new AppError('CORRUPT_DOCUMENT', `The DOCX could not be opened: ${cause.message}`, 422);
  }

  const documentPart = parts['word/document.xml'];
  if (!documentPart) {
    throw new AppError('CORRUPT_DOCUMENT', 'The DOCX has no word/document.xml part.', 422);
  }

  const xml = strFromU8(documentPart);
  const body = /<w:body[^>]*>([\s\S]*)<\/w:body>/.exec(xml)?.[1] ?? xml;

  const blocks = [];
  const headingPath = [];
  let characterCount = 0;

  // Paragraphs and tables are walked in document order so a table keeps the
  // heading that introduced it.
  for (const node of topLevelNodes(body)) {
    if (node.tag === 'w:tbl') {
      const rows = readTableRows(node.xml);
      if (rows.length === 0) continue;

      const [headerRow, ...dataRows] = rows;
      const looksHeadered = headerRow.every((cell) => cell.length > 0 && cell.length < 60);
      const headers = looksHeadered ? headerRow : [];
      const bodyRows = looksHeadered ? dataRows : rows;

      for (const cells of bodyRows) {
        const text = renderRow(headers, cells);
        if (text === '') continue;
        characterCount += text.length;

        blocks.push({
          kind: 'table-row',
          text,
          level: null,
          page: null,
          section: headingPath.join(' > ') || null,
          sheet: null,
          cell: null,
          table: { headers, cells },
        });
      }
      continue;
    }

    const text = readParagraphText(node.xml);
    if (text === '') continue;
    characterCount += text.length;

    const styleMatch = HEADING_STYLE.exec(
      /<w:pStyle[^>]*w:val="([^"]*)"/.exec(node.xml)?.[1] ?? ''
    );

    if (styleMatch) {
      const level = Number.parseInt(styleMatch[1], 10);
      headingPath.length = level - 1;
      headingPath[level - 1] = text;

      blocks.push({
        kind: 'heading',
        text,
        level,
        page: null,
        section: headingPath.filter(Boolean).join(' > '),
        sheet: null,
        cell: null,
        table: null,
      });
      continue;
    }

    blocks.push({
      kind: 'paragraph',
      text,
      level: null,
      page: null,
      section: headingPath.filter(Boolean).join(' > ') || null,
      sheet: null,
      cell: null,
      table: null,
    });
  }

  return {
    blocks,
    metrics: {
      // DOCX genuinely has no page count without laying the document out.
      page_count: null,
      extracted_char_count: characterCount,
      image_count: Object.keys(parts).filter((name) => name.startsWith('word/media/')).length,
    },
    documentId,
  };
}

/** Yields top-level <w:p> and <w:tbl> nodes in document order, skipping nesting. */
function* topLevelNodes(body) {
  const pattern = /<(w:p|w:tbl)(?:\s[^>]*)?(\/>|>)/g;
  let match;

  while ((match = pattern.exec(body)) !== null) {
    const tag = match[1];

    if (match[2] === '/>') continue; // empty element, nothing to read

    const close = `</${tag}>`;
    const end = findMatchingClose(body, pattern.lastIndex, tag, close);
    if (end === -1) continue;

    yield { tag, xml: body.slice(match.index, end + close.length) };
    pattern.lastIndex = end + close.length;
  }
}

/** Handles tables inside tables, and paragraphs inside table cells. */
function findMatchingClose(body, from, tag, close) {
  const open = new RegExp(`<${tag}(?:\\s[^>]*)?>`, 'g');
  open.lastIndex = from;

  let depth = 1;
  let cursor = from;

  while (depth > 0) {
    const nextClose = body.indexOf(close, cursor);
    if (nextClose === -1) return -1;

    open.lastIndex = cursor;
    const nextOpen = open.exec(body);

    if (nextOpen && nextOpen.index < nextClose) {
      depth += 1;
      cursor = nextOpen.index + nextOpen[0].length;
    } else {
      depth -= 1;
      if (depth === 0) return nextClose;
      cursor = nextClose + close.length;
    }
  }

  return -1;
}

function decodeXml(value) {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function readParagraphText(xml) {
  let text = '';
  for (const [, run] of xml.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)) {
    text += decodeXml(run);
  }
  // Word encodes tabs and breaks as empty elements rather than characters.
  if (/<w:tab\b/.test(xml)) text = text.replace(/\s+/g, ' ');
  return text.replace(/\s+/g, ' ').trim();
}

function readTableRows(tableXml) {
  const rows = [];

  for (const [, rowXml] of tableXml.matchAll(/<w:tr(?:\s[^>]*)?>([\s\S]*?)<\/w:tr>/g)) {
    const cells = [];
    for (const [, cellXml] of rowXml.matchAll(/<w:tc(?:\s[^>]*)?>([\s\S]*?)<\/w:tc>/g)) {
      cells.push(readParagraphText(cellXml));
    }
    if (cells.length > 0) rows.push(cells);
  }

  return rows;
}

/**
 * Renders a row as "Header: value" pairs so the column each value belongs to
 * survives into the requirement text.
 */
function renderRow(headers, cells) {
  if (headers.length === 0) {
    return cells.filter(Boolean).join(' | ').trim();
  }

  return cells
    .map((cell, index) => {
      const header = headers[index];
      if (!cell) return '';
      return header ? `${header}: ${cell}` : cell;
    })
    .filter(Boolean)
    .join(' | ')
    .trim();
}
