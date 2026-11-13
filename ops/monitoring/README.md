# QATOOL Ops Monitor

A local, read-only operations dashboard for watching QATOOL staging and Apayee during a live demo
(about 10 concurrent visitors). It is an owner's tool, **not** a QATOOL feature: it is not part of the
public frontend, the public API, the backend image or the Vercel deployment.

```text
http://127.0.0.1:3301        the dashboard (this PC only)
```

## Start it

It is a normal service of the Compose stack. From the repository root:

```powershell
docker compose up -d
```

Then open <http://127.0.0.1:3301>. No npm command and no PowerShell variable. The first run builds the
`qatool-monitoring` image; after changing the monitor's code, rebuild it with
`docker compose up -d --build qatool-monitoring`.

- **Port.** The service listens on 3300 _inside_ its container; Compose publishes it on **`127.0.0.1:3301`** of this
  PC (`compose.yaml`, `'127.0.0.1:3301:3300'`). 3301 because 3300 is commonly taken by the host-mode copy
  below. To use another port, change the host side of that line **and** `MONITOR_PUBLIC_PORT` beside it (the Host
  and Origin checks expect the port you browse), then `docker compose up -d qatool-monitoring`.
- **It needs the job metrics socket**, so `.env` must contain `OPS_METRICS_SOCKET=/run/qatool-ops/metrics.sock` and
  `PUBLIC_DEMO=true` (see "Job metrics"). Without them the stack still works and the Jobs panel says why it is empty.
- Frontend URL is set in `compose.yaml` (`MONITOR_FRONTEND_URL`). The Quick Tunnel address changes on every start, so it is **not** written
  there: `scripts/start-qatool.ps1` writes the verified current address to `.qatool-local/monitor/tunnel-url`, a file this container
  mounts **read-only** (`MONITOR_TUNNEL_URL_FILE`) and re-reads on every poll. A new tunnel needs no monitor restart; until the script has
  run once, the tunnel shows "not configured".

### Host mode (optional)

The same code also runs as a plain Node process, for development. Needs Node 22.13+ and **no `npm install`**:

```powershell
$env:MONITOR_JOBS_SOURCE = 'docker-exec'       # Docker Desktop must be running
$env:MONITOR_FRONTEND_URL = 'https://qatool-staging.vercel.app'
npm --prefix ops/monitoring start              # http://127.0.0.1:3300, loopback only
```

Host mode reads the backend and Apayee through `docker compose exec` and has container statistics from the Docker CLI,
which the container cannot have. Do not run both on the same PC for long: they show the same system twice.

## What it shows

| Section           | Contents                                                                                                                                                  |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Overview          | Backend, Apayee, Vercel frontend, Cloudflare Tunnel, containers; last poll; stale or unreadable sources                                                   |
| Jobs              | Processing, queued, completed, failed, cancelled, success rate; `queued → processing → completed / failed / cancelled`; p50/p95 processing and queue wait |
| Queue & capacity  | QATOOL workers (busy / effective / free), Apayee active / max / pending / waiting-room size, saturation warnings, 3 history charts                        |
| Infrastructure    | Host mode: per container state, health, CPU, memory, restarts, uptime. Container mode: the backend's own process figures (see below)                      |
| Activity & errors | Recent events, failure categories, refused submissions                                                                                                    |

"Refresh now" polls immediately. "Export snapshot" downloads a sanitized JSON file.

## Architecture

```text
                       docker compose  (one project, "qatool")

   qatool-net ───────────────────────────────────────────────────────────────
     apayee (private; no host port; holds APAYEE_TOKEN's other half)
     qatool-frontend  127.0.0.1:5173
     qatool-backend   127.0.0.1:3001 ─── holds APAYEE_TOKEN, asks Apayee, owns metrics.snapshot()
                           │  creates /run/qatool-ops/metrics.sock  (0600, node:node)
                           │
                  volume qatool-ops-metrics ──(rw in backend, ro in monitor)
                           │
   qatool-monitor-net ─────┼──────────────────────────────────────────────────
     qatool-backend  ◄── GET /healthz ──┐
                           │             │
     qatool-monitoring  127.0.0.1:3301 → 3300
        GET /snapshot  (job metrics)     reads the socket FILE on the volume
        GET /apayee    (gateway view)    no Docker CLI · no docker.sock · no token · read-only root fs
        GET https://qatool-staging.vercel.app/   (and the tunnel address, if set)
```

- The monitor shares **only** `qatool-monitor-net` with the backend. It is not on `qatool-net`, so it cannot reach
  Apayee or the frontend container; Apayee still publishes no port.
- `exec.js` (host mode only) is the one place a program is started, from an allow-list. In the container there is no
  Docker CLI to start.
- One collector loop polls every 4 s (3-5 s allowed), each source under its own timeout, so one failing never stops
  the others. History and events are bounded and in memory.

## Data sources: real versus not available

| Figure                                     | Container mode                                                                | Host mode                                             |
| ------------------------------------------ | ----------------------------------------------------------------------------- | ----------------------------------------------------- |
| Backend up, latency                        | `GET /healthz` on the monitor network                                         | `GET /healthz` on `127.0.0.1:3001`                    |
| Jobs, queue, workers, durations            | backend socket `GET /snapshot`                                                | same socket, via `docker compose exec`                |
| Apayee ready / not, active, max, pending   | backend socket `GET /apayee` (the backend asks Apayee)                        | `docker compose exec` into Apayee                     |
| Apayee totals (failed, timed out, ...)     | **not available** (the backend does not pass them on)                         | real                                                  |
| Apayee version, provider state text        | **not available**                                                             | real                                                  |
| Container CPU, memory, restarts, uptime    | **not available** (needs the Docker API)                                      | real (`docker stats`, `docker inspect`)               |
| Backend process memory, event-loop, uptime | real (the backend reports it itself)                                          | real                                                  |
| Cloudflare Tunnel                          | HTTP `/healthz` through the address in the tunnel file (none yet: not set up) | `MONITOR_TUNNEL_URL`, plus whether `cloudflared` runs |
| Frontend (Vercel)                          | HTTP status of `MONITOR_FRONTEND_URL`                                         | same                                                  |
| Average job time                           | not collected (QATOOL keeps p50/p95/max); p50 shown                           | same                                                  |
| Per-job timeline, job ids, visitor info    | not recorded by QATOOL, and deliberately not wanted                           | same                                                  |
| Recent job activity                        | derived from counter changes between polls                                    | same                                                  |

Nothing unavailable is shown as zero: it is an en dash and a sentence saying why.

### Why container statistics are not available in the container

CPU, memory, restart counts and uptime of _other_ containers come only from the Docker API (`docker stats`, `inspect`).
Reaching it from inside a container means mounting `/var/run/docker.sock`, which is root on the machine, or a host
cgroup bind mount that is Docker-Desktop-specific and needs the container ids. Neither is acceptable for a
read-only tool, so neither is used. What remains without them, and is shown:

- **Health and connectivity** of the backend (`/healthz`), Apayee (through the backend), the Vercel page, and the tunnel.
- **The backend's own process** (resident memory, heap, event-loop delay, uptime), which it reports in its snapshot.
- **Restarts, indirectly**: a backend restart is detected from its uptime going backwards and recorded as an event.

If you want per-container numbers, use host mode, which asks the Docker CLI on your PC.

### Job metrics: the private socket

QATOOL counts everything the Jobs panel needs in `server/jobs/metrics.js` (`snapshot()`), but only inside the backend
process, and by design no public route serves it. The backend publishes it on a **private Unix socket**:

- **Where.** `OPS_METRICS_SOCKET=/run/qatool-ops/metrics.sock` in the backend's `.env`. Unset (the default) means the
  feature does not exist. The directory is a Compose named volume, `qatool-ops-metrics`, mounted **read-write** in the
  backend and **read-only** in the monitor. Connecting to a socket does not need a writable mount.
- **Who.** The backend image creates `/run/qatool-ops` owned by `node` (uid 1000) with mode `0700`; the volume inherits
  that on first use. The socket is created `0600`. The monitor image also runs as `node` (uid 1000), the only user that
  can enter the directory and connect. Nobody else on the machine, no other container, can.
- **What it answers.** Exactly two requests: `GET /snapshot` (job metrics) and `GET /apayee` (gateway view). Every other
  method or path is refused. Each answer passes a structural guard first: plain objects of numbers, booleans, null and
  timestamps (and, for `/apayee` only, short lowercase status identifiers). A list of ids, free text or a token makes
  the answer be refused, not served.
- **No network.** No TCP listener, no route on the public API; nothing the Cloudflare Tunnel, Vercel or Compose's
  published ports can reach. It is a file on a volume.
- **Lifecycle.** Removed on graceful shutdown. A stale file left by a crash is removed at the next start only if it is
  a socket, owned by the same user, and nothing answers on it. A symlink, regular file, directory, another user's socket
  or a live socket is never touched, and the feature then stays off with one error in the log. The API never stops
  because of it. Only with `PUBLIC_DEMO=true`: outside it there are no job sources and the socket is not started.

### Apayee without giving the monitor the token

The backend already holds `APAYEE_TOKEN` and already asks the gateway for its health (cached for 5 s, no model call).
`GET /apayee` returns that same answer, reduced to: reachable and running Claude or not, a fixed reason identifier
(`gateway_offline`, `gateway_timeout`, `gateway_auth_failed`, `provider_not_ready`, ...), and active / max / pending /
capacity. The monitor never holds the token, the URL of Apayee, or any Apayee credential, and has no route to Apayee.

The cost is honesty about what that view lacks: Apayee's version, provider state text and its succeeded / failed /
timed-out / rejected totals (the backend's gateway code deliberately keeps only capacity numbers). Widening that is a
change to the backend's gateway client, not to the monitor.

#### What each state means on the Jobs panel

| Panel says                         | Meaning                                                                                    |
| ---------------------------------- | ------------------------------------------------------------------------------------------ |
| Numbers, including `0`             | The platform answered; zero really is zero                                                 |
| "switched off in the monitor"      | `MONITOR_JOBS_SOURCE` is `none`                                                            |
| `SOCKET_UNREACHABLE`               | No socket: the backend is starting, `OPS_METRICS_SOCKET` is unset, or `PUBLIC_DEMO` is off |
| "running without the job platform" | The socket answered but the backend has no job platform                                    |
| `BAD_SNAPSHOT`                     | The answer failed the guard; the backend logged `ops_metrics_refused` with the rule        |
| `SOCKET_TIMEOUT` or `TIMEOUT`      | No answer in time; the last good figures are shown greyed and marked old                   |
| Apayee `APAYEE_UNREACHABLE`        | The backend cannot reach Apayee (reason in brackets): Apayee is down or restarting         |

## Security

- **Container mode.** Listens on all interfaces _inside_ its container (`MONITOR_MODE=container` is the only way to
  allow that), but Compose publishes it on `127.0.0.1` of the host only. Host mode refuses any non-loopback bind, with
  no flag to relax it.
- **Who may connect.** On the host, loopback addresses only. In the container, loopback and Docker's private bridge
  ranges (that is where a published port arrives from), never a public address. The `Host` header must be
  `127.0.0.1`, `localhost` or `[::1]` on the published or internal port (blocks DNS rebinding).
- No CORS headers, strict CSP (`default-src 'none'`, own scripts only), no remote resources, no inline script.
- The only write-like route, `POST /api/refresh`, needs a custom header and a same-origin `Origin`, and only asks the
  collector to poll sooner. It cannot submit, cancel or change anything.
- **No secrets, no privileges.** No `env_file`, no token, no key, no Docker CLI, no `docker.sock`, no `privileged`, no
  added capabilities (`cap_drop: [ALL]`, `no-new-privileges`), read-only root filesystem (a 16 MB `/tmp` only), 256 MB,
  0.5 CPU, 128 processes, non-root.
- Everything stored or exported passes through redaction (bearer tokens, JWTs, `*_SECRET`/`*_TOKEN`/key shapes, user
  paths, tunnel host names). No request body, prompt, document text or ticket is ever read.
- Not in the backend image, not uploaded to Vercel (`.vercelignore`), and the build context is `ops/monitoring/` only,
  filtered by an allow-list `.dockerignore`.

## Limits to know

- History (about 12 minutes at 4 s) and events live in memory and start empty when the monitor starts.
- QATOOL job figures reset when the backend restarts; the monitor says so (event, and a counter) rather than stitching
  the series together.
- Success rate is `completed ÷ (completed + failed)` since the backend started; cancelled jobs are shown separately.
- The monitor network is not `internal` (it must reach the Vercel page), so its outbound traffic is not filtered by host.
  It makes only the requests listed above; a firewall rule is the way to enforce that if you need it.
- A Quick Tunnel address changes on every start; the start script keeps the tunnel file current, so nothing needs editing. After a stop, the file
  still names the old address and the tunnel reads **down**, which is accurate: the tunnel is down.
- `docker compose down -v` removes the `qatool-ops-metrics` volume (it holds only the socket file and is recreated).

## Troubleshooting

| Symptom                               | Cause and fix                                                                                                                                                                                      |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `http://127.0.0.1:3301` does not open | `docker compose ps`; start with `docker compose up -d`. Check nothing else holds port 3301 (`netstat -ano`).                                                                                       |
| Page says "403 Forbidden"             | You opened it by another name or port. Use `127.0.0.1:3301` or `localhost:3301`, or match `MONITOR_PUBLIC_PORT`.                                                                                   |
| Jobs: `SOCKET_UNREACHABLE`            | `.env` lacks `OPS_METRICS_SOCKET=/run/qatool-ops/metrics.sock` or `PUBLIC_DEMO=true`, or the backend was not recreated after editing it (`docker compose up -d --build --no-deps qatool-backend`). |
| Backend refuses to create the socket  | `docker compose logs qatool-backend`: look for `ops_metrics_failed`. The volume may be owned by root if it was created by something else; `down -v` removes it, then `up` recreates it correctly.  |
| Everything red, "No answer"           | The stack is down or restarting; the page recovers by itself.                                                                                                                                      |
| Containers "N/A"                      | Expected in container mode (see above). Use host mode for per-container numbers.                                                                                                                   |
| Tunnel "not configured"               | Run `.\scripts\start-qatool.ps1`: it verifies a tunnel and writes its address to the file the monitor reads. (Host mode: set `MONITOR_TUNNEL_URL`.)                                                |
| `port 3300 is in use` (host mode)     | Another copy is running, or set `MONITOR_PORT`.                                                                                                                                                    |

## Settings

Container mode reads these from `compose.yaml` (none is secret); host mode from the shell.

| Variable                                         | Default (host / container)                                 | Meaning                                                  |
| ------------------------------------------------ | ---------------------------------------------------------- | -------------------------------------------------------- |
| `MONITOR_MODE`                                   | `host`                                                     | `host` or `container`                                    |
| `MONITOR_HOST` / `MONITOR_PORT`                  | `127.0.0.1` / `3300` · all interfaces in the container     | Host mode: loopback only                                 |
| `MONITOR_PUBLIC_PORT`                            | `MONITOR_PORT` · `3301` in `compose.yaml`                  | The port you browse; Host and Origin checks expect it    |
| `MONITOR_JOBS_SOURCE`                            | `none` · `socket` in `compose.yaml`                        | `none`, `socket` (container) or `docker-exec` (host)     |
| `MONITOR_METRICS_SOCKET`                         | `/run/qatool-ops/metrics.sock`                             | Where the backend's socket is                            |
| `MONITOR_BACKEND_URL`                            | `http://127.0.0.1:3001` · `http://qatool-backend:3001`     | Only `/healthz` is requested                             |
| `MONITOR_FRONTEND_URL`, `MONITOR_TUNNEL_URL`     | unset · frontend set in `compose.yaml`                     | Public origins; unset = "not configured"                 |
| `MONITOR_TUNNEL_URL_FILE`                        | unset · `/run/qatool-monitor/tunnel-url` in `compose.yaml` | File holding the current tunnel address (read each poll) |
| `MONITOR_POLL_MS`                                | `4000`                                                     | 3000-5000                                                |
| `MONITOR_ADAPTER_TIMEOUT_MS`                     | `3000`                                                     | Per source                                               |
| `MONITOR_HISTORY_POINTS`, `MONITOR_EVENT_LIMIT`  | `180`, `200`                                               | In-memory bounds                                         |
| `MONITOR_COMPOSE_PROJECT`, `MONITOR_COMPOSE_DIR` | `qatool`, unset                                            | Host mode only                                           |
| `MONITOR_DOCKER_BIN`                             | `docker`                                                   | Host mode only                                           |

## Tests and checks

```bash
npm --prefix ops/monitoring test         # unit and integration tests, offline, no Docker needed
npm --prefix ops/monitoring run check    # the "build": syntax, self-contained page, no HTML-from-string
npm test                                 # from the root: includes the backend half, server/ops/*.test.js
```

The tests that need real Unix socket files are skipped on Windows. They run on Linux; to run them from Windows without
touching anything, use a throwaway container with the repository mounted read-only (no network, no capabilities):

```powershell
docker run --rm --network none --cap-drop ALL --read-only --tmpfs /tmp --user node -w /work `
  -v "${PWD}:/work:ro" node:22.15.0-bookworm-slim `
  node --test --test-concurrency=1 server/ops/metrics-socket.test.js server/ops/read-metrics.test.js ops/monitoring/src/socket.real.test.js
```

Nothing contacts a real model. A real tunnel and a populated job table are only checked live.
