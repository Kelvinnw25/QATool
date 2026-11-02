import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Architectural guard tests.
 *
 * QATOOL V1 is stateless by design: the canonical project lives in the browser
 * for one session and nothing is written anywhere. That property is easy to
 * erode one convenient `writeFileSync` at a time, so it is asserted rather than
 * left to code review.
 */

const serverDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(serverDir, '..');

function sourceFiles() {
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.js') && !entry.name.endsWith('.test.js')) files.push(full);
    }
  };
  walk(serverDir);
  return files;
}

test('no server module writes to disk', () => {
  // Reading is fine - the SIT template is read at export time. Writing is not:
  // uploaded documents are parsed from the request buffer and discarded.
  const writeApis =
    /\bfs\.(writeFile|writeFileSync|appendFile|appendFileSync|createWriteStream|mkdir|mkdirSync|rename|renameSync|copyFile|copyFileSync|rm|rmSync|unlink|unlinkSync)\b/;

  const offenders = sourceFiles().filter((file) => writeApis.test(fs.readFileSync(file, 'utf8')));

  assert.deepEqual(
    offenders.map((file) => path.relative(rootDir, file)),
    [],
    'these modules write to disk, which the stateless design forbids'
  );
});

test('no database or persistence dependency is declared', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
  const declared = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });

  const persistence = declared.filter((name) =>
    /sqlite|better-sqlite3|postgres|\bpg\b|mysql|mongo|prisma|drizzle|knex|sequelize|typeorm|redis|lowdb/i.test(
      name
    )
  );

  assert.deepEqual(persistence, [], 'a persistence dependency has crept back in');
});

test('the persistence layer is gone from the tree', () => {
  for (const removed of ['server/db', 'server/domain']) {
    assert.equal(
      fs.existsSync(path.join(rootDir, removed)),
      false,
      `${removed} should no longer exist`
    );
  }
});

test('no migration scripts remain', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts.migrate, undefined, 'there is no schema to migrate');
});

test('no server module imports a session or store abstraction', () => {
  const stateful = /@fastify\/(session|cookie|secure-session)|express-session|node:sqlite/;
  const offenders = sourceFiles().filter((file) => stateful.test(fs.readFileSync(file, 'utf8')));

  assert.deepEqual(
    offenders.map((file) => path.relative(rootDir, file)),
    [],
    'server-side session state is not part of this architecture'
  );
});
