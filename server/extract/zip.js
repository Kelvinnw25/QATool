import { Unzip, UnzipInflate, UnzipPassThrough } from 'fflate';

import { config } from '../config.js';
import { AppError } from '../lib/errors.js';

/**
 * ZIP reading for uploaded DOCX and XLSX files, with limits on what comes OUT.
 *
 * `unzipSync` inflates every entry fully before returning and sizes its output
 * from numbers the archive declares about itself. The audit measured a 0.2 MB
 * archive expanding to 200 MB (about 1000:1) and blocking the event loop while it
 * did; at the upload cap that is tens of gigabytes. The size an archive claims is
 * not evidence, so this reader trusts none of it.
 *
 * It streams instead. The compressed input is fed in small slices; each slice can
 * inflate to at most about a thousand times its own size, so the output can
 * overshoot a limit by only a few megabytes before the next check stops it. The
 * count is of bytes actually produced, never of declared sizes, and the first
 * limit crossed throws, which abandons the archive.
 *
 * Streaming also reads a ZIP written without sizes in its headers (a data
 * descriptor, as Java's ZipOutputStream does), which a header-driven reader
 * cannot size in advance.
 *
 * Limits: ZIP_MAX_ENTRIES entries, ZIP_MAX_UNCOMPRESSED_BYTES bytes in total.
 *
 * Returns what unzipSync returned, `{ [path]: Uint8Array }`, so callers change
 * only the function they call.
 */

/** Compressed bytes per step. Output per step is bounded by roughly 1000 x this. */
const SLICE_BYTES = 4096;

export class ArchiveLimitError extends AppError {
  constructor(message) {
    super('ARCHIVE_LIMIT_EXCEEDED', message, 422);
    this.name = 'ArchiveLimitError';
  }
}

/**
 * @param {Uint8Array} bytes
 * @param {{ zipMaxEntries: number, zipMaxUncompressedBytes: number }} [limits]
 * @returns {Record<string, Uint8Array>}
 * @throws {ArchiveLimitError} a limit was crossed
 * @throws {Error} the archive is not a readable ZIP (callers report it as corrupt)
 */
export function safeUnzip(bytes, limits = config.security.limits) {
  const files = {};
  let entries = 0;
  let produced = 0;
  let open = 0;

  const unzip = new Unzip((file) => {
    entries += 1;
    if (entries > limits.zipMaxEntries) {
      throw new ArchiveLimitError('The document contains too many internal files.');
    }

    const chunks = [];
    open += 1;

    file.ondata = (error, chunk, final) => {
      if (error) throw error;

      produced += chunk.length;
      if (produced > limits.zipMaxUncompressedBytes) {
        file.terminate?.();
        throw new ArchiveLimitError('The document expands to more than the allowed size.');
      }

      chunks.push(chunk);
      if (final) {
        open -= 1;
        const whole = new Uint8Array(chunks.reduce((sum, part) => sum + part.length, 0));
        let offset = 0;
        for (const part of chunks) {
          whole.set(part, offset);
          offset += part.length;
        }
        files[file.name] = whole;
      }
    };

    file.start();
  });
  unzip.register(UnzipInflate);
  unzip.register(UnzipPassThrough);

  for (let start = 0; start < bytes.length; start += SLICE_BYTES) {
    const end = Math.min(start + SLICE_BYTES, bytes.length);
    unzip.push(bytes.subarray(start, end), end >= bytes.length);
  }

  // No entries, or an entry that never finished: not a complete archive.
  if (entries === 0 || open !== 0) throw new Error('invalid zip data');
  return files;
}
