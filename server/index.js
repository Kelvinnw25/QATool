import { buildApp } from './app.js';
import { config } from './config.js';

const app = buildApp({
  logger: {
    level: config.logLevel,
    // PRD 20: never log document content or secrets. Keep request logging to
    // method and path.
    serializers: {
      req: (request) => ({ method: request.method, url: request.url }),
    },
  },
});

async function shutdown(signal) {
  app.log.info(
    { event: 'server_stopping', pid: process.pid, signal },
    `Received ${signal}, shutting down.`
  );
  try {
    await app.close();
    process.exit(0);
  } catch (error) {
    app.log.error({ err: error }, 'Failed to shut down cleanly.');
    process.exit(1);
  }
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => shutdown(signal));
}

try {
  // A misspelled gateway URL or a missing token is found now, not on the first
  // generation. Reachability is not checked: Apayee may legitimately start
  // after QATOOL, and every call reports it clearly if it is not there. Loaded
  // only for this provider, so no other configuration pays for the adapter.
  if (config.llm.provider === 'apayee') {
    const { validateApayeeSettings } = await import('./llm/apayee.js');
    validateApayeeSettings(config.llm);
  }

  await app.listen({ host: config.host, port: config.port });
  // pid and watch are here for one reason: `node --watch` replaces the process
  // on any file change, and during that gap the Vite proxy answers 500 with an
  // empty body. That is dev-server behaviour, not a QATOOL error, and a new pid
  // in the log is what distinguishes it. No "restart detected" event is
  // invented - a fresh process cannot know it replaced another one.
  //
  // The env var, not just execArgv. Watch mode runs the application in a child,
  // and that child's execArgv is EMPTY - so this field reported false under
  // `node --watch` as readily as without it, which is the one case it existed to
  // flag. Node sets WATCH_REPORT_DEPENDENCIES=1 in the watched child; execArgv
  // is kept beside it in case a future Node passes the flag down directly.
  app.log.info(
    {
      event: 'server_started',
      pid: process.pid,
      mode: config.env,
      watch:
        process.env.WATCH_REPORT_DEPENDENCIES === '1' ||
        process.execArgv.some((arg) => arg.startsWith('--watch')),
    },
    `QATOOL API listening on http://${config.host}:${config.port}`
  );
  app.log.info('Stateless: no database, no session store, nothing written to disk.');
} catch (error) {
  app.log.error({ err: error }, 'Failed to start server.');
  process.exit(1);
}
