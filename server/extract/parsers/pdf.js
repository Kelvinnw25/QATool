import { AppError } from '../../lib/errors.js';

/**
 * PDF text extraction.
 *
 * pdfjs hands back positioned text items rather than lines, so items are
 * grouped by their Y coordinate to rebuild lines, then lines are grouped into
 * paragraphs. Page numbers come straight from the document, which is why PDF is
 * the one format where a real page number can be recorded.
 *
 * No OCR: a page whose content is an image yields no text, and that is reported
 * rather than guessed around. What IS new is that it is reported by name and
 * page, as a block the rest of the pipeline can see - see imageRegionBlocks.
 */

/** Two text items within this many points vertically are on the same line. */
const LINE_TOLERANCE = 2;

/**
 * Rejoining wrapped lines.
 *
 * A PDF has no paragraphs, only glyphs at coordinates, so a sentence that runs
 * past the margin arrives as two unrelated lines. Treating each line as a block
 * splits requirements in half - and worse, the first half of a wrapped sentence
 * is capitalised and unpunctuated, which is exactly what a heading looks like.
 * A synthetic evaluation lost a documented error code that way: the condition
 * became a "heading", and the remainder was one character too short to survive
 * requirement selection, so the rule vanished with no warning anywhere.
 *
 * Three signals decide whether a line continues the one above it, and none of
 * them is capitalisation:
 *
 *   punctuation  a line ending in . ! ? finished its sentence
 *   continuation a line starting lowercase, or with a digit or comma, is a tail
 *   geometry     a line that runs to the right margin ran out of room, and a
 *                vertical gap wider than the page's usual leading is a break
 *
 * Over-joining costs a reviewer a run-on requirement they can read. Under
 * joining costs a requirement nobody knows is missing, so the tie goes to
 * joining.
 */
const ENDS_SENTENCE = /[.!?]["')\]]?$/;
const CONTINUES_SENTENCE = /^[\p{Ll}0-9,;)\]]/u;
const NUMBERED_HEADING = /^\d+(\.\d+)*[.)]?\s+\S/;

/** A line at least this share of the widest line on the page reached the margin. */
const FULL_WIDTH_RATIO = 0.85;

/** A vertical gap this much larger than the page's usual leading starts a block. */
const PARAGRAPH_GAP_RATIO = 1.6;

let pdfjsPromise = null;

function loadPdfjs() {
  // The legacy build is the one pdfjs supports in Node. Loaded lazily so the
  // server starts without paying for it until a PDF actually arrives.
  pdfjsPromise ??= import('pdfjs-dist/legacy/build/pdf.mjs');
  return pdfjsPromise;
}

/**
 * A block that looks like a heading.
 *
 * The first test is the important one: a heading occupies one line. Anything
 * that had to wrap is prose, whatever its capitalisation, and refusing to call
 * it a heading is what keeps a requirement's condition attached to its outcome.
 */
function looksLikeHeading(block) {
  if (block.lineCount > 1) return false;

  const text = block.text;
  if (text.length > 90) return false;
  if (/[.;:,]$/.test(text)) return false;

  return (
    NUMBERED_HEADING.test(text) || // "3.2 Business Rules"
    /^[A-Z][A-Za-z0-9 /&'-]+$/.test(text) || // Title Case line
    text === text.toUpperCase()
  );
}

/**
 * A drawn image this many points on a side is big enough to carry a table.
 *
 * Set well above an icon or a logo and well below a full page. The PRD's report
 * format is drawn at roughly 450 x 267; the signature marks and status chips
 * that pepper a Confluence export are an order of magnitude smaller.
 */
const MIN_SPEC_IMAGE_WIDTH = 120;

/**
 * And this tall. Lower than the width because a table drawn across the page is
 * wide and short - the real PRD's report format splits into two images, the
 * second only 76 points high - while a signature or a status chip is small in
 * both directions.
 */
const MIN_SPEC_IMAGE_HEIGHT = 50;

/**
 * And this much area, which is what separates a table from a status chip.
 *
 * A Jira "Done" badge in this document draws at 124 x 51 - over both minimums,
 * and 6,324 square points. The report format's shorter half is 224 x 75, or
 * 16,800. Eight thousand sits clear of both.
 */
const MIN_SPEC_IMAGE_AREA = 8000;

/** How far above an image to look for the sentence that introduces it. */
const LEAD_IN_DISTANCE = 60;

/**
 * Pages whose specification content is a picture.
 *
 * This does NOT read the image, and deliberately so. The report format on page
 * 6 of the real PRD is a raster table: "Report format to be generated as shown
 * below:" is followed, in the text layer, by nothing at all. Verified three
 * ways - pdftotext returns nothing for the region, the only /Alt text is
 * Confluence's placeholder "Story", and the strings inside it (TRX_DATE,
 * v_qr_release_settlement) appear nowhere in the raw PDF bytes. The content
 * exists solely as pixels.
 *
 * So the pipeline could not have seen it, and said nothing about not seeing it.
 * That silence is the defect this closes: seventeen required report columns, two
 * stated formats, a join key and a validation rule were absent from every
 * coverage figure QATOOL has ever produced for this document, and no warning
 * named the page.
 *
 * What this emits is a truthful block - this page region carries content that
 * was not read, here is the sentence that introduces it - and nothing more. It
 * does not transcribe, because transcribing means either an OCR engine or a
 * vision model, and both would make a requirement's source text a transcription
 * rather than the document's own words. In a tool whose guarantee is that the
 * model cites block ids while the system rebuilds the text verbatim, that is a
 * change to what the guarantee means, and it is not one to make quietly.
 */
async function imageRegionBlocks(page, pageNumber, lines, pdfjs) {
  const operators = await page.getOperatorList();
  const regions = [];

  // The transform in effect when an image is painted carries its drawn size:
  // [a, b, c, d, e, f] with |a| and |d| the width and height in points.
  const stack = [];
  let current = [1, 0, 0, 1, 0, 0];

  for (let index = 0; index < operators.fnArray.length; index += 1) {
    const fn = operators.fnArray[index];
    const args = operators.argsArray[index];

    if (fn === pdfjs.OPS.save) stack.push(current.slice());
    else if (fn === pdfjs.OPS.restore) current = stack.pop() ?? current;
    else if (fn === pdfjs.OPS.transform) current = multiply(current, args);
    else if (fn === pdfjs.OPS.paintImageXObject || fn === pdfjs.OPS.paintJpegXObject) {
      const width = Math.abs(current[0]);
      const height = Math.abs(current[3]);
      if (
        width >= MIN_SPEC_IMAGE_WIDTH &&
        height >= MIN_SPEC_IMAGE_HEIGHT &&
        width * height >= MIN_SPEC_IMAGE_AREA
      ) {
        regions.push({
          width: Math.round(width),
          height: Math.round(height),
          bottom: current[5],
          top: current[5] + height,
        });
      }
    }
  }

  return regions.map((region) => {
    // The sentence above the image usually says what it is - "Report format to
    // be generated as shown below:", "Current Export Button:", "Example:" - and
    // it is the only honest description available without reading the pixels.
    // PDF y grows upward, so the line introducing an image sits just ABOVE its
    // top edge: the smallest y greater than region.top.
    const above = lines
      .filter((line) => line.y >= region.top && line.y - region.top < LEAD_IN_DISTANCE)
      .sort((left, right) => left.y - right.y)[0];

    const leadIn = above?.text?.trim() ?? '';

    return {
      kind: 'image_region',
      text: leadIn
        ? `[Image on page ${pageNumber}, ${region.width}x${region.height}pt, introduced by: "${leadIn}". Its content is not in the PDF text layer and was not read.]`
        : `[Image on page ${pageNumber}, ${region.width}x${region.height}pt. Its content is not in the PDF text layer and was not read.]`,
      level: null,
      page: pageNumber,
      section: null,
      sheet: null,
      cell: null,
      table: null,
      lead_in: leadIn || null,
      width_pt: region.width,
      height_pt: region.height,
    };
  });
}

/** 3x2 affine multiply, in the order pdfjs applies transforms. */
function multiply(base, next) {
  return [
    base[0] * next[0] + base[2] * next[1],
    base[1] * next[0] + base[3] * next[1],
    base[0] * next[2] + base[2] * next[3],
    base[1] * next[2] + base[3] * next[3],
    base[0] * next[4] + base[2] * next[5] + base[4],
    base[1] * next[4] + base[3] * next[5] + base[5],
  ];
}

export async function parsePdf(buffer, documentId) {
  const pdfjs = await loadPdfjs();

  let loadingTask;
  let document;
  try {
    loadingTask = pdfjs.getDocument({
      data: new Uint8Array(buffer),
      isEvalSupported: false,
      useSystemFonts: false,
      // Keep pdfjs quiet: its warnings are about rendering, which we never do.
      verbosity: 0,
    });
    document = await loadingTask.promise;
  } catch (cause) {
    throw new AppError('PARSER_FAILURE', `The PDF could not be opened: ${cause.message}`, 422);
  }

  const blocks = [];
  let characterCount = 0;
  let imageRegionCount = 0;
  const headingStack = [];
  // Where each heading sits, for attribution (see reattribute). Kept beside the
  // blocks rather than on them, so a block's shape does not change.
  const headingPlaces = new Map();
  let lastHeading = null;
  // The place of the heading a page ended on, when it was drawn out of reading
  // order (see settleCarried); decided when that page is done.
  let carriedLate = null;
  // Set while the criteria of a scenario whose name was not read as a heading
  // are being read (see the paragraph loop); cleared by the next heading.
  let unnamedScenario = false;
  const pageCount = document.numPages;

  try {
    for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      const borders = cellBorders(await page.getOperatorList(), pdfjs);
      const lines = groupIntoLines(content.items, borders);
      const leading = lineSpacing(lines);
      const misplaced = [];
      // What this page's text inherits from an earlier page, and where all of
      // its text sits in stream order.
      const carried = [];
      const placed = [];
      // The block read just before, for a criterion split from its scenario's
      // cell (see splitAtCellBorder): [paragraph, was it a heading].
      let previous = null;

      for (const paragraph of groupIntoParagraphs(lines)) {
        characterCount += paragraph.text.length;

        if (looksLikeHeading(paragraph)) {
          unnamedScenario = false;
          previous = [paragraph, true];
          headingStack.length = 0;
          headingStack.push(paragraph.text);
          lastHeading = {
            kind: 'heading',
            text: paragraph.text,
            level: 1,
            page: pageNumber,
            section: paragraph.text,
            sheet: null,
            cell: null,
            table: null,
          };
          const place = { page: pageNumber, ...placeOf(paragraph) };
          headingPlaces.set(lastHeading, place);
          placed.push(place);
          blocks.push(lastHeading);
          continue;
        }

        // A criterion whose scenario cell beside it is not a heading: the
        // section in force is the previous scenario's, which would be a guess.
        // Nothing is named until the next heading.
        if (
          paragraph.cellStart &&
          previous &&
          !previous[1] &&
          Math.abs(previous[0].bottom - paragraph.top) <= LINE_TOLERANCE
        ) {
          unnamedScenario = true;
        }
        previous = [paragraph, false];

        const block = {
          kind: 'paragraph',
          text: paragraph.text,
          level: null,
          page: pageNumber,
          section: unnamedScenario ? null : (headingStack.at(-1) ?? null),
          sheet: null,
          cell: null,
          table: null,
        };

        const heading = headingPlaces.get(lastHeading);
        if (unnamedScenario) {
          // Left unresolved; no later rule names it either.
        } else if (heading?.page === pageNumber && liesBelow(heading, paragraph, leading)) {
          misplaced.push({
            block,
            paragraph,
            owner: headingAbove(paragraph, pageNumber, headingPlaces),
          });
        } else if (heading && heading.page < pageNumber) {
          carried.push({ block, paragraph });
        }

        placed.push(placeOf(paragraph));
        blocks.push(block);
      }

      reattribute(misplaced, headingPlaces);
      if (carriedLate) settleCarried(carried, pageNumber, headingPlaces, carriedLate);
      const ended = headingPlaces.get(lastHeading);
      if (ended?.page === pageNumber) {
        carriedLate = drawnLate(ended, placed, leading) ? ended : null;
      }

      // After the text, so an image block sits where the page puts it.
      for (const region of await imageRegionBlocks(page, pageNumber, lines, pdfjs)) {
        imageRegionCount += 1;
        blocks.push({ ...region, section: headingStack.at(-1) ?? null });
      }

      page.cleanup();
    }
  } catch (cause) {
    throw new AppError('PARSER_FAILURE', `The PDF could not be read: ${cause.message}`, 422);
  } finally {
    // destroy() lives on the loading task; the document proxy only has
    // cleanup(). Releasing the task is what frees the worker.
    await loadingTask.destroy();
  }

  return {
    blocks,
    metrics: {
      page_count: pageCount,
      extracted_char_count: characterCount,
      image_region_count: imageRegionCount,
    },
    documentId,
  };
}

/**
 * Section attribution when the content stream runs out of reading order.
 *
 * A block's section is the last heading read before it, and "before" means the
 * content stream - which is not always the order a person reads the page in.
 * The sanitized Routing PRD draws each page's numbered headings first and the
 * table cells after them, so the cell continuing at the top of page 5 (the
 * INACTIVE branch of MPM Cross Border Payment) was read after "3. QRIS TUNTAS"
 * at the bottom of that page and filed under it. Page 8 does the same to the
 * switching matrix, filed under "Rollout Plan" printed below it.
 *
 * The evidence is geometric, not textual: a heading sits above what it heads,
 * so a heading on the same page that lies wholly below a paragraph - more than
 * a line below its last line, and across the same horizontal span - cannot be
 * that paragraph's section. Only then is anything changed. Cells of one table
 * row sit within a line of each other and are left alone, as is text in another
 * column, and nothing about the wording is consulted.
 *
 * The heading that does head it is the nearest one above it on its page, else
 * the lowest on the last page that had one - the section a reader is in when
 * the page turns. That is only trusted when what it would head is laid out
 * under it: if any paragraph claiming it starts left of it, the run is not
 * that heading's continuation but something new whose own heading the parser
 * did not recognise (a fresh table row at the top of a page, say), and the
 * section is null. No section is better than a wrong one, and with neither
 * candidate it is null too.
 *
 * Only the section changes. Blocks stay in stream order, deliberately: the
 * fallback's dedup context is the heading occurrence a block follows, and
 * moving a block into another heading's run would let it merge with text
 * there - measured on a real PRD, where a new scenario's "THEN the system must
 * fulfill:" moved under the previous scenario's and disappeared. Headings,
 * text, lines and paragraphs are untouched.
 */
function placeOf(paragraph) {
  return {
    top: paragraph.top,
    bottom: paragraph.bottom,
    left: paragraph.left,
    right: paragraph.right,
  };
}

function liesBelow(heading, paragraph, leading) {
  const overlaps = heading.left < paragraph.right && paragraph.left < heading.right;
  return overlaps && heading.top < paragraph.bottom - Math.max(leading, LINE_TOLERANCE);
}

/** The heading read so far that sits nearest above a paragraph, as [block, place]. */
function headingAbove(paragraph, pageNumber, headingPlaces) {
  // Insertion order is stream order, so on a tie the later heading wins.
  const lowest = (entries) =>
    entries.reduce(
      (best, entry) => (!best || entry[1].top <= best[1].top + LINE_TOLERANCE ? entry : best),
      null
    );
  const entries = [...headingPlaces];

  const above = entries.filter(
    ([, place]) => place.page === pageNumber && place.top > paragraph.top + LINE_TOLERANCE
  );
  const earlierPage = Math.max(
    0,
    ...entries.filter(([, place]) => place.page < pageNumber).map(([, place]) => place.page)
  );
  return lowest(above) ?? lowest(entries.filter(([, place]) => place.page === earlierPage));
}

function reattribute(misplaced, headingPlaces) {
  const byOwner = new Map();
  for (const entry of misplaced) {
    const heading = entry.owner?.[0] ?? null;
    byOwner.set(heading, [...(byOwner.get(heading) ?? []), entry]);
  }

  for (const [heading, entries] of byOwner) {
    const place = headingPlaces.get(heading);
    const laidOutUnder =
      place && entries.every(({ paragraph }) => paragraph.left >= place.left - LINE_TOLERANCE);
    for (const { block } of entries) block.section = laidOutUnder ? heading.text : null;
  }
}

/**
 * Section attribution across a page turn.
 *
 * Text at the top of a page, read before any heading of its own, inherits the
 * heading the previous page ended on - in the stream. Usually that is also the
 * last heading a reader passes, but not when the stream goes back up to draw
 * it: the Routing PRD draws each scenario table's header row ("Scenario
 * Acceptance Criteria Jira Link") after the rows below it, so the WHEN branch
 * continued at the top of pages 4 and 6 was filed under the table header.
 *
 * So the inherited heading is only taken on trust when the stream reached it in
 * reading order. It was not when the text drawn just before it lies below it
 * and nothing drawn after it does - it heads nothing it was read with. Running
 * page footers are drawn first and so never trip this.
 *
 * When it was drawn late, the text is attributed as A1 attributes text read out
 * of order: to the lowest other heading on that page, and only while it is laid
 * out under that heading, top of the page down. The first paragraph that starts
 * left of it, or sits below a heading of its own page, is something new (a
 * scenario row whose heading the parser did not recognise, say), and from there
 * on no section is named; so is everything when that page has no other heading.
 * Unresolved is better than a scenario that is not its own.
 *
 * As in reattribute, only sections change; blocks keep stream order.
 */
function drawnLate(heading, placed, leading) {
  const at = placed.indexOf(heading);
  const before = placed[at - 1];
  // liesBelow(a, b) reads "a lies below b, across the same span": clearly, by
  // more than a line, for what came before; for what it heads, the next line
  // under it is enough.
  return (
    Boolean(before) &&
    liesBelow(before, heading, leading) &&
    !placed.slice(at + 1).some((place) => liesBelow(place, heading, 0))
  );
}

function settleCarried(carried, pageNumber, headingPlaces, late) {
  const others = new Map([...headingPlaces].filter(([, place]) => place !== late));
  let continuing = true;
  for (const { block, paragraph } of [...carried].sort(
    (a, b) => b.paragraph.top - a.paragraph.top
  )) {
    const [heading, place] = headingAbove(paragraph, pageNumber, others) ?? [];
    continuing &&= place?.page === late.page && paragraph.left >= place.left - LINE_TOLERANCE;
    block.section = continuing ? heading.text : null;
  }
}

/**
 * Rebuilds visual lines from positioned text items.
 *
 * Each line keeps the geometry the paragraph pass needs: where it sits, and how
 * far across the page it runs.
 */
function groupIntoLines(items, borders = []) {
  let lines = [];
  let current = null;

  for (const item of items) {
    if (typeof item.str !== 'string') continue;

    const y = item.transform?.[5] ?? 0;
    const width = Number.isFinite(item.width) ? item.width : 0;
    const part = {
      text: item.str,
      x: item.transform?.[4] ?? 0,
      width,
      size: Math.abs(item.transform?.[3] || item.transform?.[0] || 0),
    };

    if (current && Math.abs(current.y - y) <= LINE_TOLERANCE) {
      current.parts.push(part);
      current.width += width;
    } else {
      if (current) lines.push(current);
      current = { y, x: part.x, parts: [part], width };
    }

    if (item.hasEOL) {
      lines.push(current);
      current = null;
    }
  }

  if (current) lines.push(current);

  attachInlineLabels(lines);
  lines = lines.flatMap((line) => splitAtCellBorder(line, borders));

  return lines
    .map((line) => ({
      text: textOf(line.parts),
      y: line.y,
      x: line.x,
      width: line.width,
      cellStart: line.cellStart === true,
      reach: line.reach ?? line.width,
    }))
    .filter((line) => line.text !== '');
}

const textOf = (parts) =>
  parts
    .map((part) => part.text)
    .join('')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * Scenario tables: a scenario's name and its acceptance criteria on one line.
 *
 * A Confluence scenario table puts the scenario's name in the left cell and its
 * GIVEN / WHEN / THEN in the next. When the name fits on one line, the stream
 * writes it and the GIVEN beside it as one run on one baseline, so they were
 * read as one line: "Tuntas Tarik GIVEN Mobile App user initiates ...". The
 * scenario was not a heading of its own, and its GIVEN was filed under the
 * previous scenario's WHEN. Four of the Routing PRD's seven scenarios read so.
 *
 * The evidence is the table itself: the cell border is drawn, as a thin filled
 * or stroked rule, between the two. A line is split where a drawn vertical rule
 * runs between two of its words and the text right of it opens an acceptance
 * criterion - the same clause words reconstructCriteria reads. Both are needed:
 * the rule says these are two cells, the clause says the right cell is where
 * the criteria start. Other lines that cross a rule - a table's header row, the
 * cells of a matrix - are left as they were read; that is other tables'
 * structure, and section attribution leans on the header row as it is.
 *
 * The right-hand part always starts a block of its own (see
 * groupIntoParagraphs). Nothing is reordered and no text is added or dropped:
 * the name and the criterion are the same words, as two lines. Whether the
 * lines after it join it is decided by how far the whole line reached, as it was
 * before the split (its reach), so a criterion wrapped onto the next line is
 * rejoined - and the next WHEN is not - exactly as before.
 */
const CRITERION_CLAUSE = /^(?:GIVEN|WHEN|THEN|DIBERIKAN|KETIKA|SAAT|APABILA|MAKA)\b/i;

/** The same clause words written as clause markers, in capitals. */
const CLAUSE_MARKER = /^(?:GIVEN|WHEN|THEN|DIBERIKAN|KETIKA|SAAT|APABILA|MAKA)\b/;

/** A drawn rule no wider than this, and taller than it is wide, is a cell border. */
const BORDER_WIDTH = 3;

function cellBorders(operators, pdfjs) {
  const painted = new Set(
    [
      'stroke',
      'closeStroke',
      'fill',
      'eoFill',
      'fillStroke',
      'eoFillStroke',
      'closeFillStroke',
      'closeEOFillStroke',
    ].map((name) => pdfjs.OPS[name])
  );
  const borders = [];
  const stack = [];
  let current = [1, 0, 0, 1, 0, 0];

  for (let index = 0; index < operators.fnArray.length; index += 1) {
    const fn = operators.fnArray[index];
    const args = operators.argsArray[index];

    if (fn === pdfjs.OPS.save) stack.push(current.slice());
    else if (fn === pdfjs.OPS.restore) current = stack.pop() ?? current;
    else if (fn === pdfjs.OPS.transform) current = multiply(current, args);
    else if (fn === pdfjs.OPS.constructPath && painted.has(args?.[0]) && args?.[2]?.length === 4) {
      // args: [paint op, path data, [minX, minY, maxX, maxY]] in user space.
      const [x0, y0, x1, y1] = args[2];
      const xs = [x0, x1].map((x) => current[0] * x + current[2] * y0 + current[4]);
      const ys = [y0, y1].map((y) => current[1] * x0 + current[3] * y + current[5]);
      const width = Math.abs(xs[1] - xs[0]);
      const height = Math.abs(ys[1] - ys[0]);
      if (width <= BORDER_WIDTH && height > width * 4) {
        borders.push({
          x: (xs[0] + xs[1]) / 2,
          bottom: Math.min(...ys),
          top: Math.max(...ys),
        });
      }
    }
  }

  return borders;
}

function splitAtCellBorder(line, borders) {
  const words = (parts) => parts.filter((part) => part.text.trim());

  for (const border of borders) {
    if (line.y < border.bottom - LINE_TOLERANCE || line.y > border.top + LINE_TOLERANCE) continue;

    const at = line.parts.findIndex(
      (part) => part.text.trim() && part.x >= border.x - LINE_TOLERANCE
    );
    if (at <= 0) continue;

    const left = line.parts.slice(0, at);
    const right = line.parts.slice(at);
    if (words(left).length === 0) continue;
    if (!words(left).every((part) => part.x + part.width <= border.x + LINE_TOLERANCE)) continue;
    if (!words(right).every((part) => part.x >= border.x - LINE_TOLERANCE)) continue;
    if (!CRITERION_CLAUSE.test(textOf(right))) continue;

    // The left cell ends at the border, whatever whitespace runs past it.
    const leftWidth = left.reduce(
      (sum, part) => sum + Math.max(0, Math.min(part.width, border.x - part.x)),
      0
    );
    const rightWidth = right.reduce((sum, part) => sum + part.width, 0);
    return [
      { ...line, parts: left, width: leftWidth },
      {
        ...line,
        x: right[0].x,
        parts: right,
        width: rightWidth,
        cellStart: true,
        reach: line.width,
      },
    ];
  }

  return [line];
}

/**
 * Inline labels drawn after the sentence they sit in.
 *
 * Confluence draws a mention or status label - "Mobile App", "SYS", a product
 * name - in a smaller font, inline with the sentence, and writes it to the
 * content stream after everything else on the page. Read in stream order it
 * becomes a line of its own at the end of the page: "GIVEN sending Payment
 * Request to" loses its actor, and "SYS" turns into a heading that files the
 * top of the next page under itself. The sanitized Routing PRD has sixteen of
 * them.
 *
 * Where it belongs is a question of layout, not of what the label says. A run
 * of text goes back into an earlier line on the same baseline when it is set
 * clearly smaller than that line's words and occupies that line's own empty
 * space:
 *
 *   a gap   inside a stretch of whitespace the line leaves for it
 *   after   within half an em of the line's last word
 *   before  left of the line's first word, aligned with a word that starts
 *           the line directly above it - a label that wrapped to line start
 *
 * Anything else stays where it is: text in another column, a value cell of a
 * table, a label that fits more than one line. The host keeps its geometry,
 * so how lines join into paragraphs - and where sections fall - is decided
 * exactly as before; the label only adds its words.
 */
const INLINE_LABEL_RATIO = 0.8;

function attachInlineLabels(lines) {
  lines.forEach((line, index) => {
    for (const part of [...line.parts]) {
      if (!part.text.trim()) continue;

      const placements = lines
        .slice(0, index)
        .map((host, hostIndex) => ({ host, at: inlinePosition(lines, hostIndex, part) }))
        .filter(({ host, at }) => at !== null && Math.abs(host.y - line.y) <= LINE_TOLERANCE);
      if (placements.length !== 1) continue;

      const [{ host, at }] = placements;
      host.parts.splice(at, 0, { ...part, text: ` ${part.text.trim()} `, inline: true });
      line.parts.splice(line.parts.indexOf(part), 1);
      line.width -= part.width;
    }
  });
}

function inlinePosition(lines, hostIndex, label) {
  const host = lines[hostIndex];
  // The line's own words; a label attached earlier still takes up its space.
  const words = host.parts.filter((part) => part.text.trim() && !part.inline);
  if (words.length === 0 || !words.every((word) => label.size < word.size * INLINE_LABEL_RATIO)) {
    return null;
  }

  const start = label.x;
  const end = label.x + label.width;
  const overlaps = host.parts
    .filter((part) => part.text.trim())
    .some((part) => part.x < end && start < part.x + part.width);
  if (overlaps) return null;

  const gap = host.parts.findIndex(
    (part) =>
      !part.text.trim() &&
      part.width > 0 &&
      part.x - LINE_TOLERANCE <= start &&
      end <= part.x + part.width + LINE_TOLERANCE
  );
  if (gap >= 0) return gap + 1;

  const last = words.reduce((right, word) =>
    word.x + word.width > right.x + right.width ? word : right
  );
  const lastEnd = last.x + last.width;
  if (start >= lastEnd && start - lastEnd <= last.size / 2) return host.parts.indexOf(last) + 1;

  const first = words.reduce((left, word) => (word.x < left.x ? word : left));
  const above = lines[hostIndex - 1];
  const wrapped =
    above &&
    above.y > host.y &&
    above.y - host.y <= first.size * 2 &&
    above.parts.some((part) => part.text.trim() && Math.abs(part.x - start) <= LINE_TOLERANCE);
  if (end <= first.x && wrapped) return host.parts.indexOf(first);

  return null;
}

/** The page's usual line spacing, used to tell a wrap from a new block. */
function medianGap(lines) {
  const gaps = [];
  for (let index = 1; index < lines.length; index += 1) {
    const gap = Math.abs(lines[index - 1].y - lines[index].y);
    if (gap > 0) gaps.push(gap);
  }

  if (gaps.length === 0) return 0;
  gaps.sort((left, right) => left - right);
  return gaps[Math.floor(gaps.length / 2)];
}

/**
 * The page's line spacing as a reader sees it: gaps between lines taken top to
 * bottom, not in stream order. medianGap above measures the stream, which is
 * the right question for joining wraps and the wrong one here - on a page whose
 * stream jumps around, consecutive lines are far apart and its "usual gap" is
 * the size of the jumps.
 */
function lineSpacing(lines) {
  const ys = lines.map((line) => line.y).sort((upper, lower) => lower - upper);
  const gaps = [];
  for (let index = 1; index < ys.length; index += 1) {
    const gap = ys[index - 1] - ys[index];
    if (gap > LINE_TOLERANCE) gaps.push(gap);
  }

  if (gaps.length === 0) return 0;
  gaps.sort((left, right) => left - right);
  return gaps[Math.floor(gaps.length / 2)];
}

/**
 * Joins wrapped lines back into the blocks they were written as.
 *
 * Each paragraph also carries where it sits on the page - the y of its first
 * and last line and its horizontal extent - which section attribution needs.
 *
 * @param {Array<{text: string, y: number, x: number, width: number}>} lines
 * @returns {Array<{text: string, lineCount: number, top: number, bottom: number, left: number, right: number}>}
 */
function groupIntoParagraphs(lines) {
  if (lines.length === 0) return [];

  // How far a line reached across the page; for a split cell, the whole line.
  const reach = (line) => line.reach ?? line.width;
  const widest = Math.max(...lines.map(reach));
  const fullWidth = widest * FULL_WIDTH_RATIO;
  const typicalGap = medianGap(lines);

  const paragraphs = [];
  let current = null;

  for (const line of lines) {
    const gap = current ? Math.abs(current.lastY - line.y) : 0;
    const separated = typicalGap > 0 && gap > typicalGap * PARAGRAPH_GAP_RATIO;

    const continues =
      current &&
      !separated &&
      // A cell split from the line it was read with starts its own block.
      !line.cellStart &&
      // A numbered heading always begins a block, however the line above ended.
      !NUMBERED_HEADING.test(line.text) &&
      // A split criterion cell reaches as far as its whole line did, so that a
      // wrapped clause rejoins it; the next clause, in capitals, is not a wrap.
      !(current.cellStart && CLAUSE_MARKER.test(line.text)) &&
      !ENDS_SENTENCE.test(current.text) &&
      (CONTINUES_SENTENCE.test(line.text) || current.lastWidth >= fullWidth);

    if (continues) {
      current.text = `${current.text} ${line.text}`;
      current.lineCount += 1;
      current.lastY = line.y;
      current.lastWidth = reach(line);
      current.bottom = line.y;
      current.left = Math.min(current.left, line.x);
      current.right = Math.max(current.right, line.x + line.width);
      continue;
    }

    current = {
      text: line.text,
      cellStart: line.cellStart === true,
      lineCount: 1,
      lastY: line.y,
      lastWidth: reach(line),
      top: line.y,
      bottom: line.y,
      left: line.x,
      right: line.x + line.width,
    };
    paragraphs.push(current);
  }

  return paragraphs;
}
