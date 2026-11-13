/**
 * The fixed facts of the QATOOL staging setup. Nothing here is a secret: every value is a name, an address
 * that is public by design, or a limit. They are constants, not settings, on purpose: the start script
 * deploys to production, so the project it may touch is written down here and checked, not configured.
 */
export const STAGING = Object.freeze({
  /** The only Vercel project this tooling may change or deploy. */
  projectName: 'qatool-staging',
  /** The public frontend (production alias) and the origin the backend allows. */
  frontendOrigin: 'https://qatool-staging.vercel.app',
  /** The one Vercel variable the tunnel address goes into, and the one environment it is set for. */
  envName: 'VITE_API_BASE_URL',
  envTarget: 'production',

  /** Compose service names (compose.yaml). */
  services: Object.freeze({
    backend: 'qatool-backend',
    apayee: 'apayee',
    tunnel: 'cloudflared',
    monitoring: 'qatool-monitoring',
  }),
  /** Services that must be healthy before a tunnel is trusted. */
  requiredHealthy: Object.freeze(['apayee', 'qatool-backend', 'qatool-monitoring']),

  /** The tunnel container's fixed address on qatool-ingress-net (compose.yaml). The backend must trust it. */
  tunnelPeerIp: '10.250.250.2',

  /** The monitoring dashboard on the host loopback (compose.yaml). */
  dashboardUrl: 'http://127.0.0.1:3301',
  /** The backend as published on the host loopback (compose.yaml). */
  localBackendUrl: 'http://127.0.0.1:3001',

  /** The most model calls staging may run at once (JOB_WORKERS and APAYEE_MAX_CONCURRENT, each 1..this). */
  maxConcurrency: 2,

  /** Local, non-secret, Git-ignored state. */
  stateDir: '.qatool-local',

  timeouts: Object.freeze({
    healthyMs: 180_000,
    tunnelLogMs: 90_000,
    tunnelReachableMs: 120_000,
    frontendMs: 150_000,
    deployMs: 900_000,
    commandMs: 120_000,
  }),
});
