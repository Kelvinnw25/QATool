import { spawn } from 'node:child_process';

/**
 * Runs the API and the Vite dev server together.
 *
 * A hand-rolled two-process launcher rather than a `concurrently` dependency -
 * it is sixty lines and one fewer thing to keep updated (PRD 33).
 *
 * The API deliberately does NOT watch its own files.
 *
 * `node --watch` replaces the process on any change under server/, and a
 * QATOOL request is not a thing that can be replaced midway: extraction and
 * generation each wait on a Gemini call, so a request holds the process for
 * fifteen to fifty seconds. Saving a server file inside that window killed the
 * request, Vite answered the browser with an empty 500, and the work was gone -
 * including whichever Gemini calls had already been paid for out of a 20-a-day
 * quota. A watcher that aborts in-flight work costs more than it saves when the
 * work is measured in tens of seconds and metered.
 *
 * The UI keeps its hot reload: that is Vite's watcher, and it is untouched.
 * Server changes need a manual restart, which is the trade - and the one-off
 * cost of restarting is smaller than losing a run in progress.
 *
 *   npm run dev:server:watch   the old behaviour, when you want it
 *
 * The API also starts FIRST, and the UI does not open until it answers.
 *
 * Spawning both at once looks equivalent and is not: Vite is listening in well
 * under a second while the API is still behind npm's own startup, so for about
 * a minute there is a UI that cannot reach a backend. An upload submitted into
 * that window is refused by the proxy with an empty 500, which the browser
 * reports as the API not responding - indistinguishable, to whoever is reading
 * it, from the watcher problem above. Measured once: Vite up at 00:25:46, API
 * up at 00:26:39, and a 19MB PRD lost in between. Waiting on /api/health costs
 * a few hundred milliseconds and makes that window impossible.
 */
const API_HEALTH = 'http://127.0.0.1:3001/api/health';
const READY_TIMEOUT_MS = 60_000;
const POLL_INTERVAL_MS = 250;
const POLL_TIMEOUT_MS = 2_000;

let shuttingDown = false;
const processes = [];

function launch(name, args) {
  const child = spawn('npm', args, {
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });

  child.on('exit', (code, signal) => {
    if (!shuttingDown) {
      console.error(`\n[${name}] exited (code ${code}, signal ${signal}). Stopping the other.`);
      shutdown();
      process.exitCode = code ?? 1;
    }
  });

  processes.push(child);
  return child;
}

function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of processes) {
    if (!child.killed) child.kill();
  }
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    shutdown();
    process.exit(0);
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A health answer BEFORE anything is spawned means port 3001 is already held.
 *
 * This has to be checked, because otherwise it defeats the wait below. An older
 * dev process answers the poll instantly, the API we just started dies on
 * EADDRINUSE, and the UI opens against a backend running whatever code and
 * whichever GEMINI_MODEL that stale process was started with - which is a worse
 * failure than the one the wait exists to prevent, because nothing looks wrong.
 */
async function alreadyServing() {
  try {
    const response = await fetch(API_HEALTH, { signal: AbortSignal.timeout(POLL_TIMEOUT_MS) });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Polls /api/health until it answers, the API dies, or we give up.
 *
 * The health route is the right signal rather than the port being open: it is
 * served by the API itself, so a 200 means requests are actually being handled
 * and not merely queued against a half-initialised process.
 */
async function waitForApi(api) {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  let announced = false;

  while (Date.now() < deadline) {
    if (shuttingDown || api.exitCode !== null || api.signalCode !== null) return false;

    try {
      const response = await fetch(API_HEALTH, { signal: AbortSignal.timeout(POLL_TIMEOUT_MS) });
      if (response.ok) return true;
    } catch {
      // Still starting. Any other outcome is a reason to keep waiting too, so
      // there is nothing to distinguish here until the deadline decides.
    }

    if (!announced) {
      console.log('QATOOL dev: waiting for the API before opening the UI...');
      announced = true;
    }

    await sleep(POLL_INTERVAL_MS);
  }

  return false;
}

if (await alreadyServing()) {
  console.error(
    `Something is already answering ${API_HEALTH}, so this would be a second API on a port it cannot have. Stop the earlier \`npm run dev\` (or whatever is holding 3001) and run this again.`
  );
  process.exit(1);
}

const api = launch('api', ['run', 'dev:server']);
const ready = await waitForApi(api);

if (ready && !shuttingDown && api.exitCode === null) {
  launch('web', ['run', 'dev:web']);

  console.log('QATOOL dev: API ready on http://127.0.0.1:3001, UI on http://localhost:5173');
  console.log('UI reloads on change. The API does not - restart this after editing server/.');
} else if (!shuttingDown) {
  console.error(
    `\nThe API did not answer ${API_HEALTH} within ${READY_TIMEOUT_MS / 1000}s, so the UI was not started - it would only have shown an empty 500 on the first upload. Check the [api] output above.`
  );
  shutdown();
  process.exitCode = 1;
}
