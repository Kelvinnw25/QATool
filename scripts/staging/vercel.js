import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { STAGING } from './config.js';
import { tail } from './redact.js';

/**
 * The Vercel CLI, on the Windows host, for the one project this setup may change.
 *
 * Authentication is the CLI's own (`vercel login`); no token is read, stored or passed here, and none is
 * ever put in a container. What it may do is deliberately small:
 *
 *   - confirm WHO it is and WHICH project is linked (and refuse anything but `qatool-staging`);
 *   - set ONE variable, `VITE_API_BASE_URL`, for Production only, in place, never touching another variable
 *     or another environment;
 *   - deploy to production, which the owner approved for this project only.
 *
 * The address travels on standard input, not as an argument. Output is shown only through `tail`, which
 * redacts it. Vercel prints stored values as base64 text and the account's team name; neither is echoed.
 */

const VAR = STAGING.envName;
const TARGET = STAGING.envTarget;

function failure(result, what) {
  const reason = result.timedOut
    ? 'timed out'
    : result.missing
      ? 'the Vercel CLI was not found'
      : `exit ${result.code}`;
  const error = new Error(`${what} failed (${reason}).`);
  error.detail = tail(`${result.stdout}\n${result.stderr}`);
  return error;
}

/**
 * @param {object} options
 * @param {Function} options.run  from shell.js
 * @param {string} options.root   repository root (where `.vercel/` is)
 * @param {(file: string) => Promise<string>} [options.readText]
 */
export function createVercel({ run, root, readText = (file) => readFile(file, 'utf8') }) {
  const vercel = (args, options = {}) =>
    run('vercel', args, { timeoutMs: STAGING.timeouts.commandMs, ...options });

  return {
    /** The CLI's version, or null when it is not installed. */
    async version() {
      const result = await vercel(['--version'], { timeoutMs: 30_000 });
      if (result.missing || result.code !== 0) return null;
      return /(\d+\.\d+\.\d+)/.exec(`${result.stdout}\n${result.stderr}`)?.[1] ?? 'unknown';
    },

    /**
     * Is a user logged in? Exit status only; the user's name is not printed or kept. "Logged out" and "could
     * not find out" are different answers: a network or API failure must not send the owner to `vercel login`.
     *
     * @returns {Promise<{ state: 'ok' | 'logged-out' | 'error', detail: string }>}
     */
    async loginStatus() {
      const result = await vercel(['whoami'], { timeoutMs: 60_000 });
      if (result.code === 0) return { state: 'ok', detail: '' };
      const text = `${result.stdout}
${result.stderr}`;
      const loggedOut =
        /no existing credentials|not logged in|please log in|run .?vercel login|token is not valid|invalid token|expired/i.test(
          text
        );
      return {
        state: loggedOut ? 'logged-out' : 'error',
        detail: result.timedOut ? 'timed out' : tail(text, 6),
      };
    },

    /** The project this folder is linked to, from `.vercel/project.json` (a Git-ignored file). */
    async linkedProject() {
      try {
        const json = JSON.parse(await readText(path.join(root, '.vercel', 'project.json')));
        return {
          id: typeof json.projectId === 'string' ? json.projectId : null,
          name: typeof json.projectName === 'string' ? json.projectName : null,
        };
      } catch {
        return { id: null, name: null };
      }
    },

    /** What Vercel itself says the linked project is: `{ id, name }` from `vercel project inspect`. */
    async inspectProject() {
      const result = await vercel(['project', 'inspect'], { timeoutMs: 90_000 });
      if (result.code !== 0) throw failure(result, 'vercel project inspect');
      const text = `${result.stdout}\n${result.stderr}`;
      return {
        id: /^\s*ID\s+(prj_[A-Za-z0-9]+)\s*$/m.exec(text)?.[1] ?? null,
        name: /^\s*Name\s+(\S+)\s*$/m.exec(text)?.[1] ?? null,
      };
    },

    /**
     * How many times, and for which environments, the variable exists for Production.
     * @returns {Promise<Array<{ environments: string[] }>>}
     */
    async variableRows() {
      const result = await vercel(['env', 'list', '--environment', TARGET], { timeoutMs: 90_000 });
      if (result.code !== 0) throw failure(result, 'vercel env list');
      const rows = [];
      for (const line of `${result.stdout}\n${result.stderr}`.split(/\r?\n/)) {
        const columns = line.trim().split(/\s{2,}/);
        if (columns[0] !== VAR) continue;
        rows.push({
          environments: (columns[3] ?? '')
            .split(',')
            .map((e) => e.trim())
            .filter(Boolean),
        });
      }
      return rows;
    },

    /**
     * Sets `VITE_API_BASE_URL` for Production: updated in place if it exists, added if it does not. Never
     * more than one variable, never another environment. The caller has already refused the cases where an
     * update would reach beyond Production.
     */
    async setVariable(url, { exists }) {
      const args = exists
        ? ['env', 'update', VAR, '--environment', TARGET, '--yes']
        : ['env', 'add', VAR, '--environment', TARGET, '--no-sensitive', '--yes'];
      const result = await vercel(args, { input: `${url}\n`, timeoutMs: 120_000 });
      if (result.code !== 0) throw failure(result, exists ? 'vercel env update' : 'vercel env add');
    },

    /** A production deployment of the linked project. Returns the deployment's own URL. */
    async deployProduction() {
      const result = await vercel(['deploy', '--prod', '--yes'], {
        timeoutMs: STAGING.timeouts.deployMs,
      });
      if (result.code !== 0) throw failure(result, 'vercel deploy --prod');
      // The CLI prints the deployment's own address on one stream and the production alias on another; the
      // alias is the page everyone uses, not a record of this deployment, so it is skipped.
      const urls = [
        ...`${result.stderr}\n${result.stdout}`.matchAll(/https:\/\/[a-z0-9-]+\.vercel\.app/gi),
      ]
        .map((m) => m[0].toLowerCase())
        .filter((url) => url !== STAGING.frontendOrigin);
      return { deploymentUrl: urls[0] ?? null };
    },
  };
}
