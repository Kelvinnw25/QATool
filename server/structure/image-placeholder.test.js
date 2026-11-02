import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { structureRequirements } from './index.js';
import { extractDocuments, WARNING_CODES } from '../extract/index.js';
import { deriveCoverageObligations, promptedObligations } from '../scenario/obligations.js';
import { deriveChecklist } from '../scenario/checklist.js';
import { buildPrompt, systemInstruction } from '../generate/prompt.js';
import { MockProvider } from '../llm/mock.js';

/**
 * A picture the document introduces with "as shown below", from both sides.
 *
 * On the real PRD page 6 says "Report format to be generated as shown below:"
 * and gives the format as two raster images. A structuring run from before the
 * image region stopped being a block cited the parser's note about them, and
 * REQ-011 carried nothing but "[Image on page 6 ... was not read]". The
 * obligation derived from it could not be tested: in the recorded Exp 2 and
 * Exp 4 runs Gemini marked it covered in 7 runs of 20, wrote two test cases that
 * only "verify the report format against the illustration", and every case that
 * cited it was an unverified claim - 8 of the 23.
 *
 * Three cases have to stay apart:
 *
 *   A  the picture was transcribed - its details reach requirements as the
 *      transcription's own rows, and the placeholder reaches nothing
 *   B  nobody read the picture - nothing is invented for it, and QA is told,
 *      including the part a transcriber declared unreadable
 *   C  a requirement that merely refers to a picture - it is the document's own
 *      text and stays a requirement
 *
 * Page-6 texts are the real PRD's text-layer lines and the real transcription's
 * rows; the verifier's name and the image-reference rows are constructed.
 */

const DOCUMENTS = [
  {
    document_id: 'DOC-001',
    filename: 'PRD QR Manager.pdf',
    document_type: 'PRD',
    status: 'Extracted',
    page_count: 12,
  },
  {
    document_id: 'DOC-002',
    filename: 'prd-image-transcription.json',
    document_type: 'PRD',
    status: 'Extracted',
    page_count: null,
  },
];

const LEAD_IN = 'Report format to be generated as shown below:';

const PLACEHOLDERS = [
  `[Image on page 6, 224x133pt, introduced by: "${LEAD_IN}". Its content is not in the PDF text layer and was not read.]`,
  '[Image on page 6, 224x75pt. Its content is not in the PDF text layer and was not read.]',
];

const PARSER_NOTE = /\[Image on page|was not read/;

// The real PRD's text layer on the page, as the PDF parser emits it.
const PAGE_TEXT = [
  'GIVEN all transactions for the D-1 (previous day from 00.00-23.59) have concluded',
  'WHEN the system clock reaches 03.00 AM / off- peak hours',
  'THEN the system must fulfill:',
  'Create and implement new automated scheduler to trigger the daily report generation',
  'Use SETTLEMENT_QRMANAGER_DDMMYYYY.txt as file name format (Date using Transaction Date) Generate the final report file in .txt format using a tilde ~ as the data delimiter',
  LEAD_IN,
];

const COLUMNS =
  'TRX_DATE, SETTLEMENT_DATE, RETRIEVAL_REF_NUM, MERCHANT_ID, PAN, MERCHANT_NAME, MERCHANT_CRITERIA, MERCHANT_SETTLEMENT_TYPE, TO_ACCOUNT, AMOUNT, CHARGE_AMOUNT, AMOUNT_SETTLEMENT, FT_NUMBER_SETTLEMENT, SWITCHING_NAME, ID_GROUP, SETTLEMENT_STATUS, SETTLEMENT_GROUP_ID';

// The real transcription's rows for the two images.
const CONTRACT = [
  'GIVEN the daily settlement report is generated',
  'WHEN the report file is produced',
  'THEN the system must fulfill:',
  `Generate the report with exactly these 17 columns in order: ${COLUMNS}`,
  'Read SETTLEMENT_STATUS and SETTLEMENT_GROUP_ID from source table qr_settlement_group',
  'Read report column SETTLEMENT_DATE from source table qr_settlement_group source column SETTLEMENT_TIME',
  'Write TRX_DATE and SETTLEMENT_DATE in format DD-MMM-YY',
  'Write AMOUNT, CHARGE_AMOUNT and AMOUNT_SETTLEMENT as Decimal 2 digits',
  'Key join : FT_NUMBER on table qr_settlement_group dan FT_NUMBER_SETTLEMENT on table v_qr_release_settlement',
  '[Validation] Data only contains with FT_NUMBER, otherwise the data is not streamed.',
];

const pageBlocks = (lines = PAGE_TEXT) => [
  ...lines.map((text) => ({ kind: 'paragraph', text, page: 6 })),
  {
    kind: 'image_region',
    text: PLACEHOLDERS[0],
    page: 6,
    lead_in: LEAD_IN,
    width_pt: 224,
    height_pt: 133,
  },
  {
    kind: 'image_region',
    text: PLACEHOLDERS[1],
    page: 6,
    lead_in: null,
    width_pt: 224,
    height_pt: 75,
  },
];

const transcribed = (rows = CONTRACT) =>
  rows.map((text) => ({
    kind: 'image_transcription',
    text,
    level: null,
    page: 6,
    section: LEAD_IN,
    provenance: 'image_transcription',
    verified_by: 'A. Reviewer',
    transcribed_from: 'PRD QR Manager.pdf',
  }));

const parsed = (pdf, transcription) => [
  { documentId: 'DOC-001', blocks: pdf },
  ...(transcription ? [{ documentId: 'DOC-002', blocks: transcription }] : []),
];

const idsIn = (prompt) => [...new Set(String(prompt).match(/DOC-\d{3}-B\d{3}/g) ?? [])];
const grouped = (title, ids) => ({
  title,
  source_block_ids: ids,
  test_points: [],
  ambiguous: false,
  conflicted: false,
  fragmented: false,
});

/** Structuring replies: everything in one requirement, one per document, and none at all. */
const MODELS = {
  'one requirement for everything': ({ prompt }) => ({
    requirements: [grouped('Auto-Generate Daily Settlement Report', idsIn(prompt))],
    supporting_blocks: [],
  }),
  'one requirement per document': ({ prompt }) => ({
    requirements: ['DOC-001', 'DOC-002']
      .map((document) =>
        grouped(
          document,
          idsIn(prompt).filter((id) => id.startsWith(`${document}-`))
        )
      )
      .filter((requirement) => requirement.source_block_ids.length > 0),
    supporting_blocks: [],
  }),
  'no structuring at all': () => ({ requirements: [], supporting_blocks: [] }),
};

/** Runs structuring, derivation and the generation prompt, as the pipeline does. */
async function pipeline(respond, documents) {
  const { requirements } = await structureRequirements(DOCUMENTS, documents, {
    provider: new MockProvider({ responses: respond }),
  });
  const obligations = deriveCoverageObligations(requirements);
  const prompted = promptedObligations(obligations);
  const prompt = buildPrompt(
    { project: { project_name: 'QR Manager' }, documents: DOCUMENTS, requirements, test_cases: [] },
    deriveChecklist(requirements),
    prompted,
    []
  );

  return { requirements, obligations, prompted, prompt };
}

const flat = (text) => String(text).replace(/\s+/g, ' ').trim();
const contentOf = (requirements) =>
  requirements
    .flatMap((requirement) => [
      requirement.title,
      requirement.description,
      ...requirement.source_references.map((reference) => reference.quote),
    ])
    .join('\n');
const textOf = (obligation) => `${obligation.statement}\n${obligation.source_basis}`;
const listed = (obligations) =>
  obligations.map((entry) => `${entry.type}: ${entry.statement}`).join('\n');

/** The obligations whose source is this row, in either direction of containment. */
const fromRow = (obligations, row) =>
  obligations.filter(
    (entry) =>
      flat(row).includes(flat(entry.source_basis)) || flat(entry.source_basis).includes(flat(row))
  );

/**
 * The references that cite this exact row. A quote is cut at 300 characters
 * with "..." - the 17-column row is 324 - so a cut quote counts when it is the
 * row's own beginning and the requirement still holds the whole row.
 */
const referencesTo = (requirements, row) =>
  requirements.flatMap((requirement) =>
    requirement.source_references.filter((reference) => {
      const quote = flat(reference.quote);
      if (quote === flat(row)) return true;
      return (
        quote.endsWith('...') &&
        flat(row).startsWith(quote.slice(0, -3)) &&
        flat(requirement.description).includes(flat(row))
      );
    })
  );

/* --------------------------------------------------------- case A ------ */

describe('an image placeholder whose content was transcribed', () => {
  for (const [model, respond] of Object.entries(MODELS)) {
    describe(`with ${model}`, () => {
      const run = () => pipeline(respond, parsed(pageBlocks(), transcribed()));

      it('gives the placeholder no requirement of its own', async () => {
        const { requirements } = await run();

        assert.doesNotMatch(contentOf(requirements), PARSER_NOTE);
        assert.ok(
          requirements.every((requirement) => flat(requirement.description) !== LEAD_IN),
          'the sentence introducing the picture is not a requirement by itself'
        );
      });

      it('derives no obligation from the placeholder or its lead-in', async () => {
        const { obligations } = await run();

        assert.ok(
          obligations.every((entry) => !PARSER_NOTE.test(textOf(entry))),
          listed(obligations)
        );
        assert.deepEqual(fromRow(obligations, LEAD_IN), [], listed(obligations));
      });

      it('never puts the parser note in front of the generator', async () => {
        const { prompt, prompted } = await run();

        assert.doesNotMatch(prompt, PARSER_NOTE);
        assert.ok(prompted.every((entry) => !/shown below/i.test(textOf(entry))));
      });

      it('keeps every transcribed row, traced to the transcription and its page', async () => {
        const { requirements } = await run();

        const transcription = (reference) =>
          reference.document_id === 'DOC-002' && reference.page === 6;

        for (const row of CONTRACT) {
          const references = referencesTo(requirements, row);
          const attributed = `${row} is attributed to ${JSON.stringify(references)}`;

          assert.ok(references.some(transcription), attributed);
          // "THEN the system must fulfill:" is on the page as well; every other
          // row exists only in the transcription and must never look like PDF text.
          if (!PAGE_TEXT.some((line) => flat(line) === flat(row))) {
            assert.ok(references.every(transcription), attributed);
          }
        }
      });
    });
  }

  describe('the details it carries, read from the transcription', () => {
    const run = () =>
      pipeline(MODELS['one requirement for everything'], parsed(pageBlocks(), transcribed()));

    const DETAILS = [
      `Generate the report with exactly these 17 columns in order: ${COLUMNS}`,
      'Read report column SETTLEMENT_DATE from source table qr_settlement_group source column SETTLEMENT_TIME',
      'Write TRX_DATE and SETTLEMENT_DATE in format DD-MMM-YY',
      'Write AMOUNT, CHARGE_AMOUNT and AMOUNT_SETTLEMENT as Decimal 2 digits',
      'Key join : FT_NUMBER on table qr_settlement_group dan FT_NUMBER_SETTLEMENT on table v_qr_release_settlement',
    ];

    for (const row of DETAILS) {
      it(`derives "${row.slice(0, 48)}..." exactly once`, async () => {
        const { obligations } = await run();

        assert.equal(fromRow(obligations, row).length, 1, listed(obligations));
      });
    }

    it('keeps all 17 columns in their order', async () => {
      const { obligations } = await run();
      const [columns] = fromRow(obligations, DETAILS[0]);

      assert.equal(flat(columns.source_basis), flat(DETAILS[0]));
      assert.deepEqual(
        columns.source_basis.split(': ')[1].split(', '),
        COLUMNS.split(', '),
        'the basis holds every column, in order'
      );
      assert.equal(COLUMNS.split(', ').length, 17);
    });

    it('carries the FT_NUMBER validation with its condition', async () => {
      const { obligations } = await run();
      const branch = obligations.find((entry) => entry.type === 'branch');

      assert.ok(branch, listed(obligations));
      assert.match(branch.statement, /otherwise: the data is not streamed/);
      assert.match(branch.statement, /Data only contains with FT_NUMBER/);
    });

    it('still splits the tilde delimiter from the file-name row on the page itself', async () => {
      const { obligations } = await run();

      assert.ok(
        obligations.some(
          (entry) =>
            entry.type === 'criterion' &&
            entry.source_basis.startsWith(
              'Generate the final report file in .txt format using a tilde ~'
            )
        ),
        listed(obligations)
      );
    });
  });
});

/* --------------------------------------------------------- case B ------ */

describe('an image placeholder nobody transcribed', () => {
  for (const [model, respond] of Object.entries(MODELS)) {
    it(`with ${model}, invents nothing for the picture`, async () => {
      const { requirements, obligations, prompt } = await pipeline(respond, parsed(pageBlocks()));

      assert.doesNotMatch(contentOf(requirements), PARSER_NOTE);
      assert.doesNotMatch(prompt, PARSER_NOTE);
      assert.ok(
        obligations.every(
          (entry) => !/TRX_DATE|DD-MMM-YY|Decimal|Key join|shown below/.test(textOf(entry))
        ),
        listed(obligations)
      );
    });
  }

  it('keeps the document sentence that points at it, verbatim, for the generator and QA', async () => {
    const { requirements } = await pipeline(
      MODELS['one requirement for everything'],
      parsed(pageBlocks())
    );

    assert.ok(referencesTo(requirements, LEAD_IN).length > 0, 'the lead-in is source text');
  });

  it('leaves the generator its insufficient-information path', () => {
    assert.match(systemInstruction(), /INSUFFICIENT_INFORMATION/);
  });

  it('keeps every row the page states in text', async () => {
    const { obligations } = await pipeline(
      MODELS['one requirement for everything'],
      parsed(pageBlocks())
    );

    assert.equal(
      fromRow(
        obligations,
        'Create and implement new automated scheduler to trigger the daily report generation'
      ).length,
      1,
      listed(obligations)
    );
    assert.ok(
      obligations.some((entry) =>
        entry.source_basis.startsWith(
          'Generate the final report file in .txt format using a tilde ~'
        )
      ),
      listed(obligations)
    );
  });
});

describe('a partial transcription', () => {
  const PARTIAL = [CONTRACT[0], CONTRACT[1], CONTRACT[2], CONTRACT[6], CONTRACT[7]];

  it('derives what was transcribed and the page text, and nothing that was not', async () => {
    const { obligations } = await pipeline(
      MODELS['one requirement for everything'],
      parsed(pageBlocks(), transcribed(PARTIAL))
    );

    assert.equal(fromRow(obligations, CONTRACT[6]).length, 1, listed(obligations));
    assert.equal(fromRow(obligations, CONTRACT[7]).length, 1, listed(obligations));
    assert.ok(
      obligations.some((entry) =>
        entry.source_basis.startsWith(
          'Generate the final report file in .txt format using a tilde ~'
        )
      ),
      'the page text the transcription does not repeat is kept'
    );
    assert.ok(
      obligations.every((entry) => !/17 columns|Key join|SETTLEMENT_TIME/.test(textOf(entry))),
      listed(obligations)
    );
  });
});

/* ------------------------------------------- warnings, from a real PDF ------ */

const escapePdfText = (value) => String(value).replace(/([()\\])/g, '\\$1');

/**
 * One page of text lines with a picture drawn directly beneath the last one -
 * the shape of the real page 6. A 1x1 grey image painted at 224 x 133 pt is
 * enough: the parser measures the drawn size, never the pixels.
 */
function pdfWithImageBelow(lines) {
  const top = 720 - (lines.length - 1) * 20 - 10;
  const stream =
    'BT /F1 12 Tf ' +
    lines
      .map((line, index) => `1 0 0 1 50 ${720 - index * 20} Tm (${escapePdfText(line)}) Tj`)
      .join(' ') +
    ` ET q 224 0 0 133 50 ${top - 133} cm /Im1 Do Q`;
  const objects = [
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 8 /Length 1 >>\nstream\n\xff\nendstream',
    '<< /Type /Page /Parent 5 0 R /MediaBox [0 0 612 792] /Contents 1 0 R ' +
      '/Resources << /Font << /F1 2 0 R >> /XObject << /Im1 3 0 R >> >> >>',
    '<< /Type /Pages /Kids [4 0 R] /Count 1 >>',
    '<< /Type /Catalog /Pages 5 0 R >>',
  ];

  let out = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((body, index) => {
    offsets.push(out.length);
    out += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) out += `${String(offset).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 6 0 R >>\nstartxref\n${xref}\n%%EOF`;

  return Buffer.from(out, 'latin1');
}

const SPEC = {
  filename: 'spec.pdf',
  mimetype: 'application/pdf',
  buffer: pdfWithImageBelow([
    'GIVEN the report is due',
    'WHEN the clock reaches 03.00 AM',
    'THEN the system must fulfill:',
    LEAD_IN,
  ]),
};

const UNREADABLE = 'The column list beneath the second table is cut off at the page edge.';

const sidecar = (region = {}) => ({
  filename: 'spec-transcription.json',
  mimetype: 'application/json',
  buffer: Buffer.from(
    JSON.stringify({
      qatool_image_transcription: 1,
      source_document: 'spec.pdf',
      regions: [
        {
          page: 1,
          lead_in: LEAD_IN,
          verified_by: 'A. Reviewer',
          contract: [CONTRACT[6], CONTRACT[7]],
          ...region,
        },
      ],
    })
  ),
});

const unread = (result) =>
  result.warnings.filter((warning) => warning.code === WARNING_CODES.UNREAD_IMAGE_CONTENT);

describe('what QA is told about a picture', () => {
  it('names the picture nobody read, by page and lead-in', async () => {
    const result = await extractDocuments([SPEC]);
    const [warning, ...rest] = unread(result);

    assert.ok(warning, 'the gap is reported');
    assert.deepEqual(rest, []);
    assert.match(warning.message, /page 1/);
    assert.match(warning.message, /Report format to be generated as shown below/);
    assert.match(warning.message, /no obligation was derived from it/);
  });

  it('names what a transcriber declared unreadable, rather than counting it silently', async () => {
    const result = await extractDocuments([SPEC, sidecar({ unreadable: UNREADABLE })]);
    const declared = unread(result).filter((warning) => warning.document_id === 'DOC-002');

    assert.equal(declared.length, 1, JSON.stringify(unread(result)));
    assert.match(declared[0].message, /spec-transcription\.json/);
    assert.match(declared[0].message, /page 1 \("Report format to be generated as shown below:"\)/);
    assert.ok(declared[0].message.includes(UNREADABLE), 'the note is quoted, not paraphrased');
    assert.match(declared[0].message, /A\. Reviewer/);
    assert.match(declared[0].message, /Nothing was guessed/);
  });

  it('still uses what the partial transcription did read', async () => {
    const result = await extractDocuments([SPEC, sidecar({ unreadable: UNREADABLE })]);
    const text = result.requirements.map((requirement) => requirement.description).join('\n');

    assert.match(text, /DD-MMM-YY/);
    assert.match(text, /Decimal 2 digits/);
    assert.ok(!text.includes(UNREADABLE), 'the note is never requirement text');
  });

  it('adds nothing for a transcription that declares no gap', async () => {
    const result = await extractDocuments([SPEC, sidecar()]);

    assert.deepEqual(
      unread(result).filter((warning) => warning.document_id === 'DOC-002'),
      []
    );
  });
});

/* --------------------------------------------------------- case C ------ */

describe('a requirement that refers to a picture', () => {
  const REFERRING = 'Display the transaction grid with the columns shown in the image below';
  const lines = [...PAGE_TEXT.slice(0, 4), REFERRING, LEAD_IN];

  for (const [label, transcription] of [
    ['when the picture was transcribed', transcribed()],
    ['when it was not', undefined],
  ]) {
    it(`is kept as an obligation of its own ${label}`, async () => {
      const { obligations } = await pipeline(
        MODELS['one requirement for everything'],
        parsed(pageBlocks(lines), transcription)
      );

      const own = fromRow(obligations, REFERRING);
      assert.equal(own.length, 1, listed(obligations));
      assert.equal(own[0].type, 'criterion');
    });
  }

  it('is kept as a requirement when structuring leaves it to recovery', async () => {
    const statement = 'The confirmation screen must show the QR code as illustrated in Figure 2.';
    const { requirements } = await pipeline(
      MODELS['no structuring at all'],
      parsed([
        { kind: 'paragraph', text: statement, page: 3 },
        { ...pageBlocks()[PAGE_TEXT.length], page: 3 },
      ])
    );

    assert.ok(referencesTo(requirements, statement).length > 0, contentOf(requirements));
    assert.doesNotMatch(contentOf(requirements), PARSER_NOTE);
  });
});
