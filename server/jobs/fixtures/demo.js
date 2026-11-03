import { buildApp } from '../../app.js';
import { buildDocx } from '../../extract/fixtures/build.js';
import { LlmError } from '../../llm/provider.js';
import { scriptedReply } from '../../llm/fixtures/scripted-replies.js';
import { loadSecuritySettings } from '../../security/settings.js';

/**
 * The public demo, for tests: real settings, a real HTTP listener, a fake Turnstile and
 * a fake model. Nothing here reaches Cloudflare, Apayee or any model.
 *
 * Excluded from the backend image (.dockerignore) with the other test fixtures.
 */

export const ORIGIN = 'https://demo.example.com';
export const OTHER_ORIGIN = 'https://elsewhere.example.net';
export const HOSTNAME = 'demo.example.com';
export const ACTION = 'qatool_demo';
export const TICKET_SECRET = 'ticket-signing-key-0123456789-abcdefghij';
export const TURNSTILE_SECRET = 'turnstile-secret-for-tests-only';

/** Demo-mode settings with every required value present; override any variable. */
export function demoSecurity(overrides = {}) {
  return loadSecuritySettings({
    PUBLIC_DEMO: 'true',
    TICKET_SECRET,
    TURNSTILE_SECRET,
    TURNSTILE_HOSTNAMES: HOSTNAME,
    TURNSTILE_ACTION: ACTION,
    ALLOWED_ORIGINS: ORIGIN,
    // Generous by default; a test that is about a limit sets it.
    JOB_SUBMIT_PER_MINUTE: '1000',
    JOB_POLL_PER_MINUTE: '100000',
    SESSION_MINT_PER_MINUTE_PER_IP: '1000',
    ...overrides,
  });
}

/**
 * A stand-in for Cloudflare's siteverify. By default every token passes; `verdict` can
 * answer differently per call, and every call is recorded.
 */
export function fakeSiteverify({ verdict } = {}) {
  const calls = [];
  const siteverify = async (body, options) => {
    calls.push({ ...body, options });
    if (verdict) return verdict(body, calls.length);
    return {
      success: true,
      hostname: HOSTNAME,
      action: ACTION,
      challenge_ts: new Date().toISOString(),
    };
  };
  siteverify.calls = calls;
  return siteverify;
}

/** A tiny DOCX with two behavioural sentences, as a Blob for a form. */
export function documentBlob(extra = '') {
  return new Blob([
    buildDocx([
      { heading: 'Business Rules', level: 1 },
      { text: 'Transactions from a Suspended participant must be rejected with reason code U253.' },
      {
        text: `A transfer missing a mandatory BIC code must be rejected with code ADMI 002.${extra}`,
      },
    ]),
  ]);
}

export function uploadForm({ projectName = 'Demo Project', files = 1, tag = '' } = {}) {
  const form = new FormData();
  if (projectName !== null) form.append('project_name', projectName);
  for (let index = 0; index < files; index += 1) {
    form.append('documents', documentBlob(` ${tag}${index}`), `PRD ${tag}${index}.docx`);
  }
  return form;
}

/**
 * A model that answers the pipeline's three calls from the scripted replies, with a
 * controllable delay, and records how many calls were in flight at once.
 *
 * @param {object} [options]
 * @param {number} [options.delayMs]
 * @param {(request: object, call: number) => Promise<void> | void} [options.before]  runs
 *   first; throw an LlmError to fail the call
 */
export function fakeModel({ delayMs = 0, before } = {}) {
  const state = { active: 0, peak: 0, calls: 0, aborted: 0, requests: [] };

  const provider = {
    name: 'FakeModel',
    model: 'fake-model',
    async generateJson(request) {
      state.calls += 1;
      state.active += 1;
      state.peak = Math.max(state.peak, state.active);
      state.requests.push(request);
      try {
        await before?.(request, state.calls);
        await new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, delayMs);
          request.signal?.addEventListener(
            'abort',
            () => {
              clearTimeout(timer);
              state.aborted += 1;
              reject(new LlmError('LLM_UNAVAILABLE', 'The request to Apayee was cancelled.', 502));
            },
            { once: true }
          );
        });
        return { data: scriptedReply(request), usage: null };
      } finally {
        state.active -= 1;
      }
    },
  };
  return { provider, state };
}

/**
 * The catalog as the job platform uses it, backed by a fake model. `capacity` is what
 * the "gateway" reports; `available` can be flipped to simulate an outage.
 */
export function fakeProviders({ model = fakeModel(), maxActive = 1, available = true } = {}) {
  const state = {
    available,
    capacity: { reported: true, compatible: true, maxActive, active: 0, pending: 0, capacity: 16 },
    acquired: 0,
    /** the catalog ids asked for, in order */
    ids: [],
    acquireError: null,
  };

  return {
    state,
    model,
    async capacity() {
      return {
        status: state.available
          ? { available: true, reason: null, code: null }
          : { available: false, reason: 'down', code: 'gateway_offline' },
        capacity: state.available ? state.capacity : null,
      };
    },
    async acquire(id, { onCapacity } = {}) {
      state.acquired += 1;
      state.ids.push(id);
      onCapacity?.(state.capacity);
      if (state.acquireError) throw state.acquireError;
      return model.provider;
    },
  };
}

/**
 * The app on a loopback port, with a client for it.
 *
 * @param {object} [options]
 * @param {Record<string, string>} [options.env]  settings overrides (variable names)
 * @param {ReturnType<typeof fakeProviders>} [options.providers]
 * @param {ReturnType<typeof fakeSiteverify>} [options.siteverify]
 * @param {() => number} [options.now]
 * @param {object} [options.logger]
 */
export async function startDemo({
  env = {},
  providers = fakeProviders(),
  siteverify = fakeSiteverify(),
  now,
  logger = false,
} = {}) {
  const security = demoSecurity(env);
  const app = buildApp({ security, siteverify, providers, now, logger });
  const baseUrl = await app.listen({ host: '127.0.0.1', port: 0 });

  /** @returns {Promise<{ status: number, headers: Headers, body: any }>} */
  async function call(
    method,
    path,
    { ticket, origin = ORIGIN, json, form, headers = {}, signal } = {}
  ) {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      signal,
      headers: {
        ...(origin ? { origin } : {}),
        ...(ticket ? { authorization: `Bearer ${ticket}` } : {}),
        ...(json === undefined ? {} : { 'content-type': 'application/json' }),
        ...headers,
      },
      body: json === undefined ? form : JSON.stringify(json),
    });
    const text = await response.text();
    let body = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
    return { status: response.status, headers: response.headers, body };
  }

  /** A fresh visitor: one Turnstile pass, one ticket. */
  async function visitor(label = 'v') {
    const reply = await call('POST', '/api/session', {
      json: { turnstile_token: `token-${label}-${Math.random().toString(36).slice(2)}` },
    });
    if (reply.status !== 200)
      throw new Error(`could not mint a ticket: ${JSON.stringify(reply.body)}`);
    return { ticket: reply.body.ticket, label };
  }

  return {
    app,
    baseUrl,
    security,
    providers,
    siteverify,
    call,
    visitor,
    manager: app.jobPlatform.manager,
    metrics: app.jobPlatform.metrics,
    close: async () => {
      app.server.closeAllConnections?.();
      await app.close();
    },
  };
}

/** Polls until the job reaches one of the states (or the time runs out). */
export async function waitForState(demo, visitor, id, states, timeoutMs = 10_000) {
  const wanted = Array.isArray(states) ? states : [states];
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await demo.call('GET', `/api/jobs/${id}`, { ticket: visitor.ticket });
    if (last.status === 200 && wanted.includes(last.body.job.state)) return last.body.job;
    if (last.status !== 200) throw new Error(`status ${last.status}: ${JSON.stringify(last.body)}`);
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  throw new Error(`Timed out waiting for ${wanted.join('/')}; last: ${JSON.stringify(last?.body)}`);
}
