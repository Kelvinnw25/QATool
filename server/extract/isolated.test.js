import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { describe, it } from 'node:test';

import { strToU8, zipSync } from 'fflate';

import { AppError } from '../lib/errors.js';
import { loadSecuritySettings } from '../security/settings.js';
import { buildDocx } from './fixtures/build.js';
import { parseDocumentsIsolated } from './isolated.js';
import { parseDocuments } from './parse.js';

/**
 * Reading documents on a thread of their own.
 *
 * The hostile inputs here are the ones measured to hold the main thread: a few hundred
 * bytes of XML that make a regular expression do quadratic work. In-thread they take
 * seconds to hours; isolated, they end at the time limit and the main thread never notices.
 */

const limits = loadSecuritySettings({ PUBLIC_DEMO: 'true' }).limits;

const file = (buffer, filename = 'doc.docx') => ({ filename, mimetype: null, buffer });

const docxOf = (bodyXml) =>
  Buffer.from(
    zipSync({
      'word/document.xml': strToU8(`<w:document><w:body>${bodyXml}</w:body></w:document>`),
    })
  );

const refusedWith = (promise, code) =>
  assert.rejects(promise, (error) => {
    assert.ok(error instanceof AppError, `expected an AppError, got ${error}`);
    assert.equal(error.code, code);
    return true;
  });

/** How late a 10 ms ticker on this thread runs while `work` is in flight. */
async function worstLag(work) {
  let worst = 0;
  let last = performance.now();
  const ticker = setInterval(() => {
    const now = performance.now();
    worst = Math.max(worst, now - last - 10);
    last = now;
  }, 10);
  try {
    await work();
  } catch {
    // the caller asserts on the outcome
  } finally {
    clearInterval(ticker);
  }
  return worst;
}

describe('isolated parsing gives the same result as parsing in-thread', () => {
  it('for a DOCX', async () => {
    const buffer = Buffer.from(
      buildDocx([
        { heading: 'Rules', level: 1 },
        { text: 'A transfer missing a mandatory BIC code must be rejected with code ADMI 002.' },
        { text: 'Transactions from a Suspended participant must be rejected with U253.' },
      ])
    );
    const inThread = await parseDocuments([file(buffer, 'PRD.docx')], { limits });
    const isolated = await parseDocumentsIsolated([file(buffer, 'PRD.docx')], {
      limits,
      timeoutMs: 20_000,
    });

    assert.deepEqual(isolated.documents, inThread.documents);
    assert.deepEqual(isolated.parsedDocuments, inThread.parsedDocuments);
    assert.deepEqual(isolated.warnings, inThread.warnings);
  });

  it('for a PDF, which is parsed by a different library on the same thread', async () => {
    const buffer = readFileSync(
      new URL('../../fixtures/prd/PRD_Transaction_Routing_Sanitized.pdf', import.meta.url)
    );
    const inThread = await parseDocuments([file(buffer, 'PRD.pdf')], { limits });
    const isolated = await parseDocumentsIsolated([file(buffer, 'PRD.pdf')], {
      limits,
      timeoutMs: 30_000,
    });

    assert.deepEqual(isolated.documents, inThread.documents);
    assert.equal(isolated.parsedDocuments.length, inThread.parsedDocuments.length);
    assert.deepEqual(isolated.parsedDocuments[0].blocks, inThread.parsedDocuments[0].blocks);
  });

  it('with several documents, one of them unreadable, in order', async () => {
    const good = Buffer.from(buildDocx([{ text: 'The system must reject a duplicate with U1.' }]));
    const result = await parseDocumentsIsolated(
      [file(good, 'a.docx'), file(Buffer.from('not a document'), 'b.docx'), file(good, 'c.docx')],
      { limits, timeoutMs: 20_000 }
    );
    assert.deepEqual(
      result.documents.map((document) => document.status),
      ['Extracted', 'Failed', 'Extracted']
    );
  });

  it('and leaves the caller’s buffers alone, so they can be used afterwards', async () => {
    const buffer = Buffer.from(
      buildDocx([{ text: 'The system must reject a duplicate with U1.' }])
    );
    const before = Buffer.from(buffer);
    await parseDocumentsIsolated([file(buffer)], { limits, timeoutMs: 20_000 });
    assert.equal(buffer.length, before.length, 'not transferred away');
    assert.ok(buffer.equals(before));
  });
});

describe('errors keep their meaning across the thread boundary', () => {
  it('all documents unreadable: EXTRACTION_FAILED with the details, as in-thread', async () => {
    await assert.rejects(
      parseDocumentsIsolated([file(Buffer.from('nope'), 'one.docx')], {
        limits,
        timeoutMs: 20_000,
      }),
      (error) => {
        assert.ok(error instanceof AppError);
        assert.equal(error.code, 'EXTRACTION_FAILED');
        assert.equal(error.statusCode, 422);
        assert.equal(error.details[0].filename, 'one.docx');
        return true;
      }
    );
  });

  it('no documents: NO_DOCUMENTS', async () => {
    await refusedWith(parseDocumentsIsolated([], { limits, timeoutMs: 5_000 }), 'NO_DOCUMENTS');
  });
});

describe('a hostile document is ended, and costs the main thread nothing', () => {
  it('is stopped at the time limit: 4 MiB of unclosed paragraphs (hours in-thread)', async () => {
    const hostile = docxOf('<w:p>'.repeat(Math.floor((4 * 1024 * 1024) / 5)));
    const started = performance.now();
    let lag;
    lag = await worstLag(() =>
      refusedWith(
        parseDocumentsIsolated([file(hostile)], { limits, timeoutMs: 1500 }),
        'DOCUMENT_TOO_COMPLEX'
      )
    );

    const elapsed = performance.now() - started;
    assert.ok(
      elapsed >= 1400 && elapsed < 4000,
      `ended at the limit, took ${elapsed.toFixed(0)} ms`
    );
    assert.ok(lag < 250, `the main thread stayed free; worst lag ${lag.toFixed(0)} ms`);
  });

  it('is stopped at the time limit: unclosed spreadsheet rows', async () => {
    const hostile = Buffer.from(
      zipSync({
        'xl/workbook.xml': strToU8(
          '<workbook><sheets><sheet name="S" r:id="rId1"/></sheets></workbook>'
        ),
        'xl/_rels/workbook.xml.rels': strToU8(
          '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>'
        ),
        'xl/worksheets/sheet1.xml': strToU8(
          `<worksheet><sheetData>${'<row r="1">'.repeat(400_000)}</sheetData></worksheet>`
        ),
      })
    );
    await refusedWith(
      parseDocumentsIsolated([file(hostile, 'x.xlsx')], { limits, timeoutMs: 1500 }),
      'DOCUMENT_TOO_COMPLEX'
    );
  });

  it('can be taken away by the visitor leaving', async () => {
    const hostile = docxOf('<w:p>'.repeat(Math.floor((4 * 1024 * 1024) / 5)));
    const controller = new AbortController();
    setTimeout(() => controller.abort(new Error('visitor left')), 200);

    const started = performance.now();
    await assert.rejects(
      parseDocumentsIsolated([file(hostile)], {
        limits,
        timeoutMs: 20_000,
        signal: controller.signal,
      }),
      /visitor left/
    );
    assert.ok(performance.now() - started < 1500, 'stopped when asked, not at the time limit');
  });

  it('rejects at once when the signal has already fired', async () => {
    const controller = new AbortController();
    controller.abort(new Error('already gone'));
    await assert.rejects(
      parseDocumentsIsolated([file(Buffer.from('x'))], {
        limits,
        timeoutMs: 5000,
        signal: controller.signal,
      }),
      /already gone/
    );
  });

  it('leaves nothing behind: the next document parses normally after a hostile one', async () => {
    const hostile = docxOf('<w:p>'.repeat(Math.floor((2 * 1024 * 1024) / 5)));
    await assert.rejects(parseDocumentsIsolated([file(hostile)], { limits, timeoutMs: 800 }));

    const fine = Buffer.from(buildDocx([{ text: 'The system must reject a duplicate with U1.' }]));
    const result = await parseDocumentsIsolated([file(fine)], { limits, timeoutMs: 20_000 });
    assert.equal(result.documents[0].status, 'Extracted');
  });

  it('turns a worker that runs out of memory into the same refusal, without harming this process', async () => {
    // A heap limit far below what a large sheet needs: the worker dies, this thread does not.
    const cells = Array.from(
      { length: 60_000 },
      (_, i) => `<c r="A${i + 1}" t="inlineStr"><is><t>${'x'.repeat(200)}${i}</t></is></c>`
    );
    const rows = cells.map((cell, i) => `<row r="${i + 1}">${cell}</row>`).join('');
    const heavy = Buffer.from(
      zipSync({
        'xl/workbook.xml': strToU8(
          '<workbook><sheets><sheet name="S" r:id="rId1"/></sheets></workbook>'
        ),
        'xl/_rels/workbook.xml.rels': strToU8(
          '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>'
        ),
        'xl/worksheets/sheet1.xml': strToU8(
          `<worksheet><sheetData>${rows}</sheetData></worksheet>`
        ),
      })
    );
    const generous = { ...limits, xlsxMaxRows: 1e6, xlsxMaxCells: 1e6 };

    await assert.rejects(
      parseDocumentsIsolated([file(heavy, 'big.xlsx')], {
        limits: generous,
        timeoutMs: 30_000,
        maxHeapMb: 24,
      }),
      (error) =>
        error instanceof AppError && ['DOCUMENT_TOO_COMPLEX', 'PARSER_FAILURE'].includes(error.code)
    );
    assert.ok(process.memoryUsage().heapUsed < 400 * 1024 * 1024, 'this process is unharmed');
  });
});
