import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { strToU8, unzipSync, Zip, ZipDeflate, zipSync } from 'fflate';

import { config } from '../config.js';
import { AppError } from '../lib/errors.js';
import { buildDocx, buildPdf, buildXlsx } from './fixtures/build.js';
import { detectFileType } from './detect.js';
import { parseDocx } from './parsers/docx.js';
import { parsePdf } from './parsers/pdf.js';
import { parseXlsx } from './parsers/xlsx.js';
import { ArchiveLimitError, safeUnzip } from './zip.js';

const MiB = 1024 * 1024;
const LIMITS = { zipMaxEntries: 2000, zipMaxUncompressedBytes: 64 * MiB };

const here = path.dirname(fileURLToPath(import.meta.url));
const templatePath = path.resolve(here, '../../templates/sit-script-template.xlsx');

const saved = { ...config.security.limits };
afterEach(() => Object.assign(config.security.limits, saved));

const limitError = (promiseOrFn) =>
  assert.throws(promiseOrFn, (error) => {
    assert.ok(error instanceof ArchiveLimitError, `expected ArchiveLimitError, got ${error}`);
    assert.equal(error.code, 'ARCHIVE_LIMIT_EXCEEDED');
    assert.equal(error.statusCode, 422);
    return true;
  });

describe('safeUnzip reads what unzipSync reads', () => {
  it('returns identical entries for a real Excel-made workbook', () => {
    const bytes = new Uint8Array(fs.readFileSync(templatePath));
    const expected = unzipSync(bytes);
    const actual = safeUnzip(bytes, LIMITS);

    assert.deepEqual(Object.keys(actual).sort(), Object.keys(expected).sort());
    for (const name of Object.keys(expected)) {
      assert.ok(Buffer.from(actual[name]).equals(Buffer.from(expected[name])), `${name} differs`);
    }
  });

  it('reads deflated and stored entries', () => {
    const bytes = zipSync({
      'word/document.xml': strToU8('<w:body>text</w:body>'.repeat(40)),
      '[Content_Types].xml': [strToU8('<Types/>'), { level: 0 }],
    });
    const files = safeUnzip(bytes, LIMITS);
    assert.equal(Buffer.from(files['[Content_Types].xml']).toString(), '<Types/>');
    assert.ok(files['word/document.xml'].length > 100);
  });

  it('reads an archive written without sizes in its headers (data descriptor)', () => {
    const chunks = [];
    const zip = new Zip((error, chunk) => chunks.push(Buffer.from(chunk)));
    const entry = new ZipDeflate('word/document.xml');
    zip.add(entry);
    entry.push(strToU8('streamed content '.repeat(2000)), true);
    zip.end();

    const bytes = new Uint8Array(Buffer.concat(chunks));
    assert.ok((bytes[6] & 8) !== 0, 'the fixture really uses a data descriptor');
    assert.equal(
      safeUnzip(bytes, LIMITS)['word/document.xml'].length,
      'streamed content '.length * 2000
    );
  });

  it('keeps ordinary documents working end to end', async () => {
    const docx = buildDocx([
      { heading: 'Rules', level: 1 },
      { text: 'The system must reject U253.' },
    ]);
    assert.equal(detectFileType(docx, 'a.docx'), 'docx');
    assert.ok(parseDocx(docx, 'DOC-001').blocks.length > 0);

    const xlsx = buildXlsx([
      {
        name: 'S',
        rows: [
          ['Rule', 'Detail'],
          ['R1', 'Reject U253'],
        ],
      },
    ]);
    assert.equal(detectFileType(xlsx, 'a.xlsx'), 'xlsx');
    assert.ok(parseXlsx(xlsx, 'DOC-001').blocks.length > 0);
  });
});

describe('decompression bombs', () => {
  it('stops a highly compressible archive at the output limit', () => {
    // 0.2 MB on the wire, 200 MB inflated: the audit's measured ~1000:1 case.
    const bomb = zipSync({ 'word/document.xml': new Uint8Array(200 * MiB) });
    assert.ok(bomb.length < 1 * MiB, `the fixture should be small, was ${bomb.length}`);

    const started = Date.now();
    limitError(() => safeUnzip(bomb, LIMITS));
    assert.ok(Date.now() - started < 5000, 'it must stop early, not inflate everything first');
  });

  it('counts bytes actually produced, not the size the archive declares', () => {
    // The local and central headers both claim the entry is 10 bytes.
    const lying = Buffer.from(zipSync({ 'word/document.xml': new Uint8Array(100 * MiB) }));
    lying.writeUInt32LE(10, 22);
    lying.writeUInt32LE(10, lying.lastIndexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])) + 24);

    limitError(() => safeUnzip(new Uint8Array(lying), LIMITS));
  });

  it('counts the total across entries, not each on its own', () => {
    const half = new Uint8Array(40 * MiB);
    limitError(() => safeUnzip(zipSync({ 'word/a.xml': half, 'word/b.xml': half }), LIMITS));
  });

  it('allows output just under the limit', () => {
    const files = safeUnzip(zipSync({ 'word/a.xml': new Uint8Array(1000) }), {
      ...LIMITS,
      zipMaxUncompressedBytes: 1000,
    });
    assert.equal(files['word/a.xml'].length, 1000);
  });

  it('limits the number of entries', () => {
    const many = {};
    for (let i = 0; i < 50; i += 1) many[`xl/s${i}.xml`] = strToU8('x');
    limitError(() => safeUnzip(zipSync(many), { ...LIMITS, zipMaxEntries: 49 }));
    assert.equal(
      Object.keys(safeUnzip(zipSync(many), { ...LIMITS, zipMaxEntries: 50 })).length,
      50
    );
  });

  it('is applied by file-type detection, so a bomb never reaches a parser', () => {
    config.security.limits.zipMaxUncompressedBytes = 1 * MiB;
    const bomb = zipSync({ 'word/document.xml': new Uint8Array(50 * MiB) });
    assert.throws(
      () => detectFileType(bomb, 'quarterly.docx'),
      (error) => error instanceof AppError && error.code === 'ARCHIVE_LIMIT_EXCEEDED'
    );
  });

  it('is applied by the DOCX and XLSX parsers, and reported as a limit, not as corruption', () => {
    config.security.limits.zipMaxUncompressedBytes = 1 * MiB;
    const bomb = zipSync({
      'word/document.xml': new Uint8Array(50 * MiB),
      'xl/workbook.xml': new Uint8Array(1),
    });

    for (const parse of [parseDocx, parseXlsx]) {
      assert.throws(
        () => parse(bomb, 'DOC-001'),
        (error) => error instanceof AppError && error.code === 'ARCHIVE_LIMIT_EXCEEDED'
      );
    }
  });
});

describe('archives that are not archives', () => {
  it('rejects bytes that only begin like a ZIP', () => {
    const junk = new Uint8Array([
      0x50,
      0x4b,
      0x03,
      0x04,
      ...Array.from({ length: 40 }, (_, i) => i),
    ]);
    assert.throws(
      () => safeUnzip(junk, LIMITS),
      (error) => !(error instanceof ArchiveLimitError)
    );
    assert.throws(
      () => detectFileType(Buffer.from(junk), 'x.docx'),
      (error) => error.code === 'CORRUPT_DOCUMENT'
    );
  });

  it('rejects an archive cut off in the middle of an entry', () => {
    // Random bytes do not compress, so the entry is long enough for the cut to land inside it.
    const bytes = zipSync({ 'word/document.xml': new Uint8Array(randomBytes(20_000)) });
    assert.ok(bytes.length > 15_000);
    assert.throws(() => safeUnzip(bytes.subarray(0, 8000), LIMITS), /invalid zip data/);
  });

  it('rejects an empty input', () => {
    assert.throws(() => safeUnzip(new Uint8Array(0), LIMITS), /invalid zip data/);
  });

  it('still tells a ZIP that is not Office from corruption', () => {
    const plain = zipSync({ 'readme.txt': strToU8('hello') });
    assert.throws(
      () => detectFileType(Buffer.from(plain), 'x.zip'),
      (error) => error.code === 'UNSUPPORTED_FILE_TYPE'
    );
  });
});

describe('the PDF page cap', () => {
  const pages = (count) =>
    Array.from({ length: count }, (_, i) => [`Page ${i + 1}: the system must log the request.`]);

  it('refuses a document with more pages than allowed, before reading any page', async () => {
    config.security.limits.pdfMaxPages = 3;
    await assert.rejects(parsePdf(buildPdf(pages(4)), 'DOC-001'), (error) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, 'PDF_TOO_MANY_PAGES');
      assert.equal(error.statusCode, 422);
      assert.match(error.message, /3 pages/);
      return true;
    });
  });

  it('accepts a document at the limit', async () => {
    config.security.limits.pdfMaxPages = 3;
    const parsed = await parsePdf(buildPdf(pages(3)), 'DOC-001');
    assert.equal(parsed.metrics.page_count, 3);
  });
});
