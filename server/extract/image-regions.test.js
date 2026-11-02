import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { parsePdf } from './parsers/pdf.js';
import { extractDocuments, WARNING_CODES } from './index.js';
import { buildPdf } from './fixtures/build.js';

/**
 * Specification content a PDF carries as a picture.
 *
 * The real PRD states "Report format to be generated as shown below:" and then
 * supplies the format as a raster table. Proven three ways that the content
 * exists nowhere but in the pixels: pdftotext returns nothing for the region,
 * the only /Alt text is Confluence's placeholder "Story", and the strings
 * inside it - TRX_DATE, v_qr_release_settlement - appear nowhere in the raw PDF
 * bytes. Seventeen required report columns, two stated formats, a join key and
 * a validation rule were therefore absent from every coverage figure this tool
 * had ever produced for the document, and nothing said so.
 *
 * These tests lock the half of that which can be fixed without deciding what
 * QATOOL is: the silence. The parser now reports WHERE unread content sits and
 * what introduces it. It does not transcribe - that needs either an OCR engine
 * or a vision model, and both would make a requirement's source text a
 * transcription rather than the document's own words.
 */

const PRD =
  'C:/Users/M01394/AppData/Local/Temp/claude/c--Users-M01394-Desktop-QATOOL/13cd5a78-4fea-42a4-940e-e1361d7ce671/scratchpad/prd.pdf';

const realPrd = (() => {
  try {
    return readFileSync(PRD);
  } catch {
    return null;
  }
})();

describe('image regions in a synthetic PDF', () => {
  it('reports none when every page is text', async () => {
    const buffer = buildPdf([
      [
        'Validation Rules',
        'Field BIC Code is mandatory and must be 8 or 11 characters.',
        'A Suspended participant is rejected with error ADMI 002.',
      ],
    ]);

    const parsed = await parsePdf(buffer, 'DOC-001');

    assert.equal(parsed.metrics.image_region_count, 0);
    assert.equal(
      parsed.blocks.filter((block) => block.kind === 'image_region').length,
      0,
      'a text-only document gains nothing'
    );
  });

  it('leaves the text blocks of a document exactly as they were', async () => {
    const buffer = buildPdf([
      ['Business Rules', 'Transactions above IDR 50,000,000 are rejected.'],
    ]);

    const parsed = await parsePdf(buffer, 'DOC-001');
    const text = parsed.blocks.filter((block) => block.kind !== 'image_region');

    assert.ok(text.some((block) => /50,000,000/.test(block.text)));
    assert.equal(parsed.metrics.extracted_char_count > 0, true);
  });
});

describe('image regions in the real PRD', { skip: realPrd ? false : 'PRD not available' }, () => {
  it('finds the report format and names the sentence that introduces it', async () => {
    const parsed = await parsePdf(realPrd, 'DOC-001');
    const regions = parsed.blocks.filter((block) => block.kind === 'image_region');

    const reportFormat = regions.find((block) =>
      /Report format to be generated as shown below/i.test(block.lead_in ?? '')
    );

    assert.ok(reportFormat, 'the page 6 report format is located');
    assert.equal(reportFormat.page, 6, 'with its real page number');
    assert.ok(reportFormat.width_pt > 120 && reportFormat.height_pt > 50);
  });

  it('finds both halves of the table, which the page splits', async () => {
    const parsed = await parsePdf(realPrd, 'DOC-001');
    const onPage6 = parsed.blocks.filter(
      (block) => block.kind === 'image_region' && block.page === 6
    );

    assert.equal(onPage6.length, 2, 'the schema rows and the notes beneath them');
  });

  /** A Jira "Done" badge draws at 124 x 51. The area floor is what excludes it. */
  it('does not report status chips and other furniture', async () => {
    const parsed = await parsePdf(realPrd, 'DOC-001');
    const regions = parsed.blocks.filter((block) => block.kind === 'image_region');

    assert.ok(regions.length <= 8, `${regions.length} regions is too many to be useful`);
    for (const region of regions) {
      assert.ok(
        region.width_pt * region.height_pt >= 8000,
        `${region.page}: ${region.width_pt}x${region.height_pt} is furniture`
      );
    }
  });

  it('warns QA by page, naming what introduces each region', async () => {
    const result = await extractDocuments([
      { filename: 'prd.pdf', mimetype: 'application/pdf', buffer: realPrd },
    ]);

    const warning = result.warnings.find(
      (entry) => entry.code === WARNING_CODES.UNREAD_IMAGE_CONTENT
    );

    assert.ok(warning, 'the gap is reported');
    assert.match(warning.message, /page 6/);
    assert.match(warning.message, /Report format to be generated as shown below/);
    assert.match(warning.message, /no obligation was derived from it/);
  });

  /**
   * The rule that keeps this honest. The block's text is QATOOL's sentence
   * about a picture, not the document's words, so it must never become a
   * requirement - otherwise "[Image on page 6 ... was not read.]" would arrive
   * in a SIT script as something to test.
   */
  it('never turns an image region into a requirement', async () => {
    const result = await extractDocuments([
      { filename: 'prd.pdf', mimetype: 'application/pdf', buffer: realPrd },
    ]);

    for (const requirement of result.requirements) {
      assert.doesNotMatch(
        requirement.description,
        /\[Image on page/,
        `${requirement.requirement_id} carries a parser note as a requirement`
      );
      assert.doesNotMatch(requirement.title, /\[Image on page/, requirement.requirement_id);
    }
  });

  it('invents nothing about what the picture contains', async () => {
    const parsed = await parsePdf(realPrd, 'DOC-001');
    const regions = parsed.blocks.filter((block) => block.kind === 'image_region');

    for (const region of regions) {
      // The transcription IS available - it is recorded in the golden oracle -
      // but it is not in these blocks, and this asserts the separation holds.
      assert.doesNotMatch(region.text, /TRX_DATE|v_qr_release_settlement|DD-MMM-YY/);
      assert.match(region.text, /was not read/);
    }
  });
});
