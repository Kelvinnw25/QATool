import net from 'node:net';

/**
 * Security settings: public mode, the Cloudflare Access identity, the browser
 * origin allowlist and every resource limit.
 *
 * Parsed here and nowhere else, from an environment object, so a test can build
 * any configuration it likes and server/config.js stays a thin consumer. This
 * file imports nothing from the app, which keeps it free of import cycles.
 *
 * Two rules shape it:
 *
 *  - A malformed value is a startup error, never a silent default. A limit that
 *    quietly falls back to "unlimited" because of a typo is worse than a server
 *    that refuses to boot, so loadSecuritySettings() collects problems and
 *    assertSecuritySettings() throws them all at once.
 *  - Public mode is strict by default and local mode is not. The defaults for
 *    uploads, the model gate and the deadline differ between the two so that
 *    `npm run dev` keeps working exactly as before (PUBLIC_MODE unset).
 *
 * Variable NAMES appear in messages; values never do.
 */

const MiB = 1024 * 1024;

/** Cloudflare's default proxy read timeout is 125 s; stay clear of it. */
export const MAX_PUBLIC_DEADLINE_MS = 115_000;

const TEAM_DOMAIN = /^[a-z0-9][a-z0-9-]*\.cloudflareaccess\.com$/i;
const EMAIL = /^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/;
const HOSTNAME = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i;
const TURNSTILE_ACTION = /^[A-Za-z0-9_-]{1,32}$/;
const PLACEHOLDER_SECRET = /change.?me|replace.?me|your.?secret|example|placeholder/i;

/** The shortest ticket-signing secret accepted. HS256 is only as strong as its key. */
export const MIN_TICKET_SECRET_CHARS = 32;

/** Most workers QATOOL will run, whatever the setting says. Apayee's own limit applies on top. */
export const MAX_JOB_WORKERS = 3;

export class SecurityConfigError extends Error {
  constructor(problems) {
    super(`Security configuration is not valid:\n - ${problems.join('\n - ')}`);
    this.name = 'SecurityConfigError';
    this.problems = problems;
  }
}

function blank(value) {
  return value === undefined || String(value).trim() === '';
}

function readFlag(env, name, problems) {
  if (blank(env[name])) return false;
  const value = String(env[name]).trim().toLowerCase();
  if (value === 'true' || value === '1') return true;
  if (value === 'false' || value === '0') return false;
  // "yes" or "on" must not silently mean "off" for a switch that guards a deployment.
  problems.push(`${name} must be true, false, 1 or 0.`);
  return false;
}

function readWhole(env, name, fallback, problems, { min = 0 } = {}) {
  if (blank(env[name])) return fallback;
  const text = String(env[name]).trim();
  const value = Number(text);
  if (!/^\d+$/.test(text) || !Number.isSafeInteger(value) || value < min) {
    problems.push(`${name} must be a whole number of at least ${min}.`);
    return fallback;
  }
  return value;
}

function readList(env, name) {
  if (blank(env[name])) return [];
  return String(env[name])
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item !== '');
}

function isLocalHost(hostname) {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}

/** An origin is scheme + host + optional port. No path, no wildcard, written exactly as a browser sends it. */
function readOrigins(env, publicMode, problems) {
  const origins = [];
  for (const entry of readList(env, 'ALLOWED_ORIGINS')) {
    // The URL parser accepts a "*" in a host name, so a wildcard has to be named.
    if (entry.includes('*')) {
      problems.push('ALLOWED_ORIGINS must not contain a wildcard; list each origin exactly.');
      continue;
    }

    let url;
    try {
      url = new URL(entry);
    } catch {
      problems.push('ALLOWED_ORIGINS has an entry that is not a URL.');
      continue;
    }
    const exact = url.origin === entry && (url.protocol === 'https:' || url.protocol === 'http:');
    if (!exact) {
      problems.push(
        'ALLOWED_ORIGINS entries must be exact origins such as https://demo.example.com (scheme, host, optional port; no path, no trailing slash, no wildcard).'
      );
      continue;
    }
    if (publicMode && url.protocol !== 'https:' && !isLocalHost(url.hostname)) {
      problems.push('ALLOWED_ORIGINS must use https:// for anything but localhost in public mode.');
      continue;
    }
    origins.push(entry);
  }
  return [...new Set(origins)];
}

function readPeers(env, problems) {
  const peers = [];
  for (const entry of readList(env, 'TRUSTED_PROXY_PEERS')) {
    const [address, prefix, extra] = entry.split('/');
    const family = net.isIP(address);
    const bits = family === 4 ? 32 : 128;
    const prefixOk =
      prefix === undefined ||
      (/^\d+$/.test(prefix) && Number(prefix) >= 0 && Number(prefix) <= bits);
    if (family === 0 || !prefixOk || extra !== undefined) {
      problems.push('TRUSTED_PROXY_PEERS entries must be IP addresses or CIDR ranges.');
      continue;
    }
    peers.push(entry);
  }
  return peers;
}

/**
 * @param {Record<string, string | undefined>} [env]
 * @param {{ maxBodyBytes?: number }} [options]
 */
export function loadSecuritySettings(env = process.env, { maxBodyBytes = 25 * MiB } = {}) {
  const problems = [];
  const publicMode = readFlag(env, 'PUBLIC_MODE', problems);
  const demoMode = readFlag(env, 'PUBLIC_DEMO', problems);
  if (publicMode && demoMode) {
    problems.push(
      'PUBLIC_MODE (owner-only, Cloudflare Access) and PUBLIC_DEMO (visitors, Turnstile) cannot both be on.'
    );
  }
  // Either kind of exposure gets the strict defaults below.
  const strict = publicMode || demoMode;

  const ownerEmails = [];
  for (const entry of readList(env, 'OWNER_EMAILS')) {
    if (!EMAIL.test(entry)) {
      problems.push('OWNER_EMAILS has an entry that is not an email address.');
      continue;
    }
    ownerEmails.push(entry.toLowerCase());
  }

  return {
    /** Owner-only public mode: every route needs the owner's Cloudflare Access token. */
    publicMode,
    /** Public demo: visitors hold a Turnstile-issued ticket and work through the job API. */
    demoMode,
    /** Either of the two. What the strict defaults, error scrubbing and headers key on. */
    exposed: publicMode || demoMode,

    access: {
      teamDomain: blank(env.ACCESS_TEAM_DOMAIN)
        ? ''
        : String(env.ACCESS_TEAM_DOMAIN).trim().toLowerCase(),
      audience: blank(env.ACCESS_AUD) ? '' : String(env.ACCESS_AUD).trim(),
      ownerEmails: [...new Set(ownerEmails)],
    },

    allowedOrigins: readOrigins(env, strict, problems),

    /**
     * Peers whose CF-Connecting-IP is believed. Empty by default: behind
     * Docker Desktop the socket peer is the bridge gateway, not the tunnel, so
     * the owner reads `peer_ip` from the first request log and lists it here.
     */
    trustedProxyPeers: readPeers(env, problems),

    limits: {
      // A technical ceiling on multipart parts, not a product rule: how many documents
      // fit is decided by the byte limits and the structuring budget.
      uploadMaxFiles: readWhole(env, 'UPLOAD_MAX_FILES', strict ? 30 : 20, problems, { min: 1 }),
      uploadMaxFileBytes: readWhole(
        env,
        'UPLOAD_MAX_FILE_BYTES',
        strict ? 10 * MiB : maxBodyBytes,
        problems,
        { min: 1 }
      ),
      uploadMaxTotalBytes: readWhole(
        env,
        'UPLOAD_MAX_TOTAL_BYTES',
        strict ? 20 * MiB : 100 * MiB,
        problems,
        { min: 1 }
      ),
      zipMaxEntries: readWhole(env, 'ZIP_MAX_ENTRIES', 2000, problems, { min: 1 }),
      zipMaxUncompressedBytes: readWhole(env, 'ZIP_MAX_UNCOMPRESSED_BYTES', 64 * MiB, problems, {
        min: 1,
      }),
      pdfMaxPages: readWhole(env, 'PDF_MAX_PAGES', strict ? 150 : 300, problems, { min: 1 }),
      /**
       * Spreadsheet and Word ceilings. They bound how much XML the regex-based readers
       * walk, which is CPU on the one thread that also answers every other request.
       * Counted while reading, so an oversized sheet stops early.
       */
      xlsxMaxSheets: readWhole(env, 'XLSX_MAX_SHEETS', strict ? 20 : 100, problems, { min: 1 }),
      xlsxMaxRows: readWhole(env, 'XLSX_MAX_ROWS', strict ? 20_000 : 200_000, problems, { min: 1 }),
      xlsxMaxCells: readWhole(env, 'XLSX_MAX_CELLS', strict ? 200_000 : 2_000_000, problems, {
        min: 1,
      }),
      /** Size of one XML part (a sheet, shared strings, word/document.xml) once inflated. */
      xmlPartMaxBytes: readWhole(
        env,
        'XML_PART_MAX_BYTES',
        strict ? 16 * MiB : 64 * MiB,
        problems,
        {
          min: 1,
        }
      ),
      /** JSON bodies (generate, validate, export). Uploads are limited separately. */
      jsonBodyMaxBytes: readWhole(
        env,
        'JSON_BODY_MAX_BYTES',
        strict ? Math.min(5 * MiB, maxBodyBytes) : maxBodyBytes,
        problems,
        { min: 1 }
      ),
      /** Time allowed to receive a whole request. 0 keeps Node's own default. */
      requestTimeoutMs: readWhole(env, 'REQUEST_TIMEOUT_MS', strict ? 90_000 : 0, problems),
    },

    /**
     * The owner-mode model gate; 0 means "no limit" for every field. There is no
     * request budget: the only quota on a model is the provider's own, and the only
     * brakes here are concurrency, the queue and a request rate. The demo does not use
     * this gate at all (the job manager below is its concurrency control).
     */
    gate: {
      llmMaxConcurrent: readWhole(env, 'LLM_MAX_CONCURRENT', publicMode ? 1 : 0, problems),
      llmQueueMax: readWhole(env, 'LLM_QUEUE_MAX', 2, problems),
      llmQueueWaitMs: readWhole(env, 'LLM_QUEUE_WAIT_MS', 20_000, problems),
      requestDeadlineMs: readWhole(env, 'REQUEST_DEADLINE_MS', publicMode ? 110_000 : 0, problems),
      perMinute: readWhole(env, 'RATE_LIMIT_PER_MINUTE', publicMode ? 120 : 0, problems),
    },

    /**
     * The visitor session: a Turnstile check buys a short-lived signed ticket. Secrets
     * live here only to be handed to the services that use them; nothing returns or
     * logs this object.
     */
    demo: {
      ticket: {
        secret: blank(env.TICKET_SECRET) ? '' : String(env.TICKET_SECRET).trim(),
        issuer: blank(env.TICKET_ISSUER) ? 'qatool' : String(env.TICKET_ISSUER).trim(),
        ttlSeconds: readWhole(env, 'TICKET_TTL_SECONDS', 30 * 60, problems, { min: 60 }),
      },
      turnstile: {
        secret: blank(env.TURNSTILE_SECRET) ? '' : String(env.TURNSTILE_SECRET).trim(),
        hostnames: readList(env, 'TURNSTILE_HOSTNAMES').map((entry) => entry.toLowerCase()),
        action: blank(env.TURNSTILE_ACTION) ? 'qatool_demo' : String(env.TURNSTILE_ACTION).trim(),
        maxAgeMs: readWhole(env, 'TURNSTILE_MAX_AGE_MS', 5 * 60_000, problems, { min: 1000 }),
        timeoutMs: readWhole(env, 'TURNSTILE_TIMEOUT_MS', 5_000, problems, { min: 500 }),
      },
      /** A loose backstop on ticket minting per client address; see network.js. */
      mintPerMinutePerIp: readWhole(env, 'SESSION_MINT_PER_MINUTE_PER_IP', 30, problems),
    },

    /**
     * The async job platform. Capacity is `workers` running plus `maxPending` waiting.
     * Workers default to 1 and are never raised automatically: they also have to stay
     * within what the gateway reports it can run at once (jobs/manager.js).
     */
    jobs: {
      workers: readWhole(env, 'JOB_WORKERS', 1, problems, { min: 1 }),
      maxPending: readWhole(env, 'JOB_MAX_PENDING', 10, problems, { min: 1 }),
      /** How long a job may go without a status poll before it is treated as abandoned. */
      leaseMs: readWhole(env, 'JOB_LEASE_MS', 45_000, problems, { min: 1000 }),
      /** 0 derives it from the model-call timeout: 3 calls plus two minutes. */
      deadlineMs: readWhole(env, 'JOB_DEADLINE_MS', 0, problems),
      retainCompletedMs: readWhole(env, 'JOB_RETAIN_COMPLETED_MS', 15 * 60_000, problems, {
        min: 1000,
      }),
      retainFailedMs: readWhole(env, 'JOB_RETAIN_FAILED_MS', 5 * 60_000, problems, { min: 1000 }),
      maxTerminal: readWhole(env, 'JOB_MAX_TERMINAL', 30, problems, { min: 1 }),
      /** Burst protection per ticket. Polling has its own, separate bucket. */
      submitPerMinute: readWhole(env, 'JOB_SUBMIT_PER_MINUTE', 10, problems),
      pollPerMinute: readWhole(env, 'JOB_POLL_PER_MINUTE', 60, problems),
      pollIntervalMs: readWhole(env, 'JOB_POLL_INTERVAL_MS', 2_500, problems, { min: 250 }),
      /** Uploads being read or parsed at once, across all visitors. */
      uploadInflightMax: readWhole(env, 'UPLOAD_INFLIGHT_MAX', 4, problems, { min: 1 }),
      parseConcurrency: readWhole(env, 'PARSE_CONCURRENCY', 1, problems, { min: 1 }),
      /** Wall-clock limit for reading one upload, in its own thread; then the thread is ended. */
      parseTimeoutMs: readWhole(env, 'PARSE_TIMEOUT_MS', 20_000, problems, { min: 500 }),
      /** Heap limit of that thread, in MiB. */
      parseMaxHeapMb: readWhole(env, 'PARSE_MAX_HEAP_MB', 384, problems, { min: 64 }),
      /** Parsed text a pending job may hold, in characters. */
      maxParsedChars: readWhole(env, 'PARSED_TEXT_MAX_CHARS', 2_000_000, problems, { min: 1000 }),
      /** How long admission and new model work pause after the provider reports an outage. */
      breakerCooldownMs: readWhole(env, 'PROVIDER_BREAKER_COOLDOWN_MS', 60_000, problems, {
        min: 1000,
      }),
    },

    problems,
    warnings: [],
  };
}

/**
 * Throws when the settings cannot be trusted to protect a deployment, and
 * returns warnings for the ones that merely deserve a look.
 *
 * @param {ReturnType<typeof loadSecuritySettings>} settings
 * @param {{ provider?: string, timeoutMs?: number, apayeeQueueWaitMs?: number }} [llm]
 * @returns {string[]} warnings
 * @throws {SecurityConfigError}
 */
export function assertSecuritySettings(settings, llm = {}) {
  const problems = [...settings.problems];
  const warnings = [];

  if (settings.publicMode) {
    const { access, gate } = settings;

    if (!TEAM_DOMAIN.test(access.teamDomain)) {
      problems.push(
        'PUBLIC_MODE needs ACCESS_TEAM_DOMAIN set to your Cloudflare Access team domain, such as myteam.cloudflareaccess.com.'
      );
    }
    if (access.audience === '' || /\s/.test(access.audience)) {
      problems.push("PUBLIC_MODE needs ACCESS_AUD set to the Access application's audience tag.");
    }
    if (access.ownerEmails.length === 0) {
      problems.push('PUBLIC_MODE needs OWNER_EMAILS set to at least one owner email address.');
    }
    if (settings.allowedOrigins.length === 0) {
      problems.push('PUBLIC_MODE needs ALLOWED_ORIGINS set to the origin of the public frontend.');
    }

    // A server-wide default of Apayee or Claude would let a request that names
    // no provider spend the owner's subscription. Per-run choice stays possible.
    const provider = String(llm.provider ?? '').toLowerCase();
    if (provider === 'apayee' || provider === 'claude') {
      problems.push(
        'PUBLIC_MODE does not allow LLM_PROVIDER=apayee as the server default. Leave it as gemini; the owner picks Claude per run.'
      );
    } else if (provider !== '' && provider !== 'gemini' && provider !== 'mock') {
      problems.push('LLM_PROVIDER must be gemini or mock in public mode.');
    }

    if (gate.requestDeadlineMs < 1 || gate.requestDeadlineMs > MAX_PUBLIC_DEADLINE_MS) {
      problems.push(
        `REQUEST_DEADLINE_MS must be between 1 and ${MAX_PUBLIC_DEADLINE_MS} in public mode, so the backend answers before Cloudflare's proxy read timeout.`
      );
    } else if (Number(llm.timeoutMs) > gate.requestDeadlineMs) {
      warnings.push(
        'LLM_TIMEOUT_MS is longer than REQUEST_DEADLINE_MS, so the request deadline will end a slow model call first. Lower LLM_TIMEOUT_MS to match.'
      );
    }
  }

  if (settings.demoMode) {
    const { ticket, turnstile } = settings.demo;
    const { jobs } = settings;

    if (ticket.secret.length < MIN_TICKET_SECRET_CHARS || PLACEHOLDER_SECRET.test(ticket.secret)) {
      problems.push(
        `PUBLIC_DEMO needs TICKET_SECRET set to a random value of at least ${MIN_TICKET_SECRET_CHARS} characters.`
      );
    }
    if (turnstile.secret === '' || PLACEHOLDER_SECRET.test(turnstile.secret)) {
      problems.push("PUBLIC_DEMO needs TURNSTILE_SECRET set to the Turnstile widget's secret key.");
    }
    if (turnstile.hostnames.length === 0 || !turnstile.hostnames.every((h) => HOSTNAME.test(h))) {
      problems.push(
        'PUBLIC_DEMO needs TURNSTILE_HOSTNAMES set to the hostname(s) the widget runs on, such as demo.example.com.'
      );
    }
    if (!TURNSTILE_ACTION.test(turnstile.action)) {
      problems.push('TURNSTILE_ACTION may use letters, digits, "_" and "-" only (at most 32).');
    }
    if (settings.allowedOrigins.length === 0) {
      problems.push('PUBLIC_DEMO needs ALLOWED_ORIGINS set to the origin of the public frontend.');
    }
    if (jobs.workers > MAX_JOB_WORKERS) {
      problems.push(`JOB_WORKERS must be between 1 and ${MAX_JOB_WORKERS}.`);
    } else if (jobs.workers > 1) {
      warnings.push(
        `JOB_WORKERS=${jobs.workers}: the gateway must report max_active of at least that, or fewer workers run. Raising Apayee's concurrency is a separate, deliberate step.`
      );
    }
    if (jobs.maxPending > 100) problems.push('JOB_MAX_PENDING must be 100 or less.');
    if (jobs.parseConcurrency > 2) problems.push('PARSE_CONCURRENCY must be 1 or 2.');
    if (jobs.deadlineMs !== 0 && jobs.deadlineMs < Number(llm.timeoutMs)) {
      warnings.push(
        'JOB_DEADLINE_MS is shorter than LLM_TIMEOUT_MS, so the job deadline will end every model call early.'
      );
    }
  }

  if (problems.length > 0) throw new SecurityConfigError(problems);

  settings.warnings = warnings;
  return warnings;
}
