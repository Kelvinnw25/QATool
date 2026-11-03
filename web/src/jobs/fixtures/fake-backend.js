/**
 * A stand-in for the QATOOL demo backend, for tests: a `fetch` that speaks the job API.
 *
 * Shapes are copied from the real backend's source and docs (server/jobs/routes.js,
 * server/jobs/manager.js, server/routes/session.js, docs/PUBLIC_DEMO_JOBS.md), not invented: the
 * job view's fields, the 202/409/429/404 replies, `Retry-After`, and the identical 404 for a job
 * that is not yours. No network, no timers, no model.
 *
 * Each job advances one step every time its status is read, as a real one advances with time, so a
 * test can count polls instead of waiting.
 */

export const GOOD_TOKEN = 'turnstile-good';
export const BOOT = 'b_boot1';

const json = (status, body, headers = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

const fail = (status, code, message, extra = {}, headers = {}) =>
  json(status, { error: { code, message, ...extra } }, headers);

const PHASES = ['extract', 'generate', 'validate'];

const RESULTS = {
  extract: () => ({
    documents: [{ document_id: 'DOC-001', filename: 'prd.docx' }],
    requirements: [{ requirement_id: 'REQ-001', title: 'Login' }],
    test_points: [{ requirement_id: 'REQ-001', point: 'boundary' }],
    warnings: [],
    metrics: { requirement_count: 1, failed_document_count: 0 },
    structuring: { llm: 'completed', error: null },
  }),
  generate: () => ({
    project: { project_name: 'Demo project' },
    test_cases: [{ case_id: 'TC-001', requirement_ids: ['REQ-001'] }],
    warnings: [],
    metadata: { requirement_count: 1, duration_ms: 1200 },
  }),
  validate: () => ({
    valid: true,
    schema_issues: [],
    reference_issues: [],
    semantic_warnings: [],
    semantic: { llm: 'completed', error: null },
    coverage: { uncovered: [] },
  }),
};

export function fakeBackend({ now = () => Date.now(), ticketLifetimeMs = 30 * 60_000 } = {}) {
  const calls = [];
  const jobs = new Map();
  /** Responses to give instead of the default, once each, keyed by "METHOD /path-pattern". */
  const overrides = new Map();
  let nextJob = 1;
  let nextTicket = 1;
  const tickets = new Map(); // ticket -> sid
  const state = { boot: BOOT, mintCount: 0, queuedAhead: 0 };

  function override(key, ...responders) {
    overrides.set(key, [...(overrides.get(key) ?? []), ...responders]);
  }

  const sidOf = (request) => {
    const header = request.headers.get('authorization') ?? '';
    const ticket = header.startsWith('Bearer ') ? header.slice(7) : null;
    return ticket && tickets.has(ticket) ? tickets.get(ticket) : null;
  };

  function view(job) {
    const queued = job.state === 'queued';
    return {
      id: job.id,
      state: job.state,
      from: job.from,
      phase: job.phase,
      phases: { ...job.phases },
      position: queued ? job.position : null,
      queue: { capacity: 10 },
      paused: false,
      created_at: new Date(job.createdAt).toISOString(),
      started_at: null,
      updated_at: new Date(now()).toISOString(),
      completed_at: null,
      elapsed_ms: 0,
      queue_wait_ms: 0,
      processing_ms: job.state === 'processing' ? 4000 : 0,
      poll_after_ms: 2500,
      result_available: Object.keys(job.results).length > 0,
      cancel_reason: job.cancelReason,
      error: job.error,
      boot_id: state.boot,
    };
  }

  /** One step of the job's life per status read. */
  function advance(job) {
    if (['completed', 'failed', 'cancelled'].includes(job.state)) return;

    if (job.state === 'queued') {
      if (job.position > 1) {
        job.position -= 1;
        return;
      }
      job.state = 'processing';
      job.phase = job.sequence[0];
      job.phases[job.phase] = 'running';
      return;
    }

    // processing: finish the running phase, start the next or end.
    const index = job.sequence.indexOf(job.phase);
    job.phases[job.phase] = 'done';
    job.results[job.phase] = RESULTS[job.phase]();

    if (job.failAfter === job.phase) {
      job.state = 'failed';
      const next = job.sequence[index + 1] ?? job.phase;
      job.phases[next] = 'failed';
      job.error = {
        code: 'LLM_UNAVAILABLE',
        message: 'The model provider is temporarily unavailable. Retry later.',
        retryable: true,
        phase: next,
      };
      job.phase = null;
      return;
    }

    if (index + 1 < job.sequence.length) {
      job.phase = job.sequence[index + 1];
      job.phases[job.phase] = 'running';
    } else {
      job.state = 'completed';
      job.phase = null;
    }
  }

  async function handle(request) {
    const url = new URL(request.url);
    const key = `${request.method} ${url.pathname}`;
    const pattern = key.replace(/\/j_[A-Za-z0-9_-]+/, '/:id');
    calls.push({ method: request.method, path: url.pathname, request });

    const queue = overrides.get(pattern);
    if (queue?.length) {
      const respond = queue.shift();
      const reply = await respond(request, { jobs, state });
      if (reply) return reply;
    }

    if (key === 'POST /api/session') {
      const body = await request.json().catch(() => ({}));
      if (body.turnstile_token !== GOOD_TOKEN) {
        return fail(400, 'TURNSTILE_FAILED', 'The verification could not be completed.');
      }
      state.mintCount += 1;
      const ticket = `ticket-${nextTicket}`;
      tickets.set(ticket, `sid-${nextTicket}`);
      nextTicket += 1;
      return json(200, {
        ticket,
        expires_at: new Date(now() + ticketLifetimeMs).toISOString(),
        limits: {
          max_files: 30,
          max_file_bytes: 10 * 1024 * 1024,
          max_total_bytes: 20 * 1024 * 1024,
        },
        poll_interval_ms: 2500,
      });
    }

    const sid = sidOf(request);
    if (sid === null) return fail(401, 'UNAUTHENTICATED', 'Authentication is required.');

    if (key === 'POST /api/jobs') {
      const live = [...jobs.values()].find(
        (job) => job.sid === sid && !['completed', 'failed', 'cancelled'].includes(job.state)
      );
      if (live) {
        return fail(409, 'JOB_ALREADY_ACTIVE', 'You already have a job in progress.', {
          details: { job_id: live.id },
        });
      }

      let from = 'extract';
      if (request.headers.get('content-type')?.includes('application/json')) {
        from = (await request.json()).from;
      } else {
        await request.formData(); // consumes the body, as the server does
      }

      const id = `j_${String(nextJob).padStart(4, '0')}`;
      nextJob += 1;
      const sequence = PHASES.slice(PHASES.indexOf(from));
      const job = {
        id,
        sid,
        from,
        state: 'queued',
        phase: null,
        position: state.queuedAhead + 1,
        phases: Object.fromEntries(
          PHASES.map((p) => [p, PHASES.indexOf(p) < PHASES.indexOf(from) ? 'skipped' : 'pending'])
        ),
        sequence,
        results: {},
        error: null,
        cancelReason: null,
        createdAt: now(),
        failAfter: state.failAfter ?? null,
      };
      jobs.set(id, job);
      return json(202, { job: view(job) }, { Location: `/api/jobs/${id}` });
    }

    const match = /^\/api\/jobs\/(j_[A-Za-z0-9_-]+)(\/result|\/cancel)?$/.exec(url.pathname);
    if (match) {
      const job = jobs.get(match[1]);
      if (!job || job.sid !== sid) return fail(404, 'JOB_NOT_FOUND', 'The job was not found.');

      if (match[2] === '/cancel' && request.method === 'POST') {
        if (!['completed', 'failed', 'cancelled'].includes(job.state)) {
          job.state = 'cancelled';
          job.cancelReason = 'user';
          for (const p of PHASES) if (job.phases[p] === 'running') job.phases[p] = 'cancelled';
        }
        return json(200, { job: view(job) });
      }
      if (match[2] === '/result') {
        return json(200, { job: view(job), phases: { ...job.results } });
      }
      advance(job);
      return json(200, { job: view(job) });
    }

    if (key === 'POST /api/export') {
      return new Response(new Uint8Array([80, 75, 3, 4]), {
        status: 200,
        headers: {
          'content-type': 'application/octet-stream',
          'content-disposition': 'attachment; filename="SIT Script.xlsx"',
          'x-qatool-row-count': '1',
          'x-qatool-export-warnings': '0',
        },
      });
    }

    if (key === 'POST /api/validate') return json(200, RESULTS.validate());

    return fail(401, 'UNAUTHENTICATED', 'Authentication is required.');
  }

  return {
    calls,
    jobs,
    state,
    override,
    fetch: (input, init) => handle(new Request(new URL(input, 'http://api.test'), init)),
    /** Simulates a restart: every job is gone and the boot id changes. */
    restart() {
      jobs.clear();
      state.boot = `b_boot${Number(state.boot.slice(6)) + 1}`;
    },
    fail,
    json,
  };
}

/** A clock a test can move, and a `sleep` that moves it. */
export function fakeClock(start = 1_700_000_000_000) {
  let t = start;
  const slept = [];
  return {
    now: () => t,
    advance(ms) {
      t += ms;
    },
    sleep: async (ms) => {
      slept.push(ms);
      t += ms;
    },
    slept,
  };
}
