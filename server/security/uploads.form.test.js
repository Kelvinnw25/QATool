import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { describe, it } from 'node:test';

import { readUploadForm } from './uploads.js';

const LIMITS = { uploadMaxFiles: 3, uploadMaxFileBytes: 1000, uploadMaxTotalBytes: 2500 };

/** A multipart request made of file and field parts, in the order given. */
function form(parts, headers = {}) {
  const pulled = { chunks: 0, destroyed: 0 };

  const made = parts.map((part) => {
    if (part.type === 'field') {
      return {
        type: 'field',
        fieldname: part.name,
        value: part.value,
        valueTruncated: !!part.truncated,
      };
    }
    let remaining = part.size;
    const stream = new Readable({
      highWaterMark: 1,
      read() {
        if (remaining <= 0) return this.push(null);
        const length = Math.min(100, remaining);
        remaining -= length;
        pulled.chunks += 1;
        this.push(Buffer.alloc(length, 1));
      },
      destroy(error, callback) {
        pulled.destroyed += 1;
        callback(error);
      },
    });
    stream.truncated = !!part.truncated;
    return {
      type: 'file',
      fieldname: 'documents',
      filename: part.name ?? 'doc.pdf',
      mimetype: 'application/octet-stream',
      file: stream,
    };
  });

  return {
    pulled,
    request: {
      headers,
      async *parts() {
        for (const part of made) yield part;
      },
    },
  };
}

const field = (name, value, extra = {}) => ({ type: 'field', name, value, ...extra });
const file = (name, size, extra = {}) => ({ type: 'file', name, size, ...extra });

const refused = (promise, code, status = 413) =>
  assert.rejects(promise, (error) => {
    assert.equal(error.code, code);
    assert.equal(error.statusCode, status);
    return true;
  });

describe('reading an upload form', () => {
  it('returns the files and the one text field it was asked for', async () => {
    const { request } = form([
      field('project_name', 'Demo'),
      file('a.pdf', 400),
      file('b.docx', 900),
    ]);
    const { files, fields } = await readUploadForm(request, LIMITS, {
      fieldNames: ['project_name'],
    });

    assert.deepEqual(fields, { project_name: 'Demo' });
    assert.deepEqual(
      files.map((f) => [f.filename, f.buffer.length]),
      [
        ['a.pdf', 400],
        ['b.docx', 900],
      ]
    );
  });

  it('reads the field wherever it sits in the form', async () => {
    const { request } = form([file('a.pdf', 100), field('project_name', 'After the file')]);
    const { fields } = await readUploadForm(request, LIMITS, { fieldNames: ['project_name'] });
    assert.equal(fields.project_name, 'After the file');
  });

  it('keeps nothing it was not asked for: other fields are dropped, not held', async () => {
    const { request } = form([
      field('provider', 'gemini'),
      field('model', 'x'),
      field('__proto__', 'polluted'),
      field('project_name', 'Demo'),
      file('a.pdf', 100),
    ]);
    const { fields } = await readUploadForm(request, LIMITS, { fieldNames: ['project_name'] });
    assert.deepEqual(fields, { project_name: 'Demo' });
    assert.equal({}.polluted, undefined);
  });

  it('asks for no fields by default', async () => {
    const { request } = form([field('project_name', 'Demo'), file('a.pdf', 100)]);
    const { fields } = await readUploadForm(request, LIMITS);
    assert.deepEqual(fields, {});
  });

  it('refuses a field that was cut short by the field size limit', async () => {
    const { request } = form([field('project_name', 'abc', { truncated: true })]);
    await refused(
      readUploadForm(request, LIMITS, { fieldNames: ['project_name'] }),
      'UPLOAD_FAILED',
      400
    );
  });
});

describe('the same limits as a plain upload', () => {
  it('refuses more files than the ceiling, and stops reading', async () => {
    const { request, pulled } = form([
      file('1', 100),
      file('2', 100),
      file('3', 100),
      file('4', 100),
      file('5', 100),
    ]);
    await refused(readUploadForm(request, LIMITS), 'TOO_MANY_FILES');
    assert.equal(pulled.chunks, 3, 'one chunk per file read, and the fourth was never pulled');
    assert.ok(pulled.destroyed >= 1);
  });

  it('refuses one file over the per-file size as soon as it crosses it', async () => {
    const { request, pulled } = form([file('big.pdf', 1_000_000)]);
    await refused(readUploadForm(request, LIMITS), 'FILE_TOO_LARGE');
    assert.ok(pulled.chunks <= 11, `read ${pulled.chunks} chunks of 10 000 available`);
  });

  it('refuses a total over the limit even when every file is under its own', async () => {
    const { request } = form([file('a', 900), file('b', 900), file('c', 900)]);
    await refused(readUploadForm(request, LIMITS), 'UPLOAD_TOO_LARGE');
  });

  it('refuses a declared length that is already too large, before reading anything', async () => {
    const { request, pulled } = form([file('a', 100)], { 'content-length': String(10_000_000) });
    await refused(readUploadForm(request, LIMITS), 'UPLOAD_TOO_LARGE');
    assert.equal(pulled.chunks, 0);
  });

  it('refuses a file the multipart plugin truncated', async () => {
    const { request } = form([file('a', 500, { truncated: true })]);
    await refused(readUploadForm(request, LIMITS), 'FILE_TOO_LARGE');
  });

  it('turns an unexpected failure into a controlled 400', async () => {
    const request = {
      headers: {},
      async *parts() {
        yield file('x', 1);
        throw Object.assign(new Error('socket hang up with secret contents'), { code: 'EPIPE' });
      },
    };
    // `file()` above is a spec, not a part; the iterator fails before it matters.
    await assert.rejects(readUploadForm(request, LIMITS), (error) => {
      assert.equal(error.code, 'UPLOAD_FAILED');
      assert.equal(error.statusCode, 400);
      assert.ok(!error.message.includes('secret'));
      return true;
    });
  });

  it('maps the plugin’s own limit errors to the same stable codes', async () => {
    for (const [pluginCode, expected] of [
      ['FST_REQ_FILE_TOO_LARGE', 'FILE_TOO_LARGE'],
      ['FST_FILES_LIMIT', 'TOO_MANY_FILES'],
      ['FST_PARTS_LIMIT', 'TOO_MANY_FILES'],
    ]) {
      const request = {
        headers: {},
        async *parts() {
          throw Object.assign(new Error('plugin'), { code: pluginCode });
        },
      };
      await refused(readUploadForm(request, LIMITS), expected);
    }
  });
});
