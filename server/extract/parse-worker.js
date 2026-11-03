import { parentPort, workerData } from 'node:worker_threads';

import { parseDocuments } from './parse.js';

/**
 * The worker side of isolated parsing (extract/isolated.js).
 *
 * Runs exactly the parse the server runs in-thread, `parseDocuments`, on the files and
 * limits it was started with, and posts back either the result or a plain description
 * of the failure. It imports parse.js only, never the model code.
 *
 * Whatever it does, it does on its own thread with its own heap: a hostile document can
 * make it slow or hungry, and the parent ends it with `terminate()` or the heap limit.
 */

const { files, limits } = workerData;

try {
  const parsed = await parseDocuments(
    files.map((file) => ({
      filename: file.filename,
      mimetype: file.mimetype,
      buffer: Buffer.from(file.bytes.buffer, file.bytes.byteOffset, file.bytes.byteLength),
    })),
    { limits }
  );
  parentPort.postMessage({ ok: true, parsed });
} catch (error) {
  // Only what the parent needs to rebuild a controlled error. A message from here can
  // quote a document, so it is not relayed for anything but an AppError (which is
  // written by this code base, not by the document).
  parentPort.postMessage({
    ok: false,
    error:
      typeof error?.code === 'string' && Number.isInteger(error?.statusCode)
        ? {
            code: error.code,
            message: String(error.message),
            statusCode: error.statusCode,
            details: error.details ?? undefined,
          }
        : null,
  });
}
