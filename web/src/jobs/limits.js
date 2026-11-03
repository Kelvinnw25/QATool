/**
 * The upload limits the backend announced when the session started, checked before anything is sent.
 *
 * A courtesy and a saving: a file that is certainly too large is reported at once instead of after
 * a long upload. The server still enforces every limit itself, counting the bytes that actually
 * arrive, so nothing here is a guarantee.
 *
 * @param {{ name: string, size: number }[]} files
 * @param {{ max_files: number, max_file_bytes: number, max_total_bytes: number } | null} limits
 * @returns {string[]}  empty when the files fit (or when no limits are known)
 */
export function checkUploadLimits(files, limits) {
  if (!limits) return [];

  const problems = [];
  const megabytes = (bytes) =>
    `${(bytes / (1024 * 1024)).toFixed(bytes % (1024 * 1024) === 0 ? 0 : 1)} MB`;

  if (files.length > limits.max_files) {
    problems.push(`Too many files: the demo takes at most ${limits.max_files} per run.`);
  }
  for (const file of files) {
    if (file.size > limits.max_file_bytes) {
      problems.push(
        `${file.name} is too large: each file may be at most ${megabytes(limits.max_file_bytes)}.`
      );
    }
  }
  const total = files.reduce((sum, file) => sum + file.size, 0);
  if (total > limits.max_total_bytes) {
    problems.push(
      `The files together are too large: at most ${megabytes(limits.max_total_bytes)}.`
    );
  }
  return problems;
}
