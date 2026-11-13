import { createAdapters } from './src/adapters/index.js';
import { createCollector } from './src/collector.js';
import { loadConfig } from './src/config.js';
import { createMonitorServer } from './src/http-server.js';

/**
 * Starts the local operations dashboard: `npm --prefix ops/monitoring start`
 * Read ops/monitoring/README.md first. It binds to 127.0.0.1 only and never writes to the systems
 * it watches.
 */

let config;
try {
  config = loadConfig();
} catch (error) {
  console.error(`[ops-monitor] ${error.message}`);
  process.exit(1);
}

const collector = createCollector({ config, adapters: createAdapters(config) });
const app = createMonitorServer({ config, collector });

try {
  const address = await app.listen();
  console.log(
    config.mode === 'container'
      ? `[ops-monitor] container mode: listening on port ${address.port}; Compose publishes it on the host's 127.0.0.1:${config.publicPort} only`
      : `[ops-monitor] dashboard: http://${address.address}:${address.port}  (loopback only)`
  );
  console.log(
    `[ops-monitor] polling every ${config.pollMs / 1000}s; jobs source: ${config.jobsSource}`
  );
  collector.start();
} catch (error) {
  console.error(
    error.code === 'EADDRINUSE'
      ? `[ops-monitor] port ${config.port} is in use. Set MONITOR_PORT to another port.`
      : `[ops-monitor] could not start: ${error.message}`
  );
  process.exit(1);
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    collector.stop();
    await app.close();
    process.exit(0);
  });
}
