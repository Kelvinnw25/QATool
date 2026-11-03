import { watchClientDisconnect } from '../lib/cancellation.js';
import { AppError } from '../lib/errors.js';
import { parseOrThrow } from '../lib/validate.js';
import { parseDocumentsIsolated } from '../extract/isolated.js';
import { requireGeneratableInput } from '../generate/index.js';
import { requireCanonical } from '../pipeline/canonical-input.js';
import { projectSchema } from '../schema/project.js';
import { readUploadForm } from '../security/uploads.js';
import { rateLimited } from './errors.js';

/**
 * The job API.
 *
 *   POST /api/jobs               submit: documents (multipart) or a resume (JSON)
 *   GET  /api/jobs/:id           status; renews the lease
 *   GET  /api/jobs/:id/result    the phase results so far, partial included
 *   POST /api/jobs/:id/cancel    idempotent
 *
 * Every route needs a ticket (security/ticket.js), and `request.visitor.sid` is the only
 * identity any of it uses. A job is reachable only through the sid that created it; the
 * id alone proves nothing (jobs/manager.js).
 *
 * Submission order matters, and is the point of the design:
 *
 *   1. ticket          (global hook, before this file)
 *   2. submit limiter  per sid
 *   3. provider check  can the gateway take work at all? (cached, never a model call)
 *   4. reserve         a slot, the visitor's one live job, and an upload-in-flight slot
 *   5. only now: read the body, parse the documents, free the buffers, commit
 *
 * Steps 2 to 4 run in `onRequest`, before the body is read, so a refused submission
 * costs a few header checks and the connection is closed on it: an oversized upload is
 * never buffered for a queue that is full. Parsing happens at step 5, under a parse
 * limit, and what a pending job keeps is the parsed blocks, never the uploaded files.
 *
 * Polling has its own, separate limiter. It is never counted as a submission, and no
 * request here counts against a model quota: there is none.
 */

/** Text fields the upload form may carry. Anything else is ignored. */
const FORM_FIELDS = ['project_name'];

/** The structuring and generation prompts cap what they use; this only bounds what is held. */
const MAX_TEST_POINTS = 6_000;

const JOB_PARAMS = { type: 'object', properties: { id: { type: 'string', maxLength: 64 } } };

export default async function jobRoutes(fastify) {
  const { manager, limiters, metrics, checkProvider } = fastify.jobPlatform;
  const limits = fastify.security.limits;
  const maxParsedChars = manager.settings.maxParsedChars;

  /** onRequest for submit: limiter, provider, reservation. Nothing has been read yet. */
  async function admit(request, reply) {
    try {
      const { sid } = request.visitor;

      const allowance = limiters.submit.hit(sid);
      if (!allowance.ok) {
        metrics.inc('rejected_rate_limited');
        throw rateLimited(allowance.retryAfterMs);
      }

      // Asked only when the breaker is closed: during a cooldown the answer is already
      // known, and probing the gateway would be exactly the traffic the cooldown is for.
      if (!manager.breakerOpen) await checkProvider();

      request.reservation = manager.reserve(sid);
    } catch (error) {
      reply.header('Connection', 'close');
      throw error;
    }
  }

  /** onResponse / onRequestAbort: a reservation that was not committed is given back. */
  async function giveBack(request) {
    request.reservation?.release();
  }

  /** onRequest for everything else: the poll limiter. */
  async function poll(request) {
    const allowance = limiters.poll.hit(request.visitor.sid);
    if (!allowance.ok) {
      metrics.inc('rejected_rate_limited');
      throw rateLimited(allowance.retryAfterMs);
    }
  }

  fastify.post(
    '/api/jobs',
    {
      config: { ownLimit: true },
      onRequest: [admit],
      onResponse: [giveBack],
      onRequestAbort: [giveBack],
    },
    async (request, reply) => {
      const reservation = request.reservation;

      try {
        const spec = request.isMultipart()
          ? await specFromUpload(request, reply)
          : specFromJson(request.body);

        const job = reservation.commit(spec);
        reply.code(202).header('Location', `/api/jobs/${job.id}`);
        return { job };
      } finally {
        // A no-op once committed; otherwise the slot is freed on every failure path.
        reservation.release();
      }
    }
  );

  fastify.get(
    '/api/jobs/:id',
    { config: { ownLimit: true }, onRequest: [poll], schema: { params: JOB_PARAMS } },
    async (request) => ({
      job: manager.status(request.visitor.sid, request.params.id),
    })
  );

  fastify.get(
    '/api/jobs/:id/result',
    { config: { ownLimit: true }, onRequest: [poll], schema: { params: JOB_PARAMS } },
    async (request) => manager.result(request.visitor.sid, request.params.id)
  );

  fastify.post(
    '/api/jobs/:id/cancel',
    { config: { ownLimit: true }, onRequest: [poll], schema: { params: JOB_PARAMS } },
    async (request) => ({ job: manager.cancel(request.visitor.sid, request.params.id) })
  );

  /** Documents: read under the upload limits, parsed now, buffers dropped. */
  async function specFromUpload(request, reply) {
    // A visitor who closes the page while their documents are being read stops the read.
    const leaving = watchClientDisconnect(request, reply);
    try {
      return await readAndParse(request, reply, leaving);
    } finally {
      leaving.release();
    }
  }

  async function readAndParse(request, reply, leaving) {
    let form;
    try {
      form = await readUploadForm(request, limits, { fieldNames: FORM_FIELDS });
    } catch (error) {
      // The rest of an oversized upload is not worth reading.
      reply.header('Connection', 'close');
      if (error.statusCode === 413) metrics.inc('rejected_upload_limits');
      throw error;
    }

    const projectName = parseOrThrow(
      projectSchema.shape.project_name,
      (form.fields.project_name ?? '').trim()
    );

    // On a thread of its own, with a time and a heap limit (extract/isolated.js): the
    // readers are synchronous, and a hostile document can hold a thread for minutes.
    // Cancelled if the visitor leaves while it runs.
    const parsed = await manager.runParse(() =>
      parseDocumentsIsolated(form.files, {
        limits,
        timeoutMs: manager.settings.parseTimeoutMs,
        maxHeapMb: manager.settings.parseMaxHeapMb,
        signal: leaving.signal,
      })
    );
    // The uploaded bytes are no longer needed. Dropping the only references lets them go
    // before the job waits, however long that is.
    form.files.length = 0;

    const characters = parsed.parsedDocuments.reduce(
      (sum, document) =>
        sum +
        (document.blocks ?? []).reduce((inner, block) => inner + (block.text?.length ?? 0), 0),
      0
    );
    if (characters > maxParsedChars) {
      throw new AppError(
        'DOCUMENT_TOO_COMPLEX',
        'The documents contain more text than this demo can process at once.',
        422
      );
    }

    return { from: 'extract', input: { parsed, projectName } };
  }

  /** A resume: the project and test points the browser already holds. */
  function specFromJson(body) {
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      throw new AppError(
        'BAD_REQUEST',
        'Send documents as multipart/form-data, or a JSON body to resume.',
        400
      );
    }

    if (body.from !== 'generate' && body.from !== 'validate') {
      throw new AppError(
        'BAD_REQUEST',
        'A JSON job needs "from" set to "generate" or "validate". Documents start from "extract".',
        400
      );
    }

    const canonical = requireCanonical(body.canonical);
    const testPoints = Array.isArray(body.test_points) ? body.test_points : [];
    if (testPoints.length > MAX_TEST_POINTS) {
      throw new AppError('BAD_REQUEST', 'Too many test points.', 400);
    }

    // Refused now, with the same error generation would give, rather than after a wait in
    // the queue and a worker's turn.
    if (body.from === 'generate') requireGeneratableInput(canonical);

    return { from: body.from, input: { canonical, testPoints } };
  }
}
