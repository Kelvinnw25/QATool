import { Worker } from 'node:worker_threads';

import { AppError } from '../lib/errors.js';

/**
 * Reading documents on a thread of their own.
 *
 * The XLSX and DOCX readers walk the document's XML with regular expressions on the
 * thread that also answers every request. That is fine for a document that is what it
 * says it is. It is not for one built to defeat them: measured, 256 KiB of unclosed
 * `<w:p>` blocks that compresses to a few hundred bytes holds the thread for 4.3 seconds,
 * and the cost quadruples each time the size doubles. A size limit cannot fix that (the
 * ceiling on a part is megabytes), and the calls are synchronous, so nothing can stop
 * one from inside.
 *
 * So, in the public demo, a parse runs in a worker thread (a fresh one per parse, so one
 * document can never see or poison another) with:
 *
 *  - a time limit; at the limit the worker is terminated, which interrupts the regular
 *    expression too,
 *  - a heap limit, so a document that inflates into a large structure ends its own
 *    worker rather than the process,
 *  - the visitor's departure or the shutdown of the server, which terminate it as well.
 *
 * The result is exactly what `parseDocuments` returns in-thread: the worker runs that
 * same function with the same limits. Local mode keeps parsing in-thread, unchanged.
 */

const WORKER_URL = new URL('./parse-worker.js', import.meta.url);

const tooComplex = () =>
  new AppError(
    'DOCUMENT_TOO_COMPLEX',
    'A document has more content than this service can process.',
    422
  );

const failed = () => new AppError('PARSER_FAILURE', 'A document could not be read.', 422);

/**
 * @param {Array<{ filename: string, mimetype?: string, buffer: Buffer }>} files
 * @param {object} options
 * @param {object} options.limits       the parser ceilings (security/settings.js `limits`)
 * @param {number} options.timeoutMs    wall-clock limit for the whole parse
 * @param {number} [options.maxHeapMb]
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<{ documents: object[], parsedDocuments: object[], warnings: object[], startedAt: number }>}
 * @throws {AppError} DOCUMENT_TOO_COMPLEX on timeout or heap exhaustion; the parse's own
 *   errors (EXTRACTION_FAILED, NO_DOCUMENTS) unchanged; PARSER_FAILURE for anything else
 */
export function parseDocumentsIsolated(files, { limits, timeoutMs, maxHeapMb = 384, signal } = {}) {
  if (signal?.aborted) return Promise.reject(signal.reason ?? failed());

  return new Promise((resolve, reject) => {
    // Copied: the worker gets its own bytes, and the parent's buffers (which may come
    // from Node's shared pool) are never transferred away.
    const payload = files.map((file) => ({
      filename: file.filename,
      mimetype: file.mimetype ?? null,
      bytes: new Uint8Array(file.buffer),
    }));

    const worker = new Worker(WORKER_URL, {
      workerData: { files: payload, limits },
      resourceLimits: { maxOldGenerationSizeMb: maxHeapMb, maxYoungGenerationSizeMb: 32 },
    });

    let settled = false;
    const finish = (settle, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      // Always ended: a worker that already posted its answer is simply done, and one that
      // did not is stopped mid-statement.
      worker.terminate().catch(() => {});
      settle(value);
    };

    const timer = setTimeout(() => finish(reject, tooComplex()), timeoutMs);
    const onAbort = () => finish(reject, signal.reason ?? failed());
    signal?.addEventListener('abort', onAbort, { once: true });

    worker.once('message', (message) => {
      if (message.ok) return finish(resolve, message.parsed);

      const known = message.error;
      finish(
        reject,
        known ? new AppError(known.code, known.message, known.statusCode, known.details) : failed()
      );
    });
    worker.once('error', (error) => {
      finish(reject, error?.code === 'ERR_WORKER_OUT_OF_MEMORY' ? tooComplex() : failed());
    });
    worker.once('exit', () => finish(reject, failed()));
  });
}
