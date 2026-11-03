import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadSecuritySettings } from './security/settings.js';

const serverDir = path.dirname(fileURLToPath(import.meta.url));

export const rootDir = path.resolve(serverDir, '..');

function resolveFromRoot(value, fallback) {
  return path.resolve(rootDir, value ?? fallback);
}

function optionalFloat(value) {
  const parsed = Number.parseFloat(value ?? '');
  return Number.isFinite(parsed) ? parsed : null;
}

function intFromEnv(value, fallback) {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

const maxBodyBytes = intFromEnv(process.env.MAX_BODY_BYTES, 25 * 1024 * 1024);

export const config = {
  env: process.env.NODE_ENV ?? 'development',
  host: process.env.HOST ?? '127.0.0.1',
  port: intFromEnv(process.env.PORT, 3001),

  templatePath: resolveFromRoot(
    process.env.SIT_TEMPLATE_PATH,
    'templates/sit-script-template.xlsx'
  ),
  webDistDir: resolveFromRoot(null, 'web/dist'),

  /**
   * Ceiling on any request body - uploaded documents in milestone 2, and the
   * canonical object posted to /api/validate and /api/export today. Uploads are
   * parsed from this buffer in memory and never written to disk, so this is
   * also the effective memory ceiling per request.
   */
  maxBodyBytes,

  logLevel: process.env.LOG_LEVEL ?? 'info',

  /**
   * Public mode, the Cloudflare Access identity, the origin allowlist and every
   * resource limit (server/security/). PUBLIC_MODE is off unless set, so the
   * local workflow is unchanged. Checked by assertSecuritySettings() at startup.
   */
  security: loadSecuritySettings(process.env, { maxBodyBytes }),

  /**
   * LLM provider settings (PRD 5/20).
   *
   * Server-side only. The key is read here and passed to the provider adapter;
   * it is never returned by a route, never written into an error message and
   * never logged - `redactSecrets()` below is the single place that decides
   * what a secret looks like, and server/llm/llm.test.js asserts it holds.
   *
   * The provider name is the only switch: nothing outside server/llm/ knows
   * which vendor is configured.
   */
  llm: {
    provider: (process.env.LLM_PROVIDER ?? 'gemini').trim().toLowerCase(),
    apiKey: process.env.GEMINI_API_KEY ?? '',
    model: process.env.GEMINI_MODEL ?? 'gemini-3.8-flash',
    baseUrl: process.env.GEMINI_BASE_URL ?? 'https://generativelanguage.googleapis.com/v1beta',

    /** A full generation is a long single call; 2 minutes, not the fetch default. */
    timeoutMs: intFromEnv(process.env.LLM_TIMEOUT_MS, 120_000),
    maxOutputTokens: intFromEnv(process.env.LLM_MAX_OUTPUT_TOKENS, 32_768),

    /**
     * Unset by default, so the model's own default applies. Google's guidance
     * for every Gemini 3 model is to leave temperature at 1.0: lowering it "may
     * lead to unexpected behavior, such as looping or degraded performance".
     * The instinct to turn it down for structured output is wrong here - the
     * response schema already constrains the shape.
     */
    temperature: optionalFloat(process.env.LLM_TEMPERATURE),

    /**
     * Apayee, the private AI gateway (LLM_PROVIDER=apayee). The default is the
     * port Apayee listens on out of the box. The token is the one Apayee's own
     * APAYEE_AUTH_TOKEN was set to; it is optional only while Apayee runs on
     * this machine without one. Validated by the adapter, which is only loaded
     * when this provider is selected.
     */
    apayeeBaseUrl: (process.env.APAYEE_BASE_URL ?? '').trim() || 'http://127.0.0.1:4100',
    apayeeToken: process.env.APAYEE_TOKEN ?? '',

    /**
     * Allowance for waiting in Apayee's queue, on top of LLM_TIMEOUT_MS, which
     * Apayee applies to execution alone. Together they bound one call.
     */
    apayeeQueueWaitMs: intFromEnv(process.env.APAYEE_QUEUE_WAIT_MS, 60_000),
  },
};

export const isProduction = config.env === 'production';

/**
 * Removes anything key-shaped from a string before it can reach a log or an
 * API response.
 *
 * Belt and braces: no code path deliberately puts the key in a message, but a
 * provider echoing the request back in an error body would do it for us.
 */
export function redactSecrets(text) {
  const value = String(text ?? '');
  const key = config.llm.apiKey;
  const token = config.llm.apayeeToken;

  const scrubbed = key ? value.replaceAll(key, '[redacted]') : value;

  return (token ? scrubbed.replaceAll(token, '[redacted]') : scrubbed)
    .replace(/\b(AIza[\w-]{10,})/g, '[redacted]')
    .replace(/\b(sk-[\w-]{10,})/g, '[redacted]')
    .replace(/([?&](?:key|api_?key)=)[^&\s]+/gi, '$1[redacted]');
}
