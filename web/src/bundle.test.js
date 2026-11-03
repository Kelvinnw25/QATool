import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * What ships to a visitor's browser, checked on the real build output and on the source.
 *
 * The build is made here, into a temporary folder, with secret-looking values present in the
 * process environment the way they would be on the owner's machine. Vite copies only `VITE_`
 * variables into a bundle, so none of them may appear - and the test proves that by looking, not by
 * trusting the prefix. Nothing is deployed and nothing is written next to the real `web/dist`.
 */

const srcDir = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(srcDir, '..');

const SENTINELS = {
  TICKET_SECRET: 'sentinel-ticket-secret-0123456789abcdef0123456789',
  TURNSTILE_SECRET: 'sentinel-turnstile-secret-0xDEADBEEF',
  APAYEE_TOKEN: 'sentinel-apayee-token-98765',
  ANTHROPIC_API_KEY: 'sentinel-anthropic-key-abc',
};

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

async function buildInto(outDir, env) {
  const { build } = await import('vite');
  const react = (await import('@vitejs/plugin-react')).default;

  const saved = {};
  const set = { ...env, ...SENTINELS };
  for (const [key, value] of Object.entries(set)) {
    saved[key] = process.env[key];
    process.env[key] = value;
  }
  try {
    await build({
      root: webRoot,
      configFile: false,
      logLevel: 'silent',
      mode: 'production',
      plugins: [react()],
      build: { outDir, emptyOutDir: true, write: true, minify: false },
    });
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  return walk(outDir)
    .filter((file) => /\.(js|html|css)$/.test(file))
    .map((file) => readFileSync(file, 'utf8'))
    .join('\n');
}

describe('the public demo bundle', () => {
  let demo;
  let local;
  const folders = [];

  const scratch = () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'qatool-bundle-'));
    folders.push(dir);
    return dir;
  };

  it('builds', async () => {
    demo = await buildInto(scratch(), {
      VITE_PUBLIC_DEMO: 'true',
      VITE_API_BASE_URL: 'https://api.example.com',
      VITE_TURNSTILE_SITE_KEY: '1x00000000000000000000AA',
    });
    local = await buildInto(scratch(), {
      VITE_PUBLIC_DEMO: '',
      VITE_API_BASE_URL: '',
      VITE_TURNSTILE_SITE_KEY: '',
    });
    assert.ok(demo.length > 10_000 && local.length > 10_000);
  });

  it('contains no secret value and no secret setting name', () => {
    for (const [name, value] of Object.entries(SENTINELS)) {
      assert.ok(!demo.includes(value), `${name} value leaked into the demo bundle`);
      assert.ok(!local.includes(value), `${name} value leaked into the local bundle`);
    }
    for (const name of ['APAYEE_TOKEN', 'TICKET_SECRET', 'TURNSTILE_SECRET', 'ANTHROPIC_API_KEY']) {
      assert.ok(!demo.includes(name), `${name} appears in the demo bundle`);
    }
  });

  it('carries the public settings it was given and nothing more', () => {
    assert.ok(demo.includes('https://api.example.com'));
    assert.ok(demo.includes('1x00000000000000000000AA'));
    assert.ok(demo.includes('challenges.cloudflare.com/turnstile'));
  });

  it('a local build has no API origin and does not load Turnstile on its own', () => {
    assert.ok(!local.includes('https://api.example.com'));
    // The loader is in the bundle (it is code), but the local build never reaches it: no site key.
    assert.ok(!local.includes('1x00000000000000000000AA'));
  });

  it('keeps the relative API paths for the local proxy', () => {
    assert.ok(local.includes('/api/extract'));
    assert.ok(local.includes('/api/jobs'));
  });

  it('cleans up', () => {
    for (const dir of folders) rmSync(dir, { recursive: true, force: true });
  });
});

describe('the frontend source', () => {
  const stripComments = (code) =>
    code
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .map((line) => line.replace(/(^|\s)\/\/.*$/, ''))
      .join('\n');

  const sources = walk(srcDir)
    .filter((file) => /\.(js|jsx)$/.test(file) && !/\.test\.js$/.test(file))
    .filter((file) => !file.includes(`${path.sep}fixtures${path.sep}`))
    .map((file) => ({
      file: path.relative(webRoot, file),
      code: stripComments(readFileSync(file, 'utf8')),
    }));

  it('finds the files it is supposed to scan', () => {
    assert.ok(sources.length > 15);
    assert.ok(sources.some((s) => s.file.endsWith('api.js')));
  });

  it('never uses browser storage, cookies or credentialed requests', () => {
    const banned = /localStorage|sessionStorage|indexedDB|document\.cookie|credentials\s*:/;
    for (const { file, code } of sources) {
      assert.doesNotMatch(code, banned, `${file} touches browser storage or credentials`);
    }
  });

  it('builds no API URL anywhere but api.js', () => {
    for (const { file, code } of sources) {
      if (file.endsWith(`${path.sep}api.js`)) continue;
      assert.doesNotMatch(code, /fetch\(|['"`]\/api\//, `${file} calls the API by itself`);
    }
  });

  it('sends no provider or model from the job client', () => {
    const api = sources.find((s) => s.file.endsWith(`${path.sep}api.js`)).code;
    const jobPart = api.slice(api.indexOf('createSession'));
    assert.doesNotMatch(jobPart, /provider|model/);
  });
});
