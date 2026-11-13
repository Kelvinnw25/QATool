import { spawn } from 'node:child_process';

/**
 * Running the two programs these scripts use, and nothing else: `docker` and `vercel`.
 *
 * Every call is an argument list, never a command line. The one wrinkle is Windows: the Vercel CLI is a
 * `.cmd` shim, which Node will only start through a shell, so for that one program the arguments are first
 * checked against a strict pattern (letters, digits and a few punctuation marks), which no shell can
 * interpret. Values such as an address travel on standard input, never as an argument. Every call has a
 * timeout and an output limit, and a failed or missing program is a result, not an exception.
 */

const PROGRAMS = new Set(['docker', 'vercel']);
const SAFE_ARG = /^[A-Za-z0-9_.:/=@,+-]+$/;
const MAX_OUTPUT = 4 * 1024 * 1024;

/**
 * @typedef {{ code: number | null, stdout: string, stderr: string, timedOut: boolean, missing: boolean }} RunResult
 */

/**
 * @param {object} [options]
 * @param {string} [options.cwd]
 * @param {NodeJS.Platform} [options.platform]
 * @returns {(program: string, args: string[], options?: { input?: string, timeoutMs?: number }) => Promise<RunResult>}
 */
export function createRunner({ cwd = process.cwd(), platform = process.platform } = {}) {
  return function run(program, args, { input, timeoutMs = 120_000 } = {}) {
    if (!PROGRAMS.has(program)) throw new Error(`refusing to run "${program}"`);
    if (!Array.isArray(args) || args.some((a) => typeof a !== 'string' || a === '')) {
      throw new Error('arguments must be a list of non-empty strings');
    }

    const viaShell = platform === 'win32' && program === 'vercel';
    if (viaShell && !args.every((a) => SAFE_ARG.test(a))) {
      throw new Error('an argument is not safe to pass through a shell');
    }

    return new Promise((resolve) => {
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let missing = false;
      let settled = false;

      const child = spawn(viaShell ? 'vercel.cmd' : program, args, {
        cwd,
        shell: viaShell,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      const finish = (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ code, stdout, stderr, timedOut, missing });
      };

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill();
        // A process tree on Windows may linger; do not wait for it.
        setTimeout(() => finish(null), 2000).unref?.();
      }, timeoutMs);

      const take = (current, chunk) => (current.length < MAX_OUTPUT ? current + chunk : current);
      child.stdout.on('data', (chunk) => (stdout = take(stdout, chunk)));
      child.stderr.on('data', (chunk) => (stderr = take(stderr, chunk)));
      child.on('error', (error) => {
        missing = error.code === 'ENOENT';
        stderr = take(stderr, error.message);
        finish(null);
      });
      child.on('close', (code) => finish(code));

      child.stdin.on('error', () => {});
      child.stdin.end(input ?? '');
    });
  };
}
