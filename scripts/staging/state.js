import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { normalizeTunnelUrl } from './tunnel-url.js';

/**
 * The start script's memory between runs, in `.qatool-local/` (Git-ignored, never uploaded, never in an image).
 *
 * It holds public addresses and timestamps and nothing else: the current tunnel address, the address the
 * frontend was last successfully deployed with, and when. The schema is a whitelist, so a field added by
 * mistake cannot carry a secret into the file; a value that does not validate is dropped on read and refused
 * on write. A missing or damaged file is simply "no memory": the script then checks the real systems.
 */

const EMPTY = Object.freeze({
  tunnelUrl: null,
  tunnelVerifiedAt: null,
  lastDeployedUrl: null,
  lastDeployedAt: null,
  lastDeploymentUrl: null,
});

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

const FIELDS = {
  tunnelUrl: normalizeTunnelUrl,
  lastDeployedUrl: normalizeTunnelUrl,
  tunnelVerifiedAt: (v) => (typeof v === 'string' && ISO.test(v) ? v : null),
  lastDeployedAt: (v) => (typeof v === 'string' && ISO.test(v) ? v : null),
  // The unique URL of the deployment itself, e.g. https://qatool-staging-abc123.vercel.app
  lastDeploymentUrl: (v) => {
    if (typeof v !== 'string') return null;
    try {
      const url = new URL(v);
      return url.protocol === 'https:' &&
        url.hostname.endsWith('.vercel.app') &&
        !url.username &&
        url.pathname === '/'
        ? url.origin
        : null;
    } catch {
      return null;
    }
  },
};

/**
 * @param {object} options
 * @param {string} options.dir  absolute path of the state directory
 * @param {{ mkdir: Function, readFile: Function, rename: Function, writeFile: Function }} [options.fs]
 * @param {() => number} [options.now]
 */
export function createState({ dir, fs = { mkdir, readFile, rename, writeFile }, now = Date.now }) {
  const file = path.join(dir, 'staging-state.json');
  const monitorDir = path.join(dir, 'monitor');
  const monitorFile = path.join(monitorDir, 'tunnel-url');

  async function atomicWrite(target, text) {
    await fs.mkdir(path.dirname(target), { recursive: true });
    const temporary = `${target}.${process.pid}.tmp`;
    await fs.writeFile(temporary, text, 'utf8');
    await fs.rename(temporary, target);
  }

  async function read() {
    let parsed;
    try {
      parsed = JSON.parse(await fs.readFile(file, 'utf8'));
    } catch {
      return { ...EMPTY };
    }
    const out = { ...EMPTY };
    if (parsed && typeof parsed === 'object') {
      for (const [key, check] of Object.entries(FIELDS)) out[key] = check(parsed[key]);
    }
    return out;
  }

  return {
    file,
    monitorFile,
    read,

    /** Merges known fields into the state. A value that does not validate is refused, not stored. */
    async update(patch) {
      const next = await read();
      for (const [key, value] of Object.entries(patch)) {
        if (!(key in FIELDS)) throw new Error(`unknown state field "${key}"`);
        if (value === null) {
          next[key] = null;
          continue;
        }
        const checked = FIELDS[key](value);
        if (checked === null) throw new Error(`state field "${key}" has an invalid value`);
        next[key] = checked;
      }
      await atomicWrite(
        file,
        `${JSON.stringify({ version: 1, ...next, updatedAt: new Date(now()).toISOString() }, null, 2)}\n`
      );
      return next;
    },

    /**
     * The one file the monitoring container mounts (read-only): the current tunnel address, alone.
     * `null` removes the address (an empty file), so the dashboard says "no tunnel address".
     */
    async writeMonitorUrl(url) {
      const checked = url === null ? '' : normalizeTunnelUrl(url);
      if (checked === null)
        throw new Error('refusing to publish an address that is not a tunnel address');
      await atomicWrite(monitorFile, checked === '' ? '' : `${checked}\n`);
    },
  };
}
