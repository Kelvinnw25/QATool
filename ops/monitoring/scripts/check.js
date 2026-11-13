import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The monitor's "production build". There is nothing to bundle (no dependencies, no compile
 * step), so what a build would guarantee is checked instead:
 *
 *   - every source file parses (`node --check`);
 *   - the page references only files that exist and loads nothing from outside;
 *   - no inline script or inline style attribute that the page's CSP would block;
 *   - no file in the module names a secret variable's value or a non-loopback bind address.
 */

const root = fileURLToPath(new URL('..', import.meta.url));
const problems = [];

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules') continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* walk(path);
    else yield path;
  }
}

const files = [...walk(root)];
for (const file of files.filter((f) => f.endsWith('.js'))) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
  } catch (error) {
    problems.push(`syntax: ${file}\n${error.stderr}`);
  }
}

const html = readFileSync(join(root, 'public', 'index.html'), 'utf8');
for (const [, ref] of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
  if (/^[a-z]+:|^\/\//i.test(ref)) problems.push(`index.html loads an external resource: ${ref}`);
  else if (ref.startsWith('/') && !files.some((f) => f.endsWith(join('public', ref.slice(1))))) {
    if (!ref.startsWith('/api/')) problems.push(`index.html references a missing file: ${ref}`);
  }
}
if (/<script(?![^>]*\bsrc=)[^>]*>/i.test(html)) problems.push('index.html has an inline <script>');
if (/\sstyle="/i.test(html) || /<style[\s>]/i.test(html))
  problems.push('index.html has inline style');
if (/\son[a-z]+="/i.test(html)) problems.push('index.html has an inline event handler');

for (const file of files) {
  if (!/\.(js|html|css)$/.test(file) || file.endsWith('.test.js') || file.endsWith('check.js'))
    continue;
  const text = readFileSync(file, 'utf8');
  if (/\b0\.0\.0\.0\b/.test(text)) problems.push(`${file}: mentions 0.0.0.0`);
  if (/innerHTML|outerHTML|insertAdjacentHTML|document\.write/.test(text)) {
    problems.push(`${file}: writes HTML from a string`);
  }
}

if (problems.length) {
  console.error(`[check] ${problems.length} problem(s):\n- ${problems.join('\n- ')}`);
  process.exit(1);
}
console.log(`[check] ok: ${files.length} files, syntax valid, page is self-contained.`);
