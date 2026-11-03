import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { describe, it } from 'node:test';

import { readUploads } from './uploads.js';

const LIMITS = { uploadMaxFiles: 3, uploadMaxFileBytes: 1000, uploadMaxTotalBytes: 2500 };

/**
 * A request whose files are streams that count how many chunks were pulled, so a
 * test can tell "stopped reading" from "read everything and then complained".
 */
function upload(parts, headers = {}) {
  const pulled = { chunks: 0, destroyed: 0 };

  const files = parts.map(({ name = 'doc.pdf', size, chunk = 100, truncated = false }) => {
    let remaining = size;
    const stream = new Readable({
      // Pull on demand only. The default buffers 16 KB ahead of the consumer, which
      // would make "how much was read" a statement about the buffer, not the reader.
      highWaterMark: 1,
      read() {
        if (remaining <= 0) return this.push(null);
        const length = Math.min(chunk, remaining);
        remaining -= length;
        pulled.chunks += 1;
        this.push(Buffer.alloc(length, 1));
      },
      destroy(error, callback) {
        pulled.destroyed += 1;
        callback(error);
      },
    });
    stream.truncated = truncated;
    return { filename: name, mimetype: 'application/octet-stream', file: stream };
  });

  return {
    pulled,
    request: {
      headers,
      async *files() {
        for (const file of files) yield file;
      },
    },
  };
}

const refused = (promise, code) =>
  assert.rejects(promise, (error) => {
    assert.equal(error.code, code);
    assert.equal(error.statusCode, 413);
    return true;
  });

describe('uploads within the limits', () => {
  it('returns every file with its bytes', async () => {
    const { request } = upload([
      { name: 'a.pdf', size: 400 },
      { name: 'b.docx', size: 1000 },
    ]);
    const files = await readUploads(request, LIMITS);
    assert.deepEqual(
      files.map((file) => [file.filename, file.buffer.length]),
      [
        ['a.pdf', 400],
        ['b.docx', 1000],
      ]
    );
  });

  it('allows a file exactly at the per-file limit and a total exactly at the total limit', async () => {
    const { request } = upload([{ size: 1000 }, { size: 1000 }, { size: 500 }]);
    assert.equal((await readUploads(request, LIMITS)).length, 3);
  });
});

describe('the file count', () => {
  it('refuses a fourth file with TOO_MANY_FILES', async () => {
    const { request } = upload([{ size: 10 }, { size: 10 }, { size: 10 }, { size: 10 }]);
    await refused(readUploads(request, LIMITS), 'TOO_MANY_FILES');
  });

  it('does not read the file that is over the count', async () => {
    const { request, pulled } = upload([{ size: 10 }, { size: 10 }, { size: 10 }, { size: 900 }]);
    const before = pulled.chunks;
    await refused(readUploads(request, LIMITS), 'TOO_MANY_FILES');
    assert.ok(pulled.chunks - before <= 3, 'only the three accepted files were read');
    assert.equal(pulled.destroyed >= 1, true, "the extra file's stream was destroyed");
  });
});

describe('the per-file size', () => {
  it('refuses a file over the limit with FILE_TOO_LARGE', async () => {
    const { request } = upload([{ size: 1001 }]);
    await refused(readUploads(request, LIMITS), 'FILE_TOO_LARGE');
  });

  it('stops reading as soon as the limit is crossed', async () => {
    const { request, pulled } = upload([{ size: 1_000_000, chunk: 100 }]);
    await refused(readUploads(request, LIMITS), 'FILE_TOO_LARGE');
    assert.ok(pulled.chunks <= 12, `pulled ${pulled.chunks} chunks of 10 000, expected about 11`);
  });

  it("honours the plugin's own truncation flag", async () => {
    const { request } = upload([{ size: 1000, truncated: true }]);
    await refused(readUploads(request, LIMITS), 'FILE_TOO_LARGE');
  });
});

describe('the total size across files', () => {
  it('refuses files that are each fine but too large together, with UPLOAD_TOO_LARGE', async () => {
    const { request } = upload([{ size: 900 }, { size: 900 }, { size: 900 }]); // 2700 > 2500
    await refused(readUploads(request, LIMITS), 'UPLOAD_TOO_LARGE');
  });

  it('stops reading while the bytes arrive, not after buffering them all', async () => {
    const limits = { uploadMaxFiles: 20, uploadMaxFileBytes: 1_000_000, uploadMaxTotalBytes: 2500 };
    const { request, pulled } = upload(
      Array.from({ length: 20 }, () => ({ size: 900, chunk: 100 }))
    );
    await refused(readUploads(request, limits), 'UPLOAD_TOO_LARGE');
    assert.ok(pulled.chunks <= 27, `pulled ${pulled.chunks} chunks of the 180 available`);
  });

  it('refuses a declared Content-Length over the total before reading anything', async () => {
    const { request, pulled } = upload([{ size: 100 }], {
      'content-length': String(10 * 1024 * 1024),
    });
    await refused(readUploads(request, LIMITS), 'UPLOAD_TOO_LARGE');
    assert.equal(pulled.chunks, 0);
  });

  it('allows for multipart framing in the declared length', async () => {
    const { request } = upload([{ size: 100 }], {
      'content-length': String(LIMITS.uploadMaxTotalBytes + 500),
    });
    assert.equal((await readUploads(request, LIMITS)).length, 1);
  });

  it('ignores a Content-Length that is not a number', async () => {
    const { request } = upload([{ size: 100 }], { 'content-length': 'abc' });
    assert.equal((await readUploads(request, LIMITS)).length, 1);
  });
});

describe('other upload failures', () => {
  it("maps the multipart plugin's own limit errors to the same stable codes", async () => {
    const failing = (code) => ({
      headers: {},
      async *files() {
        throw Object.assign(new Error('plugin'), { code });
      },
    });
    await refused(readUploads(failing('FST_REQ_FILE_TOO_LARGE'), LIMITS), 'FILE_TOO_LARGE');
    await refused(readUploads(failing('FST_FILES_LIMIT'), LIMITS), 'TOO_MANY_FILES');
    await refused(readUploads(failing('FST_PARTS_LIMIT'), LIMITS), 'TOO_MANY_FILES');
  });

  it("reports anything else as UPLOAD_FAILED without the cause's text", async () => {
    const request = {
      headers: {},
      async *files() {
        throw new Error('socket hang up while reading C:\\secret\\file.pdf');
      },
    };
    await assert.rejects(readUploads(request, LIMITS), (error) => {
      assert.equal(error.code, 'UPLOAD_FAILED');
      assert.equal(error.statusCode, 400);
      assert.doesNotMatch(error.message, /secret|socket/);
      return true;
    });
  });
});
