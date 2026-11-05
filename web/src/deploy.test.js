import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * The staging deployment files, held to the rules that make the deployment safe. Nothing here
 * starts a tunnel, calls Vercel or Cloudflare, or reads a real setting: these are the committed
 * templates (vercel.json, the cloudflared template, the compose file) checked as text.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (relative) => readFileSync(path.join(root, relative), 'utf8');

describe('vercel.json', () => {
  const vercel = JSON.parse(read('vercel.json'));
  const rootPackage = JSON.parse(read('package.json'));

  it('builds the frontend workspace from the repository root and publishes web/dist', () => {
    assert.equal(vercel.installCommand, 'npm ci --workspace web');
    assert.equal(vercel.buildCommand, 'npm run build');
    assert.equal(vercel.outputDirectory, 'web/dist');
    assert.equal(rootPackage.scripts.build, 'npm run build --workspace web');
    assert.ok(rootPackage.workspaces.includes('web'));
    assert.match(read('web/vite.config.js'), /outDir:\s*'dist'/);
  });

  it('has no rewrite, redirect or route: the page calls the API host directly', () => {
    for (const key of ['rewrites', 'redirects', 'routes', 'proxy']) {
      assert.equal(vercel[key], undefined, `vercel.json must not define ${key}`);
    }
    const text = JSON.stringify(vercel);
    assert.doesNotMatch(text, /cfargotunnel|localhost|127\.0\.0\.1|:3001|:4100|:4101|:5173|\/api/);
  });

  it('carries no environment values and no secret of any kind', () => {
    assert.equal(vercel.env, undefined);
    assert.equal(vercel.build, undefined);
    // Header names are called "key" in this format, so look at the values and the commands.
    const values = [
      vercel.installCommand,
      vercel.buildCommand,
      vercel.ignoreCommand,
      ...vercel.headers.flatMap((entry) => entry.headers.map((header) => header.value)),
    ].join(' ');
    assert.doesNotMatch(values, /secret|token|password|api[_-]?key|VITE_/i);
  });

  it('only builds the main branch', () => {
    assert.match(vercel.ignoreCommand, /VERCEL_GIT_COMMIT_REF/);
    assert.match(vercel.ignoreCommand, /"main"/);
  });

  it('adds safe response headers and no Content-Security-Policy that would need a domain', () => {
    const headers = vercel.headers.flatMap((entry) => entry.headers);
    const names = headers.map((header) => header.key);
    for (const name of ['X-Content-Type-Options', 'X-Frame-Options', 'Referrer-Policy']) {
      assert.ok(names.includes(name), `${name} is set`);
    }
    assert.ok(!names.includes('Content-Security-Policy'));
  });
});

describe('.vercelignore', () => {
  const lines = read('.vercelignore')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'));

  it('keeps environment files, keys and the backend out of what is uploaded', () => {
    for (const entry of [
      '.env',
      '.env.*',
      '**/.env',
      '*.pem',
      '*.key',
      'server',
      'compose.yaml',
      'docs',
    ]) {
      assert.ok(lines.includes(entry), `.vercelignore lists ${entry}`);
    }
  });

  it('does not exclude anything the build needs', () => {
    for (const needed of ['web', 'web/src', 'package.json', 'package-lock.json', 'vercel.json']) {
      assert.ok(!lines.includes(needed), `.vercelignore must not list ${needed}`);
    }
  });

  it('keeps the Vercel link folder out of Git', () => {
    assert.ok(
      read('.gitignore')
        .split('\n')
        .map((line) => line.trim())
        .includes('.vercel/')
    );
  });
});

describe('the cloudflared template', () => {
  const template = read('deploy/cloudflared/config.example.yml');
  const lines = template.split(/\r?\n/);
  const rules = lines.filter((line) => /^\s*-\s*(hostname|service):/.test(line));

  it('routes exactly one hostname to the backend on port 3001, then 404s everything else', () => {
    assert.deepEqual(
      rules.map((line) => line.trim()),
      ['- hostname: api.<DOMAIN>', '- service: http_status:404']
    );
    assert.match(template, /^\s+service: http:\/\/localhost:3001\s*$/m);
    assert.equal(
      rules.at(-1).trim(),
      '- service: http_status:404',
      'the catch-all must be the last rule'
    );
  });

  it('never points at Apayee or the Vite dev server', () => {
    const active = lines.filter((line) => !/^\s*#/.test(line)).join('\n');
    assert.doesNotMatch(active, /4100|4101|5173|apayee/i);
  });

  it('holds placeholders only: no real tunnel id, credentials or token', () => {
    const active = lines.filter((line) => !/^\s*#/.test(line)).join('\n');
    assert.match(active, /tunnel: <TUNNEL_UUID>/);
    assert.match(active, /credentials-file: .*<TUNNEL_UUID>\.json/);
    assert.doesNotMatch(
      active,
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
      'no real UUID'
    );
    assert.doesNotMatch(active, /eyJ[A-Za-z0-9_-]{20,}|TunnelSecret|AccountTag/);
    // The credentials file lives in the user's profile, not in the repository.
    assert.match(active, /C:\\Users\\<WINDOWS_USER>\\\.cloudflared\\/);
  });

  it('is shipped nowhere: the Docker build context excludes deploy/ and vercel.json', () => {
    const ignore = read('.dockerignore');
    assert.match(ignore, /^\*$/m, 'allow-list style: everything is excluded unless listed');
    assert.doesNotMatch(ignore, /^!deploy/m);
    assert.doesNotMatch(ignore, /^!vercel\.json/m);
  });

  it('keeps tunnel credentials out of Git', () => {
    const ignore = read('.gitignore');
    for (const pattern of ['.cloudflared/', 'cert.pem', '*.pem']) {
      assert.ok(ignore.split(/\r?\n/).includes(pattern), `.gitignore lists ${pattern}`);
    }
  });
});

describe('the Vercel staging template', () => {
  const lines = read('deploy/staging.vercel.env.example')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'));
  const values = Object.fromEntries(
    lines.map((line) => [line.split('=')[0], line.slice(line.indexOf('=') + 1)])
  );

  it('lists exactly the four public settings the page reads, all VITE_', () => {
    assert.deepEqual(Object.keys(values).sort(), [
      'VITE_API_BASE_URL',
      'VITE_PUBLIC_DEMO',
      'VITE_TURNSTILE_ACTION',
      'VITE_TURNSTILE_SITE_KEY',
    ]);
    const source = read('web/src/config.js');
    for (const name of Object.keys(values)) assert.ok(source.includes(name), name);
  });

  it('holds no value to leak: the site key and API origin are blank, the rest are public flags', () => {
    assert.equal(values.VITE_PUBLIC_DEMO, 'true');
    assert.equal(values.VITE_API_BASE_URL, '');
    assert.equal(values.VITE_TURNSTILE_SITE_KEY, '');
    assert.equal(values.VITE_TURNSTILE_ACTION, 'qatool_demo');
  });

  it('uses the same action as the backend template', () => {
    assert.match(read('deploy/staging.backend.env.example'), /^TURNSTILE_ACTION=qatool_demo$/m);
  });

  it('is shipped nowhere: neither template reaches Vercel or an image', () => {
    assert.ok(read('.vercelignore').split('\n').includes('deploy'));
    assert.doesNotMatch(read('.dockerignore'), /^!deploy/m);
  });
});

describe('the Quick Tunnel address is a valid API base for the page', () => {
  it('accepts a trycloudflare.com origin over https, and not the same host over http', async () => {
    const { normalizeApiBase } = await import('./config.js');
    assert.equal(
      normalizeApiBase('https://random-words-example.trycloudflare.com').base,
      'https://random-words-example.trycloudflare.com'
    );
    assert.ok(normalizeApiBase('http://random-words-example.trycloudflare.com').problem);
  });
});

describe('compose.yaml still keeps the private things private', () => {
  const compose = read('compose.yaml');
  const service = (name) => {
    const start = compose.indexOf(`\n  ${name}:`);
    assert.notEqual(start, -1, `service ${name}`);
    const next = compose.slice(start + 1).search(/\n {2}[a-z][\w-]*:\n/);
    return compose.slice(start, next === -1 ? undefined : start + 1 + next);
  };
  const active = (text) =>
    text
      .split(/\r?\n/)
      .filter((line) => !/^\s*#/.test(line))
      .join('\n');

  it('publishes nothing for Apayee, and only loopback ports for the rest', () => {
    assert.doesNotMatch(active(service('apayee')), /^\s+ports:/m);
    assert.doesNotMatch(active(compose), /\b410[01]:/);
    assert.match(active(service('qatool-backend')), /'127\.0\.0\.1:3001:3001'/);
    assert.match(active(service('qatool-frontend')), /'127\.0\.0\.1:5173:5173'/);
    assert.doesNotMatch(active(compose), /['"]0\.0\.0\.0:/);
  });

  it('keeps the Claude sign-in as an external volume under its exact name', () => {
    assert.match(
      active(compose),
      /apayee-claude-config:\s*\n\s+external: true\s*\n\s+name: apayee-claude-config/
    );
  });

  it('sets neither concurrency nor the public demo: the defaults (1 worker, 1 CLI, demo off) stand', () => {
    const text = active(compose);
    assert.doesNotMatch(text, /APAYEE_MAX_CONCURRENT|JOB_WORKERS|PUBLIC_DEMO|PUBLIC_MODE/);
    assert.doesNotMatch(text, /TICKET_SECRET|TURNSTILE|APAYEE_TOKEN|APAYEE_AUTH_TOKEN/);
  });
});
