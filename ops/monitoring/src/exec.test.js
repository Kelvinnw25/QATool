import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  APAYEE_HEALTH_SCRIPT,
  BACKEND_READER_PATH,
  INSPECT_FORMAT,
  isAllowedDockerCommand,
  runDocker,
} from './exec.js';

const ID = 'a1b2c3d4e5f6';

test('the commands the adapters use are allowed', () => {
  const allowed = [
    ['ps', '-a', '--filter', 'label=com.docker.compose.project=qatool', '--format', '{{json .}}'],
    ['inspect', '--format', INSPECT_FORMAT, ID, 'ffffffffffff'],
    ['stats', '--no-stream', '--format', '{{json .}}', ID],
    ['compose', '-p', 'qatool', 'exec', '-T', 'apayee', 'node', '-e', APAYEE_HEALTH_SCRIPT],
    [
      'compose',
      '--project-directory',
      'C:\\x',
      '-p',
      'qatool',
      'exec',
      '-T',
      'apayee',
      'node',
      '-e',
      APAYEE_HEALTH_SCRIPT,
    ],
    ['compose', '-p', 'qatool', 'exec', '-T', 'qatool-backend', 'node', BACKEND_READER_PATH],
  ];
  for (const args of allowed)
    assert.equal(isAllowedDockerCommand(args), true, args.join(' ').slice(0, 60));
});

test('anything that could change a container is refused', () => {
  const refused = [
    ['restart', ID],
    ['stop', ID],
    ['rm', '-f', ID],
    ['kill', ID],
    ['volume', 'rm', 'apayee-claude-config'],
    ['system', 'prune', '-f'],
    ['run', '--rm', 'alpine'],
    ['exec', ID, 'sh'],
    ['cp', `${ID}:/etc/passwd`, '.'],
    ['compose', '-p', 'qatool', 'down', '-v'],
    ['compose', '-p', 'qatool', 'up', '-d'],
    ['compose', '-p', 'qatool', 'restart'],
    ['compose', '-p', 'qatool', 'exec', '-T', 'apayee', 'sh', '-c', 'cat /proc/1/environ'],
    ['compose', '-p', 'qatool', 'exec', '-T', 'apayee', 'node', '-e', 'process.exit(0)'],
    ['compose', '-p', 'qatool', 'exec', '-T', 'other', 'node', '-e', APAYEE_HEALTH_SCRIPT],
    ['compose', '-p', 'qatool', 'exec', '-T', 'qatool-backend', 'node', '-e', APAYEE_HEALTH_SCRIPT],
  ];
  for (const args of refused) assert.equal(isAllowedDockerCommand(args), false, args.join(' '));
});

test('arguments cannot be smuggled into the allowed shapes', () => {
  assert.equal(isAllowedDockerCommand(['inspect', '--format', '{{json .}}', ID]), false); // would include Env
  assert.equal(
    isAllowedDockerCommand(['inspect', '--format', INSPECT_FORMAT, `${ID} --privileged`]),
    false
  );
  assert.equal(isAllowedDockerCommand(['inspect', '--format', INSPECT_FORMAT, '../etc']), false);
  assert.equal(
    isAllowedDockerCommand(['stats', '--no-stream', '--format', '{{json .}}', '$(id)']),
    false
  );
  assert.equal(
    isAllowedDockerCommand([
      'ps',
      '-a',
      '--filter',
      'label=com.docker.compose.project=x;rm',
      '--format',
      '{{json .}}',
    ]),
    false
  );
  assert.equal(
    isAllowedDockerCommand([
      'compose',
      '-p',
      'q;x',
      'exec',
      '-T',
      'apayee',
      'node',
      '-e',
      APAYEE_HEALTH_SCRIPT,
    ]),
    false
  );
  assert.equal(isAllowedDockerCommand('ps'), false);
  assert.equal(isAllowedDockerCommand([]), false);
  assert.equal(isAllowedDockerCommand(['ps', 5]), false);
});

test('the inspect format never asks for the environment', () => {
  assert.doesNotMatch(INSPECT_FORMAT, /Env|Cmd|Args|Mounts|Binds/);
});

test('the in-container scripts only read health and print it', () => {
  assert.match(APAYEE_HEALTH_SCRIPT, /127\.0\.0\.1:4100\/v1\/health/);
  assert.doesNotMatch(APAYEE_HEALTH_SCRIPT, /method|POST|PUT|DELETE|console\.log\(.*TOKEN/i);
  assert.doesNotMatch(APAYEE_HEALTH_SCRIPT, /stdout\.write\([^)]*Authorization/);
});

test('the backend may be asked for exactly one thing: the fixed reader, by absolute path', () => {
  const exec = (...program) => [
    'compose',
    '-p',
    'qatool',
    'exec',
    '-T',
    'qatool-backend',
    'node',
    ...program,
  ];
  assert.equal(BACKEND_READER_PATH, '/app/server/ops/read-metrics.js');
  assert.equal(isAllowedDockerCommand(exec(BACKEND_READER_PATH)), true);

  const refused = [
    exec(), // node with nothing
    exec('-e', 'process.exit(0)'),
    exec('-e', BACKEND_READER_PATH),
    exec('-p', 'process.env'),
    exec('/app/server/index.js'),
    exec('/app/server/ops/read-metrics.js', '--socket=/etc/passwd'),
    exec('/app/server/ops/read-metrics.js', 'extra'),
    exec('server/ops/read-metrics.js'), // relative: depends on the working directory
    exec('/app/server/ops/../index.js'),
    exec('/app/server/ops/read-metrics.js;id'),
    exec('/tmp/read-metrics.js'),
    exec('/app/server/ops/metrics-socket.js'),
    // the reader is for the backend only, and the Apayee script only for Apayee
    ['compose', '-p', 'qatool', 'exec', '-T', 'apayee', 'node', BACKEND_READER_PATH],
    ['compose', '-p', 'qatool', 'exec', '-T', 'qatool-frontend', 'node', BACKEND_READER_PATH],
    // other programs and other exec flags
    ['compose', '-p', 'qatool', 'exec', '-T', 'qatool-backend', 'sh', BACKEND_READER_PATH],
    ['compose', '-p', 'qatool', 'exec', '-T', 'qatool-backend', 'cat', '/proc/1/environ'],
    ['compose', '-p', 'qatool', 'exec', '-T', 'qatool-backend', 'env'],
    [
      'compose',
      '-p',
      'qatool',
      'exec',
      '-T',
      '-u',
      'root',
      'qatool-backend',
      'node',
      BACKEND_READER_PATH,
    ],
    [
      'compose',
      '-p',
      'qatool',
      'exec',
      '-T',
      '-e',
      'X=1',
      'qatool-backend',
      'node',
      BACKEND_READER_PATH,
    ],
    ['compose', '-p', 'qatool', 'exec', 'qatool-backend', 'node', BACKEND_READER_PATH], // allocates a tty
    ['compose', '-p', 'qatool', 'run', '--rm', 'qatool-backend', 'node', BACKEND_READER_PATH],
  ];
  for (const args of refused) assert.equal(isAllowedDockerCommand(args), false, args.join(' '));
});

test('the Docker daemon socket is never part of any command', () => {
  for (const args of [
    ['ps', '-a', '--filter', 'label=com.docker.compose.project=qatool', '--format', '{{json .}}'],
    ['compose', '-p', 'qatool', 'exec', '-T', 'qatool-backend', 'node', BACKEND_READER_PATH],
  ]) {
    assert.doesNotMatch(args.join(' '), /docker\.sock|\/var\/run|\s-v\s|--volume|--privileged/);
  }
});

test('runDocker rejects a disallowed command before spawning anything', async () => {
  await assert.rejects(
    () => runDocker('docker-that-does-not-exist', ['rm', '-f', ID], { timeoutMs: 100 }),
    (error) => error.code === 'NOT_ALLOWED'
  );
});
