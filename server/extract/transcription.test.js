import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { detectFileType } from './detect.js';
import { parseTranscription, looksLikeTranscription } from './parsers/transcription.js';
import { extractDocuments } from './index.js';
import { buildPdf } from './fixtures/build.js';

/**
 * The human-verifiable transcription boundary.
 *
 * A PDF region that is a picture carries no text to rebuild from, so the two
 * obvious ingestion routes both break this tool's central guarantee: OCR makes
 * a decoder the author of requirement text, a vision model makes the LLM the
 * author, and either turns a misread character into a fabricated banking
 * requirement with full provenance.
 *
 * The transcription comes from a person instead. These tests lock what that
 * costs and what it must never allow: the text is marked, the page survives,
 * the verifier is named, and declared sample values stay out of the pipeline.
 */

const sidecar = (overrides = {}) =>
  Buffer.from(
    JSON.stringify({
      qatool_image_transcription: 1,
      source_document: 'spec.pdf',
      regions: [
        {
          page: 6,
          lead_in: 'Report format to be generated as shown below:',
          verified_by: 'A. Reviewer',
          contract: [
            'Write TRX_DATE and SETTLEMENT_DATE in format DD-MMM-YY',
            'Write AMOUNT as Decimal 2 digits',
          ],
          samples: ['03-Feb-25', 'FT04FDFKNR90'],
          ...overrides,
        },
      ],
    })
  );

describe('recognising a transcription', () => {
  it('is detected by its marker, not by its name', () => {
    assert.equal(detectFileType(sidecar(), 'anything.dat'), 'transcription');
  });

  it('does not claim ordinary JSON', () => {
    const plain = Buffer.from(JSON.stringify({ title: 'notes', body: 'some text' }));

    assert.throws(() => detectFileType(plain, 'notes.json'), /not a PDF, DOCX, XLSX/);
  });

  it('does not claim a PDF', () => {
    assert.equal(detectFileType(buildPdf([['Requirements', 'A rule.']]), 'spec.pdf'), 'pdf');
  });

  it('refuses a file that is almost one', () => {
    assert.equal(looksLikeTranscription(Buffer.from('{"something_else": 1}')), false);
  });
});

describe('parsing a transcription', () => {
  it('marks every block as image-derived and names who verified it', async () => {
    const parsed = await parseTranscription(sidecar(), 'DOC-002');

    assert.equal(parsed.blocks.length, 2);
    for (const block of parsed.blocks) {
      assert.equal(block.kind, 'image_transcription');
      assert.equal(block.provenance, 'image_transcription');
      assert.equal(block.verified_by, 'A. Reviewer');
      assert.equal(block.page, 6, 'the page it was read from survives');
      assert.equal(block.transcribed_from, 'spec.pdf');
    }
  });

  /**
   * The rule that matters most. A specimen FT number in the Sample Data column
   * must not become something a SIT script asserts, so declared samples are
   * counted and then deliberately left out of the blocks.
   */
  it('never turns a declared sample into a block', async () => {
    const parsed = await parseTranscription(sidecar(), 'DOC-002');
    const text = parsed.blocks.map((block) => block.text).join(' ');

    assert.doesNotMatch(text, /FT04FDFKNR90/, 'the specimen FT number is not carried across');
    assert.doesNotMatch(text, /03-Feb-25/);
    assert.equal(parsed.metrics.declared_sample_count, 2, 'but it is counted, so it is visible');
  });

  it('records what the person could not read, rather than guessing it', async () => {
    const parsed = await parseTranscription(
      sidecar({ unreadable: 'the last sample value wraps illegibly' }),
      'DOC-002'
    );

    assert.equal(parsed.metrics.unreadable_regions, 1);
  });

  it('refuses a transcription with no named verifier', async () => {
    const anonymous = Buffer.from(
      JSON.stringify({
        qatool_image_transcription: 1,
        source_document: 'spec.pdf',
        regions: [{ page: 6, contract: ['A rule.'] }],
      })
    );

    await assert.rejects(() => parseTranscription(anonymous, 'DOC-002'), /verified_by/);
  });

  it('refuses malformed JSON rather than accepting half of it', async () => {
    await assert.rejects(
      () => parseTranscription(Buffer.from('{"qatool_image_transcription": 1, oops'), 'DOC-002'),
      /not valid JSON/
    );
  });
});

describe('a transcription in the pipeline', () => {
  const upload = async () =>
    extractDocuments([
      {
        filename: 'spec.pdf',
        mimetype: 'application/pdf',
        buffer: buildPdf([
          [
            'Daily Report',
            'GIVEN the report is due',
            'WHEN the clock reaches 03.00 AM',
            'THEN the system must fulfill:',
            'Save the file into the designated directory.',
          ],
        ]),
      },
      {
        filename: 'spec-transcription.json',
        mimetype: 'application/json',
        buffer: sidecar(),
      },
    ]);

  it('reaches the requirements, because a person vouched for the words', async () => {
    const result = await upload();
    const text = result.requirements.map((entry) => entry.description).join(' ');

    assert.match(text, /DD-MMM-YY/, 'the transcribed contract is available downstream');
    assert.match(text, /Decimal 2 digits/);
  });

  it('keeps the PDF and the transcription as separate documents', async () => {
    const result = await upload();

    assert.equal(result.documents.length, 2);
    assert.ok(result.documents.every((document) => document.status === 'Extracted'));
  });

  /**
   * The boundary, asserted. Transcribed text must never arrive looking like
   * text the PDF itself held - the whole point is that a reviewer can tell the
   * difference and go back to the person who wrote it down.
   */
  it('never presents transcribed text as ordinary PDF text', async () => {
    const result = await upload();
    const fromPdf = result.documents.find((document) => document.filename === 'spec.pdf');

    assert.ok(fromPdf, 'the PDF is its own document');
    assert.doesNotMatch(
      JSON.stringify(result.requirements.filter((r) => /DD-MMM-YY/.test(r.description))),
      /"document_id":"DOC-001"/,
      'the transcribed contract is attributed to the transcription, not to the PDF'
    );
  });
});
