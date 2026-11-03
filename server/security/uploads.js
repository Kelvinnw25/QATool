import { AppError } from '../lib/errors.js';

/**
 * Reads uploaded documents with limits applied WHILE the bytes arrive.
 *
 * The earlier route called `part.toBuffer()` on each file, which stops one file
 * at the per-file limit but lets twenty of them through: the audit measured a
 * 60 MB upload accepted under a 25 MB body limit. Here every chunk is counted as
 * it is read, and the first limit crossed ends the read at once, so an oversized
 * request costs at most one chunk beyond the limit rather than the whole upload.
 *
 * Three limits, three stable errors (all HTTP 413):
 *
 *   TOO_MANY_FILES    more files than UPLOAD_MAX_FILES
 *   FILE_TOO_LARGE    one file over UPLOAD_MAX_FILE_BYTES
 *   UPLOAD_TOO_LARGE  all files together over UPLOAD_MAX_TOTAL_BYTES
 *
 * A declared Content-Length that already exceeds the total (plus a small
 * allowance for multipart framing) is refused before any byte is read.
 *
 * The multipart plugin is configured with the same per-file and file-count
 * limits, so it is a second line of defence, not the only one.
 */

const MiB = 1024 * 1024;

/** Multipart boundaries and part headers: far below this for a handful of files. */
const FRAMING_ALLOWANCE = 256 * 1024;

const mib = (bytes) => (bytes >= MiB ? `${Math.floor(bytes / MiB)} MB` : `${bytes} bytes`);

function tooLarge(limits) {
  return new AppError(
    'UPLOAD_TOO_LARGE',
    `The documents together exceed the ${mib(limits.uploadMaxTotalBytes)} upload limit.`,
    413
  );
}

function fileTooLarge(limits) {
  return new AppError(
    'FILE_TOO_LARGE',
    `A document exceeds the ${mib(limits.uploadMaxFileBytes)} limit.`,
    413
  );
}

/**
 * Reads one uploaded file part, counting as the bytes arrive.
 *
 * @param {any} part     a multipart file part
 * @param {{ total: number }} state  bytes read so far across all files (updated here)
 */
async function readFilePart(part, state, limits) {
  const chunks = [];
  let size = 0;

  for await (const chunk of part.file) {
    size += chunk.length;
    state.total += chunk.length;

    if (size > limits.uploadMaxFileBytes) {
      part.file.destroy();
      throw fileTooLarge(limits);
    }
    if (state.total > limits.uploadMaxTotalBytes) {
      part.file.destroy();
      throw tooLarge(limits);
    }
    chunks.push(chunk);
  }

  // The plugin cuts a file off at its own per-file limit and flags it.
  if (part.file.truncated) throw fileTooLarge(limits);

  return {
    filename: part.filename,
    mimetype: part.mimetype,
    buffer: Buffer.concat(chunks),
  };
}

function tooManyFiles(part) {
  part.file.destroy();
  return new AppError('TOO_MANY_FILES', 'Too many documents in one upload.', 413);
}

/** Maps what the multipart plugin throws to the stable errors above. */
function asUploadError(cause, limits) {
  if (cause instanceof AppError) return cause;
  if (cause?.code === 'FST_REQ_FILE_TOO_LARGE') return fileTooLarge(limits);
  if (cause?.code === 'FST_FILES_LIMIT' || cause?.code === 'FST_PARTS_LIMIT') {
    return new AppError('TOO_MANY_FILES', 'Too many documents in one upload.', 413);
  }
  return new AppError('UPLOAD_FAILED', 'The upload could not be read.', 400);
}

function checkDeclaredLength(request, limits) {
  const declared = Number(request.headers?.['content-length']);
  if (Number.isFinite(declared) && declared > limits.uploadMaxTotalBytes + FRAMING_ALLOWANCE) {
    throw tooLarge(limits);
  }
}

/**
 * @param {{ files: () => AsyncIterable<any>, headers: Record<string, any> }} request
 * @param {{ uploadMaxFiles: number, uploadMaxFileBytes: number, uploadMaxTotalBytes: number }} limits
 * @returns {Promise<Array<{ filename: string, mimetype: string, buffer: Buffer }>>}
 * @throws {AppError}
 */
export async function readUploads(request, limits) {
  checkDeclaredLength(request, limits);

  const files = [];
  const state = { total: 0 };

  try {
    for await (const part of request.files()) {
      if (files.length >= limits.uploadMaxFiles) throw tooManyFiles(part);
      files.push(await readFilePart(part, state, limits));
    }
  } catch (cause) {
    throw asUploadError(cause, limits);
  }

  return files;
}

/**
 * Like readUploads(), for a form that also carries a few text fields (the job upload
 * sends the project name beside its documents). Files are limited exactly the same way;
 * a text field is kept only if its name is in `fieldNames`, so a caller cannot make the
 * server hold arbitrary form data. Each field is capped by the multipart plugin's own
 * field size limit.
 *
 * @param {{ parts: () => AsyncIterable<any>, headers: Record<string, any> }} request
 * @param {object} limits  as readUploads()
 * @param {{ fieldNames?: string[] }} [options]
 * @returns {Promise<{ files: Array<{ filename: string, mimetype: string, buffer: Buffer }>, fields: Record<string, string> }>}
 * @throws {AppError}
 */
export async function readUploadForm(request, limits, { fieldNames = [] } = {}) {
  checkDeclaredLength(request, limits);

  const allowed = new Set(fieldNames);
  const files = [];
  const fields = {};
  const state = { total: 0 };

  try {
    for await (const part of request.parts()) {
      if (part.type === 'file') {
        if (files.length >= limits.uploadMaxFiles) throw tooManyFiles(part);
        files.push(await readFilePart(part, state, limits));
        continue;
      }

      if (allowed.has(part.fieldname) && typeof part.value === 'string' && !part.valueTruncated) {
        fields[part.fieldname] = part.value;
      } else if (allowed.has(part.fieldname)) {
        throw new AppError('UPLOAD_FAILED', 'The upload could not be read.', 400);
      }
    }
  } catch (cause) {
    throw asUploadError(cause, limits);
  }

  return { files, fields };
}
