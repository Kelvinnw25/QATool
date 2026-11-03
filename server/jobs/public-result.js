/**
 * What a phase's output looks like once it is stored for a visitor.
 *
 * Each phase returns exactly what its HTTP route returns today, and the browser
 * already knows that shape. Three fields describe the machinery rather than the
 * project and are removed: which provider answered, which model, and token usage.
 * Where a stage recorded a failure, only its code is kept (the message was already
 * made public by public-provider.js, and a code is all the page branches on).
 *
 * Applied by the job runner before anything is stored, so no code path reads an
 * unscrubbed result, and tested for it.
 */

function scrubStatus(status) {
  if (status === null || typeof status !== 'object') return status;
  const { provider, model, usage, error, ...rest } = status;
  void provider;
  void model;
  void usage;
  return { ...rest, error: error ? { code: error.code ?? null } : (error ?? null) };
}

/** The `/api/extract` body. */
export function publicExtract(result) {
  return { ...result, structuring: scrubStatus(result.structuring) };
}

/** The `/api/generate` body. */
export function publicGenerate(result) {
  if (result.metadata === null || typeof result.metadata !== 'object') return result;
  const { provider, model, usage, ...metadata } = result.metadata;
  void provider;
  void model;
  void usage;
  return { ...result, metadata };
}

/** The `/api/validate` body. */
export function publicValidate(result) {
  return { ...result, semantic: scrubStatus(result.semantic) };
}
