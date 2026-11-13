import path from 'node:path';

/**
 * The one rule for what `OPS_METRICS_SOCKET` may name, shared by the server that creates the
 * socket and the reader that connects to it, so they cannot disagree.
 *
 * Deliberately narrow. The path is operator configuration, not input, but it is still the one
 * place a mistake could aim a later `unlink` at the wrong file, so it must be: absolute, POSIX,
 * already normalised (no `..`, no doubled slash), short enough for `sun_path`, and a plain
 * `*.sock` file name. Anything else is refused rather than corrected.
 */

/** `sun_path` is 108 bytes on Linux including the terminator; stay well inside it. */
export const MAX_SOCKET_PATH_BYTES = 100;

/**
 * @param {unknown} value
 * @param {NodeJS.Platform} [platform]
 * @returns {{ ok: true, path: string } | { ok: false, reason: string }}
 */
export function validateSocketPath(value, platform = process.platform) {
  // Node on Windows has no file-based Unix sockets (it would create a named pipe instead), so the
  // feature is Linux/macOS only. In practice that means "inside the backend container".
  if (platform === 'win32') {
    return {
      ok: false,
      reason: 'Unix sockets are not available on Windows; use the Docker backend.',
    };
  }
  if (typeof value !== 'string' || value === '') return { ok: false, reason: 'the path is empty' };
  if (value.includes('\0')) return { ok: false, reason: 'the path contains a NUL byte' };
  if (!path.posix.isAbsolute(value)) return { ok: false, reason: 'the path must be absolute' };
  if (path.posix.normalize(value) !== value || value.endsWith('/')) {
    return { ok: false, reason: 'the path must be normalised (no "..", "//" or trailing "/")' };
  }
  if (Buffer.byteLength(value) > MAX_SOCKET_PATH_BYTES) {
    return { ok: false, reason: `the path is longer than ${MAX_SOCKET_PATH_BYTES} bytes` };
  }
  if (!/^[A-Za-z0-9._-]+\.sock$/.test(path.posix.basename(value))) {
    return {
      ok: false,
      reason: 'the file name must be letters, digits, ".", "_" or "-" and end in ".sock"',
    };
  }
  return { ok: true, path: value };
}
